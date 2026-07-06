/**
 * Adaptador MQTT del Order Controller.
 *
 * Diferencias con el cliente de la app:
 *  - TCP, no WebSocket (estamos en la misma red que Mosquitto).
 *  - El controller es el único publicador de `controller/...` y `hardware/...`.
 *  - El controller escucha TODOS los topics `mobile/...` (vía wildcard).
 *  - QoS 1 + retain donde corresponde.
 *  - Limpieza segura de timers y promesa de ACK en cada shutdown.
 */

import mqtt, { MqttClient, IClientOptions, IClientPublishOptions } from 'mqtt';
import { EventEmitter } from 'events';

import {
  SHARED,
  SUBSCRIBE_PATTERNS,
  TOPICS,
} from '../../src/protocol/topics';
import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  OrderEnvelope,
  OrderEvent,
  QueueSnapshot,
} from '../../src/protocol/types';
import {
  parseCommandAck,
  parseCommandEnvelope,
  parseHardwareState,
  parseOrderEnvelope,
  parseOrderEvent,
} from '../../src/protocol/parsers';

export interface MqttControllerConfig {
  url: string;
  clientId: string;
  /** Si true, retiene el último snapshot autoritativo del hardware. */
  retainHardwareState: boolean;
  /** Tablas que el controller publica en el snapshot retenido. */
  retainQueueTables: boolean;
}

export interface ControllerMqttEvents {
  onOrderSubmit(envelope: OrderEnvelope, topic: string): void;
  onOrderCancel(orderId: string, tableId: number): void;
  onOrderServed(orderId: string, tableId: number): void;
  onQueueRequest(tableId: number): void;
  onHardwareRequest(): void;
  onAdminCommand(command: CommandEnvelope): void;
  onHardwareAck(ack: CommandAck): void;
  onHardwareState(state: HardwareState): void;
  onHardwareEvent(event: OrderEvent): void;
  onHardwarePresence(online: boolean, lastSeenAt: number | null): void;
}

export class ControllerMqttClient extends EventEmitter {
  private client: MqttClient | null = null;
  private connected = false;

  constructor(private readonly config: MqttControllerConfig) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts: IClientOptions = {
        clientId: this.config.clientId,
        reconnectPeriod: 2_000,
        connectTimeout: 8_000,
        keepalive: 30,
        clean: true,
        protocolVersion: 4,
      };
      const client = mqtt.connect(this.config.url, opts);
      this.client = client;
      client.once('connect', () => {
        this.connected = true;
        this.subscribeAll();
        resolve();
      });
      client.once('error', (err) => {
        if (!this.connected) reject(err);
      });
      client.on('message', (topic, payload, packet) => {
        this.handleMessage(topic, payload, packet.retain === true);
      });
      client.on('close', () => {
        this.connected = false;
      });
    });
  }

  private subscribeAll(): void {
    if (!this.client) return;
    const subs: string[] = [
      SUBSCRIBE_PATTERNS.ALL_MOBILE_ORDERS,
      SUBSCRIBE_PATTERNS.ALL_MOBILE_CANCELS,
      SUBSCRIBE_PATTERNS.ALL_MOBILE_SERVED,
      SUBSCRIBE_PATTERNS.ALL_QUEUE_REQUESTS,
      SUBSCRIBE_PATTERNS.ALL_HARDWARE_REQUESTS,
      SUBSCRIBE_PATTERNS.ALL_ADMIN_COMMANDS,
      SUBSCRIBE_PATTERNS.HARDWARE_ACK,
      SUBSCRIBE_PATTERNS.HARDWARE_STATE,
      SUBSCRIBE_PATTERNS.HARDWARE_EVENT,
      SUBSCRIBE_PATTERNS.HARDWARE_PRESENCE,
    ];
    for (const topic of subs) {
      this.client.subscribe(topic, { qos: SHARED.QOS_COMMANDS }, (err) => {
        if (err) console.warn(`[ControllerMqtt] subscribe ${topic} failed`, err.message);
      });
    }
  }

  private handleMessage(topic: string, payload: Buffer, retain: boolean): void {
    try {
      const text = payload.toString('utf8');
      if (topic === TOPICS.HARDWARE_PRESENCE()) {
        const online = text.trim() === 'online';
        const lastSeenAt = online ? Date.now() : null;
        this.emit('hardware_presence', online, lastSeenAt);
        return;
      }
      if (topic === TOPICS.HARDWARE_COMMAND_ACK()) {
        const ack = parseCommandAck(safeJson(text));
        if (ack) this.emit('hardware_ack', ack);
        return;
      }
      if (topic === TOPICS.HARDWARE_STATE()) {
        const state = parseHardwareState(safeJson(text));
        if (state) this.emit('hardware_state', state);
        return;
      }
      if (topic === TOPICS.HARDWARE_EVENT()) {
        const event = parseOrderEvent(safeJson(text));
        if (event) this.emit('hardware_event', event);
        return;
      }
      if (topic.startsWith('penpito/v2/mobile/table/') && topic.endsWith('/order/submit')) {
        const tableId = extractTableId(topic);
        if (tableId == null) return;
        const env = parseOrderEnvelope(safeJson(text));
        if (env) this.emit('order_submit', env, topic);
        return;
      }
      if (topic.startsWith('penpito/v2/mobile/table/') && topic.endsWith('/order/cancel')) {
        const tableId = extractTableId(topic);
        if (tableId == null) return;
        const raw = safeJson(text) as { orderId?: unknown } | null;
        if (raw && typeof raw.orderId === 'string') {
          this.emit('order_cancel', raw.orderId, tableId);
        }
        return;
      }
      if (topic.startsWith('penpito/v2/mobile/table/') && topic.endsWith('/order/served')) {
        const tableId = extractTableId(topic);
        if (tableId == null) return;
        const raw = safeJson(text) as { orderId?: unknown } | null;
        if (raw && typeof raw.orderId === 'string') {
          this.emit('order_served', raw.orderId, tableId);
        }
        return;
      }
      if (topic.startsWith('penpito/v2/mobile/table/') && topic.endsWith('/queue/request')) {
        const tableId = extractTableId(topic);
        if (tableId == null) return;
        this.emit('queue_request', tableId);
        return;
      }
      if (topic === TOPICS.MOBILE_HARDWARE_REQUEST()) {
        this.emit('hardware_request');
        return;
      }
      if (topic === TOPICS.MOBILE_ADMIN_COMMAND()) {
        const cmd = parseCommandEnvelope(safeJson(text));
        if (cmd) this.emit('admin_command', cmd);
        return;
      }
    } catch (err) {
      console.warn('[ControllerMqtt] message parse error', err);
    }
  }

  publishOrderEvent(event: OrderEvent): void {
    this.publish(TOPICS.CONTROLLER_ORDER_EVENT(event.tableId), event, { qos: SHARED.QOS_EVENTS, retain: false });
  }

  publishQueueSnapshot(snapshot: QueueSnapshot): void {
    this.publish(TOPICS.CONTROLLER_QUEUE_STATE(snapshot.tableId), snapshot, {
      qos: SHARED.QOS_STATE,
      retain: this.config.retainQueueTables,
    });
  }

  publishHardwareAuthoritativeState(state: HardwareState): void {
    this.publish(TOPICS.CONTROLLER_HARDWARE_STATE(), state, {
      qos: SHARED.QOS_STATE,
      retain: this.config.retainHardwareState,
    });
  }

  publishHardwareCommand(command: CommandEnvelope): void {
    this.publish(TOPICS.CONTROLLER_HARDWARE_COMMAND(), command, { qos: SHARED.QOS_COMMANDS, retain: false });
  }

  publishAdminResult(result: CommandAck): void {
    this.publish(TOPICS.CONTROLLER_ADMIN_RESULT(), result, { qos: SHARED.QOS_COMMANDS, retain: false });
  }

  private publish(topic: string, payload: unknown, opts: IClientPublishOptions): void {
    if (!this.client || !this.connected) {
      console.warn(`[ControllerMqtt] cannot publish to ${topic} - not connected`);
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.client.publish(topic, body, opts, (err) => {
      if (err) console.warn(`[ControllerMqtt] publish ${topic} failed`, err.message);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      const c = this.client;
      c.end(false, {}, () => {
        this.connected = false;
        this.client = null;
        resolve();
      });
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const TABLE_TOPIC_REGEX = /^penpito\/v2\/mobile\/table\/(\d+)\/order\/(submit|cancel|served)$/;
const QUEUE_REQ_REGEX = /^penpito\/v2\/mobile\/table\/(\d+)\/queue\/request$/;

export function extractTableId(topic: string): number | null {
  let match = TABLE_TOPIC_REGEX.exec(topic);
  if (match) return Number(match[1]);
  match = QUEUE_REQ_REGEX.exec(topic);
  if (match) return Number(match[1]);
  return null;
}
