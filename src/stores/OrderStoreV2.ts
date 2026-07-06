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

import { DrinkOrder, DrinkOrderStatus, PreparationStepId } from '../models';
import { PenpitoAppMqttAdapter } from '../adapters/PenpitoAppMqttAdapter';
import {
  HardwareState,
  OrderEvent,
  OrderEventType,
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

function snapshotToDrinkOrders(snap: QueueSnapshot): DrinkOrder[] {
  const result: DrinkOrder[] = [];
  for (const entry of snap.orders) {
    result.push({
      id: entry.orderId,
      recipe_id: entry.recipeId,
      recipe_name: entry.recipeId,
      table_number: snap.tableId,
      qr_value: '',
      requested_at: entry.requestedAt,
      status: mapStateToStatus(entry.state),
      ice_count: entry.options.iceCount,
      alcohol_oz: entry.options.alcoholOz,
      mixer_oz: entry.options.mixerOz,
      piscola_intensity: entry.options.piscolaIntensity,
      est_time_seconds: 0,
      completed_step_ids: [],
      skipped_step_ids: [],
      is_drink_ready: entry.state === 'ready',
      queued_at: entry.requestedAt,
      guest_name: entry.guestName,
      group_id: entry.groupId,
    });
  }
  return result;
}

function generateId(): string {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateCommandId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createOrderStoreV2(adapter: PenpitoAppMqttAdapter) {
  return create<OrderStoreV2State>((set, get) => {
    const unsubQueue = adapter.onQueueSnapshot((snapshot) => {
      set((state) => {
        const next = new Map(state.snapshots);
        next.set(snapshot.tableId, snapshot);
        const ready = new Map(state.hasInitialSnapshot);
        ready.set(snapshot.tableId, true);
        return { snapshots: next, hasInitialSnapshot: ready };
      });
    });

    const unsubEvents = adapter.onOrderEvent((event) => {
      set((state) => {
        const next = new Map(state.recentEvents);
        next.set(event.orderId, event);
        return { recentEvents: next };
      });
    });

    const unsubHardware = adapter.onHardwareAuthoritativeState((hardware) => {
      set({ hardware });
    });

    const unsubConnection = adapter.onConnectionChange((snap) => {
      set({ isConnected: snap.broker === 'connected' && snap.deviceOnline });
    });

    return {
      snapshots: new Map(),
      hardware: null,
      recentEvents: new Map(),
      hasInitialSnapshot: new Map(),
      isConnected: false,
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
      _dispose() {
        unsubQueue();
        unsubEvents();
        unsubHardware();
        unsubConnection();
      },
    };
  });
}

export type OrderStoreV2 = ReturnType<typeof createOrderStoreV2>;

export function projectOrdersForTable(snapshots: Map<number, QueueSnapshot>, tableId: number): DrinkOrder[] {
  const snap = snapshots.get(tableId);
  if (!snap) return [];
  return snapshotToDrinkOrders(snap);
}

export { mapStateToStatus, snapshotToDrinkOrders };
