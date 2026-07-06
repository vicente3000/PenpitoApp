/**
 * OrderStoreV2 — Proyección pura de los snapshots autoritativos del
 * Order Controller.
 *
 * Reglas:
 *  - La cola no se calcula aquí. Se recibe vía `controller/table/{N}/queue`.
 *  - El estado del hardware se recibe vía `controller/hardware/state` (retained).
 *  - El OrderStore es la ÚNICA proyección autorizada por la UI.
 *  - Cualquier mutación (submit, cancel, serve) se hace PUBLICANDO
 *    `mobile/...` y esperando el evento del controller.
 *  - No hay mutex de JavaScript. La concurrencia es el problema del controller.
 *
 * Por compat temporal, este store coexiste con el OrderStore legacy.
 * La migración de pantallas se hace incremental.
 */

import { create } from 'zustand';

import { ConnectionSnapshot } from '../adapters/ICommunicationAdapter';
import { DrinkOrder, DrinkOrderStatus, PreparationStepId } from '../models';
import { getSkippedSteps } from '../utils/preparation';
import { PenpitoAppMqttAdapter } from '../adapters/PenpitoAppMqttAdapter';
import {
  HardwareState,
  OrderEvent,
  OrderState,
  PROTOCOL_VERSION,
  QueueSnapshot,
} from '../protocol/types';
import { makeOrderEnvelope } from '../protocol/types';

export interface OrderStoreV2State {
  /** Snapshot autoritativo por mesa. */
  snapshots: Map<number, QueueSnapshot>;
  /** Estado autoritativo del hardware. */
  hardware: HardwareState | null;
  /** Eventos observados por orderId, para UI reactiva. */
  recentEvents: Map<string, OrderEvent>;
  /** Inicializado: el primer snapshot llegó o la reconexión terminó. */
  hasInitialSnapshot: Map<number, boolean>;
  isConnected: boolean;
  connectionSnapshot: ConnectionSnapshot | null;
  error: string | null;
  /** Acciones de UI. */
  submitOrder: (input: {
    tableId: number;
    recipeId: string;
    guestName?: string;
    groupId?: string;
    options: { iceCount: number; alcoholOz?: number; mixerOz?: number; piscolaIntensity?: 'suave' | 'normal' | 'fuerte' };
  }) => Promise<{ orderId: string; commandId: string }>;
  cancelOrder: (tableId: number, orderId: string) => Promise<void>;
  serveOrder: (tableId: number, orderId: string) => Promise<void>;
  requestSnapshot: (tableId: number) => void;
}

function mapStateToStatus(state: OrderState): DrinkOrderStatus {
  switch (state) {
    case 'queued':
    case 'dispatching':
    case 'accepted':
      return 'queued';
    case 'preparing':
      return 'preparing';
    case 'ready':
      return 'ready';
    case 'served':
      return 'served';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

const projectionCache = new WeakMap<QueueSnapshot, DrinkOrder[]>();

const PREPARATION_STEP_IDS = new Set<PreparationStepId>([
  'cup_dispenser',
  'ice_dispenser',
  'alcohol_dispenser',
  'agitation_system',
  'carbonated_station',
  'ready',
]);

function toPreparationStepId(value: string | null | undefined): PreparationStepId | undefined {
  return value && PREPARATION_STEP_IDS.has(value as PreparationStepId)
    ? (value as PreparationStepId)
    : undefined;
}

function toPreparationStepIds(values: readonly string[] | undefined): PreparationStepId[] {
  if (!values) return [];
  const out: PreparationStepId[] = [];
  for (const value of values) {
    const step = toPreparationStepId(value);
    if (step && !out.includes(step)) out.push(step);
  }
  return out;
}

function snapshotToDrinkOrders(
  snap: QueueSnapshot,
  hardware?: HardwareState | null,
  recentEvents?: Map<string, OrderEvent>
): DrinkOrder[] {
  if (!hardware && !recentEvents) {
    const cached = projectionCache.get(snap);
    if (cached) return cached;
  }

  const result: DrinkOrder[] = [];
  for (const entry of snap.orders) {
    const event = recentEvents?.get(entry.orderId);
    const isHardwareOrder = hardware?.activeOrderId === entry.orderId;
    const eventActiveStepId = toPreparationStepId(event?.activeStepId);
    const hardwareActiveStepId = isHardwareOrder
      ? toPreparationStepId(hardware?.activeStepId)
      : undefined;
    const activeStepId = hardwareActiveStepId ?? eventActiveStepId;
    const defaultSkipped = getSkippedSteps(entry.recipeId, entry.options.iceCount);
    const completedStepIds = isHardwareOrder
      ? toPreparationStepIds(hardware?.completedStepIds)
      : toPreparationStepIds(event?.completedStepIds);
    const skippedStepIds = isHardwareOrder
      ? toPreparationStepIds(hardware?.skippedStepIds)
      : toPreparationStepIds(event?.skippedStepIds);
    const statusFromSnapshot = mapStateToStatus(entry.state);
    const status = isHardwareOrder && hardware?.isDrinkReady
      ? 'ready'
      : isHardwareOrder && hardware?.status === 'preparing'
        ? 'preparing'
        : statusFromSnapshot;

    result.push({
      id: entry.orderId,
      recipe_id: entry.recipeId,
      recipe_name: entry.recipeId,
      table_number: snap.tableId,
      qr_value: '',
      requested_at: entry.requestedAt,
      status,
      ice_count: entry.options.iceCount,
      alcohol_oz: entry.options.alcoholOz,
      mixer_oz: entry.options.mixerOz,
      piscola_intensity: entry.options.piscolaIntensity,
      est_time_seconds: 0,
      active_step_id: activeStepId,
      completed_step_ids: completedStepIds,
      skipped_step_ids: skippedStepIds.length ? skippedStepIds : defaultSkipped,
      is_drink_ready: status === 'ready',
      queued_at: entry.requestedAt,
      started_at: status === 'preparing' ? (hardware?.startedAt ?? event?.timestamp) : undefined,
      finished_at: status === 'ready' ? event?.timestamp : undefined,
      guest_name: entry.guestName,
      group_id: entry.groupId,
    });
  }
  if (!hardware && !recentEvents) projectionCache.set(snap, result);
  return result;
}

function generateId(): string {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateCommandId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface OrderStoreV2Disposable {
  dispose(): void;
}

/**
 * Crea un store v2 con cleanup explícito.
 * Los listeners del adapter se desregistran en `dispose()` para evitar
 * memory leaks tras logout, hot reload, o reset de singleton en tests.
 */
export function createOrderStoreV2(adapter: PenpitoAppMqttAdapter): OrderStoreV2 {
  const unsubscribers: Array<() => void> = [];

  const store = create<OrderStoreV2State>((set, get) => {
    unsubscribers.push(
      adapter.onQueueSnapshot((snapshot) => {
        set((state) => {
          const next = new Map(state.snapshots);
          next.set(snapshot.tableId, snapshot);
          const ready = new Map(state.hasInitialSnapshot);
          ready.set(snapshot.tableId, true);
          return { snapshots: next, hasInitialSnapshot: ready };
        });
      })
    );

    unsubscribers.push(
      adapter.onOrderEvent((event) => {
        set((state) => {
          const next = new Map(state.recentEvents);
          next.set(event.orderId, event);
          return { recentEvents: next };
        });
      })
    );

    unsubscribers.push(
      adapter.onHardwareAuthoritativeState((hardware) => {
        set({ hardware });
      })
    );

    unsubscribers.push(
      adapter.onConnectionChange((snap) => {
        set({
          connectionSnapshot: snap,
          isConnected: snap.broker === 'connected' && snap.deviceOnline,
        });
      })
    );

    return {
      snapshots: new Map(),
      hardware: null,
      recentEvents: new Map(),
      hasInitialSnapshot: new Map(),
      isConnected: false,
      connectionSnapshot: null,
      error: null,
      async submitOrder(input) {
        const orderId = generateId();
        const commandId = generateCommandId();
        const envelope = makeOrderEnvelope({
          orderId,
          tableId: input.tableId,
          commandId,
          recipeId: input.recipeId,
          guestName: input.guestName,
          groupId: input.groupId,
          options: input.options,
        });
        try {
          await adapter.submitOrder(envelope);
          return { orderId, commandId };
        } catch (err) {
          set({ error: String(err) });
          throw err;
        }
      },
      async cancelOrder(tableId, orderId) {
        try {
          await adapter.cancelOrder(tableId, orderId);
        } catch (err) {
          set({ error: String(err) });
          throw err;
        }
      },
      async serveOrder(tableId, orderId) {
        try {
          await adapter.markOrderServed(tableId, orderId);
        } catch (err) {
          set({ error: String(err) });
          throw err;
        }
      },
      requestSnapshot(tableId) {
        adapter.requestQueueSnapshot(tableId);
      },
    };
  });

  (store as any).__dispose = () => {
    while (unsubscribers.length) {
      const u = unsubscribers.pop();
      try { u?.(); } catch { /* ignore */ }
    }
  };
  return store as unknown as OrderStoreV2;
}

import type { StoreApi, UseBoundStore } from 'zustand';

export type OrderStoreV2 = UseBoundStore<StoreApi<OrderStoreV2State>> & {
  __dispose?: () => void;
};

export function projectOrdersForTable(
  snapshots: Map<number, QueueSnapshot>,
  tableId: number,
  hardware?: HardwareState | null,
  recentEvents?: Map<string, OrderEvent>
): DrinkOrder[] {
  const snap = snapshots.get(tableId);
  if (!snap) return [];
  return snapshotToDrinkOrders(snap, hardware, recentEvents);
}

export { mapStateToStatus, snapshotToDrinkOrders };
