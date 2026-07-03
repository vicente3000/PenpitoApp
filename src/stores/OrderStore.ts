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
  return [...orders].sort((a, b) => b.requested_at - a.requested_at);
}

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
    JSON.stringify(current.completed_step_ids) !== JSON.stringify(next.completed_step_ids) ||
    JSON.stringify(current.skipped_step_ids) !== JSON.stringify(next.skipped_step_ids)
  );
}

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
      const activeOrder = orders.find((order) => order.status === 'preparing') ?? null;
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
    let buildIndex = 0;

    for (const item of items) {
      const quantity = Math.max(1, item.quantity ?? 1);

      for (let quantityIndex = 0; quantityIndex < quantity; quantityIndex += 1) {
        const now = Date.now() + buildIndex;
        const nextOrder: DrinkOrder = {
          id: buildOrderId(item.recipe.id, buildIndex),
          recipe_id: item.recipe.id,
          recipe_name: item.recipe.name,
          table_number,
          qr_value,
          requested_at: now,
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
          queued_at: now,
          started_at: undefined,
          finished_at: undefined,
          served_at: undefined,
          guest_name: item.guest_name,
          group_id: batchId,
          split_method,
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
    const { machineState, isConnected } = useAppStore.getState();
    const state = get();

    // No encolar el siguiente trago si la máquina no está ociosa, o si la bebida previa está lista esperando retiro
    if (!isConnected || machineState.status !== 'idle' || machineState.isDrinkReady) {
      return false;
    }

    // Tampoco encolar si hay algún trago en preparación o listo esperando ser retirado (marcado como servido)
    if (state.orders.some((order) => order.status === 'preparing' || order.status === 'ready')) {
      return false;
    }

    const nextQueued = sortOrders(state.orders)
      .filter((order) => order.status === 'queued')
      .sort((a, b) => (a.queued_at ?? a.requested_at) - (b.queued_at ?? b.requested_at))[0];

    if (!nextQueued) {
      return false;
    }

    const sessionStore = useSessionStore.getState();
    const tableSession = sessionStore.sessions.find((s) => s.table_number === nextQueued.table_number);
    const hasActiveSession = tableSession && tableSession.guests && tableSession.guests.length > 0;

    if (!hasActiveSession) {
      console.log(`[OrderStore] Deleting stale queued order ${nextQueued.id} for table ${nextQueued.table_number} because there is no active session`);
      await orderRepository.deleteOrder(nextQueued.id);
      set((prevState) => ({
        orders: prevState.orders.filter((o) => o.id !== nextQueued.id),
      }));
      publishOrdersUpdate(nextQueued.table_number, get().orders);
      
      // Devolver ingredientes
      try {
        const recipe = useRecipeStore.getState().recipes.find((r) => r.id === nextQueued.recipe_id);
        if (recipe) {
          await useInventoryStore.getState().restoreForRecipe(recipe, {
            iceCount: nextQueued.ice_count,
            alcoholOz: nextQueued.alcohol_oz,
            mixerOz: nextQueued.mixer_oz,
          });
        }
      } catch (e) {
        console.warn('[OrderStore] Failed to restore ingredients for stale order', e);
      }
      
      // Intentar procesar la siguiente orden de la cola
      return get().triggerNextQueuedOrder();
    }

    const startedOrder = await startPreparation(nextQueued);
    if (!startedOrder) {
      return false;
    }

    await orderRepository.saveOrder(startedOrder);
    set((prevState) => ({
      orders: upsertOrder(prevState.orders, startedOrder),
      activeOrderId: startedOrder.id,
    }));
    publishOrdersUpdate(nextQueued.table_number, get().orders);

    return true;
  },
  syncFromMachine: async (machineState) => {
    const state = get();
    const activeOrderId =
      state.activeOrderId ?? state.orders.find((order) => order.status === 'preparing')?.id ?? null;

    if (!activeOrderId) {
      if (machineState.status === 'idle' && !machineState.isDrinkReady) {
        await get().triggerNextQueuedOrder();
      }
      return;
    }

    const currentOrder = state.orders.find((order) => order.id === activeOrderId);
    if (!currentOrder) {
      set({ activeOrderId: null });
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
      };
    }

    if (
      machineState.status === 'idle' &&
      !machineState.isDrinkReady &&
      currentOrder.status === 'preparing' &&
      !currentOrder.is_drink_ready
    ) {
      nextOrder = {
        ...currentOrder,
        status: 'failed',
        active_step_id: undefined,
        finished_at: currentOrder.finished_at ?? Date.now(),
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

    if (!hasOrderChanged(currentOrder, nextOrder)) {
      if (machineState.status === 'idle' && !machineState.isDrinkReady) {
        const keepActive = nextOrder.status === 'preparing' ? activeOrderId : null;
        set({ activeOrderId: keepActive });
        if (!keepActive) {
          await get().triggerNextQueuedOrder();
        }
      }
      return;
    }

    await orderRepository.saveOrder(nextOrder);
    set((prevState) => ({
      orders: upsertOrder(prevState.orders, nextOrder),
      activeOrderId: nextOrder.status === 'preparing' ? nextOrder.id : null,
    }));
    publishOrdersUpdate(nextOrder.table_number, get().orders);

    if (machineState.status === 'idle' && !machineState.isDrinkReady && nextOrder.status !== 'preparing') {
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
    };

    await orderRepository.saveOrder(nextOrder);
    set((state) => ({
      orders: upsertOrder(state.orders, nextOrder),
      activeOrderId: state.activeOrderId === orderId ? null : state.activeOrderId,
    }));
    publishOrdersUpdate(order.table_number, get().orders);

    // Enviar comando al ESP32 para informarle que la bebida ya fue retirada de la bandeja
    await commandQueueService.enqueue({
      cmd: 'TAKEN',
      val: '',
      target: 'kraken',
    });
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

    await orderRepository.deleteOrder(orderId);
    set((state) => ({
      orders: state.orders.filter((entry) => entry.id !== orderId),
      activeOrderId: state.activeOrderId === orderId ? null : state.activeOrderId,
    }));
    publishOrdersUpdate(order.table_number, get().orders);

    // Restablecer ingredientes ya que la orden fue cancelada/eliminada
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
      console.warn('[OrderStore] Failed to restore ingredients for deleted order', e);
    }

    await get().triggerNextQueuedOrder();
    return order;
  },
  clearTableOrders: async (tableNumber) => {
    await orderRepository.deleteOrdersForTable(tableNumber);
    set((prevState) => ({
      orders: prevState.orders.filter((order) => order.table_number !== tableNumber),
      activeOrderId:
        prevState.orders.find((order) => order.id === prevState.activeOrderId)?.table_number === tableNumber
          ? null
          : prevState.activeOrderId,
    }));
    publishOrdersUpdate(tableNumber, []);
  },
  syncOrdersFromNetwork: async (tableNumber, nextOrders) => {
    for (const order of nextOrders) {
      await orderRepository.saveOrder(order);
    }

    if (nextOrders.length === 0) {
      await orderRepository.deleteOrdersForTable(tableNumber);
    }

    const localOthers = get().orders.filter((o) => o.table_number !== tableNumber);
    const updatedList = sortOrders([...localOthers, ...nextOrders]);
    const activeOrder = updatedList.find((order) => order.status === 'preparing') ?? null;

    set({
      orders: updatedList,
      activeOrderId: activeOrder?.id ?? null,
    });
  },
}));
