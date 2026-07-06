/**
 * Estado interno del Order Controller.
 *
 * Es la única fuente de verdad autoritativa. El store de Zustand de la app
 * es una PROYECCIÓN de este estado, alimentada por los snapshots
 * que el controller publica en MQTT.
 *
 * El estado en memoria se serializa a SQLite en cada transición.
 */

import type { OrderEnvelope, OrderState } from '../../src/protocol/types';

export interface ManagedOrder {
  envelope: OrderEnvelope;
  state: OrderState;
  sequence: number;
  failureCode?: string;
  reason?: string;
  acceptedAt?: number;
  dispatchedAt?: number;
  completedAt?: number;
  servedAt?: number;
  lastEventAt: number;
  retryCount: number;
  /** Snapshot autoritativo del hardware al momento de la última transición. */
  hardwareSnapshot?: {
    bootId: string;
    stateSequence: number;
    activeStepId: string | null;
    isDrinkReady: boolean;
    activeOrderId: string | null;
  };
}

export interface QueueEntry {
  tableId: number;
  orderId: string;
  commandId: string;
  enqueuedAt: number;
  state: 'queued' | 'dispatching';
  /** Lock FIFO: posición estable en la cola. */
  fifoKey: number;
  groupId?: string;
  guestName?: string;
}

export interface HardwareSnapshot {
  bootId: string;
  isOn: boolean;
  status: 'idle' | 'preparing' | 'cleaning' | 'error';
  activeOrderId: string | null;
  activeTableId: number | null;
  activeCommandId: string | null;
  stateSequence: number;
  isDrinkReady: boolean;
  activeStepId: string | null;
  completedStepIds: string[];
  skippedStepIds: string[];
  errorMessage: string | null;
  startedAt: number | null;
  lastSeenAt: number;
  uptimeMs: number;
}

export interface ControllerState {
  orders: Map<string, ManagedOrder>;
  /** Cola FIFO global. La clave es `${fifoKey}#${orderId}` para estabilidad. */
  queue: Map<string, QueueEntry>;
  hardware: HardwareSnapshot | null;
  /** Pedido que el controller ya envió al hardware pero aún no recibió COMPLETED/FAILED. */
  claimedOrderId: string | null;
  /** Próximo FIFO key. Monotónicamente creciente. */
  nextFifoKey: number;
  /** Próximo sequence de evento por pedido. */
  nextSequenceByOrder: Map<string, number>;
  /** Lock serial del dispatcher. */
  dispatchLocked: boolean;
  startedAt: number;
}

export function createInitialControllerState(now: number = Date.now()): ControllerState {
  return {
    orders: new Map(),
    queue: new Map(),
    hardware: null,
    claimedOrderId: null,
    nextFifoKey: 1,
    nextSequenceByOrder: new Map(),
    dispatchLocked: false,
    startedAt: now,
  };
}

export function queueKey(fifoKey: number, orderId: string): string {
  return `${fifoKey}#${orderId}`;
}

export function compareFifoEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.fifoKey !== b.fifoKey) return a.fifoKey - b.fifoKey;
  return a.orderId.localeCompare(b.orderId);
}

export function nextSequence(state: ControllerState, orderId: string): number {
  const current = state.nextSequenceByOrder.get(orderId) ?? 0;
  const next = current + 1;
  state.nextSequenceByOrder.set(orderId, next);
  return next;
}
