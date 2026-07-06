/**
 * Transiciones de estado del Order Controller.
 *
 * Es el ÚNICO módulo que puede mover un orderId de un estado a otro.
 * Reglas:
 *  - `queued → dispatching` solo vía `claimNextQueuedOrder` (atómico).
 *  - `dispatching → accepted` solo cuando llega HARDWARE_ACCEPTED correlacionado.
 *  - `accepted → preparing` opcional (transición informativa, derivada de HARDWARE_STATE).
 *  - `accepted|preparing → ready` solo en PREPARATION_COMPLETED.
 *  - `accepted|preparing|ready → failed` solo en PREPARATION_FAILED o timeout duro.
 *  - `ready → served` solo por evento ORDER_SERVED.
 *  - `served|failed → released` cuando se libera la bandeja (TAKEN autoritativo) o purge.
 *
 * `idle` por sí solo no marca failed. El controller distingue entre:
 *   - "hardware arrancó"     (HARDWARE_ACCEPTED con activeOrderId)
 *   - "hardware progresó"    (eventos PREPARATION_PROGRESS / state)
 *   - "hardware terminó"     (PREPARATION_COMPLETED o PREPARATION_FAILED)
 *
 * Cualquier transición:
 *   1. Asigna `sequence` monotónico por orderId.
 *   2. Persiste a SQLite antes de publicar el evento.
 *   3. Publica el OrderEvent correspondiente.
 *   4. Si la transición lo requiere, encola el siguiente claim.
 */

import { randomUUID } from 'crypto';

import {
  compareFifoEntries,
  ControllerState,
  createInitialControllerState,
  HardwareSnapshot,
  ManagedOrder,
  nextSequence,
  queueKey,
  QueueEntry,
} from './ControllerState';
import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  makeCommandEnvelope,
  makeOrderEvent,
  OrderEnvelope,
  OrderEvent,
  OrderEventType,
  OrderFailureCode,
  OrderState,
  PROTOCOL_VERSION,
} from '../../src/protocol/types';
import { ControllerPersistence } from './persistence';

export interface ControllerEventBus {
  publishOrderEvent(event: OrderEvent): void;
  publishQueueSnapshot(tableId: number, orders: QueueEntry[], activeOrder: OrderEnvelope | null, now: number): void;
  publishHardwareAuthoritativeState(state: HardwareState): void;
  publishHardwareCommand(command: CommandEnvelope): void;
  log(message: string, meta?: Record<string, unknown>): void;
}

export interface ClaimResult {
  claimed: QueueEntry | null;
  command?: CommandEnvelope;
}

export interface TransitionResult {
  accepted: boolean;
  events: OrderEvent[];
  nextClaim: ClaimResult;
  reason?: string;
}

const HARDWARE_PREPARATION_START_TIMEOUT_MS = 30_000;
const HARDWARE_PROGRESS_HEARTBEAT_MS = 10_000;
const HARDWARE_PROGRESS_HARD_TIMEOUT_MS = 90_000;
const HARDWARE_EXECUTION_TIMEOUT_MARGIN_MS = 60_000;

export class OrderControllerCore {
  private state: ControllerState;
  private readonly persistence: ControllerPersistence;
  private readonly bus: ControllerEventBus;
  /**
   * Set de commandIds de admin ya enrutados al hardware.
   * Previene retransmisión: si el controller recibe el mismo admin command dos
   * veces (mismo commandId) reenvía una sola vez.
   * Memoria: bounded por TTL implícito (sólo comandos vivos en la demo).
   */
  private readonly adminCommandIds = new Set<string>();

  constructor(persistence: ControllerPersistence, bus: ControllerEventBus) {
    this.persistence = persistence;
    this.bus = bus;
    this.state = persistence.loadState();
  }

  /** Acceso solo-lectura al estado (para diagnósticos/tests). */
  getState(): Readonly<ControllerState> {
    return this.state;
  }

  /** Tabla actual (autoritativa). */
  getHardware(): HardwareSnapshot | null {
    return this.state.hardware;
  }

  /** Snapshot de cola por mesa, ordenado FIFO. */
  getQueueForTable(tableId: number): QueueEntry[] {
    return [...this.state.queue.values()]
      .filter((q) => q.tableId === tableId)
      .sort(compareFifoEntries);
  }

  /** Snapshot global FIFO. */
  getGlobalQueue(): QueueEntry[] {
    return [...this.state.queue.values()].sort(compareFifoEntries);
  }

  getOrder(orderId: string): ManagedOrder | null {
    return this.state.orders.get(orderId) ?? null;
  }

  listOrdersForTable(tableId: number): ManagedOrder[] {
    return [...this.state.orders.values()].filter((o) => o.envelope.tableId === tableId);
  }

  /**
   * Sometimiento de un pedido por una mesa.
   *
   * Idempotente por `orderId`: si el mismo `orderId` ya existe, se devuelve
   * el estado actual sin re-encolar. Si el mismo `commandId` llega con un
   * `orderId` distinto, se considera error de cliente y se rechaza.
   */
  submitOrder(envelope: OrderEnvelope): TransitionResult {
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      return this.emptyResult('protocol_mismatch');
    }
    if (!envelope.orderId || !envelope.tableId || !envelope.commandId || !envelope.recipeId) {
      return this.emptyResult('invalid_envelope');
    }
    const existing = this.state.orders.get(envelope.orderId);
    if (existing) {
      // Idempotencia por orderId
      if (existing.envelope.commandId === envelope.commandId) {
        return {
          accepted: true,
          events: [],
          nextClaim: { claimed: null },
        };
      }
      return this.emptyResult('orderId_conflict');
    }
    const now = Date.now();
    const fifoKey = this.state.nextFifoKey++;
    const order: ManagedOrder = {
      envelope,
      state: 'queued',
      sequence: nextSequence(this.state, envelope.orderId),
      acceptedAt: now,
      lastEventAt: now,
      retryCount: 0,
    };
    const entry: QueueEntry = {
      orderId: envelope.orderId,
      tableId: envelope.tableId,
      commandId: envelope.commandId,
      fifoKey,
      enqueuedAt: now,
      groupId: envelope.groupId,
      guestName: envelope.guestName,
      state: 'queued',
    };
    this.state.orders.set(envelope.orderId, order);
    this.state.queue.set(queueKey(fifoKey, envelope.orderId), entry);
    this.persistence.saveQueueEntry(entry);
    this.persistence.saveOrder(order, entry);
    const event = makeOrderEvent({
      type: 'ORDER_ACCEPTED',
      orderId: envelope.orderId,
      tableId: envelope.tableId,
      commandId: envelope.commandId,
      sequence: order.sequence,
    });
    this.emitEvent(order, event);
    this.publishQueueSnapshotForTable(envelope.tableId);
    const nextClaim = this.claimNextQueuedOrder();
    return { accepted: true, events: [event], nextClaim };
  }

  /** Cancelar un pedido aún no despachado. */
  cancelOrder(orderId: string, reason = 'cancelled_by_user'): TransitionResult {
    const order = this.state.orders.get(orderId);
    if (!order) return this.emptyResult('unknown_order');
    if (order.state !== 'queued') {
      return this.emptyResult('not_cancellable', { currentState: order.state });
    }
    this.removeFromQueue(orderId);
    order.state = 'failed';
    order.failureCode = 'unknown';
    order.reason = reason;
    order.lastEventAt = Date.now();
    order.sequence = nextSequence(this.state, orderId);
    this.clearClaimIfMatches(orderId);
    this.persistence.saveOrder(order, null);
    this.persistence.removeQueueEntry(orderId);
    const event = makeOrderEvent({
      type: 'ORDER_RELEASED',
      orderId,
      tableId: order.envelope.tableId,
      commandId: order.envelope.commandId,
      sequence: order.sequence,
      reason,
    });
    this.emitEvent(order, event);
    this.publishQueueSnapshotForTable(order.envelope.tableId);
    const nextClaim = this.claimNextQueuedOrder();
    return { accepted: true, events: [event], nextClaim };
  }

  /** Marcar pedido como servido (acción del mesero). */
  serveOrder(orderId: string): TransitionResult {
    const order = this.state.orders.get(orderId);
    if (!order) return this.emptyResult('unknown_order');
    if (order.state !== 'ready') {
      return this.emptyResult('not_ready', { currentState: order.state });
    }
    order.state = 'served';
    order.servedAt = Date.now();
    order.lastEventAt = order.servedAt;
    order.sequence = nextSequence(this.state, orderId);
    this.persistence.saveOrder(order, null);
    this.removeFromQueue(orderId);
    const event = makeOrderEvent({
      type: 'ORDER_SERVED',
      orderId,
      tableId: order.envelope.tableId,
      commandId: order.envelope.commandId,
      sequence: order.sequence,
    });
    this.emitEvent(order, event);
    this.publishQueueSnapshotForTable(order.envelope.tableId);
    // Liberar la bandeja del hardware para que pueda aceptar el siguiente PREPARE.
    // TAKEN es idempotente en el hardware (cache por commandId).
    const takenCommand: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: `taken-${order.envelope.commandId}`,
      type: 'TAKEN',
      orderId,
      tableId: order.envelope.tableId,
      issuedAt: Date.now(),
      issuedBy: 'controller',
    };
    this.bus.publishHardwareCommand(takenCommand);
    const nextClaim = this.claimNextQueuedOrder();
    return { accepted: true, events: [event], nextClaim };
  }

  /**
   * Reenvía un comando administrativo (POWER, CLEAN, SET_CALIB, etc.) al ESP32.
   * El commandId se preserva para correlación con el ACK del hardware.
   *
   * Reglas:
   *  - POWER ON/OFF: permitido siempre; el controller publica el resultado.
   *  - CLEAN / SET_CALIB / TEST_HW: permitido siempre; el controller delega al hardware.
   *  - Si el hardware está offline, devuelve aceptado=false con reason=hardware_offline.
   */
  submitAdminCommand(input: CommandEnvelope): { accepted: boolean; command: CommandEnvelope; reason?: string } {
    if (input.protocolVersion !== PROTOCOL_VERSION) {
      return { accepted: false, command: input, reason: 'protocol_mismatch' };
    }
    if (!input.commandId) {
      return { accepted: false, command: input, reason: 'missing_command_id' };
    }
    if (!input.type) {
      return { accepted: false, command: input, reason: 'missing_type' };
    }
    // Idempotencia: si ya reenviamos este commandId, no lo reenviamos otra vez.
    // El hardware también cachea por commandId, así que devolver el mismo ACK
    // es seguro. La app maneja el timeout: si el ACK no llega en X ms, reintenta
    // con un commandId NUEVO (no reutilizar).
    if (this.adminCommandIds.has(input.commandId)) {
      return { accepted: true, command: input, reason: 'duplicate_admin' };
    }
    this.adminCommandIds.add(input.commandId);
    const forward: CommandEnvelope = {
      ...input,
      issuedBy: 'controller',
      issuedAt: Date.now(),
    };
    this.bus.publishHardwareCommand(forward);
    return { accepted: true, command: forward };
  }

  /** Para diagnóstico: ¿cuántos admin commands en vuelo? */
  getAdminCommandCount(): number {
    return this.adminCommandIds.size;
  }

  /**
   * Procesa un ACK del hardware que NO corresponde a un pedido (es un admin command).
   * Devuelve el CommandAck a republicar por `controller/admin/result` y limpia
   * el commandId del registro.
   *
   * Si el commandId no está en el registro, el ACK se ignora (retransmisión tardía).
   */
  consumeAdminAck(ack: CommandAck): CommandAck | null {
    if (ack.protocolVersion !== PROTOCOL_VERSION) return null;
    if (!ack.commandId) return null;
    if (!this.adminCommandIds.has(ack.commandId)) return null;
    this.adminCommandIds.delete(ack.commandId);
    return ack;
  }

  /**
   * Reclamar el siguiente pedido en cola. Esta función es atómica con respecto
   * al resto del controller porque JavaScript es single-threaded y la bandera
   * `dispatchLocked` evita reentrancy.
   */
  claimNextQueuedOrder(): ClaimResult {
    if (this.state.dispatchLocked) return { claimed: null };
    if (this.state.hardware == null) return { claimed: null };
    if (!this.state.hardware.isOn) return { claimed: null };
    if (this.state.hardware.status === 'cleaning' || this.state.hardware.status === 'error') {
      return { claimed: null };
    }
    // Si el controller ya tiene un pedido en vuelo (esperando HARDWARE_ACCEPTED/COMPLETED),
    // no reclamar otro. Esto es independiente del snapshot del hardware, que puede
    // estar desactualizado entre eventos.
    if (this.state.claimedOrderId) return { claimed: null };
    // El hardware ya está ocupado con otro pedido o está en 'ready' sin TAKEN.
    if (this.state.hardware.activeOrderId && this.state.hardware.activeOrderId !== '') {
      return { claimed: null };
    }
    if (this.state.hardware.isDrinkReady) {
      // Bandeja ocupada: la app todavía no confirmó TAKEN. No reclamar.
      return { claimed: null };
    }
    // Si hay un pedido en 'ready' aún no servido, la bandeja está conceptualmente
    // ocupada: no promover el siguiente hasta que el operador confirme servido/TAKEN.
    for (const order of this.state.orders.values()) {
      if (order.state === 'ready') {
        return { claimed: null };
      }
    }
    const next = this.getGlobalQueue().find((q) => q.state === 'queued');
    if (!next) return { claimed: null };
    this.state.dispatchLocked = true;
    try {
      const order = this.state.orders.get(next.orderId);
      if (!order) return { claimed: null };
      // Re-check: el order pudo haber sido cancelado entre getGlobalQueue y aquí.
      next.state = 'dispatching';
      order.state = 'dispatching';
      order.dispatchedAt = Date.now();
      order.lastEventAt = order.dispatchedAt;
      order.sequence = nextSequence(this.state, order.envelope.orderId);
      this.state.claimedOrderId = order.envelope.orderId;
      this.persistence.saveOrder(order, next);
      this.bus.log('dispatch', {
        orderId: order.envelope.orderId,
        fifoKey: next.fifoKey,
      });
      const command = makeCommandEnvelope({
        commandId: order.envelope.commandId,
        type: 'PREPARE',
        orderId: order.envelope.orderId,
        tableId: order.envelope.tableId,
        payload: {
          recipeId: order.envelope.recipeId,
          iceCount: order.envelope.options.iceCount,
          alcoholOz: order.envelope.options.alcoholOz,
          mixerOz: order.envelope.options.mixerOz,
          piscolaIntensity: order.envelope.options.piscolaIntensity,
        },
        issuedBy: 'controller',
      });
      this.bus.publishHardwareCommand(command);
      this.publishQueueSnapshotForTable(order.envelope.tableId);
      return { claimed: next, command };
    } finally {
      this.state.dispatchLocked = false;
    }
  }

  /** Manejo del ACK de un comando enviado al hardware. */
  handleCommandAck(ack: CommandAck): TransitionResult {
    if (ack.protocolVersion !== PROTOCOL_VERSION) return this.emptyResult('protocol_mismatch');
    const order = this.findOrderByCommandId(ack.commandId);
    if (!order) return this.emptyResult('unknown_command');
    if (ack.accepted) {
      // HARDWARE_ACCEPTED: el hardware tomó el trabajo.
      if (order.state !== 'dispatching') {
        // ACK llega tarde o duplicado. No cambiamos estado.
        return { accepted: true, events: [], nextClaim: { claimed: null } };
      }
      order.state = 'accepted';
      order.lastEventAt = Date.now();
      order.sequence = nextSequence(this.state, order.envelope.orderId);
      const event = makeOrderEvent({
        type: 'HARDWARE_ACCEPTED',
        orderId: order.envelope.orderId,
        tableId: order.envelope.tableId,
        commandId: order.envelope.commandId,
        sequence: order.sequence,
      });
      this.emitEvent(order, event);
      this.persistence.saveOrder(order, this.findQueueEntry(order.envelope.orderId));
      this.publishQueueSnapshotForTable(order.envelope.tableId);
      return { accepted: true, events: [event], nextClaim: { claimed: null } };
    }
    // ACK negativo por carrera de liberacion: el hardware aun esta ocupado.
    // No es un fallo del pedido; lo devolvemos a la cola con su FIFO original.
    if (ack.failureCode === 'machine_busy' || ack.reason === 'machine_busy') {
      const entry = this.findQueueEntry(order.envelope.orderId);
      order.state = 'queued';
      order.failureCode = undefined;
      order.reason = undefined;
      order.retryCount += 1;
      order.lastEventAt = Date.now();
      order.sequence = nextSequence(this.state, order.envelope.orderId);
      order.dispatchedAt = undefined;
      if (entry) {
        entry.state = 'queued';
        this.persistence.saveQueueEntry(entry);
      }
      this.clearClaimIfMatches(order.envelope.orderId);
      this.persistence.saveOrder(order, entry);
      this.publishQueueSnapshotForTable(order.envelope.tableId);
      return { accepted: true, events: [], nextClaim: { claimed: null } };
    }

    // ACK negativo definitivo
    order.state = 'failed';
    order.failureCode = ack.failureCode ?? 'machine_rejected';
    order.reason = ack.reason ?? 'machine_rejected';
    order.lastEventAt = Date.now();
    order.sequence = nextSequence(this.state, order.envelope.orderId);
    this.clearClaimIfMatches(order.envelope.orderId);
    this.removeFromQueue(order.envelope.orderId);
    this.persistence.saveOrder(order, null);
    this.persistence.removeQueueEntry(order.envelope.orderId);
    const event = makeOrderEvent({
      type: 'PREPARATION_FAILED',
      orderId: order.envelope.orderId,
      tableId: order.envelope.tableId,
      commandId: order.envelope.commandId,
      sequence: order.sequence,
      reason: order.reason,
      failureCode: order.failureCode as OrderFailureCode,
    });
    this.emitEvent(order, event);
    this.publishQueueSnapshotForTable(order.envelope.tableId);
    const nextClaim = this.claimNextQueuedOrder();
    return { accepted: true, events: [event], nextClaim };
  }

  /** Procesa un evento del hardware (PREPARATION_*, etc.). */
  handleHardwareEvent(event: OrderEvent): TransitionResult {
    if (event.protocolVersion !== PROTOCOL_VERSION) return this.emptyResult('protocol_mismatch');
    const order = this.state.orders.get(event.orderId);
    if (!order) {
      // Evento huérfano: probablemente del boot anterior. Loggeamos y descartamos.
      this.bus.log('orphan_hardware_event', { orderId: event.orderId, type: event.type });
      return { accepted: true, events: [], nextClaim: { claimed: null } };
    }
    // Defensa contra orden de eventos revertido.
    const incomingSeq = event.sequence;
    if (incomingSeq < order.sequence && (event.type === 'PREPARATION_PROGRESS' || event.type === 'HARDWARE_ACCEPTED')) {
      return { accepted: true, events: [], nextClaim: { claimed: null } };
    }
    switch (event.type) {
      case 'PREPARATION_STARTED':
        if (order.state === 'accepted' || order.state === 'dispatching') {
          order.state = 'preparing';
          order.lastEventAt = Date.now();
          order.sequence = Math.max(order.sequence, incomingSeq) + 1;
          this.persistence.saveOrder(order, this.findQueueEntry(order.envelope.orderId));
          this.publishQueueSnapshotForTable(order.envelope.tableId);
        }
        return { accepted: true, events: [], nextClaim: { claimed: null } };
      case 'PREPARATION_PROGRESS':
        if (order.state === 'accepted' || order.state === 'preparing' || order.state === 'dispatching') {
          if (order.state === 'accepted') order.state = 'preparing';
          order.lastEventAt = Date.now();
          this.persistence.saveOrder(order, this.findQueueEntry(order.envelope.orderId));
          this.publishQueueSnapshotForTable(order.envelope.tableId);
        }
        return { accepted: true, events: [], nextClaim: { claimed: null } };
      case 'PREPARATION_COMPLETED':
        if (order.state === 'served' || order.state === 'failed') {
          return { accepted: true, events: [], nextClaim: { claimed: null } };
        }
        order.state = 'ready';
        order.completedAt = Date.now();
        order.lastEventAt = order.completedAt;
        order.sequence = Math.max(order.sequence, incomingSeq) + 1;
        this.clearClaimIfMatches(order.envelope.orderId);
        this.persistence.saveOrder(order, this.findQueueEntry(order.envelope.orderId));
        const readyEvent = makeOrderEvent({
          type: 'PREPARATION_COMPLETED',
          orderId: order.envelope.orderId,
          tableId: order.envelope.tableId,
          commandId: order.envelope.commandId,
          sequence: order.sequence,
        });
        this.emitEvent(order, readyEvent);
        this.publishQueueSnapshotForTable(order.envelope.tableId);
        const nextClaim = this.claimNextQueuedOrder();
        return { accepted: true, events: [readyEvent], nextClaim };
      case 'PREPARATION_FAILED':
        if (order.state === 'served' || order.state === 'failed') {
          return { accepted: true, events: [], nextClaim: { claimed: null } };
        }
        order.state = 'failed';
        order.failureCode = event.failureCode ?? 'mechanical_error';
        order.reason = event.reason ?? 'mechanical_error';
        order.lastEventAt = Date.now();
        order.sequence = Math.max(order.sequence, incomingSeq) + 1;
        this.clearClaimIfMatches(order.envelope.orderId);
        this.removeFromQueue(order.envelope.orderId);
        this.persistence.saveOrder(order, null);
        this.persistence.removeQueueEntry(order.envelope.orderId);
        this.emitEvent(order, event);
        this.publishQueueSnapshotForTable(order.envelope.tableId);
        const failureNextClaim = this.claimNextQueuedOrder();
        return { accepted: true, events: [event], nextClaim: failureNextClaim };
      case 'HARDWARE_ACCEPTED':
        return this.handleCommandAck({
          protocolVersion: PROTOCOL_VERSION,
          commandId: event.commandId,
          accepted: true,
          timestamp: event.timestamp,
        });
      default:
        return this.emptyResult('ignored_event_type');
    }
  }

  /** Snapshot de estado del hardware. */
  updateHardwareState(snapshot: HardwareState): TransitionResult {
    if (snapshot.protocolVersion !== PROTOCOL_VERSION) return this.emptyResult('protocol_mismatch');
    const prev = this.state.hardware;
    this.state.hardware = {
      bootId: snapshot.bootId,
      isOn: snapshot.isOn,
      status: snapshot.status,
      activeOrderId: snapshot.activeOrderId,
      activeTableId: snapshot.activeTableId,
      activeCommandId: snapshot.activeCommandId,
      stateSequence: snapshot.stateSequence,
      isDrinkReady: snapshot.isDrinkReady,
      activeStepId: snapshot.activeStepId,
      completedStepIds: snapshot.completedStepIds,
      skippedStepIds: snapshot.skippedStepIds,
      errorMessage: snapshot.errorMessage,
      startedAt: snapshot.startedAt,
      lastSeenAt: Date.now(),
      uptimeMs: snapshot.uptimeMs,
    };
    this.persistence.saveHardware(this.state.hardware);
    this.bus.publishHardwareAuthoritativeState(snapshot);
    const events: OrderEvent[] = [];
    if (snapshot.status === 'error' && snapshot.activeOrderId) {
      const order = this.state.orders.get(snapshot.activeOrderId);
      if (order && order.state !== 'served' && order.state !== 'failed') {
        order.state = 'failed';
        order.failureCode = snapshot.errorMessage?.toLowerCase().includes('home')
          ? 'home_failed'
          : 'mechanical_error';
        order.reason = snapshot.errorMessage ?? 'hardware_error';
        order.lastEventAt = Date.now();
        order.sequence = nextSequence(this.state, order.envelope.orderId);
        this.clearClaimIfMatches(order.envelope.orderId);
        this.removeFromQueue(order.envelope.orderId);
        this.persistence.saveOrder(order, null);
        this.persistence.removeQueueEntry(order.envelope.orderId);
        const event = makeOrderEvent({
          type: 'PREPARATION_FAILED',
          orderId: order.envelope.orderId,
          tableId: order.envelope.tableId,
          commandId: order.envelope.commandId,
          sequence: order.sequence,
          reason: order.reason,
          failureCode: order.failureCode as OrderFailureCode,
        });
        this.emitEvent(order, event);
        events.push(event);
      }
    }
    if (prev) {
      // Si el hardware indica que la bebida está lista, pero el estado era preparing/accepted,
      // pero el hardware NO publicó PREPARATION_COMPLETED, NO asumimos ready: esperamos el evento.
      // Si el hardware reporta un activeOrderId distinto al de cualquier pedido dispatching,
      // no movemos el estado: la app puede haber recibido el snapshot autoritativo del controller.
    }
    // Si el hardware se apaga, todos los pedidos en 'dispatching'/'accepted'/'preparing' se marcan failed.
    if (!snapshot.isOn) {
      for (const order of this.state.orders.values()) {
        if (order.state === 'dispatching' || order.state === 'accepted' || order.state === 'preparing') {
          order.state = 'failed';
          order.failureCode = 'machine_offline';
          order.reason = 'machine_powered_off';
          order.lastEventAt = Date.now();
          order.sequence = nextSequence(this.state, order.envelope.orderId);
          this.clearClaimIfMatches(order.envelope.orderId);
          this.removeFromQueue(order.envelope.orderId);
          this.persistence.saveOrder(order, null);
          this.persistence.removeQueueEntry(order.envelope.orderId);
          const event = makeOrderEvent({
            type: 'PREPARATION_FAILED',
            orderId: order.envelope.orderId,
            tableId: order.envelope.tableId,
            commandId: order.envelope.commandId,
            sequence: order.sequence,
            reason: 'machine_powered_off',
            failureCode: 'machine_offline',
          });
          this.emitEvent(order, event);
          events.push(event);
        }
      }
    }
    this.publishQueueSnapshotForAll();
    const nextClaim = this.claimNextQueuedOrder();
    return { accepted: true, events, nextClaim };
  }

  /**
   * Hardware se fue o se reinició. Limpia admin commands en vuelo (sus ACKs
   * nunca llegarán). El caller (main.ts) debe publicar admin/result con
   * accepted=false para cada uno.
   */
  drainAdminCommandsOnHardwareLoss(): CommandAck[] {
    const drained: CommandAck[] = [];
    for (const commandId of this.adminCommandIds) {
      drained.push({
        protocolVersion: PROTOCOL_VERSION,
        commandId,
        accepted: false,
        reason: 'hardware_offline',
        failureCode: 'machine_offline',
        timestamp: Date.now(),
      });
    }
    this.adminCommandIds.clear();
    return drained;
  }

  /**
   * Watchdog: se llama periódicamente. Hace dos cosas:
   *  1. Detecta pedidos en `dispatching` que nunca recibieron HARDWARE_ACCEPTED
   *     después de `HARDWARE_PREPARATION_START_TIMEOUT_MS` y los marca failed.
   *  2. Detecta pedidos en `preparing` que no reciben heartbeat por
   *     `HARDWARE_PROGRESS_HARD_TIMEOUT_MS` y los marca failed.
   */
  tickWatchdog(now: number = Date.now()): TransitionResult {
    const events: OrderEvent[] = [];
    for (const order of this.state.orders.values()) {
      if (order.state === 'dispatching') {
        const dispatchAge = now - (order.dispatchedAt ?? order.lastEventAt);
        if (dispatchAge > HARDWARE_PREPARATION_START_TIMEOUT_MS) {
          order.state = 'failed';
          order.failureCode = 'timeout_preparation_start';
          order.reason = 'no_hardware_accepted';
          order.lastEventAt = now;
          order.sequence = nextSequence(this.state, order.envelope.orderId);
          this.clearClaimIfMatches(order.envelope.orderId);
          this.removeFromQueue(order.envelope.orderId);
          this.persistence.saveOrder(order, null);
          this.persistence.removeQueueEntry(order.envelope.orderId);
          const event = makeOrderEvent({
            type: 'PREPARATION_FAILED',
            orderId: order.envelope.orderId,
            tableId: order.envelope.tableId,
            commandId: order.envelope.commandId,
            sequence: order.sequence,
            reason: 'no_hardware_accepted',
            failureCode: 'timeout_preparation_start',
          });
          this.emitEvent(order, event);
          events.push(event);
        }
      } else if (order.state === 'preparing' || order.state === 'accepted') {
        const sinceLast = now - order.lastEventAt;
        if (sinceLast > HARDWARE_PROGRESS_HARD_TIMEOUT_MS) {
          order.state = 'failed';
          order.failureCode = 'timeout_no_progress';
          order.reason = 'no_hardware_progress';
          order.lastEventAt = now;
          order.sequence = nextSequence(this.state, order.envelope.orderId);
          this.clearClaimIfMatches(order.envelope.orderId);
          this.removeFromQueue(order.envelope.orderId);
          this.persistence.saveOrder(order, null);
          this.persistence.removeQueueEntry(order.envelope.orderId);
          const event = makeOrderEvent({
            type: 'PREPARATION_FAILED',
            orderId: order.envelope.orderId,
            tableId: order.envelope.tableId,
            commandId: order.envelope.commandId,
            sequence: order.sequence,
            reason: 'no_hardware_progress',
            failureCode: 'timeout_no_progress',
          });
          this.emitEvent(order, event);
          events.push(event);
        }
      }
    }
    if (events.length > 0) {
      this.publishQueueSnapshotForAll();
      const nextClaim = this.claimNextQueuedOrder();
      return { accepted: true, events, nextClaim };
    }
    return { accepted: true, events, nextClaim: { claimed: null } };
  }

  /** Reconciliación tras reinicio del controller. */
  reconcileAfterBoot(): TransitionResult {
    if (!this.state.hardware) {
      // No hay hardware aún. La app debe esperar al primer snapshot.
      return { accepted: true, events: [], nextClaim: { claimed: null } };
    }
    const hw = this.state.hardware;
    if (hw.activeOrderId) {
      const order = this.state.orders.get(hw.activeOrderId);
      if (order) {
        // El hardware tiene un pedido activo que coincide con uno que el controller
        // conoce. Marcamos como accepted/preparing y dejamos que el hardware dicte
        // el resto por eventos.
        if (order.state === 'queued' || order.state === 'dispatching') {
          order.state = hw.isDrinkReady ? 'ready' : 'preparing';
          order.lastEventAt = Date.now();
          order.sequence = nextSequence(this.state, order.envelope.orderId);
          this.persistence.saveOrder(order, this.findQueueEntry(order.envelope.orderId));
          this.bus.log('reconcile_resumed', { orderId: order.envelope.orderId, state: order.state });
        }
      } else {
        // El hardware tiene un pedido activo desconocido. No hacemos nada: la app
        // verá el snapshot del controller, que mostrará `activeOrder` autoritativo.
        this.bus.log('reconcile_unknown_active_order', { activeOrderId: hw.activeOrderId });
      }
    } else {
      // Hardware libre. Promover siguiente si existe.
      const nextClaim = this.claimNextQueuedOrder();
      return { accepted: true, events: [], nextClaim };
    }
    this.publishQueueSnapshotForAll();
    return { accepted: true, events: [], nextClaim: { claimed: null } };
  }

  /** Helpers internos */
  private findOrderByCommandId(commandId: string): ManagedOrder | null {
    for (const order of this.state.orders.values()) {
      if (order.envelope.commandId === commandId) return order;
    }
    return null;
  }

  private findQueueEntry(orderId: string): QueueEntry | null {
    for (const entry of this.state.queue.values()) {
      if (entry.orderId === orderId) return entry;
    }
    return null;
  }

  private removeFromQueue(orderId: string): void {
    for (const [key, entry] of this.state.queue.entries()) {
      if (entry.orderId === orderId) {
        this.state.queue.delete(key);
        return;
      }
    }
  }

  private clearClaimIfMatches(orderId: string): void {
    if (this.state.claimedOrderId === orderId) {
      this.state.claimedOrderId = null;
    }
  }

  private emitEvent(order: ManagedOrder, event: OrderEvent): void {
    this.bus.publishOrderEvent(event);
  }

  private publishQueueSnapshotForTable(tableId: number): void {
    const entries = this.getQueueForTable(tableId);
    const ordersForTable: QueueSnapshotLike[] = [];
    for (const entry of entries) {
      const order = this.state.orders.get(entry.orderId);
      if (!order) continue;
      ordersForTable.push({
        orderId: order.envelope.orderId,
        commandId: order.envelope.commandId,
        recipeId: order.envelope.recipeId,
        requestedAt: order.envelope.requestedAt,
        guestName: order.envelope.guestName,
        groupId: order.envelope.groupId,
        state: order.state,
        options: order.envelope.options,
      });
    }
    const activeOrderEntry = entries
      .map((e) => this.state.orders.get(e.orderId))
      .find(
        (o) => o && (o.state === 'dispatching' || o.state === 'accepted' || o.state === 'preparing' || o.state === 'ready')
      );
    const activeOrder: OrderEnvelope | null = activeOrderEntry ? activeOrderEntry.envelope : null;
    this.bus.publishQueueSnapshot(tableId, entries, activeOrder, Date.now());
  }

  private publishQueueSnapshotForAll(): void {
    const tables = new Set<number>();
    for (const entry of this.state.queue.values()) tables.add(entry.tableId);
    for (const order of this.state.orders.values()) tables.add(order.envelope.tableId);
    for (const tableId of tables) this.publishQueueSnapshotForTable(tableId);
  }

  private emptyResult(reason: string, meta?: Record<string, unknown>): TransitionResult {
    if (meta) this.bus.log('transition_rejected', { reason, ...meta });
    else this.bus.log('transition_rejected', { reason });
    return { accepted: false, events: [], nextClaim: { claimed: null }, reason };
  }
}

interface QueueSnapshotLike {
  orderId: string;
  commandId: string;
  recipeId: string;
  requestedAt: number;
  guestName?: string;
  groupId?: string;
  state: OrderState;
  options: { iceCount: number; alcoholOz?: number; mixerOz?: number; piscolaIntensity?: 'suave' | 'normal' | 'fuerte' };
}

export function makeRandomOrderId(): string {
  return `ord_${randomUUID()}`;
}

export function makeRandomCommandId(): string {
  return `cmd_${randomUUID()}`;
}
