/**
 * Parsers estrictos para el protocolo v2.
 *
 * Cada parser:
 *  - Devuelve `null` / `[]` si el payload no cumple el shape.
 *  - No lanza excepciones; el caller descarta el mensaje.
 *  - Es seguro de importar desde el server (Node), la app (RN), y el simulador (Node).
 */

import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  HardwareStatus,
  OrderEnvelope,
  OrderEvent,
  OrderEventType,
  OrderFailureCode,
  OrderOptions,
  OrderState,
  PROTOCOL_VERSION,
  QueueSnapshot,
} from './types';

const VALID_HARDWARE_STATUS: readonly HardwareStatus[] = ['idle', 'preparing', 'cleaning', 'error'];
const VALID_ORDER_STATES: readonly OrderState[] = [
  'queued',
  'dispatching',
  'accepted',
  'preparing',
  'ready',
  'served',
  'failed',
];
const VALID_EVENT_TYPES: readonly OrderEventType[] = [
  'ORDER_ACCEPTED',
  'ORDER_REJECTED',
  'HARDWARE_ACCEPTED',
  'PREPARATION_STARTED',
  'PREPARATION_PROGRESS',
  'PREPARATION_COMPLETED',
  'PREPARATION_FAILED',
  'ORDER_SERVED',
  'ORDER_RELEASED',
];
const VALID_FAILURE_CODES: readonly OrderFailureCode[] = [
  'inventory_shortage',
  'machine_offline',
  'machine_busy',
  'machine_rejected',
  'timeout_no_progress',
  'timeout_preparation_start',
  'home_failed',
  'mechanical_error',
  'emergency_stop',
  'unknown',
];
const VALID_COMMAND_TYPES: readonly CommandEnvelope['type'][] = [
  'PREPARE',
  'TAKEN',
  'POWER',
  'CLEAN',
  'SET_CALIB',
  'CONFIG_WIFI',
  'TEST_HW',
  'EMERGENCY_STOP',
];
const VALID_ISSUED_BY: readonly CommandEnvelope['issuedBy'][] = ['mobile', 'controller'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeNumber(
  value: unknown,
  options: { min?: number; max?: number; integer?: boolean; fallback: number }
): number {
  let n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return options.fallback;
  if (options.integer) n = Math.trunc(n);
  if (typeof options.min === 'number' && n < options.min) n = options.min;
  if (typeof options.max === 'number' && n > options.max) n = options.max;
  return n;
}

function safeStringArray(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (item.length === 0 || item.length > 64) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function parseOrderEnvelope(raw: unknown): OrderEnvelope | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const orderId = safeString(raw.orderId);
  const tableId = safeNumber(raw.tableId, { min: 1, integer: true, fallback: 0 });
  const commandId = safeString(raw.commandId);
  const recipeId = safeString(raw.recipeId);
  const requestedAt = safeNumber(raw.requestedAt, { min: 0, integer: true, fallback: 0 });
  if (!orderId || !commandId || !recipeId || tableId <= 0 || requestedAt <= 0) return null;
  const optionsRaw = isPlainObject(raw.options) ? raw.options : {};
  const iceCount = safeNumber(optionsRaw.iceCount, { min: 0, max: 20, integer: true, fallback: 0 });
  const options: OrderOptions = { iceCount };
  if (typeof optionsRaw.alcoholOz === 'number' && Number.isFinite(optionsRaw.alcoholOz)) {
    options.alcoholOz = Math.max(0, optionsRaw.alcoholOz);
  }
  if (typeof optionsRaw.mixerOz === 'number' && Number.isFinite(optionsRaw.mixerOz)) {
    options.mixerOz = Math.max(0, optionsRaw.mixerOz);
  }
  if (optionsRaw.piscolaIntensity === 'suave' || optionsRaw.piscolaIntensity === 'normal' || optionsRaw.piscolaIntensity === 'fuerte') {
    options.piscolaIntensity = optionsRaw.piscolaIntensity;
  }
  const guestName = typeof raw.guestName === 'string' && raw.guestName.length > 0 ? raw.guestName : undefined;
  const groupId = typeof raw.groupId === 'string' && raw.groupId.length > 0 ? raw.groupId : undefined;
  return {
    protocolVersion: PROTOCOL_VERSION,
    orderId,
    tableId,
    commandId,
    recipeId,
    guestName,
    groupId,
    requestedAt,
    options,
  };
}

export function parseOrderEvent(raw: unknown): OrderEvent | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !VALID_EVENT_TYPES.includes(type as OrderEventType)) return null;
  const orderId = safeString(raw.orderId);
  const tableId = safeNumber(raw.tableId, { min: 1, integer: true, fallback: 0 });
  const commandId = safeString(raw.commandId);
  const sequence = safeNumber(raw.sequence, { min: 0, integer: true, fallback: 0 });
  const timestamp = safeNumber(raw.timestamp, { min: 0, integer: true, fallback: Date.now() });
  if (!orderId || !commandId || tableId <= 0) return null;
  let failureCode: OrderFailureCode | undefined;
  if (typeof raw.failureCode === 'string' && VALID_FAILURE_CODES.includes(raw.failureCode as OrderFailureCode)) {
    failureCode = raw.failureCode as OrderFailureCode;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: type as OrderEventType,
    orderId,
    tableId,
    commandId,
    sequence,
    timestamp,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    failureCode,
    activeStepId: typeof raw.activeStepId === 'string' ? raw.activeStepId : undefined,
    completedStepIds: safeStringArray(raw.completedStepIds),
    skippedStepIds: safeStringArray(raw.skippedStepIds),
  };
}

export function parseCommandEnvelope(raw: unknown): CommandEnvelope | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !VALID_COMMAND_TYPES.includes(type as CommandEnvelope['type'])) return null;
  const commandId = safeString(raw.commandId);
  const issuedBy = raw.issuedBy;
  if (typeof issuedBy !== 'string' || !VALID_ISSUED_BY.includes(issuedBy as CommandEnvelope['issuedBy'])) return null;
  const issuedAt = safeNumber(raw.issuedAt, { min: 0, integer: true, fallback: 0 });
  if (!commandId || issuedAt <= 0) return null;
  const out: CommandEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    type: type as CommandEnvelope['type'],
    issuedAt,
    issuedBy: issuedBy as CommandEnvelope['issuedBy'],
  };
  if (typeof raw.orderId === 'string' && raw.orderId.length > 0) out.orderId = raw.orderId;
  if (typeof raw.tableId === 'number' && Number.isFinite(raw.tableId) && raw.tableId > 0) {
    out.tableId = Math.trunc(raw.tableId);
  }
  if (isPlainObject(raw.payload)) {
    out.payload = raw.payload as Record<string, unknown>;
  }
  return out;
}

export function parseCommandAck(raw: unknown): CommandAck | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const commandId = safeString(raw.commandId);
  if (!commandId) return null;
  const accepted = raw.accepted === true;
  const timestamp = safeNumber(raw.timestamp, { min: 0, integer: true, fallback: Date.now() });
  let failureCode: OrderFailureCode | undefined;
  if (typeof raw.failureCode === 'string' && VALID_FAILURE_CODES.includes(raw.failureCode as OrderFailureCode)) {
    failureCode = raw.failureCode as OrderFailureCode;
  }
  const out: CommandAck = {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    accepted,
    timestamp,
  };
  if (typeof raw.reason === 'string') out.reason = raw.reason;
  if (failureCode) out.failureCode = failureCode;
  if (typeof raw.activeOrderId === 'string') out.activeOrderId = raw.activeOrderId;
  if (typeof raw.activeTableId === 'number' && Number.isFinite(raw.activeTableId)) {
    out.activeTableId = Math.trunc(raw.activeTableId);
  }
  return out;
}

export function parseHardwareState(raw: unknown): HardwareState | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const status = raw.status;
  if (typeof status !== 'string' || !VALID_HARDWARE_STATUS.includes(status as HardwareStatus)) return null;
  const bootId = safeString(raw.bootId);
  if (!bootId) return null;
  const activeOrderId =
    typeof raw.activeOrderId === 'string' && raw.activeOrderId.length > 0 ? raw.activeOrderId : null;
  const activeTableId =
    typeof raw.activeTableId === 'number' && Number.isFinite(raw.activeTableId) && raw.activeTableId > 0
      ? Math.trunc(raw.activeTableId)
      : null;
  const activeCommandId =
    typeof raw.activeCommandId === 'string' && raw.activeCommandId.length > 0 ? raw.activeCommandId : null;
  const stateSequence = safeNumber(raw.stateSequence, { min: 0, integer: true, fallback: 0 });
  const startedAt =
    typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? Math.trunc(raw.startedAt) : null;
  const uptimeMs = safeNumber(raw.uptimeMs, { min: 0, integer: true, fallback: 0 });
  return {
    protocolVersion: PROTOCOL_VERSION,
    bootId,
    isOn: raw.isOn === true,
    status: status as HardwareStatus,
    activeOrderId,
    activeTableId,
    activeCommandId,
    stateSequence,
    activeStepId:
      typeof raw.activeStepId === 'string' && raw.activeStepId.length > 0 ? raw.activeStepId : null,
    completedStepIds: safeStringArray(raw.completedStepIds),
    skippedStepIds: safeStringArray(raw.skippedStepIds),
    isDrinkReady: raw.isDrinkReady === true,
    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : null,
    startedAt,
    uptimeMs,
  };
}

export function parseQueueSnapshot(raw: unknown): QueueSnapshot | null {
  if (!isPlainObject(raw)) return null;
  if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
  const tableId = safeNumber(raw.tableId, { min: 1, integer: true, fallback: 0 });
  if (tableId <= 0) return null;
  const generatedAt = safeNumber(raw.generatedAt, { min: 0, integer: true, fallback: Date.now() });
  const orders: QueueSnapshot['orders'] = [];
  if (Array.isArray(raw.orders)) {
    for (const item of raw.orders) {
      if (!isPlainObject(item)) continue;
      const orderId = safeString(item.orderId);
      const commandId = safeString(item.commandId);
      const recipeId = safeString(item.recipeId);
      const requestedAt = safeNumber(item.requestedAt, { min: 0, integer: true, fallback: 0 });
      const state = item.state;
      if (
        !orderId ||
        !commandId ||
        !recipeId ||
        requestedAt <= 0 ||
        typeof state !== 'string' ||
        !VALID_ORDER_STATES.includes(state as OrderState)
      ) {
        continue;
      }
      const entry: QueueSnapshot['orders'][number] = {
        orderId,
        commandId,
        recipeId,
        requestedAt,
        state: state as OrderState,
        options: { iceCount: 0 },
      };
      if (typeof item.guestName === 'string') entry.guestName = item.guestName;
      if (typeof item.groupId === 'string') entry.groupId = item.groupId;
      if (isPlainObject(item.options)) {
        const opts = item.options;
        entry.options = {
          iceCount: safeNumber(opts.iceCount, { min: 0, max: 20, integer: true, fallback: 0 }),
        };
        if (typeof opts.alcoholOz === 'number' && Number.isFinite(opts.alcoholOz)) {
          entry.options.alcoholOz = Math.max(0, opts.alcoholOz);
        }
        if (typeof opts.mixerOz === 'number' && Number.isFinite(opts.mixerOz)) {
          entry.options.mixerOz = Math.max(0, opts.mixerOz);
        }
        if (opts.piscolaIntensity === 'suave' || opts.piscolaIntensity === 'normal' || opts.piscolaIntensity === 'fuerte') {
          entry.options.piscolaIntensity = opts.piscolaIntensity;
        }
      }
      orders.push(entry);
    }
  }
  const activeOrder = isPlainObject(raw.activeOrder) ? parseOrderEnvelope(raw.activeOrder) : null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    tableId,
    orders,
    activeOrder,
    generatedAt,
  };
}
