import {
  MachineState,
  PreparationStepId,
  DeviceCommand,
  TableSession,
  SessionGuest,
  DrinkOrder,
  BottleInventory,
  BillSplitMethod,
  DrinkOrderStatus,
} from '../models';

const VALID_STATUS = new Set<MachineState['status']>(['idle', 'preparing', 'cleaning', 'error']);
const VALID_STEPS: readonly PreparationStepId[] = [
  'cup_dispenser',
  'ice_dispenser',
  'alcohol_dispenser',
  'agitation_system',
  'carbonated_station',
  'ready',
];
const VALID_STEP_SET = new Set<string>(VALID_STEPS);
const VALID_DEVICE_TARGETS = new Set<NonNullable<DeviceCommand['target']>>(['pumps', 'motor', 'kraken']);
const VALID_SPLIT_METHODS = new Set<BillSplitMethod>(['pay_own', 'equal_split', 'host_pays']);
const VALID_ORDER_STATUS = new Set<DrinkOrderStatus>(['queued', 'preparing', 'ready', 'served', 'failed']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function safeNumber(
  value: unknown,
  options: { min?: number; max?: number; integer?: boolean; fallback: number }
): number {
  let n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return options.fallback;
  }
  if (options.integer) {
    n = Math.trunc(n);
  }
  if (typeof options.min === 'number' && n < options.min) {
    n = options.min;
  }
  if (typeof options.max === 'number' && n > options.max) {
    n = options.max;
  }
  return n;
}

function safeStepArray(value: unknown): PreparationStepId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PreparationStepId[] = [];
  const seen = new Set<PreparationStepId>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    if (!VALID_STEP_SET.has(item)) {
      continue;
    }
    const step = item as PreparationStepId;
    if (seen.has(step)) {
      continue;
    }
    seen.add(step);
    out.push(step);
  }
  return out;
}

function safeStatus(value: unknown, fallback: MachineState['status']): MachineState['status'] {
  if (typeof value === 'string' && VALID_STATUS.has(value as MachineState['status'])) {
    return value as MachineState['status'];
  }
  return fallback;
}

function safeStep(value: unknown): PreparationStepId | undefined {
  if (typeof value === 'string' && VALID_STEP_SET.has(value)) {
    return value as PreparationStepId;
  }
  return undefined;
}

export function parseMachineState(raw: unknown, fallback: MachineState): MachineState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...fallback };
  }
  const obj = raw as Record<string, unknown>;
  return {
    isOn: safeBool(obj.isOn, fallback.isOn),
    status: safeStatus(obj.status, fallback.status),
    errorMessage: typeof obj.errorMessage === 'string' ? obj.errorMessage : undefined,
    currentRecipeId: typeof obj.currentRecipeId === 'string' ? obj.currentRecipeId : undefined,
    requestedIceCount: safeNumber(obj.requestedIceCount, { min: 0, max: 20, integer: true, fallback: fallback.requestedIceCount ?? 0 }),
    activeStepId: safeStep(obj.activeStepId),
    completedStepIds: safeStepArray(obj.completedStepIds),
    skippedStepIds: safeStepArray(obj.skippedStepIds),
    isDrinkReady: safeBool(obj.isDrinkReady, fallback.isDrinkReady ?? false),
  };
}

export function parseAck(
  raw: unknown,
  fallback?: MachineState
): { requestId: string | null; ok: boolean; state: MachineState | null } {
  if (!isPlainObject(raw)) {
    return { requestId: null, ok: false, state: null };
  }
  const obj = raw as Record<string, unknown>;
  const requestId = typeof obj.requestId === 'string' && obj.requestId.length > 0 ? obj.requestId : null;
  const ok = obj.ok === true;
  let state: MachineState | null = null;
  if (isPlainObject(obj.state) && fallback) {
    state = parseMachineState(obj.state, fallback);
  }
  return { requestId, ok, state };
}

export function isValidDeviceTarget(value: unknown): value is NonNullable<DeviceCommand['target']> {
  return typeof value === 'string' && VALID_DEVICE_TARGETS.has(value as NonNullable<DeviceCommand['target']>);
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function safeRequestId(value: unknown, fallback: string): string {
  return isValidRequestId(value) ? (value as string) : fallback;
}

export function sanitizeCommand(command: DeviceCommand): DeviceCommand {
  return {
    ...command,
    cmd: safeString(command.cmd),
    val: safeString(command.val),
    requestId: isValidRequestId(command.requestId) ? command.requestId : undefined,
    target: isValidDeviceTarget(command.target) ? command.target : undefined,
    iceCount: typeof command.iceCount === 'number' ? Math.max(0, Math.min(20, Math.trunc(command.iceCount))) : undefined,
    alcoholOz: typeof command.alcoholOz === 'number' ? Math.max(0, command.alcoholOz) : undefined,
    mixerOz: typeof command.mixerOz === 'number' ? Math.max(0, command.mixerOz) : undefined,
    mqttPort: typeof command.mqttPort === 'number' ? Math.max(1, Math.min(65535, Math.trunc(command.mqttPort))) : undefined,
  };
}

function safeBillSplit(value: unknown): BillSplitMethod {
  return typeof value === 'string' && VALID_SPLIT_METHODS.has(value as BillSplitMethod)
    ? (value as BillSplitMethod)
    : 'pay_own';
}

function safeOrderStatus(value: unknown, fallback: DrinkOrderStatus): DrinkOrderStatus {
  return typeof value === 'string' && VALID_ORDER_STATUS.has(value as DrinkOrderStatus)
    ? (value as DrinkOrderStatus)
    : fallback;
}

// Validacion estricta de un invitado de sesion recibido por red.
export function parseSessionGuest(raw: unknown): SessionGuest | null {
  if (!isPlainObject(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  const name = typeof obj.name === 'string' ? obj.name : '';
  if (id.length === 0 || name.length === 0) return null;
  const joinedAt = safeNumber(obj.joined_at, { min: 0, integer: true, fallback: Date.now() });
  const deviceId = typeof obj.device_id === 'string' && obj.device_id.length > 0 ? obj.device_id : undefined;
  return { id, name, joined_at: joinedAt, device_id: deviceId };
}

// Validacion estricta de una sesion de mesa recibida por red.
// Devuelve null si el shape es invalido; el caller debe descartar el mensaje.
export function parseTableSession(raw: unknown, tableNumber: number): TableSession | null {
  if (!isPlainObject(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const sessionTableNumber = safeNumber(obj.table_number, {
    min: 1,
    integer: true,
    fallback: tableNumber,
  });
  if (sessionTableNumber !== tableNumber) return null;

  const qrValue = typeof obj.qr_value === 'string' ? obj.qr_value : '';
  if (qrValue.length === 0) return null;

  const guestsRaw = Array.isArray(obj.guests) ? obj.guests : [];
  const guests: SessionGuest[] = [];
  const seenGuestIds = new Set<string>();
  for (const item of guestsRaw) {
    const guest = parseSessionGuest(item);
    if (!guest || seenGuestIds.has(guest.id)) continue;
    seenGuestIds.add(guest.id);
    guests.push(guest);
  }

  const splitMethod = safeBillSplit(obj.split_method);
  const hostGuestId =
    typeof obj.host_guest_id === 'string' && obj.host_guest_id.length > 0 ? obj.host_guest_id : undefined;
  const tipPercentage = safeNumber(obj.tip_percentage, { min: 0, max: 100, integer: true, fallback: 0 });
  const billRequested = obj.bill_requested === true;

  return {
    table_number: sessionTableNumber,
    qr_value: qrValue,
    guests,
    split_method: splitMethod,
    host_guest_id: hostGuestId,
    tip_percentage: tipPercentage,
    bill_requested: billRequested,
  };
}

// Validacion estricta de una orden recibida por red.
export function parseDrinkOrder(raw: unknown, tableNumber: number): DrinkOrder | null {
  if (!isPlainObject(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id : '';
  const recipeId = typeof obj.recipe_id === 'string' ? obj.recipe_id : '';
  const recipeName = typeof obj.recipe_name === 'string' ? obj.recipe_name : '';
  if (id.length === 0 || recipeId.length === 0 || recipeName.length === 0) return null;

  const orderTableNumber = safeNumber(obj.table_number, { min: 1, integer: true, fallback: tableNumber });
  if (orderTableNumber !== tableNumber) return null;

  const qrValue = typeof obj.qr_value === 'string' ? obj.qr_value : '';
  const requestedAt = safeNumber(obj.requested_at, { min: 0, integer: true, fallback: Date.now() });
  const status = safeOrderStatus(obj.status, 'queued');
  const iceCount = safeNumber(obj.ice_count, { min: 0, max: 20, integer: true, fallback: 0 });
  const alcoholOz =
    typeof obj.alcohol_oz === 'number' && Number.isFinite(obj.alcohol_oz) ? Math.max(0, obj.alcohol_oz) : undefined;
  const mixerOz =
    typeof obj.mixer_oz === 'number' && Number.isFinite(obj.mixer_oz) ? Math.max(0, obj.mixer_oz) : undefined;
  const piscolaIntensity =
    typeof obj.piscola_intensity === 'string' &&
    ['suave', 'normal', 'fuerte'].includes(obj.piscola_intensity as string)
      ? (obj.piscola_intensity as DrinkOrder['piscola_intensity'])
      : undefined;
  const estTimeSeconds = safeNumber(obj.est_time_seconds, { min: 0, integer: true, fallback: 0 });
  const activeStepId = safeStep(obj.active_step_id);
  const completedStepIds = safeStepArray(obj.completed_step_ids);
  const skippedStepIds = safeStepArray(obj.skipped_step_ids);
  const isDrinkReady = safeBool(obj.is_drink_ready, false);
  const startedAt =
    typeof obj.started_at === 'number' && Number.isFinite(obj.started_at) ? obj.started_at : undefined;
  const finishedAt =
    typeof obj.finished_at === 'number' && Number.isFinite(obj.finished_at) ? obj.finished_at : undefined;
  const servedAt =
    typeof obj.served_at === 'number' && Number.isFinite(obj.served_at) ? obj.served_at : undefined;
  const queuedAt =
    typeof obj.queued_at === 'number' && Number.isFinite(obj.queued_at) ? obj.queued_at : undefined;
  const guestName = typeof obj.guest_name === 'string' && obj.guest_name.length > 0 ? obj.guest_name : undefined;
  const groupId = typeof obj.group_id === 'string' && obj.group_id.length > 0 ? obj.group_id : undefined;
  const splitMethod =
    typeof obj.split_method === 'string' && VALID_SPLIT_METHODS.has(obj.split_method as BillSplitMethod)
      ? (obj.split_method as BillSplitMethod)
      : undefined;
  const orderIndex =
    typeof obj.order_index === 'number' && Number.isFinite(obj.order_index) ? obj.order_index : undefined;
  const readySince =
    typeof obj.ready_since === 'number' && Number.isFinite(obj.ready_since) ? obj.ready_since : undefined;

  return {
    id,
    recipe_id: recipeId,
    recipe_name: recipeName,
    table_number: orderTableNumber,
    qr_value: qrValue,
    requested_at: requestedAt,
    status,
    ice_count: iceCount,
    alcohol_oz: alcoholOz,
    mixer_oz: mixerOz,
    piscola_intensity: piscolaIntensity,
    est_time_seconds: estTimeSeconds,
    active_step_id: activeStepId,
    completed_step_ids: completedStepIds,
    skipped_step_ids: skippedStepIds,
    is_drink_ready: isDrinkReady,
    started_at: startedAt,
    finished_at: finishedAt,
    served_at: servedAt,
    queued_at: queuedAt,
    guest_name: guestName,
    group_id: groupId,
    split_method: splitMethod,
    order_index: orderIndex,
    ready_since: readySince,
  };
}

// Validacion estricta de un arreglo de ordenes recibido por red.
// Descarta items invalidos sin abortar el resto del lote.
export function parseDrinkOrderArray(raw: unknown, tableNumber: number): DrinkOrder[] {
  if (!Array.isArray(raw)) return [];
  const out: DrinkOrder[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    const order = parseDrinkOrder(item, tableNumber);
    if (!order || seenIds.has(order.id)) continue;
    seenIds.add(order.id);
    out.push(order);
  }
  return out;
}

// Validacion estricta de un arreglo de botellas de inventario recibido por red.
export function parseBottleInventoryArray(raw: unknown): BottleInventory[] {
  if (!Array.isArray(raw)) return [];
  const out: BottleInventory[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : '';
    const ingredientName = typeof obj.ingredient_name === 'string' ? obj.ingredient_name : '';
    const displayName = typeof obj.display_name === 'string' ? obj.display_name : '';
    if (id.length === 0 || ingredientName.length === 0 || displayName.length === 0) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    out.push({
      id,
      ingredient_name: ingredientName,
      display_name: displayName,
      capacity_ml: safeNumber(obj.capacity_ml, { min: 0, fallback: 0 }),
      remaining_ml: safeNumber(obj.remaining_ml, { min: 0, fallback: 0 }),
    });
  }
  return out;
}
