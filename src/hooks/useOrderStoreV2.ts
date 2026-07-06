/**
 * Hooks que conectan los stores v2 con componentes React.
 *
 * Responsabilidades:
 *  - useOrderStoreV2(): acceso al store singleton creado en AppBootstrap.
 *  - useTableOrders(tableId): suscripción reactiva a los pedidos de UNA mesa.
 *  - useAllTables(): suscripción reactiva a TODAS las mesas.
 *  - useOrderActions(): acciones para submitir/cancelar/servir.
 *  - useControllerHardware(): snapshot autoritativo del hardware.
 *  - useControllerConnection(): estado de conexión.
 *
 * El OrderStoreV2 es el ÚNICO responsable de la cola.
 * La UI no llama a commandQueueService ni a deviceService.sendCommand.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DrinkOrder, DrinkOrderStatus } from '../models';
import {
  createOrderStoreV2,
  OrderStoreV2,
  OrderStoreV2State,
  projectOrdersForTable,
} from '../stores/OrderStoreV2';
import {
  ConnectionSnapshot,
} from '../adapters/ICommunicationAdapter';
import { deviceService } from '../services/DeviceService';
import { HardwareState, OrderOptions, QueueSnapshot } from '../protocol/types';

let _store: OrderStoreV2 | null = null;

const DISCONNECTED_CONNECTION_SNAPSHOT: ConnectionSnapshot = {
  broker: 'disconnected',
  deviceOnline: false,
  lastDeviceMessageAt: null,
  error: 'no_connection_snapshot',
};

export function getOrCreateOrderStoreV2(): OrderStoreV2 {
  if (_store) return _store;
  _store = createOrderStoreV2(deviceService.penpitoAdapter);
  return _store;
}

/**
 * Resetea el singleton del store. Usar en logout, reset de app, o entre tests.
 * Libera los listeners del adapter para no dejar zombies tras hot reload.
 */
export function resetOrderStoreV2(): void {
  if (_store && typeof ( _store as any).__dispose === 'function') {
    (_store as any).__dispose();
  }
  _store = null;
}

function useStoreSelector<T>(selector: (s: OrderStoreV2State) => T, equalityFn?: (a: T, b: T) => boolean): T {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  // useSyncExternalStore: si no pasamos equalityFn, el default es === (referencia).
  // Para snapshots (Map) y recentEvents (Map) y hardware (objeto nuevo por set),
  // el cambio de referencia en cada `set` causa re-render aunque el contenido sea idéntico.
  // Usamos un cache local con shallow compare cuando no se provee equalityFn.
  const ref = useRef<{ value: T; selected: ReturnType<typeof selector> } | null>(null);
  const getSnapshot = useMemo(
    () => () => {
      const next = selector(store.getState());
      const prev = ref.current;
      if (prev && (equalityFn ? equalityFn(prev.value, next) : prev.value === next)) {
        return prev.value;
      }
      ref.current = { value: next, selected: next };
      return next;
    },
    [store, selector, equalityFn]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOrderStoreV2(): OrderStoreV2 {
  return getOrCreateOrderStoreV2();
}

export function useTableOrders(tableId: number): DrinkOrder[] {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  // Cache estable: el array de DrinkOrder[] cambia de referencia en cada snapshot,
  // pero solo re-renderizamos si el contenido realmente cambió.
  const ref = useRef<{
    orders: DrinkOrder[];
    snap: QueueSnapshot | undefined;
    hardware: OrderStoreV2State['hardware'];
    recentEvents: OrderStoreV2State['recentEvents'];
  } | null>(null);
  const getSnapshot = useMemo(
    () => () => {
      const state = store.getState();
      const snap = state.snapshots.get(tableId);
      const prev = ref.current;
      if (
        prev &&
        prev.snap === snap &&
        prev.hardware === state.hardware &&
        prev.recentEvents === state.recentEvents
      ) {
        return prev.orders;
      }
      const next = projectOrdersForTable(state.snapshots, tableId, state.hardware, state.recentEvents);
      // Comparación shallow: si el número y orden de orders no cambió, reusar.
      if (prev && prev.orders.length === next.length) {
        let same = true;
        for (let i = 0; i < next.length; i++) {
          if (prev.orders[i] !== next[i]) { same = false; break; }
        }
        if (same) {
          ref.current = {
            orders: prev.orders,
            snap,
            hardware: state.hardware,
            recentEvents: state.recentEvents,
          };
          return prev.orders;
        }
      }
      ref.current = {
        orders: next,
        snap,
        hardware: state.hardware,
        recentEvents: state.recentEvents,
      };
      return next;
    },
    [store, tableId]
  );
  const orders = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Snapshot request SOLO al montar o al cambiar tableId, no en cada render.
  useEffect(() => {
    if (Number.isFinite(tableId) && tableId > 0) {
      store.getState().requestSnapshot(tableId);
    }
  }, [store, tableId]);
  return orders;
}

export function useAllTables(): Map<number, DrinkOrder[]> {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  const ref = useRef<{
    snapshots: Map<number, QueueSnapshot>;
    hardware: OrderStoreV2State['hardware'];
    recentEvents: OrderStoreV2State['recentEvents'];
    map: Map<number, DrinkOrder[]>;
  } | null>(null);
  const getSnapshot = useMemo(
    () => () => {
      const state = store.getState();
      const prev = ref.current;
      if (
        prev &&
        prev.snapshots === state.snapshots &&
        prev.hardware === state.hardware &&
        prev.recentEvents === state.recentEvents
      ) {
        return prev.map;
      }
      const next = new Map<number, DrinkOrder[]>();
      for (const [tableId, snap] of state.snapshots) {
        const projected = projectOrdersForTable(state.snapshots, tableId, state.hardware, state.recentEvents);
        if (projected.length > 0) next.set(tableId, projected);
      }
      // Shallow compare con cache: si mismo tamaño y mismas referencias, reusar.
      if (prev && prev.map.size === next.size) {
        let same = true;
        for (const [k, v] of next) {
          const pv = prev.map.get(k);
          if (!pv || pv !== v) { same = false; break; }
        }
        if (same) {
          ref.current = {
            snapshots: state.snapshots,
            hardware: state.hardware,
            recentEvents: state.recentEvents,
            map: prev.map,
          };
          return prev.map;
        }
      }
      ref.current = {
        snapshots: state.snapshots,
        hardware: state.hardware,
        recentEvents: state.recentEvents,
        map: next,
      };
      return next;
    },
    [store]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useControllerHardware(): HardwareState | null {
  return useStoreSelector((s) => s.hardware);
}

export function useControllerConnection(): {
  isConnected: boolean;
  snapshot: ConnectionSnapshot;
} {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  // isConnected: valor reactivo, suscrito al store, no leído de getState (stale).
  const isConnected = useSyncExternalStore(
    subscribe,
    () => store.getState().isConnected,
    () => false
  );
  const getSnapshot = useMemo(
    () => () => {
      const s = store.getState();
      if (s.connectionSnapshot) {
        return s.connectionSnapshot;
      }
      return DISCONNECTED_CONNECTION_SNAPSHOT;
    },
    [store]
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DISCONNECTED_CONNECTION_SNAPSHOT
  );
  return { isConnected, snapshot };
}

export function useRecentOrderEvent(orderId: string | null) {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  return useSyncExternalStore(
    subscribe,
    () => (orderId ? store.getState().recentEvents.get(orderId) ?? null : null),
    () => null
  );
}

export interface UseOrderActions {
  submitOrder: (input: {
    tableId: number;
    recipeId: string;
    guestName?: string;
    groupId?: string;
    options: OrderOptions;
  }) => Promise<{ orderId: string; commandId: string }>;
  cancelOrder: (tableId: number, orderId: string) => Promise<void>;
  serveOrder: (tableId: number, orderId: string) => Promise<void>;
  requestSnapshot: (tableId: number) => void;
}

export function useOrderActions(): UseOrderActions {
  const store = getOrCreateOrderStoreV2();
  return useMemo<UseOrderActions>(
    () => ({
      submitOrder: store.getState().submitOrder,
      cancelOrder: store.getState().cancelOrder,
      serveOrder: store.getState().serveOrder,
      requestSnapshot: store.getState().requestSnapshot,
    }),
    [store]
  );
}

export function useHasInitialSnapshot(tableId: number): boolean {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getState().hasInitialSnapshot.get(tableId) ?? false,
    () => false
  );
}

export function useOrderCounts(orders: DrinkOrder[]): {
  queued: number;
  preparing: number;
  ready: number;
  served: number;
  failed: number;
} {
  return useMemo(() => {
    const counts = { queued: 0, preparing: 0, ready: 0, served: 0, failed: 0 };
    for (const o of orders) {
      const k = o.status as DrinkOrderStatus;
      if (k in counts) counts[k] += 1;
    }
    return counts;
  }, [orders]);
}

/**
 * Dispara `requestSnapshot` cuando el store pasa a `isConnected=true`.
 * Idempotente: dedupea por transición, no por cada `set` del store.
 * Sin esto, cada `set` durante una reconexión dispara 1-10 publishes a MQTT.
 */
export function useRequestAllSnapshotsOnConnect(tableIds: number[], debounceMs = 250): void {
  const store = getOrCreateOrderStoreV2();
  const ids = useMemo(() => [...tableIds].sort((a, b) => a - b), [tableIds]);
  useEffect(() => {
    let lastConnected = store.getState().isConnected;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pending = null;
      if (store.getState().isConnected) {
        for (const t of ids) store.getState().requestSnapshot(t);
      }
    };
    const unsub = store.subscribe(() => {
      const now = store.getState().isConnected;
      if (now && !lastConnected) {
        if (pending) clearTimeout(pending);
        pending = setTimeout(flush, debounceMs);
      }
      lastConnected = now;
    });
    if (lastConnected) flush();
    return () => {
      unsub();
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    };
  }, [store, ids, debounceMs]);
}

export function useForceSnapshotOnConnect(debounceMs = 250): void {
  const store = getOrCreateOrderStoreV2();
  useEffect(() => {
    let lastConnected = store.getState().isConnected;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pending = null;
      if (store.getState().isConnected) {
        for (let t = 1; t <= 10; t++) store.getState().requestSnapshot(t);
      }
    };
    const unsub = store.subscribe(() => {
      const now = store.getState().isConnected;
      if (now && !lastConnected) {
        if (pending) clearTimeout(pending);
        pending = setTimeout(flush, debounceMs);
      }
      lastConnected = now;
    });
    if (lastConnected) flush();
    return () => {
      unsub();
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    };
  }, [store, debounceMs]);
}
