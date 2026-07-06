/**
 * Entry point del Order Controller.
 *
 * Responsabilidades:
 *  1. Conectar al broker MQTT (vía TCP).
 *  2. Crear/inicializar la persistence SQLite.
 *  3. Crear el OrderControllerCore.
 *  4. Cablear los eventos del cliente MQTT con las acciones del core.
 *  5. Iniciar el watchdog cada 1s.
 *  6. Manejar SIGINT/SIGTERM cerrando limpiamente.
 *
 * Variables de entorno:
 *   MQTT_URL          URL del broker (default: mqtt://localhost:1883)
 *   CONTROLLER_DB     Ruta al archivo SQLite (default: ./data/controller.db)
 *   CONTROLLER_ID     Client ID (default: penpito-controller-{pid})
 *   LOG_LEVEL         'debug' | 'info' (default: info)
 */

import path from 'path';
import fs from 'fs';

import {
  ControllerMqttClient,
  MqttControllerConfig,
} from './ControllerMqttClient';
import { ControllerPersistence, createSqlitePersistence } from './persistence';
import {
  ControllerEventBus,
  OrderControllerCore,
} from './OrderControllerCore';
import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  OrderEnvelope,
  OrderEvent,
  QueueSnapshot,
} from './protocol';
import { ControllerState, QueueEntry } from './ControllerState';

function loadConfig(): { mqttUrl: string; dbPath: string; clientId: string } {
  const mqttUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';
  const dbPath = process.env.CONTROLLER_DB || path.resolve(process.cwd(), 'data/controller.db');
  const clientId =
    process.env.CONTROLLER_ID || `penpito-controller-${process.pid}-${Date.now().toString(36)}`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { mqttUrl, dbPath, clientId };
}

class ConsoleBus implements ControllerEventBus {
  log(message: string, meta?: Record<string, unknown>): void {
    if (process.env.LOG_LEVEL === 'debug' || meta?.level === 'warn') {
      console.log(`[controller] ${message}`, meta ? JSON.stringify(meta) : '');
    }
  }
  publishOrderEvent(event: OrderEvent): void {
    /* El cliente MQTT lo hace. */
  }
  publishQueueSnapshot(tableId: number, entries: QueueEntry[], activeOrder: OrderEnvelope | null, now: number): void {
    /* El cliente MQTT lo hace. */
  }
  publishHardwareAuthoritativeState(state: HardwareState): void {
    /* El cliente MQTT lo hace. */
  }
  publishHardwareCommand(command: CommandEnvelope): void {
    /* El cliente MQTT lo hace. */
  }
}

async function main(): Promise<void> {
  const { mqttUrl, dbPath, clientId } = loadConfig();
  console.log(`[controller] starting: broker=${mqttUrl} db=${dbPath} id=${clientId}`);

  const persistence: ControllerPersistence = createSqlitePersistence(dbPath);
  const mqttConfig: MqttControllerConfig = {
    url: mqttUrl,
    clientId,
    retainHardwareState: true,
    retainQueueTables: true,
  };
  const mqttClient = new ControllerMqttClient(mqttConfig);
  const core = new OrderControllerCore(persistence, new ConsoleBus());

  mqttClient.on('order_submit', (envelope: OrderEnvelope) => {
    const result = core.submitOrder(envelope);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
  });
  mqttClient.on('order_cancel', (orderId: string) => {
    const result = core.cancelOrder(orderId);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
  });
  mqttClient.on('order_served', (orderId: string) => {
    const result = core.serveOrder(orderId);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
  });
  mqttClient.on('queue_request', (tableId: number) => {
    publishSnapshotForTable(mqttClient, core, tableId);
  });
  mqttClient.on('hardware_request', () => {
    if (core.getHardware()) {
      mqttClient.publishHardwareAuthoritativeState(toHardwareStateMessage(core.getHardware()!));
    }
  });
  mqttClient.on('hardware_ack', (ack: CommandAck) => {
    const result = core.handleCommandAck(ack);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
    // Si el ACK corresponde a un comando sin orderId (admin), republicarlo por
    // el canal admin/result para que la app lo reciba. El handleCommandAck
    // ignora ACKs cuyo commandId no es un orderId activo, pero el hardware
    // también puede confirmar ACKs administrativos que no tocan la cola.
    if (!ack.activeOrderId) {
      mqttClient.publishAdminResult(ack);
    }
  });
  mqttClient.on('admin_command', (command: CommandEnvelope) => {
    const r = core.submitAdminCommand(command);
    if (r.accepted) {
      // El hardware responderá con un CommandAck por el mismo commandId.
      // Reenviamos ese ACK al cliente por el canal admin/result cuando llegue.
      // (Ya está manejado en hardware_ack más abajo: el ACk correlacionado
      // se republica por admin/result.)
    } else {
      mqttClient.publishAdminResult({
        protocolVersion: 2,
        commandId: command.commandId,
        accepted: false,
        reason: r.reason ?? 'rejected',
        timestamp: Date.now(),
      });
    }
  });
  mqttClient.on('hardware_state', (state: HardwareState) => {
    const result = core.updateHardwareState(state);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
  });
  mqttClient.on('hardware_event', (event: OrderEvent) => {
    const result = core.handleHardwareEvent(event);
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    publishAllSnapshots(mqttClient, core);
  });
  mqttClient.on('hardware_presence', (online: boolean) => {
    if (!online) {
      // El hardware se fue. Reconcilia: limpia activeOrder, libera lock.
      const synthState: HardwareState = {
        protocolVersion: 2,
        bootId: core.getHardware()?.bootId ?? 'unknown',
        isOn: false,
        status: 'idle',
        activeOrderId: null,
        activeTableId: null,
        activeCommandId: null,
        stateSequence: (core.getHardware()?.stateSequence ?? 0) + 1,
        activeStepId: null,
        completedStepIds: [],
        skippedStepIds: [],
        isDrinkReady: false,
        errorMessage: 'hardware_offline',
        startedAt: null,
        uptimeMs: 0,
      };
      const result = core.updateHardwareState(synthState);
      publishEvents(mqttClient, core, result.events);
      if (result.nextClaim.claimed) {
        mqttClient.publishHardwareCommand(result.nextClaim.command!);
      }
      publishAllSnapshots(mqttClient, core);
    }
  });

  await mqttClient.connect();
  console.log('[controller] connected to broker');

  // Reconciliación tras boot
  const reconcile = core.reconcileAfterBoot();
  if (reconcile.nextClaim.claimed) {
    mqttClient.publishHardwareCommand(reconcile.nextClaim.command!);
  }
  publishAllSnapshots(mqttClient, core);

  // Watchdog cada 1s
  const watchdog = setInterval(() => {
    const result = core.tickWatchdog();
    publishEvents(mqttClient, core, result.events);
    if (result.nextClaim.claimed) {
      mqttClient.publishHardwareCommand(result.nextClaim.command!);
    }
    if (result.events.length > 0) publishAllSnapshots(mqttClient, core);
  }, 1000);

  const shutdown = async (signal: string) => {
    console.log(`[controller] received ${signal}, shutting down...`);
    clearInterval(watchdog);
    await mqttClient.close();
    persistence.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function publishEvents(mqttClient: ControllerMqttClient, core: OrderControllerCore, events: OrderEvent[]): void {
  for (const event of events) mqttClient.publishOrderEvent(event);
}

function publishAllSnapshots(mqttClient: ControllerMqttClient, core: OrderControllerCore): void {
  const tables = new Set<number>();
  for (const order of core.getState().orders.values()) tables.add(order.envelope.tableId);
  for (const entry of core.getState().queue.values()) tables.add(entry.tableId);
  for (const tableId of tables) publishSnapshotForTable(mqttClient, core, tableId);
  const hw = core.getHardware();
  if (hw) {
    mqttClient.publishHardwareAuthoritativeState(toHardwareStateMessage(hw));
  }
}

function publishSnapshotForTable(
  mqttClient: ControllerMqttClient,
  core: OrderControllerCore,
  tableId: number
): void {
  const queue = core.getQueueForTable(tableId);
  const orders = core.listOrdersForTable(tableId);
  const ordersForQueue = orders
    .filter((o) => queue.some((q) => q.orderId === o.envelope.orderId))
    .map((o) => ({
      orderId: o.envelope.orderId,
      commandId: o.envelope.commandId,
      recipeId: o.envelope.recipeId,
      requestedAt: o.envelope.requestedAt,
      guestName: o.envelope.guestName,
      groupId: o.envelope.groupId,
      state: o.state,
      options: o.envelope.options,
    }));
  const activeOrder = orders.find(
    (o) => o.state === 'dispatching' || o.state === 'accepted' || o.state === 'preparing' || o.state === 'ready'
  );
  const snapshot: QueueSnapshot = {
    protocolVersion: 2,
    tableId,
    orders: ordersForQueue,
    activeOrder: activeOrder ? activeOrder.envelope : null,
    generatedAt: Date.now(),
  };
  mqttClient.publishQueueSnapshot(snapshot);
}

function toHardwareStateMessage(snapshot: ControllerState['hardware'] extends infer T ? NonNullable<T> : never): HardwareState {
  return {
    protocolVersion: 2,
    bootId: snapshot.bootId,
    isOn: snapshot.isOn,
    status: snapshot.status,
    activeOrderId: snapshot.activeOrderId,
    activeTableId: snapshot.activeTableId,
    activeCommandId: snapshot.activeCommandId,
    stateSequence: snapshot.stateSequence,
    activeStepId: snapshot.activeStepId,
    completedStepIds: [],
    skippedStepIds: [],
    isDrinkReady: snapshot.isDrinkReady,
    errorMessage: null,
    startedAt: null,
    uptimeMs: snapshot.uptimeMs,
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[controller] fatal error', err);
    process.exit(1);
  });
}
