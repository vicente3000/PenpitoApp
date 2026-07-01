import { ICommunicationAdapter } from './ICommunicationAdapter';
import { DeviceCommand, MachineState } from '../models';

const DEFAULT_MQTT_WS_URL = 'ws://192.168.1.100:9001';
const MQTT_KEEPALIVE_SECONDS = 30;
const COMMAND_ACK_TIMEOUT_MS = 10000;

const TOPIC_STATE = 'penpito/kraken/state';
const TOPIC_COMMAND = 'penpito/kraken/command';
const TOPIC_ACK = 'penpito/kraken/command/ack';
const DEVICE_IDS = ['pumps', 'motor'] as const;

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

type MqttMessageHandler = (topic: string, payload: string) => void;

function getMqttUrl() {
  return process.env.EXPO_PUBLIC_MQTT_WS_URL ?? DEFAULT_MQTT_WS_URL;
}

function encodeUtf8(value: string) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(value));
  }

  return unescape(encodeURIComponent(value))
    .split('')
    .map((char) => char.charCodeAt(0));
}

function decodeUtf8(bytes: Uint8Array) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }

  let raw = '';
  bytes.forEach((byte) => {
    raw += String.fromCharCode(byte);
  });
  return decodeURIComponent(escape(raw));
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

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimeout = setTimeout(() => {
        this.rejectConnect(new Error('Timeout conectando a Mosquitto.'));
        this.socket?.close();
      }, 8000);

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
        this.onClose();
      };
      this.socket = socket;
    });
  }

  disconnect() {
    this.stopPing();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendPacket(makePacket(0xe0, []));
    }
    this.socket?.close();
    this.socket = null;
  }

  subscribe(topic: string) {
    const packetId = this.nextPacketId();
    const body = [...toPacketIdBytes(packetId), ...encodeString(topic), 0];
    this.sendPacket(makePacket(0x82, body));
  }

  publish(topic: string, payload: string) {
    const body = [...encodeString(topic), ...encodeUtf8(payload)];
    this.sendPacket(makePacket(0x30, body));
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
    const packet = await dataToBytes(data);
    if (packet.length < 2) {
      return;
    }

    const packetType = packet[0] >> 4;
    const remaining = this.decodeRemainingLength(packet, 1);
    const bodyStart = 1 + remaining.bytesRead;
    const bodyEnd = bodyStart + remaining.value;

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

    if (packetType !== 3) {
      return;
    }

    let cursor = bodyStart;
    const topicLength = (packet[cursor] << 8) | packet[cursor + 1];
    cursor += 2;
    const topic = decodeUtf8(packet.slice(cursor, cursor + topicLength));
    cursor += topicLength;
    const payload = decodeUtf8(packet.slice(cursor, bodyEnd));
    this.onMessage(topic, payload);
  }

  private decodeRemainingLength(packet: Uint8Array, offset: number) {
    let multiplier = 1;
    let value = 0;
    let bytesRead = 0;
    let encoded = 0;

    do {
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
      try {
        this.sendPacket(makePacket(0xc0, []));
      } catch {
        this.disconnect();
      }
    }, MQTT_KEEPALIVE_SECONDS * 500);
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
  private stateChangeCallback: ((state: MachineState) => void) | null = null;
  private currentState: MachineState = initialState;
  private pendingAcks = new Map<string, PendingAck>();
  private connectPromise: Promise<boolean> | null = null;

  constructor(private readonly brokerUrl = getMqttUrl()) {}

  async connect(): Promise<boolean> {
    if (this.isConnected) {
      return true;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openConnection();
    const result = await this.connectPromise;
    this.connectPromise = null;
    return result;
  }

  async disconnect(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
    this.isConnected = false;
    this.pendingAcks.forEach((entry) => {
      clearTimeout(entry.timeout);
      entry.resolve(false);
    });
    this.pendingAcks.clear();
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    const connected = await this.connect();
    if (!connected || !this.client) {
      return false;
    }

    const client = this.client;
    const requestId = makeRequestId();
    const payload = JSON.stringify({ ...command, requestId });
    const commandTopic = command.target ? getDeviceTopic(command.target, 'command') : TOPIC_COMMAND;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        resolve(false);
      }, COMMAND_ACK_TIMEOUT_MS);

      this.pendingAcks.set(requestId, { resolve, timeout });

      try {
        client.publish(commandTopic, payload);
      } catch (error) {
        console.warn('[KrakenMqttAdapter] Error publishing command.', error);
        clearTimeout(timeout);
        this.pendingAcks.delete(requestId);
        this.isConnected = false;
        resolve(false);
      }
    });
  }

  onStateChange(callback: (state: MachineState) => void): void {
    this.stateChangeCallback = callback;
    this.fireStateChange();
  }

  private async openConnection() {
    try {
      const client = new MinimalMqttWebSocketClient(
        this.brokerUrl,
        makeClientId(),
        (topic, payload) => this.handleMessage(topic, payload),
        () => {
          this.isConnected = false;
        }
      );

      await client.connect();
      client.subscribe(TOPIC_STATE);
      client.subscribe(TOPIC_ACK);
      DEVICE_IDS.forEach((deviceId) => {
        client.subscribe(getDeviceTopic(deviceId, 'state'));
        client.subscribe(getDeviceTopic(deviceId, 'command/ack'));
      });
      this.client = client;
      this.isConnected = true;
      return true;
    } catch (error) {
      console.warn('[KrakenMqttAdapter] Could not connect to Mosquitto.', error);
      this.isConnected = false;
      this.setState({
        ...initialState,
        status: 'error',
        errorMessage: 'No se pudo conectar con Mosquitto. Revisa el broker MQTT.',
      });
      return false;
    }
  }

  private handleMessage(topic: string, payload: string) {
    try {
      if (topic === TOPIC_STATE || topic === getDeviceTopic('pumps', 'state')) {
        this.setState(JSON.parse(payload));
        return;
      }

      if (topic === TOPIC_ACK || DEVICE_IDS.some((deviceId) => topic === getDeviceTopic(deviceId, 'command/ack'))) {
        const ack = JSON.parse(payload) as {
          requestId?: string;
          ok?: boolean;
          state?: MachineState;
        };

        if (ack.state) {
          this.setState(ack.state);
        }

        if (ack.requestId) {
          const pending = this.pendingAcks.get(ack.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingAcks.delete(ack.requestId);
            pending.resolve(ack.ok !== false);
          }
        }
      }
    } catch (error) {
      console.warn('[KrakenMqttAdapter] Invalid MQTT payload.', error);
    }
  }

  private setState(state: MachineState) {
    this.currentState = {
      ...initialState,
      ...state,
      completedStepIds: state.completedStepIds ?? [],
      skippedStepIds: state.skippedStepIds ?? [],
    };
    this.fireStateChange();
  }

  private fireStateChange() {
    if (this.stateChangeCallback) {
      this.stateChangeCallback({ ...this.currentState });
    }
  }
}
