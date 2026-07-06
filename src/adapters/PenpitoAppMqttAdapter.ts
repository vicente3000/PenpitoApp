/**
 * Cliente MQTT v2 para la app móvil.
 *
 * Rol en la arquitectura:
 *  - Sometimiento de pedidos: publica `mobile/table/{N}/order/submit`.
 *  - Cancelación: `mobile/table/{N}/order/cancel`.
 *  - Confirmación de servido: `mobile/table/{N}/order/served`.
 *  - Solicitud de snapshot: `mobile/table/{N}/queue/request`.
 *  - Solicitud de hardware autoritativo: `mobile/hardware/request`.
 *
 * La app NO publica comandos de hardware. Esos los publica únicamente el
 * Order Controller. Esto elimina por construcción la condición de carrera
 * donde dos teléfonos publican PREPARE simultáneamente.
 *
 * Lo que la app recibe:
 *  - `controller/table/{N}/queue` (retained, snapshot FIFO autoritativo)
 *  - `controller/table/{N}/event` (OrderEvent por orderId)
 *  - `controller/hardware/state` (retained, snapshot del hardware autoritativo)
 *  - `hardware/state` (retained del ESP32) — solo lectura, el controller lo canibaliza
 *  - `hardware/presence` (LWT)
 */

import { ICommunicationAdapter, ConnectionSnapshot, ConnectionStatus } from './ICommunicationAdapter';
import {
  parseQueueSnapshot,
  parseOrderEvent,
  parseHardwareState,
  parseCommandAck,
} from '../protocol/parsers';
import {
  TOPICS,
  SUBSCRIBE_PATTERNS,
  SHARED,
} from '../protocol/topics';
import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  OrderEvent,
  OrderEnvelope,
  PROTOCOL_VERSION,
  QueueSnapshot,
} from '../protocol/types';
import {
  MachineState,
  PreparationStepId,
} from '../models';

const MQTT_KEEPALIVE_SECONDS = 30;
const COMMAND_ACK_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = MQTT_KEEPALIVE_SECONDS * 500;
const CONNECT_TIMEOUT_MS = 8_000;
const PUBLISH_QUEUE_LIMIT = 200;
const DEVICE_STALE_AFTER_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 3_000;
const DEFAULT_MQTT_WS_URL = 'ws://172.20.10.7:9001';

function decorrelatedJitter(attempt: number): number {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
  const base = Math.min(cap, RECONNECT_BASE_MS * 3);
  return Math.min(RECONNECT_MAX_MS, base + Math.random() * cap);
}

function encodeUtf8(value: string): number[] {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(value));
  }
  return Array.from(unescape(encodeURIComponent(value))).map((c) => (c as string).charCodeAt(0));
}

function safeDecodeUtf8(bytes: Uint8Array, offset: number, length: number): string {
  try {
    const slice = bytes.subarray(offset, offset + length);
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(slice);
    }
    let raw = '';
    slice.forEach((byte) => {
      raw += String.fromCharCode(byte);
    });
    try {
      return decodeURIComponent(escape(raw));
    } catch {
      return raw;
    }
  } catch {
    return '';
  }
}

function encodeString(value: string) {
  const payload = encodeUtf8(value);
  return [(payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
}

function encodeRemainingLength(value: number) {
  const output: number[] = [];
  let remaining = value;
  do {
    let encoded = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) encoded |= 128;
    output.push(encoded);
  } while (remaining > 0);
  return output;
}

function makePacket(header: number, body: number[]) {
  return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]);
}

function toPacketIdBytes(packetId: number) {
  return [(packetId >> 8) & 0xff, packetId & 0xff];
}

function makeClientId() {
  return `penpito-mobile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeRequestId() {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function dataToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === 'string') {
    return new Uint8Array(encodeUtf8(data));
  }
  return new Uint8Array();
}

type MqttMessageHandler = (topic: string, payload: string, retain: boolean) => void;

class MinimalMqttWebSocketClient {
  private socket: WebSocket | null = null;
  private packetId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private pendingQos1Packets = new Set<number>();

  constructor(
    private readonly url: string,
    private readonly clientId: string,
    private readonly onMessage: MqttMessageHandler,
    private readonly onClose: () => void
  ) {}

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            clearInterval(checkInterval);
            resolve();
          } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
            clearInterval(checkInterval);
            reject(new Error('MQTT WebSocket conexión abortada'));
          }
        }, 100);
      });
    }

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimeout = setTimeout(() => {
        this.rejectConnect(new Error('Timeout conectando a Mosquitto.'));
        this.socket?.close();
      }, CONNECT_TIMEOUT_MS);

      const socket = new WebSocket(this.url, 'mqtt');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => this.sendConnect();
      socket.onmessage = (event: { data: unknown }) => {
        void this.handlePacket(event.data);
      };
      socket.onerror = () => {
        this.rejectConnect(new Error('No se pudo abrir MQTT por WebSocket.'));
      };
      socket.onclose = () => {
        if (this.connectReject) {
          this.rejectConnect(new Error('MQTT WebSocket cerrado antes de conectar.'));
        }
        this.stopPing();
        this.pendingQos1Packets.clear();
        this.onClose();
      };
      this.socket = socket;
    });
  }

  disconnect() {
    this.stopPing();
    this.pendingQos1Packets.clear();
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.sendPacket(makePacket(0xe0, []));
      } catch {
        // ignore
      }
    }
    this.socket?.close();
    this.socket = null;
  }

  subscribe(topic: string, qos: 0 | 1 = 0) {
    const packetId = this.nextPacketId();
    const body = [...toPacketIdBytes(packetId), ...encodeString(topic), qos];
    this.sendPacket(makePacket(0x82, body));
  }

  unsubscribe(topic: string) {
    const packetId = this.nextPacketId();
    const body = [...toPacketIdBytes(packetId), ...encodeString(topic)];
    try {
      this.sendPacket(makePacket(0xa2, body));
    } catch (err) {
      console.warn(`[MinimalMqtt] unsubscribe ${topic} failed`, err);
    }
  }

  publish(topic: string, payload: string, qos: 0 | 1 = 0, retain = false) {
    if (qos === 1) {
      let packetId = this.nextPacketId();
      let attempts = 0;
      while (this.pendingQos1Packets.has(packetId) && attempts < 100) {
        packetId = this.nextPacketId();
        attempts += 1;
      }
      this.pendingQos1Packets.add(packetId);
      const body = [...encodeString(topic), ...toPacketIdBytes(packetId), ...encodeUtf8(payload)];
      const header = retain ? 0x33 : 0x32;
      this.sendPacket(makePacket(header, body));
    } else {
      const body = [...encodeString(topic), ...encodeUtf8(payload)];
      const header = retain ? 0x31 : 0x30;
      this.sendPacket(makePacket(header, body));
    }
  }

  private sendConnect() {
    const variableHeader = [
      ...encodeString('MQTT'),
      4,
      2,
      (MQTT_KEEPALIVE_SECONDS >> 8) & 0xff,
      MQTT_KEEPALIVE_SECONDS & 0xff,
    ];
    const payload = encodeString(this.clientId);
    this.sendPacket(makePacket(0x10, [...variableHeader, ...payload]));
  }

  private async handlePacket(data: unknown) {
    try {
      const packet = await dataToBytes(data);
      if (packet.length < 2) return;
      const packetType = packet[0] >> 4;
      const remaining = this.decodeRemainingLength(packet, 1);
      const bodyStart = 1 + remaining.bytesRead;
      const bodyEnd = bodyStart + remaining.value;
      if (bodyEnd > packet.length || bodyStart > packet.length) return;

      if (packetType === 2) {
        const returnCode = packet[bodyStart + 1];
        if (returnCode === 0) {
          this.resolveConnect();
          this.startPing();
        } else {
          this.rejectConnect(new Error(`MQTT CONNACK ${returnCode}`));
        }
        return;
      }
      if (packetType === 4) {
        if (bodyStart + 2 <= bodyEnd) {
          const ackedId = (packet[bodyStart] << 8) | packet[bodyStart + 1];
          this.pendingQos1Packets.delete(ackedId);
        }
        return;
      }
      if (packetType !== 3) return;
      const retainFlag = (packet[0] & 0x01) === 0x01;
      const qos = (packet[0] >> 1) & 0x03;
      let cursor = bodyStart;
      if (cursor + 2 > bodyEnd) return;
      const topicLength = (packet[cursor] << 8) | packet[cursor + 1];
      cursor += 2;
      if (cursor + topicLength > bodyEnd || topicLength < 0) return;
      const topic = safeDecodeUtf8(packet, cursor, topicLength);
      cursor += topicLength;
      let packetId: number | undefined;
      if (qos > 0) {
        if (cursor + 2 > bodyEnd) return;
        packetId = (packet[cursor] << 8) | packet[cursor + 1];
        cursor += 2;
        if (qos === 1) {
          try {
            this.sendPacket(makePacket(0x40, toPacketIdBytes(packetId)));
          } catch {
            // ignore
          }
        }
      }
      const payload = safeDecodeUtf8(packet, cursor, bodyEnd - cursor);
      this.onMessage(topic, payload, retainFlag);
    } catch (err) {
      console.warn('[MinimalMqtt] Paquete MQTT inválido descartado.', err);
    }
  }

  private decodeRemainingLength(packet: Uint8Array, offset: number) {
    let multiplier = 1;
    let value = 0;
    let bytesRead = 0;
    let encoded = 0;
    do {
      if (offset + bytesRead >= packet.length) break;
      encoded = packet[offset + bytesRead];
      value += (encoded & 127) * multiplier;
      multiplier *= 128;
      bytesRead += 1;
    } while ((encoded & 128) !== 0 && bytesRead < 4);
    return { value, bytesRead };
  }

  private sendPacket(packet: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('MQTT socket no conectado');
    }
    this.socket.send(packet);
  }

  private nextPacketId() {
    this.packetId = this.packetId >= 65535 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  private resolveConnect() {
    this.clearConnectTimeout();
    this.connectResolve?.();
    this.connectResolve = null;
    this.connectReject = null;
  }

  private rejectConnect(error: Error) {
    this.clearConnectTimeout();
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
  }

  private clearConnectTimeout() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.disconnect();
        return;
      }
      try {
        this.sendPacket(makePacket(0xc0, []));
      } catch {
        this.disconnect();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

let customMqttUrl: string | null = null;

export function setCustomMqttUrl(url: string | null) {
  customMqttUrl = url && url.trim().length > 0 ? url.trim() : null;
}

export function getMqttUrl(): string {
  return customMqttUrl || process.env.EXPO_PUBLIC_MQTT_WS_URL || DEFAULT_MQTT_WS_URL;
}

export type QueueSnapshotListener = (snapshot: QueueSnapshot) => void;
export type OrderEventListener = (event: OrderEvent) => void;
export type HardwareAuthoritativeListener = (state: HardwareState) => void;
export type AdminResultListener = (ack: CommandAck) => void;

export interface MqttV2Events {
  onQueueSnapshot(listener: QueueSnapshotListener): () => void;
  onOrderEvent(listener: OrderEventListener): () => void;
  onHardwareAuthoritativeState(listener: HardwareAuthoritativeListener): () => void;
  onAdminResult(listener: AdminResultListener): () => void;
}

/**
 * Interfaz v2 que reemplaza ICommunicationAdapter para los stores.
 * La app NO envía comandos de hardware; la responsabilidad de
 * coordinar el hardware vive en el Order Controller.
 */
export interface IAppV2Adapter {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  onStateChange(callback: (state: MachineState) => void): () => void;
  onConnectionChange(callback: (snapshot: ConnectionSnapshot) => void): () => void;
  /** Suscribirse a un topic arbitrario (compatibilidad con stores que aún publican en v1). */
  subscribeCustom(topic: string, callback: (payload: string) => void): () => void;
  /** Publicar en un topic arbitrario. Usar solo para `mobile/...`. */
  publish(topic: string, payload: string): void;
  /** Someter un pedido al controller. */
  submitOrder(envelope: OrderEnvelope): Promise<{ commandId: string }>;
  /** Cancelar un pedido. */
  cancelOrder(tableId: number, orderId: string): Promise<void>;
  /** Marcar pedido como servido. */
  markOrderServed(tableId: number, orderId: string): Promise<void>;
  /** Pedir un snapshot fresco. */
  requestQueueSnapshot(tableId: number): void;
  /**
   * Envía un comando administrativo (POWER, CLEAN, SET_CALIB, TEST_HW, EMERGENCY_STOP,
   * CONFIG_WIFI) al controller. El controller lo reenvía al ESP32. Devuelve una
   * promesa que se resuelve con el CommandAck cuando el hardware confirma.
   */
  submitAdminCommand(command: CommandEnvelope, timeoutMs?: number): Promise<CommandAck>;
  /** Listeners v2. */
  onQueueSnapshot(listener: QueueSnapshotListener): () => void;
  onOrderEvent(listener: OrderEventListener): () => void;
  onHardwareAuthoritativeState(listener: HardwareAuthoritativeListener): () => void;
  onAdminResult(listener: AdminResultListener): () => void;
}

export class PenpitoAppMqttAdapter implements IAppV2Adapter {
  private client: MinimalMqttWebSocketClient | null = null;
  private isConnected = false;
  private connectPromise: Promise<boolean> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private currentBrokerStatus: ConnectionStatus = 'disconnected';
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private deviceOnline = false;
  private lastDeviceMessageAt: number | null = null;
  private lastAuthoritativeHardware: HardwareState | null = null;
  private lastRawHardwareState: MachineState | null = null;
  private connectionListeners = new Set<(s: ConnectionSnapshot) => void>();
  private stateListeners = new Set<(s: MachineState) => void>();
  private queueSnapshotListeners = new Set<QueueSnapshotListener>();
  private orderEventListeners = new Set<OrderEventListener>();
  private hwAuthListeners = new Set<HardwareAuthoritativeListener>();
  private adminResultListeners = new Set<AdminResultListener>();
  private customSubscribers = new Map<string, Set<(payload: string) => void>>();
  private pendingSubscribes = new Set<string>();
  private publishQueue: Array<{ topic: string; payload: string }> = [];

  constructor(private readonly brokerUrl: string = getMqttUrl()) {}

  async connect(): Promise<boolean> {
    this.shouldReconnect = true;
    if (this.isConnected) return true;
    if (this.connectPromise) return this.connectPromise;
    const wasReconnecting = this.reconnectTimer !== null || this.reconnectAttempts > 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (wasReconnecting) {
      this.fireConnectionChange('reconnecting');
    } else if (this.currentBrokerStatus !== 'connected') {
      this.fireConnectionChange('connecting');
    }
    this.connectPromise = this.openConnection();
    const result = await this.connectPromise;
    this.connectPromise = null;
    return result;
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    this.publishQueue = [];
    this.pendingSubscribes.clear();
    this.client?.disconnect();
    this.client = null;
    this.isConnected = false;
    this.deviceOnline = false;
    this.fireConnectionChange('disconnected');
  }

  async submitOrder(envelope: OrderEnvelope): Promise<{ commandId: string }> {
    if (!envelope) throw new Error('envelope required');
    const commandId = envelope.commandId;
    const connected = await this.connect();
    if (!connected || !this.client) {
      throw new Error('mqtt_not_connected');
    }
    this.client.publish(
      TOPICS.MOBILE_ORDER_SUBMIT(envelope.tableId),
      JSON.stringify(envelope),
      SHARED.QOS_COMMANDS,
      false
    );
    return { commandId };
  }

  async cancelOrder(tableId: number, orderId: string): Promise<void> {
    const connected = await this.connect();
    if (!connected || !this.client) throw new Error('mqtt_not_connected');
    this.client.publish(
      TOPICS.MOBILE_ORDER_CANCEL(tableId),
      JSON.stringify({ orderId, tableId, commandId: makeRequestId() }),
      SHARED.QOS_COMMANDS,
      false
    );
  }

  async markOrderServed(tableId: number, orderId: string): Promise<void> {
    const connected = await this.connect();
    if (!connected || !this.client) throw new Error('mqtt_not_connected');
    this.client.publish(
      TOPICS.MOBILE_ORDER_SERVED(tableId),
      JSON.stringify({ orderId, tableId, commandId: makeRequestId() }),
      SHARED.QOS_COMMANDS,
      false
    );
  }

  requestQueueSnapshot(tableId: number): void {
    if (!this.client || !this.isConnected) return;
    this.client.publish(
      TOPICS.MOBILE_QUEUE_REQUEST(tableId),
      JSON.stringify({ tableId, ts: Date.now() }),
      0,
      false
    );
  }

  async submitAdminCommand(command: CommandEnvelope, timeoutMs = COMMAND_ACK_TIMEOUT_MS): Promise<CommandAck> {
    if (!command || !command.commandId || !command.type) {
      throw new Error('admin_command_invalid');
    }
    const connected = await this.connect();
    if (!connected || !this.client) {
      throw new Error('mqtt_not_connected');
    }
    const envelope: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: command.commandId,
      type: command.type,
      issuedBy: 'mobile',
      issuedAt: Date.now(),
    };
    if (command.payload) envelope.payload = command.payload;
    if (command.orderId) envelope.orderId = command.orderId;
    if (command.tableId) envelope.tableId = command.tableId;

    return await new Promise<CommandAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('admin_command_timeout'));
      }, timeoutMs);
      const unsub = this.onAdminResult((ack) => {
        if (ack.commandId === envelope.commandId) {
          clearTimeout(timer);
          unsub();
          resolve(ack);
        }
      });
      try {
        this.client!.publish(
          TOPICS.MOBILE_ADMIN_COMMAND(),
          JSON.stringify(envelope),
          SHARED.QOS_COMMANDS,
          false
        );
      } catch (err) {
        clearTimeout(timer);
        unsub();
        reject(err instanceof Error ? err : new Error('admin_command_publish_failed'));
      }
    });
  }

  onStateChange(callback: (state: MachineState) => void): () => void {
    this.stateListeners.add(callback);
    if (this.lastRawHardwareState) callback({ ...this.lastRawHardwareState });
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  onConnectionChange(callback: (snapshot: ConnectionSnapshot) => void): () => void {
    this.connectionListeners.add(callback);
    callback(this.buildConnectionSnapshot());
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  onQueueSnapshot(listener: QueueSnapshotListener): () => void {
    this.queueSnapshotListeners.add(listener);
    return () => {
      this.queueSnapshotListeners.delete(listener);
    };
  }

  onOrderEvent(listener: OrderEventListener): () => void {
    this.orderEventListeners.add(listener);
    return () => {
      this.orderEventListeners.delete(listener);
    };
  }

  onHardwareAuthoritativeState(listener: HardwareAuthoritativeListener): () => void {
    this.hwAuthListeners.add(listener);
    if (this.lastAuthoritativeHardware) listener(this.lastAuthoritativeHardware);
    return () => {
      this.hwAuthListeners.delete(listener);
    };
  }

  onAdminResult(listener: AdminResultListener): () => void {
    this.adminResultListeners.add(listener);
    return () => {
      this.adminResultListeners.delete(listener);
    };
  }

  subscribeCustom(topic: string, callback: (payload: string) => void): () => void {
    if (!this.customSubscribers.has(topic)) {
      this.customSubscribers.set(topic, new Set());
      this.pendingSubscribes.add(topic);
      if (this.isConnected && this.client) {
        this.client.subscribe(topic, SHARED.QOS_COMMANDS);
        this.pendingSubscribes.delete(topic);
      }
    }
    this.customSubscribers.get(topic)!.add(callback);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const subs = this.customSubscribers.get(topic);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.customSubscribers.delete(topic);
          this.pendingSubscribes.delete(topic);
          // Liberar la suscripción MQTT para no acumular filtros en el broker.
          if (this.isConnected && this.client) {
            try {
              this.client.unsubscribe(topic);
            } catch (err) {
              console.warn(`[AppMqtt] unsubscribe ${topic} failed`, err);
            }
          }
        }
      }
    };
  }

  publish(topic: string, payload: string): void {
    if (typeof topic !== 'string' || topic.length === 0) {
      console.warn('[AppMqtt] publish: topic inválido descartado.');
      return;
    }
    if (this.isConnected && this.client) {
      try {
        // Regla: la app no publica en `controller/...` ni en `hardware/...`.
        if (topic.startsWith('penpito/v2/controller/') || topic.startsWith('penpito/v2/hardware/')) {
          console.warn('[AppMqtt] publish bloqueado: la app no puede escribir en el bus de controller/hardware.');
          return;
        }
        this.client.publish(topic, payload, 0, false);
        return;
      } catch (error) {
        console.warn(`[AppMqtt] Error publishing to topic: ${topic}`, error);
      }
    }
    if (this.publishQueue.length >= PUBLISH_QUEUE_LIMIT) this.publishQueue.shift();
    this.publishQueue.push({ topic, payload });
  }

  private async openConnection(): Promise<boolean> {
    try {
      const client = new MinimalMqttWebSocketClient(
        this.brokerUrl,
        makeClientId(),
        (topic, payload, retain) => this.handleMessage(topic, payload, retain),
        () => {
          this.isConnected = false;
          this.fireConnectionChange('disconnected');
          if (this.shouldReconnect) this.scheduleReconnect();
        }
      );
      await client.connect();
      // Suscripciones v2
      client.subscribe(`penpito/v2/controller/table/+/queue`, SHARED.QOS_STATE);
      client.subscribe(`penpito/v2/controller/table/+/event`, SHARED.QOS_EVENTS);
      client.subscribe(`penpito/v2/controller/hardware/state`, SHARED.QOS_STATE);
      client.subscribe(TOPICS.CONTROLLER_ADMIN_RESULT(), SHARED.QOS_COMMANDS);
      client.subscribe(TOPICS.HARDWARE_PRESENCE(), SHARED.QOS_PRESENCE);
      // Compatibilidad v1: solo lectura (lo que la app necesita para UI/debug).
      // No suscribimos a `penpito/kraken/state` para evitar doble fuente de verdad.
      this.customSubscribers.forEach((_, topic) => {
        client.subscribe(topic, SHARED.QOS_COMMANDS);
        this.pendingSubscribes.delete(topic);
      });
      this.client = client;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startStaleCheck();
      this.fireConnectionChange('connected');
      this.flushPublishQueue();
      return true;
    } catch (error) {
      console.warn('[AppMqtt] Could not connect to Mosquitto.', error);
      this.isConnected = false;
      this.reconnectAttempts += 1;
      this.fireConnectionChange('error', 'No se pudo conectar con Mosquitto.');
      if (this.shouldReconnect) this.scheduleReconnect();
      return false;
    }
  }

  private flushPublishQueue(): void {
    if (!this.client || this.publishQueue.length === 0) return;
    const queue = this.publishQueue;
    this.publishQueue = [];
    for (const item of queue) {
      try {
        this.client.publish(item.topic, item.payload, 0, false);
      } catch (err) {
        console.warn(`[AppMqtt] Error vaciando cola en ${item.topic}`, err);
      }
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer || this.isConnected) return;
    const delay = decorrelatedJitter(this.reconnectAttempts);
    this.fireConnectionChange('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.reconnectAttempts += 1;
        void this.connect();
      }
    }, delay);
  }

  private handleMessage(topic: string, payload: string, retain: boolean): void {
    try {
      // Presencia del hardware
      if (topic === TOPICS.HARDWARE_PRESENCE()) {
        const online = payload.trim() === 'online';
        this.deviceOnline = online;
        this.lastDeviceMessageAt = online ? Date.now() : null;
        this.fireConnectionChange();
        return;
      }

      // Snapshots de cola
      if (/^penpito\/v2\/controller\/table\/\d+\/queue$/.test(topic)) {
        const snap = parseQueueSnapshot(safeJson(payload));
        if (snap) {
          this.queueSnapshotListeners.forEach((cb) => {
            try {
              cb(snap);
            } catch (e) {
              console.error('[AppMqtt] queue snapshot listener error', e);
            }
          });
        }
        return;
      }

      // Eventos de pedido
      if (/^penpito\/v2\/controller\/table\/\d+\/event$/.test(topic)) {
        const event = parseOrderEvent(safeJson(payload));
        if (event) {
          this.orderEventListeners.forEach((cb) => {
            try {
              cb(event);
            } catch (e) {
              console.error('[AppMqtt] order event listener error', e);
            }
          });
        }
        return;
      }

      // Estado autoritativo del hardware (publicado por el controller).
      if (topic === TOPICS.CONTROLLER_HARDWARE_STATE()) {
        const state = parseHardwareState(safeJson(payload));
        if (state) {
          this.lastAuthoritativeHardware = state;
          this.lastRawHardwareState = {
            isOn: state.isOn,
            status: state.status,
            errorMessage: state.errorMessage ?? undefined,
            currentRecipeId: state.activeOrderId ?? undefined,
            requestedIceCount: undefined,
            activeStepId: (state.activeStepId ?? undefined) as PreparationStepId | undefined,
            completedStepIds: state.completedStepIds as PreparationStepId[],
            skippedStepIds: state.skippedStepIds as PreparationStepId[],
            isDrinkReady: state.isDrinkReady,
          };
          this.hwAuthListeners.forEach((cb) => {
            try {
              cb(state);
            } catch (e) {
              console.error('[AppMqtt] hw auth listener error', e);
            }
          });
          this.fireStateChange();
        }
        return;
      }

      // Resultado de un comando administrativo (POWER, CLEAN, SET_CALIB, etc.)
      if (topic === TOPICS.CONTROLLER_ADMIN_RESULT()) {
        const ack = parseCommandAck(safeJson(payload));
        if (ack) {
          this.adminResultListeners.forEach((cb) => {
            try {
              cb(ack);
            } catch (e) {
              console.error('[AppMqtt] admin result listener error', e);
            }
          });
        }
        return;
      }

      // Custom subscribers
      const subs = this.customSubscribers.get(topic);
      if (subs) {
        subs.forEach((cb) => {
          try {
            cb(payload);
          } catch (err) {
            console.error(`[AppMqtt] Error in custom subscriber callback for topic ${topic}`, err);
          }
        });
      }
      // Suppress unused 'retain' warning
      void retain;
    } catch (err) {
      console.warn('[AppMqtt] Invalid MQTT payload.', err);
    }
  }

  private buildConnectionSnapshot(): ConnectionSnapshot {
    return {
      broker: this.currentBrokerStatus,
      deviceOnline: this.isDeviceFresh(),
      lastDeviceMessageAt: this.lastDeviceMessageAt,
      error: this.currentBrokerStatus === 'error' ? 'mqtt_unreachable' : null,
    };
  }

  private fireConnectionChange(statusOverride?: ConnectionStatus, errorMsg: string | null = null) {
    if (statusOverride) this.currentBrokerStatus = statusOverride;
    else this.currentBrokerStatus = this.isConnected ? 'connected' : 'disconnected';
    const snap = this.buildConnectionSnapshot();
    this.connectionListeners.forEach((cb) => {
      try {
        cb(snap);
      } catch (e) {
        console.warn('[AppMqtt] onConnectionChange listener error', e);
      }
    });
  }

  private fireStateChange() {
    if (!this.lastRawHardwareState) return;
    const snap = { ...this.lastRawHardwareState };
    this.stateListeners.forEach((cb) => {
      try {
        cb(snap);
      } catch (e) {
        console.warn('[AppMqtt] onStateChange listener error', e);
      }
    });
  }

  private isDeviceFresh(): boolean {
    if (!this.deviceOnline) return false;
    if (this.lastDeviceMessageAt == null) return false;
    return Date.now() - this.lastDeviceMessageAt < DEVICE_STALE_AFTER_MS;
  }

  private startStaleCheck() {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = setInterval(() => {
      const fresh = this.isDeviceFresh();
      if (this.deviceOnline && !fresh) {
        this.deviceOnline = false;
        this.fireConnectionChange();
      } else if (!this.deviceOnline && fresh) {
        this.deviceOnline = true;
        this.fireConnectionChange();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
