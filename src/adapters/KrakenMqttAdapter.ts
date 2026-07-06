import { ICommunicationAdapter, ConnectionSnapshot, ConnectionStatus } from './ICommunicationAdapter';
import { DeviceCommand, MachineState } from '../models';
import { parseMachineState, parseAck, isValidDeviceTarget, isValidRequestId, sanitizeCommand } from './payloadParsers';

const DEFAULT_MQTT_WS_URL = 'ws://192.168.243.219:9001';
const MQTT_KEEPALIVE_SECONDS = 30;
const COMMAND_ACK_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = MQTT_KEEPALIVE_SECONDS * 500;
const CONNECT_TIMEOUT_MS = 8000;
const PUBLISH_QUEUE_LIMIT = 200;
const DEVICE_STALE_AFTER_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 3000;

function decorrelatedJitter(attempt: number): number {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
  const base = Math.min(cap, RECONNECT_BASE_MS * 3);
  return Math.min(RECONNECT_MAX_MS, base + Math.random() * cap);
}

const TOPIC_STATE = 'penpito/kraken/state';
const TOPIC_COMMAND = 'penpito/kraken/command';
const TOPIC_ACK = 'penpito/kraken/command/ack';
const TOPIC_PRESENCE = 'penpito/kraken/presence';
const TOPIC_REQUEST_STATE = 'penpito/kraken/request_state';
const DEVICE_IDS = ['pumps', 'motor', 'kraken'] as const;

const initialState: MachineState = {
  isOn: false,
  status: 'idle',
  currentRecipeId: undefined,
  requestedIceCount: 2,
  activeStepId: undefined,
  completedStepIds: [],
  skippedStepIds: [],
  isDrinkReady: false,
};

type PendingAck = {
  resolve: (success: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type QueuedPublish = {
  topic: string;
  payload: string;
  qos: 0 | 1;
};

type MqttMessageHandler = (topic: string, payload: string, retain: boolean) => void;

let customMqttUrl: string | null = null;

export function setCustomMqttUrl(url: string | null) {
  customMqttUrl = url && url.trim().length > 0 ? url.trim() : null;
}

export function getMqttUrl() {
  return customMqttUrl || process.env.EXPO_PUBLIC_MQTT_WS_URL || DEFAULT_MQTT_WS_URL;
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
    if (remaining > 0) {
      encoded |= 128;
    }
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
  return `penpito-app-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeRequestId() {
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getDeviceTopic(deviceId: DeviceCommand['target'], suffix: 'state' | 'command' | 'command/ack') {
  return `penpito/${deviceId}/${suffix}`;
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

  subscribe(topic: string) {
    const packetId = this.nextPacketId();
    const body = [...toPacketIdBytes(packetId), ...encodeString(topic), 0];
    this.sendPacket(makePacket(0x82, body));
  }

  publish(topic: string, payload: string, qos: 0 | 1 = 0) {
    if (qos === 1) {
      let packetId = this.nextPacketId();
      let attempts = 0;
      while (this.pendingQos1Packets.has(packetId) && attempts < 100) {
        packetId = this.nextPacketId();
        attempts += 1;
      }
      this.pendingQos1Packets.add(packetId);
      const body = [...encodeString(topic), ...toPacketIdBytes(packetId), ...encodeUtf8(payload)];
      this.sendPacket(makePacket(0x32, body));
    } else {
      const body = [...encodeString(topic), ...encodeUtf8(payload)];
      this.sendPacket(makePacket(0x30, body));
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
      if (packet.length < 2) {
        return;
      }

      const packetType = packet[0] >> 4;
      const remaining = this.decodeRemainingLength(packet, 1);
      const bodyStart = 1 + remaining.bytesRead;
      const bodyEnd = bodyStart + remaining.value;

      if (bodyEnd > packet.length || bodyStart > packet.length) {
        return;
      }

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

      if (packetType !== 3) {
        return;
      }

      const retainFlag = (packet[0] & 0x01) === 0x01;
      const qos = (packet[0] >> 1) & 0x03;
      let cursor = bodyStart;
      if (cursor + 2 > bodyEnd) {
        return;
      }
      const topicLength = (packet[cursor] << 8) | packet[cursor + 1];
      cursor += 2;
      if (cursor + topicLength > bodyEnd || topicLength < 0) {
        return;
      }
      const topic = safeDecodeUtf8(packet, cursor, topicLength);
      cursor += topicLength;
      let packetId: number | undefined;
      if (qos > 0) {
        if (cursor + 2 > bodyEnd) {
          return;
        }
        packetId = (packet[cursor] << 8) | packet[cursor + 1];
        cursor += 2;
        if (qos === 1) {
          try {
            this.sendPacket(makePacket(0x40, toPacketIdBytes(packetId)));
          } catch {
            // ignore if socket closed
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
      if (offset + bytesRead >= packet.length) {
        break;
      }
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

export class KrakenMqttAdapter implements ICommunicationAdapter {
  private client: MinimalMqttWebSocketClient | null = null;
  private isConnected = false;
  private stateListeners = new Set<(state: MachineState) => void>();
  private currentState: MachineState = initialState;
  private lastEmittedState: MachineState = initialState;
  private pendingAcks = new Map<string, PendingAck>();
  private connectPromise: Promise<boolean> | null = null;
  private customSubscribers = new Map<string, Set<(payload: string) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceOnline = false;
  private lastDeviceMessageAt: number | null = null;
  private connectionListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private currentBrokerStatus: ConnectionStatus = 'disconnected';
  private publishQueue: QueuedPublish[] = [];
  private pendingSubscribes = new Set<string>();
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly brokerUrl = getMqttUrl()) {}

  async connect(): Promise<boolean> {
    this.shouldReconnect = true;
    if (this.isConnected) {
      return true;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    // Distinguir reconexion (timer pendiente) de conexion inicial sin depender
    // del estado racy del timer, que ya fue limpiado arriba.
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
    this.failAllPendingAcks();
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    const safe = sanitizeCommand(command);
    const requestId = isValidRequestId(safe.requestId) ? (safe.requestId as string) : makeRequestId();
    const payload = JSON.stringify({ ...safe, requestId });
    const commandTopic = isValidDeviceTarget(safe.target) ? getDeviceTopic(safe.target, 'command') : TOPIC_COMMAND;

    const tryPublish = (): boolean => {
      if (!this.client) return false;
      try {
        this.client.publish(commandTopic, payload, 1);
        return true;
      } catch (error) {
        console.warn('[KrakenMqttAdapter] Error publishing command.', error);
        return false;
      }
    };

    // Single intento en el adapter; CommandQueueService reintenta independientemente.
    // Evita publicar el mismo requestId multiples veces (duplicados en el ESP32).
    const connected = await this.connect();
    if (!connected || !this.client) {
      return false;
    }
    if (!tryPublish()) {
      this.isConnected = false;
      this.failAllPendingAcks();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
      return false;
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        resolve(false);
      }, COMMAND_ACK_TIMEOUT_MS);
      this.pendingAcks.set(requestId, { resolve, timeout });
    });
  }

  onStateChange(callback: (state: MachineState) => void): () => void {
    this.stateListeners.add(callback);
    callback({ ...this.currentState });
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  onConnectionChange(callback: (snapshot: ConnectionSnapshot) => void): () => void {
    this.connectionListeners.add(callback);
    callback({
      broker: this.currentBrokerStatus,
      deviceOnline: this.deviceOnline,
      lastDeviceMessageAt: this.lastDeviceMessageAt,
      error: null,
    });
    return () => {
      this.connectionListeners.delete(callback);
    };
  }

  private fireConnectionChange(statusOverride?: ConnectionStatus, errorMsg: string | null = null) {
    if (statusOverride) {
      this.currentBrokerStatus = statusOverride;
    } else {
      this.currentBrokerStatus = this.isConnected ? 'connected' : 'disconnected';
    }
    const fresh = this.isDeviceFresh();
    const snapshot: ConnectionSnapshot = {
      broker: this.currentBrokerStatus,
      deviceOnline: fresh,
      lastDeviceMessageAt: this.lastDeviceMessageAt,
      error: errorMsg,
    };
    this.connectionListeners.forEach((cb) => {
      try {
        cb(snapshot);
      } catch (err) {
        console.warn('[KrakenMqttAdapter] Error en onConnectionChange listener.', err);
      }
    });
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer || this.isConnected) {
      return;
    }
    const delay = decorrelatedJitter(this.reconnectAttempts);
    console.log(`[KrakenMqttAdapter] Reconexión en ${Math.round(delay)}ms (intento #${this.reconnectAttempts})`);
    this.fireConnectionChange('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.reconnectAttempts += 1;
        void this.connect();
      }
    }, delay);
  }

  publish(topic: string, payload: string) {
    if (typeof topic !== 'string' || topic.length === 0) {
      console.warn('[KrakenMqttAdapter] publish: topic inválido descartado.');
      return;
    }
    if (this.isConnected && this.client) {
      try {
        this.client.publish(topic, payload, 0);
        return;
      } catch (error) {
        console.warn(`[KrakenMqttAdapter] Error publishing to topic: ${topic}`, error);
        this.isConnected = false;
        this.failAllPendingAcks();
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      }
    }
    if (this.publishQueue.length >= PUBLISH_QUEUE_LIMIT) {
      this.publishQueue.shift();
    }
    this.publishQueue.push({ topic, payload, qos: 0 });
  }

  subscribeCustom(topic: string, callback: (payload: string) => void): () => void {
    if (typeof topic !== 'string' || topic.length === 0) {
      console.warn('[KrakenMqttAdapter] subscribeCustom: topic inválido.');
      return () => undefined;
    }
    if (!this.customSubscribers.has(topic)) {
      this.customSubscribers.set(topic, new Set());
      this.pendingSubscribes.add(topic);
      if (this.isConnected && this.client) {
        this.client.subscribe(topic);
        this.pendingSubscribes.delete(topic);
      }
    }
    this.customSubscribers.get(topic)!.add(callback);

    return () => {
      const subs = this.customSubscribers.get(topic);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.customSubscribers.delete(topic);
          this.pendingSubscribes.delete(topic);
        }
      }
    };
  }

  private async openConnection() {
    try {
      const client = new MinimalMqttWebSocketClient(
        this.brokerUrl,
        makeClientId(),
        (topic, payload, retain) => this.handleMessage(topic, payload, retain),
        () => {
          this.isConnected = false;
          this.fireConnectionChange('disconnected');
          this.failAllPendingAcks();
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        }
      );

      await client.connect();
      client.subscribe(TOPIC_STATE);
      client.subscribe(TOPIC_ACK);
      client.subscribe(TOPIC_PRESENCE);
      DEVICE_IDS.forEach((deviceId) => {
        client.subscribe(getDeviceTopic(deviceId, 'state'));
        client.subscribe(getDeviceTopic(deviceId, 'command/ack'));
      });
      this.customSubscribers.forEach((_, topic) => {
        client.subscribe(topic);
        this.pendingSubscribes.delete(topic);
      });
      this.client = client;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startStaleCheck();
      this.fireConnectionChange('connected');

      this.requestFreshState();
      this.flushPublishQueue();

      return true;
    } catch (error) {
      console.warn('[KrakenMqttAdapter] Could not connect to Mosquitto.', error);
      this.isConnected = false;
      this.reconnectAttempts += 1;
      this.fireConnectionChange('error', 'No se pudo conectar con Mosquitto.');
      // NO mutar MachineState.status:'error' — es fallo de RED, no de HARDWARE.
      // El ConnectionSnapshot.error ya transporta el mensaje a la UI.
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
      return false;
    }
  }

  // Best-effort: solo el simulador responde. El estado RETAINED del broker
  // ya llega al resuscribir en openConnection, asi que la UI se sincroniza
  // igual con ESP32 (que no atiende este topico).
  private requestFreshState() {
    if (this.client) {
      try {
        this.client.publish(TOPIC_REQUEST_STATE, JSON.stringify({ ts: Date.now() }), 0);
      } catch (err) {
        console.warn('[KrakenMqttAdapter] No se pudo solicitar estado fresco.', err);
      }
    }
  }

  private flushPublishQueue() {
    if (!this.client || this.publishQueue.length === 0) {
      return;
    }
    const queue = this.publishQueue;
    this.publishQueue = [];
    for (const item of queue) {
      try {
        this.client.publish(item.topic, item.payload, item.qos);
      } catch (err) {
        console.warn(`[KrakenMqttAdapter] Error vaciando cola en ${item.topic}`, err);
      }
    }
  }

  private handleMessage(topic: string, payload: string, retain: boolean) {
    try {
      // El LWT retenido "offline" (publicado por el broker al caer el ESP32)
      // es un estado legitimo del dispositivo y debe mutar deviceOnline.
      if (topic === TOPIC_PRESENCE) {
        const online = payload.trim() === 'online';
        this.deviceOnline = online;
        this.lastDeviceMessageAt = online ? Date.now() : null;
        this.fireConnectionChange();
        return;
      }

      const subs = this.customSubscribers.get(topic);
      if (subs) {
        subs.forEach((callback) => {
          try {
            callback(payload);
          } catch (err) {
            console.error(`[KrakenMqttAdapter] Error in custom subscriber callback for topic ${topic}`, err);
          }
        });
      }

      if (topic === TOPIC_STATE || DEVICE_IDS.some((deviceId) => topic === getDeviceTopic(deviceId, 'state'))) {
        if (retain) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return;
          }
          const safe = parseMachineState(parsed, this.currentState);
          this.setState(safe);
          return;
        }
        this.deviceOnline = true;
        this.lastDeviceMessageAt = Date.now();
        this.fireConnectionChange();
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        const safe = parseMachineState(parsed, this.currentState);
        this.setState(safe);
        return;
      }

      if (topic === TOPIC_ACK || DEVICE_IDS.some((deviceId) => topic === getDeviceTopic(deviceId, 'command/ack'))) {
        this.deviceOnline = true;
        this.lastDeviceMessageAt = Date.now();
        this.fireConnectionChange();
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        const ack = parseAck(parsed, this.currentState);
        if (ack.state) {
          this.setState(ack.state);
        }
        if (ack.requestId) {
          const pending = this.pendingAcks.get(ack.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingAcks.delete(ack.requestId);
            pending.resolve(ack.ok);
          }
        }
      }
    } catch (error) {
      console.warn('[KrakenMqttAdapter] Invalid MQTT payload.', error);
    }
  }

  private setState(state: MachineState) {
    this.currentState = state;
    if (this.isSameState(this.lastEmittedState, state)) {
      return;
    }
    this.lastEmittedState = state;
    this.fireStateChange();
  }

  private isSameState(a: MachineState, b: MachineState): boolean {
    if (a === b) return true;
    return (
      a.isOn === b.isOn &&
      a.status === b.status &&
      a.errorMessage === b.errorMessage &&
      a.currentRecipeId === b.currentRecipeId &&
      a.requestedIceCount === b.requestedIceCount &&
      a.activeStepId === b.activeStepId &&
      a.isDrinkReady === b.isDrinkReady &&
      this.arrayShallowEqual(a.completedStepIds, b.completedStepIds) &&
      this.arrayShallowEqual(a.skippedStepIds, b.skippedStepIds)
    );
  }

  private arrayShallowEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    const aLen = a?.length ?? 0;
    const bLen = b?.length ?? 0;
    if (aLen !== bLen) return false;
    if (!a || !b) return aLen === 0;
    for (let i = 0; i < aLen; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private fireStateChange() {
    const snapshot = { ...this.currentState };
    this.stateListeners.forEach((cb) => {
      try {
        cb(snapshot);
      } catch (err) {
        console.warn('[KrakenMqttAdapter] Error en onStateChange listener.', err);
      }
    });
  }

  private failAllPendingAcks() {
    if (this.pendingAcks.size === 0) return;
    this.pendingAcks.forEach((entry) => {
      clearTimeout(entry.timeout);
      entry.resolve(false);
    });
    this.pendingAcks.clear();
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
