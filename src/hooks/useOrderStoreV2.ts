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

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
import { HardwareState } from '../protocol/types';
import { OrderOptions } from '../protocol/types';

let _store: OrderStoreV2 | null = null;

export function getOrCreateOrderStoreV2(): OrderStoreV2 {
  if (_store) return _store;
  _store = createOrderStoreV2(deviceService.penpitoAdapter);
  return _store;
}

function useStoreSelector<T>(selector: (s: OrderStoreV2State) => T, equalityFn?: (a: T, b: T) => boolean): T {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  return useSyncExternalStore(
    subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}

function shallowEqualArray<T>(a: T[], b: T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  const orders = useSyncExternalStore(
    subscribe,
    () => projectOrdersForTable(store.getState().snapshots, tableId),
    () => projectOrdersForTable(store.getState().snapshots, tableId)
  );
  useEffect(() => {
    store.getState().requestSnapshot(tableId);
  }, [store, tableId]);
  return orders;
}

export function useAllTables(): Map<number, DrinkOrder[]> {
  const store = getOrCreateOrderStoreV2();
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store]
  );
  const result = useSyncExternalStore(
    subscribe,
    () => {
      const out: Array<[number, DrinkOrder[]]> = [];
      const state = store.getState();
      for (const [tableId, _snap] of state.snapshots) {
        out.push([tableId, projectOrdersForTable(state.snapshots, tableId)]);
      }
      return out;
    },
    () => [] as Array<[number, DrinkOrder[]]>
  );
  return useMemo(() => {
    const map = new Map<number, DrinkOrder[]>();
    for (const [tableId, orders] of result) {
      if (orders.length > 0) map.set(tableId, orders);
    }
    return map;
  }, [result]);
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
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      const s = store.getState();
      return {
        broker: s.isConnected ? 'connected' : 'disconnected',
        deviceOnline: !!s.hardware?.isOn,
        lastDeviceMessageAt: null,
        error: null,
      } as ConnectionSnapshot;
    },
    () => ({
      broker: 'disconnected',
      deviceOnline: false,
      lastDeviceMessageAt: null,
      error: null,
    } as ConnectionSnapshot)
  );
  return { isConnected: store.getState().isConnected, snapshot };
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

export function useRequestAllSnapshotsOnConnect(tableIds: number[]): void {
  const store = getOrCreateOrderStoreV2();
  useEffect(() => {
    const unsub = store.subscribe(() => {
      if (store.getState().isConnected) {
        for (const t of tableIds) store.getState().requestSnapshot(t);
      }
    });
    if (store.getState().isConnected) {
      for (const t of tableIds) store.getState().requestSnapshot(t);
    }
    return () => unsub();
  }, [store, tableIds.join(',')]);
}

export function useForceSnapshotOnConnect(): void {
  const store = getOrCreateOrderStoreV2();
  useEffect(() => {
    const unsub = store.subscribe(() => {
      if (store.getState().isConnected) {
        for (let t = 1; t <= 10; t++) store.getState().requestSnapshot(t);
      }
    });
    if (store.getState().isConnected) {
      for (let t = 1; t <= 10; t++) store.getState().requestSnapshot(t);
    }
    return () => unsub();
  }, [store]);
}
