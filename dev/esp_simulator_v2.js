/**
 * Simulador v2 del ESP32 Kraken.
 *
 * Implementa el MISMO contrato que el firmware (Kraken/src/main.cpp):
 *  - Escucha `penpito/v2/controller/hardware/command` (QoS 1).
 *  - Publica `penpito/v2/hardware/state` (QoS 1, retained).
 *  - Publica `penpito/v2/hardware/event` (QoS 1, no retained).
 *  - Publica `penpito/v2/hardware/command/ack` (QoS 1).
 *  - Publica `penpito/v2/hardware/presence` (QoS 1, retained, LWT "offline").
 *
 * El simulador mantiene el contexto de ActiveOrder (orderId, tableId, commandId)
 * y publica eventos correlacionados. La cola FIFO NO la decide el simulador
 * (la decide el Order Controller); el simulador solo ejecuta.
 *
 * Comparte fixtures con el firmware en el sentido de: ambos leen el mismo JSON.
 * Si el firmware cambia un campo, el simulador lo refleja, y viceversa.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const v2Topics = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'protocol', 'v2-topics.json'), 'utf8')
);

function loadBrokerUrl() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/EXPO_PUBLIC_MQTT_WS_URL=(.+)/);
      if (match && match[1]) return match[1].trim();
    }
  } catch (_) {}
  return process.env.EXPO_PUBLIC_MQTT_WS_URL || 'ws://192.168.243.219:9001';
}

const BROKER_URL = loadBrokerUrl();
console.log(`[ESP32 Sim v2] Broker: ${BROKER_URL}`);

let WebSocket;
try {
  WebSocket = globalThis.WebSocket || require('ws');
} catch (err) {
  console.error('No se pudo cargar WebSocket. Instala ws (npm i ws).');
  process.exit(1);
}

let TextDecoderImpl = globalThis.TextDecoder;

function decodeUtf8(bytes) {
  if (TextDecoderImpl) return new TextDecoderImpl('utf-8', { fatal: false }).decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

function encodeUtf8(str) {
  return Array.from(Buffer.from(str, 'utf8'));
}

function encodeString(str) {
  const bytes = encodeUtf8(str);
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}

function encodeRemainingLength(value) {
  const output = [];
  let remaining = value;
  do {
    let encoded = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) encoded |= 128;
    output.push(encoded);
  } while (remaining > 0);
  return output;
}

function makePacket(header, body) {
  return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]);
}

function toPacketIdBytes(id) {
  return [(id >> 8) & 0xff, id & 0xff];
}

function randomBootId() {
  return crypto.randomBytes(4).toString('hex');
}

const QOS = v2Topics.qos;
const TOPIC_CMD = v2Topics.topics.controllerHardwareCommand;
const TOPIC_ACK = v2Topics.topics.hardwareCommandAck;
const TOPIC_STATE = v2Topics.topics.hardwareState;
const TOPIC_EVENT = v2Topics.topics.hardwareEvent;
const TOPIC_PRESENCE = v2Topics.topics.hardwarePresence;

const bootId = randomBootId();
const bootAt = Date.now();

let machineState = {
  protocolVersion: 2,
  bootId,
  isOn: true,
  status: 'idle',
  activeOrderId: null,
  activeTableId: null,
  activeCommandId: null,
  stateSequence: 0,
  activeStepId: null,
  completedStepIds: [],
  skippedStepIds: [],
  isDrinkReady: false,
  errorMessage: null,
  startedAt: null,
  uptimeMs: 0,
};

let currentSocket = null;
let pingTimer = null;
let idlePublishTimer = null;
let nextPacketId = 1;
const pubackPending = new Map();
const cachedRequests = new Map();
const CACHE_SIZE = 10;
const CACHE_TTL_MS = 5 * 60_000;
let currentOrder = null;
let prepStepIndex = 0;
let prepStepTimer = null;
let prepSteps = [];

function allocPacketId() {
  nextPacketId = nextPacketId >= 65535 ? 1 : nextPacketId + 1;
  return nextPacketId;
}

function publish(topic, payload, opts = {}) {
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
  const { qos = 0, retain = false } = opts;
  const body = [...encodeString(topic), ...encodeUtf8(payload)];
  let header;
  if (qos === 1) {
    header = retain ? 0x33 : 0x32;
    const pid = allocPacketId();
    const bodyWithId = [...encodeString(topic), ...toPacketIdBytes(pid), ...encodeUtf8(payload)];
    try {
      currentSocket.send(makePacket(header, bodyWithId));
      pubackPending.set(pid, { topic, payload });
    } catch (err) {
      console.error(`[ESP32 Sim v2] Error publicando en ${topic}:`, err.message || err);
    }
  } else {
    header = retain ? 0x31 : 0x30;
    try {
      currentSocket.send(makePacket(header, body));
    } catch (err) {
      console.error(`[ESP32 Sim v2] Error publicando en ${topic}:`, err.message || err);
    }
  }
}

function publishState() {
  machineState.stateSequence += 1;
  machineState.uptimeMs = Date.now() - bootAt;
  publish(TOPIC_STATE, JSON.stringify(machineState), { qos: QOS.state, retain: v2Topics.retain.state });
}

function publishPresence() {
  publish(TOPIC_PRESENCE, 'online', { qos: QOS.presence, retain: v2Topics.retain.presence });
}

function publishEvent(type, extra = {}) {
  if (!currentOrder) return;
  const event = {
    protocolVersion: 2,
    type,
    orderId: currentOrder.orderId,
    tableId: currentOrder.tableId,
    commandId: currentOrder.commandId,
    sequence: currentOrder.sequence,
    timestamp: Date.now(),
    activeStepId: machineState.activeStepId,
    completedStepIds: machineState.completedStepIds.slice(),
    skippedStepIds: machineState.skippedStepIds.slice(),
    ...extra,
  };
  currentOrder.sequence += 1;
  publish(TOPIC_EVENT, JSON.stringify(event), { qos: QOS.events, retain: false });
}

function sendAck(commandId, accepted, opts = {}) {
  if (!commandId) return;
  const ack = {
    protocolVersion: 2,
    commandId,
    accepted,
    timestamp: Date.now(),
    activeOrderId: machineState.activeOrderId,
    activeTableId: machineState.activeTableId,
  };
  if (!accepted) {
    ack.reason = opts.reason || 'rejected';
    ack.failureCode = opts.failureCode || 'machine_rejected';
  }
  publish(TOPIC_ACK, JSON.stringify(ack), { qos: QOS.commands, retain: false });
}

function getCachedRequest(id) {
  if (!id) return null;
  const entry = cachedRequests.get(id);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cachedRequests.delete(id);
    return null;
  }
  return entry;
}

// Escribe en cache SOLO después de publicar el ACK. Así, si el broker nos
// entrega un retransmit antes de que el ACK original saliera, replay del ACK
// se hace con el resultado ya en cache.
function cacheRequest(id, accepted, reason = '') {
  if (!id) return;
  cachedRequests.set(id, { at: Date.now(), accepted, reason });
  if (cachedRequests.size > CACHE_SIZE) {
    const firstKey = cachedRequests.keys().next().value;
    cachedRequests.delete(firstKey);
  }
}

function subscribe(topic, qos = 1) {
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
  const body = [0x00, 0x01, ...encodeString(topic), qos & 0xff];
  try {
    currentSocket.send(makePacket(0x82, body));
  } catch (err) {
    console.error(`[ESP32 Sim v2] Error suscribiendose a ${topic}:`, err.message || err);
  }
}

function decodeRemainingLength(packet, offset) {
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

function clearPrepTimer() {
  if (prepStepTimer) {
    clearTimeout(prepStepTimer);
    prepStepTimer = null;
  }
}

const STEP_DURATIONS_MS = {
  cup_dispenser: 2000,
  ice_dispenser: 1800,
  alcohol_dispenser: 4000,
  agitation_system: 7000,
  carbonated_station: 1500,
  ready: 1500,
};

function stepDuration(step, recipeId, iceCount) {
  if (step === 'ice_dispenser') return Math.max(1500, iceCount * STEP_DURATIONS_MS.ice_dispenser);
  if (step === 'alcohol_dispenser') {
    return ['negroni', 'boulevardier', 'godfather', 'americano'].includes(recipeId)
      ? 5500
      : STEP_DURATIONS_MS.alcohol_dispenser;
  }
  return STEP_DURATIONS_MS[step] ?? 3000;
}

function buildPrepSteps(recipeId, iceCount) {
  const needsAgitation = ['negroni', 'boulevardier', 'godfather', 'americano'].includes(recipeId);
  const needsCarbonation = recipeId === 'piscola';
  const steps = ['cup_dispenser'];
  if (iceCount > 0) steps.push('ice_dispenser');
  steps.push('alcohol_dispenser');
  if (needsAgitation) steps.push('agitation_system');
  if (needsCarbonation) steps.push('carbonated_station');
  steps.push('ready');
  return steps;
}

function startPreparation(env) {
  const { orderId, tableId, commandId } = env;
  const payload = env.payload || {};
  const recipeId = payload.recipeId;
  const iceCount = typeof payload.iceCount === 'number' ? payload.iceCount : 2;
  const skipped = [];
  if (iceCount === 0) skipped.push('ice_dispenser');
  if (!['negroni', 'boulevardier', 'godfather', 'americano'].includes(recipeId)) skipped.push('agitation_system');
  if (recipeId !== 'piscola') skipped.push('carbonated_station');
  prepSteps = buildPrepSteps(recipeId, iceCount);
  prepStepIndex = 0;
  currentOrder = {
    orderId,
    tableId,
    commandId,
    recipeId,
    iceCount,
    sequence: 0,
  };
  machineState.status = 'preparing';
  machineState.activeOrderId = orderId;
  machineState.activeTableId = tableId;
  machineState.activeCommandId = commandId;
  machineState.activeStepId = prepSteps[0] || 'cup_dispenser';
  machineState.completedStepIds = [];
  machineState.skippedStepIds = skipped;
  machineState.isDrinkReady = false;
  machineState.startedAt = Date.now();
  publishState();
  publishEvent('PREPARATION_STARTED');
  scheduleNextStep();
}

function scheduleNextStep() {
  if (!currentOrder) return;
  if (prepStepIndex >= prepSteps.length) {
    machineState.status = 'idle';
    machineState.activeStepId = null;
    machineState.isDrinkReady = true;
    publishState();
    // ÚNICA señal que cuenta como listo:
    publishEvent('PREPARATION_COMPLETED');
    currentOrder = null;
    return;
  }
  const step = prepSteps[prepStepIndex];
  machineState.activeStepId = step;
  publishState();
  publishEvent('PREPARATION_PROGRESS');
  const duration = stepDuration(step, currentOrder.recipeId, currentOrder.iceCount);
  prepStepIndex += 1;
  clearPrepTimer();
  prepStepTimer = setTimeout(() => {
    if (step !== 'ready' && !machineState.completedStepIds.includes(step)) {
      machineState.completedStepIds.push(step);
    }
    if (currentOrder) {
      publishEvent('PREPARATION_PROGRESS');
    }
    scheduleNextStep();
  }, duration);
}

function failPreparation(reason, failureCode) {
  publishEvent('PREPARATION_FAILED', { reason, failureCode });
  machineState.status = 'error';
  machineState.errorMessage = reason;
  machineState.activeOrderId = null;
  machineState.activeTableId = null;
  machineState.activeCommandId = null;
  machineState.activeStepId = null;
  machineState.isDrinkReady = false;
  publishState();
  currentOrder = null;
}

function handleCommand(topic, payloadStr) {
  let doc;
  try {
    doc = JSON.parse(payloadStr);
  } catch (_) {
    return;
  }
  const type = doc.type || doc.cmd;
  const commandId = doc.commandId;
  const orderId = doc.orderId;
  const tableId = doc.tableId;

  // Idempotencia universal: si ya vimos este commandId, replay.
  // Cubre retransmisiones TCP/WS y reintentos del controller.
  const cached = getCachedRequest(commandId);
  if (cached) {
    sendAck(commandId, cached.accepted, { reason: cached.reason });
    return;
  }

  if (type === 'EMERGENCY_STOP' || (type === 'POWER' && (doc.payload?.val === 'OFF' || doc.val === 'OFF'))) {
    clearPrepTimer();
    if (currentOrder) {
      failPreparation('emergency_stop', 'emergency_stop');
    }
    machineState.isOn = false;
    machineState.status = 'idle';
    machineState.isDrinkReady = false;
    machineState.activeOrderId = null;
    machineState.activeTableId = null;
    machineState.activeCommandId = null;
    publishState();
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    return;
  }
  if (type === 'POWER') {
    machineState.isOn = true;
    if (machineState.status === 'error') {
      machineState.status = 'idle';
      machineState.errorMessage = null;
    }
    publishState();
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    return;
  }
  if (!machineState.isOn) {
    cacheRequest(commandId, false, 'machine_offline');
    sendAck(commandId, false, { reason: 'machine_offline', failureCode: 'machine_offline' });
    return;
  }
  if (type === 'PREPARE') {
    // Guard 1: si el hardware ya tiene un pedido activo Y su orderId coincide,
    // es un retransmit del mismo PREPARE. Re-confirmamos sin reiniciar.
    if (
      currentOrder &&
      machineState.activeOrderId === orderId &&
      machineState.activeCommandId === commandId
    ) {
      cacheRequest(commandId, true);
      sendAck(commandId, true);
      return;
    }
    // Guard 2: si el hardware está preparando OTRO pedido, no aceptamos.
    if (currentOrder || machineState.isDrinkReady) {
      cacheRequest(commandId, false, 'machine_busy');
      sendAck(commandId, false, { reason: 'machine_busy', failureCode: 'machine_busy' });
      return;
    }
    if (machineState.status !== 'idle') {
      cacheRequest(commandId, false, 'machine_busy');
      sendAck(commandId, false, { reason: 'machine_busy', failureCode: 'machine_busy' });
      return;
    }
    if (!orderId || !tableId) {
      cacheRequest(commandId, false, 'invalid_envelope');
      sendAck(commandId, false, { reason: 'invalid_envelope', failureCode: 'machine_rejected' });
      return;
    }
    // Aceptamos el comando. El HARDWARE_ACCEPTED se publica al iniciar preparación.
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    startPreparation({ orderId, tableId, commandId, payload: doc.payload || {} });
    return;
  }
  if (type === 'TAKEN') {
    machineState.isDrinkReady = false;
    machineState.activeOrderId = null;
    machineState.activeTableId = null;
    machineState.activeCommandId = null;
    machineState.status = 'idle';
    machineState.activeStepId = null;
    currentOrder = null;
    clearPrepTimer();
    publishState();
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    return;
  }
  if (type === 'CLEAN') {
    if (machineState.status !== 'idle') {
      cacheRequest(commandId, false, 'machine_busy');
      sendAck(commandId, false, { reason: 'machine_busy', failureCode: 'machine_busy' });
      return;
    }
    machineState.status = 'cleaning';
    machineState.activeOrderId = null;
    publishState();
    setTimeout(() => {
      machineState.status = 'idle';
      publishState();
    }, 4000);
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    return;
  }
  if (type === 'SET_CALIB' || type === 'TEST_HW' || type === 'CONFIG_WIFI') {
    cacheRequest(commandId, true);
    sendAck(commandId, true);
    return;
  }
  cacheRequest(commandId, false, 'unknown_command');
  sendAck(commandId, false, { reason: 'unknown_command', failureCode: 'machine_rejected' });
}

function start() {
  const clientId = `esp32-kraken-sim-v2-${Math.random().toString(16).slice(2, 8)}`;
  console.log(`[ESP32 Sim v2] Conectando como ${clientId} (bootId=${bootId})...`);

  const socket = new WebSocket(BROKER_URL, 'mqtt');
  socket.binaryType = 'arraybuffer';
  currentSocket = socket;

  socket.onopen = () => {
    console.log('[ESP32 Sim v2] Socket abierto. Enviando CONNECT...');
    const variableHeader = [...encodeString('MQTT'), 4, 2, 0, 30];
    const payload = encodeString(clientId);
    socket.send(makePacket(0x10, [...variableHeader, ...payload]));
  };

  socket.onmessage = (event) => {
    const bytes = new Uint8Array(event.data);
    if (bytes.length < 2) return;
    const packetType = bytes[0] >> 4;
    const remaining = decodeRemainingLength(bytes, 1);
    const bodyStart = 1 + remaining.bytesRead;
    const bodyEnd = bodyStart + remaining.value;
    if (bodyEnd > bytes.length) return;

    if (packetType === 2) {
      const returnCode = bytes[bodyStart + 1];
      if (returnCode !== 0) {
        console.error(`[ESP32 Sim v2] CONNACK con error ${returnCode}`);
        return;
      }
      console.log('[ESP32 Sim v2] CONNACK OK. Suscribiendose a comandos del controller...');
      subscribe(TOPIC_CMD, QOS.commands);
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(makePacket(0xc0, []));
        }
      }, 15000);

      idlePublishTimer = setInterval(() => {
        if (machineState.status === 'idle' && !machineState.isDrinkReady) {
          publishState();
        }
      }, 3000);

      publishState();
      publishPresence();
      console.log('[ESP32 Sim v2] Listo para recibir comandos del controller.');
    } else if (packetType === 4) {
      const pid = (bytes[bodyStart] << 8) | bytes[bodyStart + 1];
      if (pubackPending.has(pid)) {
        pubackPending.delete(pid);
      }
    } else if (packetType === 3) {
      const qos = (bytes[0] >> 1) & 0x03;
      let cursor = bodyStart;
      if (cursor + 2 > bodyEnd) return;
      const topicLength = (bytes[cursor] << 8) | bytes[cursor + 1];
      cursor += 2;
      if (cursor + topicLength > bodyEnd || topicLength < 0) return;
      const topic = decodeUtf8(bytes.slice(cursor, cursor + topicLength));
      cursor += topicLength;
      if (qos > 0) {
        if (cursor + 2 > bodyEnd) return;
        cursor += 2;
        if (qos === 1) {
          try {
            const packetId = (bytes[bodyStart + 2] << 8) | bytes[bodyStart + 3];
            socket.send(makePacket(0x40, toPacketIdBytes(packetId)));
          } catch (_) {}
        }
      }
      const payload = decodeUtf8(bytes.slice(cursor, bodyEnd));
      if (topic === TOPIC_CMD) {
        handleCommand(topic, payload);
      }
    }
  };

  socket.onclose = () => {
    console.log('[ESP32 Sim v2] Conexion cerrada. Reintentando en 3s...');
    if (pingTimer) clearInterval(pingTimer);
    if (idlePublishTimer) clearInterval(idlePublishTimer);
    clearPrepTimer();
    currentSocket = null;
    pubackPending.clear();
    if (!shuttingDown) setTimeout(start, 3000);
  };

  socket.onerror = (err) => {
    console.error('[ESP32 Sim v2] Error de socket:', err.message || err);
  };
}

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  if (pingTimer) clearInterval(pingTimer);
  if (idlePublishTimer) clearInterval(idlePublishTimer);
  clearPrepTimer();
  if (currentSocket) {
    try {
      currentSocket.close();
    } catch (_) {}
  }
  console.log('[ESP32 Sim v2] Apagado.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
