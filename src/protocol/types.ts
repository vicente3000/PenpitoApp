/**
 * Tipos compartidos del protocolo MQTT v2.
 *
 * Fuente única de verdad consumida por:
 *  - App móvil (React Native)  →  src/protocol/*
 *  - Order Controller (Node)  →  server/src/protocol.ts (re-exports)
 *  - Simulador (Node)         →  dev/esp_simulator_v2.js (require con require() de un .json mirror)
 *  - Firmware ESP32 (C++)     →  espejo manual mantenido en Kraken/src/protocol_v2.h
 *
 * Cualquier cambio aquí debe reflejarse en el resto.
 */

export const PROTOCOL_VERSION = 2 as const;

export type OrderState =
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'failed';

export type HardwareStatus = 'idle' | 'preparing' | 'cleaning' | 'error';

export type OrderFailureCode =
  | 'inventory_shortage'
  | 'machine_offline'
  | 'machine_busy'
  | 'machine_rejected'
  | 'timeout_no_progress'
  | 'timeout_preparation_start'
  | 'home_failed'
  | 'mechanical_error'
  | 'emergency_stop'
  | 'unknown';

export interface OrderOptions {
  iceCount: number;
  alcoholOz?: number;
  mixerOz?: number;
  piscolaIntensity?: 'suave' | 'normal' | 'fuerte';
}

export interface OrderEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  orderId: string;
  tableId: number;
  commandId: string;
  guestName?: string;
  groupId?: string;
  recipeId: string;
  requestedAt: number;
  options: OrderOptions;
}

export type OrderEventType =
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'HARDWARE_ACCEPTED'
  | 'PREPARATION_STARTED'
  | 'PREPARATION_PROGRESS'
  | 'PREPARATION_COMPLETED'
  | 'PREPARATION_FAILED'
  | 'ORDER_SERVED'
  | 'ORDER_RELEASED';

export interface OrderEvent {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: OrderEventType;
  orderId: string;
  tableId: number;
  commandId: string;
  sequence: number;
  timestamp: number;
  reason?: string;
  failureCode?: OrderFailureCode;
  activeStepId?: string;
  completedStepIds?: string[];
  skippedStepIds?: string[];
}

export interface QueueSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  tableId: number;
  orders: Array<
    Pick<
      OrderEnvelope,
      'orderId' | 'recipeId' | 'requestedAt' | 'guestName' | 'groupId' | 'options'
    > & { state: OrderState; commandId: string }
  >;
  activeOrder: OrderEnvelope | null;
  generatedAt: number;
}

export interface HardwareState {
  protocolVersion: typeof PROTOCOL_VERSION;
  bootId: string;
  isOn: boolean;
  status: HardwareStatus;
  activeOrderId: string | null;
  activeTableId: number | null;
  activeCommandId: string | null;
  stateSequence: number;
  activeStepId: string | null;
  completedStepIds: string[];
  skippedStepIds: string[];
  isDrinkReady: boolean;
  errorMessage: string | null;
  startedAt: number | null;
  uptimeMs: number;
}

export interface CommandEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  type:
    | 'PREPARE'
    | 'TAKEN'
    | 'POWER'
    | 'CLEAN'
    | 'SET_CALIB'
    | 'CONFIG_WIFI'
    | 'TEST_HW'
    | 'EMERGENCY_STOP';
  orderId?: string;
  tableId?: number;
  payload?: Record<string, unknown>;
  issuedAt: number;
  issuedBy: 'mobile' | 'controller';
}

export interface CommandAck {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  accepted: boolean;
  reason?: string;
  failureCode?: OrderFailureCode;
  activeOrderId?: string | null;
  activeTableId?: number | null;
  timestamp: number;
}

export function isProtocolV2(value: unknown): value is { protocolVersion: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { protocolVersion?: unknown }).protocolVersion === PROTOCOL_VERSION
  );
}

export function makeOrderEnvelope(input: {
  orderId: string;
  tableId: number;
  commandId: string;
  recipeId: string;
  guestName?: string;
  groupId?: string;
  options: OrderOptions;
  requestedAt?: number;
}): OrderEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    orderId: input.orderId,
    tableId: input.tableId,
    commandId: input.commandId,
    recipeId: input.recipeId,
    guestName: input.guestName,
    groupId: input.groupId,
    options: input.options,
    requestedAt: input.requestedAt ?? Date.now(),
  };
}

export function makeOrderEvent(input: {
  type: OrderEventType;
  orderId: string;
  tableId: number;
  commandId: string;
  sequence: number;
  reason?: string;
  failureCode?: OrderFailureCode;
  activeStepId?: string;
  completedStepIds?: string[];
  skippedStepIds?: string[];
}): OrderEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: input.type,
    orderId: input.orderId,
    tableId: input.tableId,
    commandId: input.commandId,
    sequence: input.sequence,
    timestamp: Date.now(),
    reason: input.reason,
    failureCode: input.failureCode,
    activeStepId: input.activeStepId,
    completedStepIds: input.completedStepIds,
    skippedStepIds: input.skippedStepIds,
  };
}

export function makeCommandEnvelope(input: {
  commandId: string;
  type: CommandEnvelope['type'];
  orderId?: string;
  tableId?: number;
  payload?: Record<string, unknown>;
  issuedBy: CommandEnvelope['issuedBy'];
}): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: input.commandId,
    type: input.type,
    orderId: input.orderId,
    tableId: input.tableId,
    payload: input.payload,
    issuedAt: Date.now(),
    issuedBy: input.issuedBy,
  };
}

export function makeCommandAck(input: {
  commandId: string;
  accepted: boolean;
  reason?: string;
  failureCode?: OrderFailureCode;
  activeOrderId?: string | null;
  activeTableId?: number | null;
  timestamp?: number;
}): CommandAck {
  const out: CommandAck = {
    protocolVersion: PROTOCOL_VERSION,
    commandId: input.commandId,
    accepted: input.accepted,
    timestamp: input.timestamp ?? Date.now(),
  };
  if (input.reason) out.reason = input.reason;
  if (input.failureCode) out.failureCode = input.failureCode;
  if (input.activeOrderId !== undefined) out.activeOrderId = input.activeOrderId;
  if (input.activeTableId !== undefined) out.activeTableId = input.activeTableId;
  return out;
}
