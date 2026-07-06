/**
 * ESP32 Kraken Simulator (dev only)
 *
 * Emula el firmware del ESP32 dosificador para que puedas probar la app
 * sin hardware. Se conecta al broker Mosquitto por WebSocket, escucha los
 * mismos topics que el firmware real y publica estado, presencia y ACKs
 * respetando el contrato de la app.
 *
 * Uso:
 *   node dev/esp_simulator.js
 *
 * Variables de entorno:
 *   EXPO_PUBLIC_MQTT_WS_URL  URL del broker (default: ws://localhost:9001)
 */

const fs = require('fs');
const path = require('path');

function loadBrokerUrl() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/EXPO_PUBLIC_MQTT_WS_URL=(.+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch (_) {}
  return process.env.EXPO_PUBLIC_MQTT_WS_URL || 'ws://172.20.10.7:9001';
}

const BROKER_URL = loadBrokerUrl();
console.log(`[ESP32 Sim] Broker: ${BROKER_URL}`);

let WebSocket;
try {
  WebSocket = globalThis.WebSocket || require('ws');
} catch (err) {
  console.error('No se pudo cargar WebSocket. Instala la dependencia ws (npm i ws).');
  process.exit(1);
}

let TextDecoderImpl;
try {
  TextDecoderImpl = globalThis.TextDecoder;
} catch (_) {
  TextDecoderImpl = undefined;
}

function decodeUtf8(bytes) {
  if (TextDecoderImpl) {
    return new TextDecoderImpl('utf-8', { fatal: false }).decode(bytes);
  }
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

const STATUS_IDLE = 'idle';
const STATUS_PREPARING = 'preparing';

let machineState = {
  isOn: true,
  status: STATUS_IDLE,
  currentRecipeId: null,
  requestedIceCount: 2,
  activeStepId: null,
  completedStepIds: [],
  skippedStepIds: [],
  isDrinkReady: false,
};

let currentSocket = null;
let pingTimer = null;
let idlePublishTimer = null;
let nextPacketId = 1;
const pubackPending = new Map();
let lastRequestStateAt = 0;

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
      console.error(`[ESP32 Sim] Error publicando en ${topic}:`, err.message || err);
    }
  } else {
    header = retain ? 0x31 : 0x30;
    try {
      currentSocket.send(makePacket(header, body));
    } catch (err) {
      console.error(`[ESP32 Sim] Error publicando en ${topic}:`, err.message || err);
    }
  }
}

function publishState() {
  publish('penpito/kraken/state', JSON.stringify(machineState), { retain: true });
}

function publishPresence() {
  publish('penpito/kraken/presence', 'online', { retain: true });
}

function subscribe(topic) {
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
  const body = [0x00, 0x01, ...encodeString(topic), 0x00];
  try {
    currentSocket.send(makePacket(0x82, body));
  } catch (err) {
    console.error(`[ESP32 Sim] Error suscribiendose a ${topic}:`, err.message || err);
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

let prepStepIndex = 0;
let prepStepTimer = null;
let prepSteps = [];

function clearPrepTimer() {
  if (prepStepTimer) {
    clearTimeout(prepStepTimer);
    prepStepTimer = null;
  }
}

function getStepDuration(step, recipeId, iceCount) {
  switch (step) {
    case 'cup_dispenser': return 2000;
    case 'ice_dispenser': return Math.max(1500, iceCount * 1800);
    case 'alcohol_dispenser': return ['negroni', 'boulevardier', 'godfather', 'americano'].includes(recipeId) ? 5500 : 4000;
    case 'agitation_system': return 7000;
    case 'carbonated_station': return 1500;
    case 'ready': return 2000;
    default: return 3000;
  }
}

function startPreparation(recipeId, iceCount, deferPublish = false) {
  const needsAgitation = ['negroni', 'boulevardier', 'godfather', 'americano'].includes(recipeId);
  const needsCarbonation = recipeId === 'piscola';

  const skipped = [];
  if (iceCount === 0) skipped.push('ice_dispenser');
  if (!needsAgitation) skipped.push('agitation_system');
  if (!needsCarbonation) skipped.push('carbonated_station');

  prepSteps = ['cup_dispenser'];
  if (iceCount > 0) prepSteps.push('ice_dispenser');
  prepSteps.push('alcohol_dispenser');
  if (needsAgitation) prepSteps.push('agitation_system');
  if (needsCarbonation) prepSteps.push('carbonated_station');
  prepSteps.push('ready');

  machineState.status = STATUS_PREPARING;
  machineState.currentRecipeId = recipeId;
  machineState.requestedIceCount = iceCount;
  machineState.isDrinkReady = false;
  machineState.completedStepIds = [];
  machineState.skippedStepIds = skipped;
  prepStepIndex = 0;

  console.log(`[ESP32 Sim] Preparando ${recipeId} (hielos=${iceCount})`);
  console.log(`[ESP32 Sim] Pasos activos: ${prepSteps.join(', ')}`);
  console.log(`[ESP32 Sim] Pasos omitidos: ${skipped.join(', ')}`);

  if (!deferPublish) {
    nextStep();
  }
}

function nextStep() {
  if (prepStepIndex >= prepSteps.length) {
    machineState.status = STATUS_IDLE;
    machineState.activeStepId = null;
    machineState.isDrinkReady = true;
    publishState();
    console.log('[ESP32 Sim] Trago listo para retirar.');
    return;
  }
  const step = prepSteps[prepStepIndex];
  console.log(`[ESP32 Sim] Paso activo: ${step}`);
  machineState.activeStepId = step;
  publishState();

  const duration = getStepDuration(step, machineState.currentRecipeId, machineState.requestedIceCount);
  prepStepIndex += 1;
  prepStepTimer = setTimeout(() => {
    if (step !== 'ready') {
      machineState.completedStepIds.push(step);
    }
    nextStep();
  }, duration);
}

function handleCommand(topic, payloadStr) {
  console.log(`\n[ESP32 Sim] CMD ${topic}: ${payloadStr}`);
  let doc;
  try {
    doc = JSON.parse(payloadStr);
  } catch (err) {
    console.warn('[ESP32 Sim] Payload no es JSON valido, ignorando.');
    return;
  }
  const cmd = doc.cmd || '';
  const val = doc.val || '';
  const requestId = doc.requestId || '';

  const sendAck = (ok) => {
    if (!requestId) return;
    const ackTopic = topic + '/ack';
    const ackPayload = JSON.stringify({ requestId, ok, state: machineState });
    publish(ackTopic, ackPayload, { qos: 1 });
    console.log(`[ESP32 Sim] ACK -> ${ackTopic} (ok=${ok})`);
  };

  if (cmd === 'POWER') {
    machineState.isOn = val === 'ON';
    if (!machineState.isOn) {
      clearPrepTimer();
      machineState.status = STATUS_IDLE;
      machineState.currentRecipeId = null;
      machineState.activeStepId = null;
      machineState.completedStepIds = [];
      machineState.isDrinkReady = false;
    }
    publishState();
    sendAck(true);
    return;
  }

  if (cmd === 'PREPARE') {
    if (!machineState.isOn) {
      console.log('[ESP32 Sim] Maquina apagada, rechazando.');
      sendAck(false);
      return;
    }
    if (machineState.status !== STATUS_IDLE) {
      console.log('[ESP32 Sim] Maquina ocupada, rechazando.');
      sendAck(false);
      return;
    }
    const recipeId = val;
    const iceCount = typeof doc.iceCount === 'number' ? doc.iceCount : 2;
    startPreparation(recipeId, iceCount, true);
    machineState.activeStepId = prepSteps[0] || 'cup_dispenser';
    sendAck(true);
    nextStep();
    return;
  }

  if (cmd === 'TAKEN') {
    machineState.isDrinkReady = false;
    publishState();
    sendAck(true);
    return;
  }

  // Comandos TEST_HW, configuracion WiFi, etc. simplemente se aceptan.
  sendAck(true);
}

function start() {
  const clientId = `esp32-kraken-sim-${Math.random().toString(16).slice(2, 8)}`;
  console.log(`[ESP32 Sim] Conectando como ${clientId}...`);

  const socket = new WebSocket(BROKER_URL, 'mqtt');
  socket.binaryType = 'arraybuffer';
  currentSocket = socket;

  socket.onopen = () => {
    console.log('[ESP32 Sim] Socket abierto. Enviando CONNECT...');
    const variableHeader = [
      ...encodeString('MQTT'),
      4,
      2,
      0,
      30,
    ];
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
        console.error(`[ESP32 Sim] CONNACK con error ${returnCode}`);
        return;
      }
      console.log('[ESP32 Sim] CONNACK OK. Suscribiendose a comandos...');
      subscribe('penpito/kraken/command');
      subscribe('penpito/pumps/command');
      subscribe('penpito/motor/command');
      subscribe('penpito/kraken/request_state');
      console.log('[ESP32 Sim] Suscripciones enviadas. Listo para recibir comandos.');

      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(makePacket(0xc0, []));
        }
      }, 15000);

      idlePublishTimer = setInterval(() => {
        if (machineState.status === STATUS_IDLE) {
          publishState();
        }
      }, 3000);

      publishState();
      publishPresence();
      console.log('[ESP32 Sim] Estado y presencia publicados (retained). Esperando comandos...');
    } else if (packetType === 4) {
      const pid = (bytes[bodyStart] << 8) | bytes[bodyStart + 1];
      if (pubackPending.has(pid)) {
        const p = pubackPending.get(pid);
        pubackPending.delete(pid);
        console.log(`[ESP32 Sim] PUBACK para ${p.topic} (pid=${pid})`);
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
      let packetId = null;
      if (qos > 0) {
        if (cursor + 2 > bodyEnd) return;
        packetId = (bytes[cursor] << 8) | bytes[cursor + 1];
        cursor += 2;
        if (qos === 1) {
          try {
            socket.send(makePacket(0x40, toPacketIdBytes(packetId)));
          } catch (_) {}
        }
      }
      const payload = decodeUtf8(bytes.slice(cursor, bodyEnd));

      if (topic === 'penpito/kraken/request_state') {
        const now = Date.now();
        if (now - lastRequestStateAt < 2000) {
          console.log('[ESP32 Sim] request_state ignorado (cooldown).');
          return;
        }
        lastRequestStateAt = now;
        console.log('[ESP32 Sim] Solicitud de estado fresco. Re-publicando.');
        publishState();
        publishPresence();
        return;
      }
      handleCommand(topic, payload);
    }
  };

  socket.onclose = () => {
    console.log('[ESP32 Sim] Conexion cerrada. Reintentando en 3s...');
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (idlePublishTimer) {
      clearInterval(idlePublishTimer);
      idlePublishTimer = null;
    }
    currentSocket = null;
    pubackPending.clear();
    if (!shuttingDown) {
      setTimeout(start, 3000);
    }
  };

  socket.onerror = (err) => {
    console.error('[ESP32 Sim] Error de socket:', err.message || err);
  };
}

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (idlePublishTimer) {
    clearInterval(idlePublishTimer);
    idlePublishTimer = null;
  }
  clearPrepTimer();
  if (currentSocket) {
    try { currentSocket.close(); } catch (_) {}
  }
  console.log('[ESP32 Sim] Apagado.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
