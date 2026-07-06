import { create } from 'zustand';
import {
  BillSplitMethod,
  DrinkOrder,
  DrinkPreparationOptions,
  MachineState,
  Recipe,
} from '../models';
import { orderRepository } from '../repositories/OrderRepository';
import { commandQueueService } from '../services/CommandQueueService';
import { useAppStore } from './AppStore';
import { getSkippedSteps } from '../utils/preparation';
import { deviceService } from '../services/DeviceService';
import { useInventoryStore } from './InventoryStore';
import { useRecipeStore } from './RecipeStore';
import { useSessionStore } from './SessionStore';
import { parseDrinkOrderArray } from '../adapters/payloadParsers';

const TAG = '[OrderStore]';

type CreateOrderItemInput = {
  recipe: Recipe;
  options?: DrinkPreparationOptions;
  quantity?: number;
  guest_name?: string;
};

type CreateOrderBatchInput = {
  items: CreateOrderItemInput[];
  table_number: number;
  qr_value: string;
  split_method: BillSplitMethod;
  group_id?: string;
};

interface OrderState {
  orders: DrinkOrder[];
  activeOrderId: string | null;
  isLoading: boolean;
  error: string | null;
  loadOrders: () => Promise<void>;
  createOrderBatch: (input: CreateOrderBatchInput) => Promise<DrinkOrder[]>;
  syncFromMachine: (machineState: MachineState) => Promise<void>;
  markOrderServed: (orderId: string) => Promise<void>;
  deleteOrder: (orderId: string) => Promise<DrinkOrder | null>;
  triggerNextQueuedOrder: () => Promise<boolean>;
  clearTableOrders: (tableNumber: number) => Promise<void>;
  syncOrdersFromNetwork: (tableNumber: number, orders: DrinkOrder[]) => Promise<void>;
}

function publishOrdersUpdate(tableNumber: number, orders: DrinkOrder[]) {
  const tableOrders = orders.filter((o) => o.table_number === tableNumber);
  deviceService.publish(`penpito/table/${tableNumber}/orders`, JSON.stringify(tableOrders));
}

function sortOrders(orders: DrinkOrder[]) {
  return [...orders].sort((a, b) => {
    const aTime = a.queued_at ?? a.requested_at;
    const bTime = b.queued_at ?? b.requested_at;
    if (aTime !== bTime) return aTime - bTime;
    return (a.order_index ?? 0) - (b.order_index ?? 0);
  });
}

let triggerMutex: Promise<void> = Promise.resolve();
let isTriggering = false;
const processedRecoveryRecipes = new Set<string>();

const READY_TIMEOUT_MS = 300_000;
const STALE_ORDER_WITHOUT_SESSION_MS = 300_000;

function upsertOrder(orders: DrinkOrder[], nextOrder: DrinkOrder) {
  return sortOrders([...orders.filter((order) => order.id !== nextOrder.id), nextOrder]);
}

function hasOrderChanged(current: DrinkOrder, next: DrinkOrder) {
  return (
    current.status !== next.status ||
    current.active_step_id !== next.active_step_id ||
    current.is_drink_ready !== next.is_drink_ready ||
    current.started_at !== next.started_at ||
    current.finished_at !== next.finished_at ||
    current.served_at !== next.served_at ||
    current.ready_since !== next.ready_since ||
    current.order_index !== next.order_index ||
    JSON.stringify(current.completed_step_ids) !== JSON.stringify(next.completed_step_ids) ||
    JSON.stringify(current.skipped_step_ids) !== JSON.stringify(next.skipped_step_ids)
  );
}

const STATUS_PRIORITY: Record<string, number> = {
  queued: 0,
  preparing: 1,
  ready: 2,
  served: 3,
  failed: 4,
};

function buildOrderId(recipeId: string, index: number) {
  return `${recipeId}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

async function startPreparation(order: DrinkOrder): Promise<DrinkOrder | null> {
  const success = await commandQueueService.enqueue({
    cmd: 'PREPARE',
    val: order.recipe_id,
    iceCount: order.ice_count,
    alcoholOz: order.alcohol_oz,
    mixerOz: order.mixer_oz,
  });

  if (!success) {
    return null;
  }

  return {
    ...order,
    status: 'preparing',
    active_step_id: 'cup_dispenser',
    started_at: Date.now(),
  };
}

export const useOrderStore = create<OrderState>((set, get) => ({
  orders: [],
  activeOrderId: null,
  isLoading: false,
  error: null,
  loadOrders: async () => {
    set({ isLoading: true, error: null });
    try {
      const orders = await orderRepository.getAllOrders();
      const activeOrder = orders.find((order) => order.status === 'preparing' || order.status === 'ready') ?? null;
      set({
        orders,
        activeOrderId: activeOrder?.id ?? null,
        isLoading: false,
      });
    } catch {
      set({ error: 'Failed to load orders', isLoading: false });
    }
  },
  createOrderBatch: async ({ items, table_number, qr_value, split_method, group_id }) => {
    const createdOrders: DrinkOrder[] = [];
    const batchId = group_id ?? `group-${table_number}-${Date.now()}`;
    const batchTimestamp = Date.now();
    let buildIndex = 0;

    for (const item of items) {
      const quantity = Math.max(1, item.quantity ?? 1);

      for (let quantityIndex = 0; quantityIndex < quantity; quantityIndex += 1) {
        const nextOrder: DrinkOrder = {
          id: buildOrderId(item.recipe.id, buildIndex),
          recipe_id: item.recipe.id,
          recipe_name: item.recipe.name,
          table_number,
          qr_value,
          requested_at: batchTimestamp,
          status: 'queued',
          ice_count: item.options?.iceCount ?? 0,
          alcohol_oz: item.options?.alcoholOz,
          mixer_oz: item.options?.mixerOz,
          piscola_intensity: item.options?.piscolaIntensity,
          est_time_seconds: item.recipe.est_time_seconds,
          active_step_id: undefined,
          completed_step_ids: [],
          skipped_step_ids: getSkippedSteps(item.recipe.id, item.options?.iceCount ?? 0),
          is_drink_ready: false,
          queued_at: batchTimestamp,
          started_at: undefined,
          finished_at: undefined,
          served_at: undefined,
          guest_name: item.guest_name,
          group_id: batchId,
          split_method,
          order_index: buildIndex,
        };

        await orderRepository.saveOrder(nextOrder);
        createdOrders.push(nextOrder);
        buildIndex += 1;
      }
    }

    set((state) => ({
      orders: sortOrders([...state.orders, ...createdOrders]),
    }));

    publishOrdersUpdate(table_number, get().orders);
    await get().triggerNextQueuedOrder();
    return createdOrders;
  },
  triggerNextQueuedOrder: async () => {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousPromise = triggerMutex;
    triggerMutex = previousPromise.then(() => nextPromise);

    await previousPromise;
    isTriggering = true;

    try {
      let didTrigger = false;

      while (!didTrigger) {
        const { machineState, connectionSnapshot } = useAppStore.getState();
        const state = get();

        if (connectionSnapshot?.broker !== 'connected' || machineState.status !== 'idle' || machineState.isDrinkReady) {
          break;
        }

        const hasActivePrep = state.orders.some(
          (order) =>
            order.status === 'preparing' ||
            (order.status === 'ready' && !order.served_at)
        );
        if (hasActivePrep) {
          break;
        }

        const queuedOrders = state.orders
          .filter((order) => order.status === 'queued')
          .sort((a, b) => {
            const aTime = a.queued_at ?? a.requested_at;
            const bTime = b.queued_at ?? b.requested_at;
            if (aTime !== bTime) return aTime - bTime;
            return (a.order_index ?? 0) - (b.order_index ?? 0);
          });

        const groupMinTime = new Map<string, number>();
        for (const o of queuedOrders) {
          const gid = o.group_id ?? '';
          const t = o.queued_at ?? o.requested_at;
          if (!groupMinTime.has(gid) || t < groupMinTime.get(gid)!) {
            groupMinTime.set(gid, t);
          }
        }

        const nextQueued = [...queuedOrders].sort((a, b) => {
          const ga = groupMinTime.get(a.group_id ?? '') ?? 0;
          const gb = groupMinTime.get(b.group_id ?? '') ?? 0;
          if (ga !== gb) return ga - gb;
          const aTime = a.queued_at ?? a.requested_at;
          const bTime = b.queued_at ?? b.requested_at;
          if (aTime !== bTime) return aTime - bTime;
          return (a.order_index ?? 0) - (b.order_index ?? 0);
        })[0];

        if (!nextQueued) {
          break;
        }

        const sessionStore = useSessionStore.getState();
        const tableSession = sessionStore.sessions.find((s) => s.table_number === nextQueued.table_number);
        const hasActiveSession = tableSession && tableSession.guests && tableSession.guests.length > 0;

        if (!hasActiveSession) {
          const orderAge = Date.now() - (nextQueued.queued_at ?? nextQueued.requested_at);
          if (orderAge > STALE_ORDER_WITHOUT_SESSION_MS) {
            console.warn(`${TAG} Deleting stale queued order ${nextQueued.id} for table ${nextQueued.table_number} — no active session after ${Math.round(orderAge / 1000)}s`);
            await orderRepository.deleteOrder(nextQueued.id);
            set((prevState) => ({
              orders: prevState.orders.filter((o) => o.id !== nextQueued.id),
            }));
            publishOrdersUpdate(nextQueued.table_number, get().orders);
            continue;
          }
          console.log(`${TAG} Order ${nextQueued.id} waiting for session on table ${nextQueued.table_number}. Deferring.`);
          break;
        }

        const recipe = useRecipeStore.getState().recipes.find((r) => r.id === nextQueued.recipe_id);
        const orderOptions: DrinkPreparationOptions = {
          iceCount: nextQueued.ice_count,
          alcoholOz: nextQueued.alcohol_oz,
          mixerOz: nextQueued.mixer_oz,
          piscolaIntensity: nextQueued.piscola_intensity,
        };

        if (recipe && !useInventoryStore.getState().recipeIsAvailable(recipe, orderOptions)) {
          console.warn(`${TAG} Insufficient inventory for order ${nextQueued.id}, marking as failed`);
          const failedOrder: DrinkOrder = {
            ...nextQueued,
            status: 'failed',
            finished_at: Date.now(),
            ready_since: undefined,
          };
          await orderRepository.saveOrder(failedOrder);
          set((prevState) => ({
            orders: upsertOrder(prevState.orders, failedOrder),
          }));
          publishOrdersUpdate(nextQueued.table_number, get().orders);
          continue;
        }

        const stillBusy = get().orders.some(
          (order) =>
            order.status === 'preparing' ||
            (order.status === 'ready' && !order.served_at)
        );
        if (stillBusy) {
          console.log(`${TAG} Aborting preparation of order ${nextQueued.id} because another order is currently preparing or ready.`);
          break;
        }

        if (recipe) {
          await useInventoryStore.getState().consumeForRecipe(recipe, orderOptions);
        }

        const startedOrder = await startPreparation(nextQueued);
        if (!startedOrder) {
          if (recipe) {
            await useInventoryStore.getState().restoreForRecipe(recipe, orderOptions);
          }
          break;
        }

        await orderRepository.saveOrder(startedOrder);
        set((prevState) => ({
          orders: upsertOrder(prevState.orders, startedOrder),
          activeOrderId: startedOrder.id,
        }));
        publishOrdersUpdate(nextQueued.table_number, get().orders);

        didTrigger = true;
      }

      return didTrigger;
    } finally {
      isTriggering = false;
      release!();
    }
  },
  syncFromMachine: async (machineState) => {
    const state = get();
    const activeOrderId =
      state.activeOrderId ??
      state.orders.find((order) => order.status === 'preparing' || order.status === 'ready')?.id ??
      null;

    const orphanedPreparing = state.orders.filter(
      (o) => o.status === 'preparing' && o.id !== activeOrderId
    );
    if (orphanedPreparing.length > 0) {
      console.warn(`${TAG} Found ${orphanedPreparing.length} orphaned preparing orders. Resetting them to queued.`);
      let updatedOrders = [...state.orders];
      for (const orphan of orphanedPreparing) {
        const resetOrder: DrinkOrder = {
          ...orphan,
          status: 'queued',
          active_step_id: undefined,
          started_at: undefined,
        };
        await orderRepository.saveOrder(resetOrder);
        updatedOrders = upsertOrder(updatedOrders, resetOrder);
        try {
          const recipe = useRecipeStore.getState().recipes.find((r) => r.id === orphan.recipe_id);
          if (recipe) {
            await useInventoryStore.getState().restoreForRecipe(recipe, {
              iceCount: orphan.ice_count,
              alcoholOz: orphan.alcohol_oz,
              mixerOz: orphan.mixer_oz,
            });
          }
        } catch (e) {
          console.warn('[OrderStore] Failed to restore ingredients for orphaned order', e);
        }
      }
      set({ orders: updatedOrders });
      if (orphanedPreparing.length > 0) {
        const affectedTables = new Set(orphanedPreparing.map((o) => o.table_number));
        for (const tableNum of affectedTables) {
          publishOrdersUpdate(tableNum, get().orders);
        }
      }
    }

    if (machineState.isDrinkReady) {
      const readyOrder = get().orders.find((o) => o.status === 'ready');
      const preparingOrder = get().orders.find((o) => o.status === 'preparing');

      if (!readyOrder && !preparingOrder) {
        // Guard against a timing race: if there is a queued order that matches the
        // machine's current recipe, it is likely the one we just sent and whose local
        // status hasn't been updated to 'preparing' yet. Wait for the next sync cycle
        // rather than sending a destructive TAKEN immediately.
        const hasMatchingQueued =
          machineState.currentRecipeId != null &&
          get().orders.some(
            (o) => o.status === 'queued' && o.recipe_id === machineState.currentRecipeId
          );

        if (hasMatchingQueued) {
          console.warn(
            `${TAG} Machine reports isDrinkReady but only queued (in-flight) orders exist for ${machineState.currentRecipeId}. Deferring TAKEN.`
          );
        } else {
          console.warn(
            `${TAG} Machine reports isDrinkReady but no ready or preparing order found locally. Sending TAKEN to clear machine state.`
          );
          await commandQueueService.enqueue({ cmd: 'TAKEN', val: '', target: 'kraken' });
        }
      } else if (readyOrder && readyOrder.ready_since && Date.now() - readyOrder.ready_since > READY_TIMEOUT_MS) {
        console.warn(`${TAG} Order ${readyOrder.id} has been ready for more than ${READY_TIMEOUT_MS}ms. Auto-sending TAKEN to unblock queue.`);
        await commandQueueService.enqueue({ cmd: 'TAKEN', val: '', target: 'kraken' });
      }
    }

    if (machineState.status === 'idle' && !machineState.isDrinkReady) {
      processedRecoveryRecipes.clear();
    }

    if (!activeOrderId) {
      if (machineState.status === 'idle' && !machineState.isDrinkReady) {
        const hasPendingRecovery =
          machineState.currentRecipeId != null &&
          !processedRecoveryRecipes.has(machineState.currentRecipeId) &&
          get().orders.some(
            (o) => o.status === 'queued' && o.recipe_id === machineState.currentRecipeId
          );
        if (hasPendingRecovery) {
          return;
        }
        const hasUnservedReadyOrder = get().orders.some((o) => o.status === 'ready' && !o.served_at);
        if (!hasUnservedReadyOrder) {
          await get().triggerNextQueuedOrder();
        }
        return;
      }

      if (isTriggering) {
        return;
      }

      if (machineState.currentRecipeId && processedRecoveryRecipes.has(machineState.currentRecipeId)) {
        return;
      }

      const recoveryCandidate = [...get().orders]
        .filter((o) => o.status === 'queued' && o.recipe_id === machineState.currentRecipeId)
        .sort((a, b) => {
          const aTime = a.queued_at ?? a.requested_at;
          const bTime = b.queued_at ?? b.requested_at;
          if (aTime !== bTime) return aTime - bTime;
          return (a.order_index ?? 0) - (b.order_index ?? 0);
        })[0] ?? null;

      const recoveryOrder = recoveryCandidate;

      const existingPrepared = get().orders.some(
        (o) => o.recipe_id === machineState.currentRecipeId && (o.status === 'preparing' || o.status === 'ready')
      );
      if (recoveryOrder && (machineState.status === 'preparing' || machineState.isDrinkReady) && !existingPrepared) {
        if (machineState.currentRecipeId) {
          processedRecoveryRecipes.add(machineState.currentRecipeId);
        }
        const recipe = useRecipeStore.getState().recipes.find((r) => r.id === recoveryOrder.recipe_id);
        const orderOptions: DrinkPreparationOptions = {
          iceCount: recoveryOrder.ice_count,
          alcoholOz: recoveryOrder.alcohol_oz,
          mixerOz: recoveryOrder.mixer_oz,
          piscolaIntensity: recoveryOrder.piscola_intensity,
        };
        if (recipe && useInventoryStore.getState().recipeIsAvailable(recipe, orderOptions)) {
          await useInventoryStore.getState().consumeForRecipe(recipe, orderOptions);
        }

        if (machineState.isDrinkReady) {
          // Machine already finished — bind the order directly as 'ready' so the
          // waiter can confirm delivery manually.
          console.warn(`${TAG} Recovery: binding queued order ${recoveryOrder.id} directly as ready (isDrinkReady=true).`);
          const boundOrder: DrinkOrder = {
            ...recoveryOrder,
            status: 'ready',
            active_step_id: 'ready',
            is_drink_ready: true,
            started_at: Date.now(),
            finished_at: Date.now(),
            ready_since: Date.now(),
            completed_step_ids: machineState.completedStepIds ?? [],
            skipped_step_ids: machineState.skippedStepIds ?? recoveryOrder.skipped_step_ids,
          };
          await orderRepository.saveOrder(boundOrder);
          set((prevState) => ({
            orders: upsertOrder(prevState.orders, boundOrder),
            activeOrderId: boundOrder.id,
          }));
          publishOrdersUpdate(boundOrder.table_number, get().orders);
        } else {
          const boundOrder: DrinkOrder = {
            ...recoveryOrder,
            status: 'preparing',
            active_step_id: machineState.activeStepId ?? 'cup_dispenser',
            started_at: Date.now(),
          };
          await orderRepository.saveOrder(boundOrder);
          set((prevState) => ({
            orders: upsertOrder(prevState.orders, boundOrder),
            activeOrderId: boundOrder.id,
          }));
          publishOrdersUpdate(boundOrder.table_number, get().orders);
        }
        return;
      }

      if (machineState.currentRecipeId && !machineState.isDrinkReady && machineState.status === 'idle') {
        console.log(`${TAG} Ignoring residual ESP32 state with currentRecipeId=${machineState.currentRecipeId} - no matching queued orders`);
      }

      return;
    }

    const currentOrder = get().orders.find((order) => order.id === activeOrderId);
    if (!currentOrder) {
      set({ activeOrderId: null });
      return;
    }

    if (currentOrder.status === 'served') {
      if (machineState.status === 'idle' && !machineState.isDrinkReady) {
        set({ activeOrderId: null });
      }
      return;
    }

    let nextOrder = currentOrder;

    if (machineState.status === 'preparing') {
      nextOrder = {
        ...currentOrder,
        status: 'preparing',
        active_step_id: machineState.activeStepId,
        completed_step_ids: machineState.completedStepIds ?? [],
        skipped_step_ids: machineState.skippedStepIds ?? currentOrder.skipped_step_ids,
        is_drink_ready: false,
        started_at: currentOrder.started_at ?? Date.now(),
      };
    }

    if (machineState.isDrinkReady) {
      nextOrder = {
        ...currentOrder,
        status: 'ready',
        active_step_id: 'ready',
        completed_step_ids:
          machineState.completedStepIds?.length
            ? machineState.completedStepIds
            : currentOrder.completed_step_ids,
        skipped_step_ids: machineState.skippedStepIds ?? currentOrder.skipped_step_ids,
        is_drink_ready: true,
        finished_at: currentOrder.finished_at ?? Date.now(),
        ready_since: currentOrder.ready_since ?? Date.now(),
      };
    }

    const preparingDuration = Date.now() - (currentOrder.started_at ?? Date.now());
    const MIN_PREP_MS = 5000;

    const { connectionSnapshot } = useAppStore.getState();
    const isDeviceOnline = connectionSnapshot?.deviceOnline ?? false;
    const isActualActiveOrder = state.activeOrderId === currentOrder.id;

    if (
      isDeviceOnline &&
      isActualActiveOrder &&
      machineState.status === 'idle' &&
      !machineState.isDrinkReady &&
      currentOrder.status === 'preparing' &&
      !currentOrder.is_drink_ready &&
      preparingDuration > MIN_PREP_MS
    ) {
      console.warn(`${TAG} Preparación interrumpida o fallida tras ${preparingDuration}ms. Limpiando cola de comandos pendientes.`);
      commandQueueService.clear();
      nextOrder = {
        ...currentOrder,
        status: 'failed',
        active_step_id: undefined,
        finished_at: currentOrder.finished_at ?? Date.now(),
        ready_since: undefined,
      };
      
      // Restablecer los ingredientes al inventario porque la preparación falló
      try {
        const recipe = useRecipeStore.getState().recipes.find((r) => r.id === currentOrder.recipe_id);
        if (recipe) {
          await useInventoryStore.getState().restoreForRecipe(recipe, {
            iceCount: currentOrder.ice_count,
            alcoholOz: currentOrder.alcohol_oz,
            mixerOz: currentOrder.mixer_oz,
          });
        }
      } catch (e) {
        console.warn('[OrderStore] Failed to restore ingredients for failed order', e);
      }
    }

    // Bug 5 fix: Completely disable auto-served on machine idle, ensuring that
    // the waiter must explicitly mark the order as served in the app.

    if (!hasOrderChanged(currentOrder, nextOrder)) {
      if (machineState.status === 'idle' && !machineState.isDrinkReady) {
        const keepActive = (nextOrder.status === 'preparing' || nextOrder.status === 'ready') ? activeOrderId : null;
        set({ activeOrderId: keepActive });
        if (!keepActive) {
          const hasUnservedReadyOrder = get().orders.some((o) => o.status === 'ready' && !o.served_at);
          if (!hasUnservedReadyOrder) {
            await get().triggerNextQueuedOrder();
          }
        }
      }
      return;
    }

    await orderRepository.saveOrder(nextOrder);
    set((prevState) => ({
      orders: upsertOrder(prevState.orders, nextOrder),
      activeOrderId: (nextOrder.status === 'preparing' || nextOrder.status === 'ready') ? nextOrder.id : null,
    }));
    publishOrdersUpdate(nextOrder.table_number, get().orders);

    if (machineState.status === 'idle' && !machineState.isDrinkReady && nextOrder.status !== 'preparing' && nextOrder.status !== 'ready') {
      await get().triggerNextQueuedOrder();
    }
  },
  markOrderServed: async (orderId) => {
    const order = get().orders.find((entry) => entry.id === orderId);
    if (!order) {
      return;
    }

    const nextOrder: DrinkOrder = {
      ...order,
      status: 'served',
      served_at: Date.now(),
      ready_since: undefined,
    };

    await orderRepository.saveOrder(nextOrder);
    set((state) => ({
      orders: upsertOrder(state.orders, nextOrder),
    }));
    publishOrdersUpdate(order.table_number, get().orders);

    const { machineState } = useAppStore.getState();
    if (machineState.status !== 'preparing') {
      await commandQueueService.enqueue({
        cmd: 'TAKEN',
        val: '',
        target: 'kraken',
      });
    } else {
      console.log(`${TAG} markOrderServed: skipping TAKEN because machine is already preparing next order.`);
    }

    await get().triggerNextQueuedOrder();
  },
  deleteOrder: async (orderId) => {
    const order = get().orders.find((entry) => entry.id === orderId);
    if (!order) {
      return null;
    }

    const { isConnected } = useAppStore.getState();
    if (order.status === 'preparing' && isConnected) {
      return null;
    }

    if (order.id === get().activeOrderId || order.status === 'queued') {
      commandQueueService.clear();
    }
    await orderRepository.deleteOrder(orderId);
    set((state) => ({
      orders: state.orders.filter((entry) => entry.id !== orderId),
      activeOrderId: state.activeOrderId === orderId ? null : state.activeOrderId,
    }));
    publishOrdersUpdate(order.table_number, get().orders);

    if (order.status === 'preparing' || order.status === 'ready') {
      try {
        const recipe = useRecipeStore.getState().recipes.find((r) => r.id === order.recipe_id);
        if (recipe) {
          await useInventoryStore.getState().restoreForRecipe(recipe, {
            iceCount: order.ice_count,
            alcoholOz: order.alcohol_oz,
            mixerOz: order.mixer_oz,
          });
        }
      } catch (e) {
        console.warn(`${TAG} Failed to restore ingredients for deleted order`, e);
      }
    }

    await get().triggerNextQueuedOrder();
    return order;
  },
  clearTableOrders: async (tableNumber) => {
    commandQueueService.clear();
    await orderRepository.deleteOrdersForTable(tableNumber);
    set((prevState) => ({
      orders: prevState.orders.filter(
        (order) => order.table_number !== tableNumber || order.status === 'served'
      ),
      activeOrderId:
        prevState.orders.find((order) => order.id === prevState.activeOrderId)?.table_number === tableNumber
          ? null
          : prevState.activeOrderId,
    }));
    publishOrdersUpdate(tableNumber, []);
  },
  syncOrdersFromNetwork: async (tableNumber, nextOrders) => {
    // Re-validacion defensiva por si se invoca directamente sin pasar por el parser del hook.
    const safeOrders = parseDrinkOrderArray(nextOrders as unknown, tableNumber);

    const currentTableOrders = get().orders.filter((o) => o.table_number === tableNumber);
    const nextIds = new Set(safeOrders.map((o) => o.id));
    for (const old of currentTableOrders) {
      if (!nextIds.has(old.id)) {
        await orderRepository.deleteOrder(old.id);
      }
    }

    for (const order of safeOrders) {
      const existing = currentTableOrders.find((o) => o.id === order.id);
      if (existing && !hasOrderChanged(existing, order)) {
        continue;
      }
      if (existing && (STATUS_PRIORITY[existing.status] ?? -1) > (STATUS_PRIORITY[order.status] ?? -1)) {
        continue;
      }
      await orderRepository.saveOrder(order);
    }

    if (safeOrders.length === 0) {
      const hasActiveOrders = currentTableOrders.some(
        (o) => o.status === 'preparing' || o.status === 'ready' || o.status === 'queued'
      );
      if (!hasActiveOrders) {
        await orderRepository.deleteOrdersForTable(tableNumber);
      } else {
        console.warn(`${TAG} Received empty orders for table ${tableNumber} but local has active orders. Ignoring destructive wipe.`);
      }
    }

    const localOthers = get().orders.filter((o) => o.table_number !== tableNumber);
    const localTable = get().orders.filter((o) => o.table_number === tableNumber);
    const mergedTable = safeOrders.map((netOrder) => {
      const local = localTable.find((o) => o.id === netOrder.id);
      if (local && (STATUS_PRIORITY[local.status] ?? -1) > (STATUS_PRIORITY[netOrder.status] ?? -1)) {
        return local;
      }
      return netOrder;
    });
    const updatedList = sortOrders([...localOthers, ...mergedTable]);
    const activeOrder = updatedList.find((order) => order.status === 'preparing' || order.status === 'ready') ?? null;

    set({
      orders: updatedList,
      activeOrderId: activeOrder?.id ?? null,
    });
  },
}));
