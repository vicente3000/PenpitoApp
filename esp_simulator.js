/**
 * ESP32 Kraken Simulator - PenpitoApp
 * 
 * Este script emula el comportamiento físico del ESP32 dosificador. Se conecta al mismo
 * broker MQTT por WebSocket para recibir comandos (como iniciar preparación), enviar
 * confirmaciones (ACKs) y simular el ciclo de vida del coctel en la barra de progreso en vivo.
 * 
 * Uso:
 *   node esp_simulator.js
 */

const fs = require('fs');
const path = require('path');

// Intentar cargar la URL del broker de .env
let brokerUrl = 'ws://localhost:9001';
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/EXPO_PUBLIC_MQTT_WS_URL=(.+)/);
    if (match && match[1]) {
      brokerUrl = match[1].trim();
    }
  }
} catch (e) {
  // Fallback a localhost
}

console.log(`[ESP32 Simulator] Buscando Broker MQTT en: ${brokerUrl}`);

// Soporte de WebSocket nativo en Node 21+ o cargando desde node_modules (instalado por Expo)
let WebSocket;
try {
  WebSocket = globalThis.WebSocket || require('ws');
} catch (err) {
  console.error('\n❌ Error: No se pudo cargar la librería WebSocket ("ws").');
  console.error('Por favor corre: npm install ws');
  process.exit(1);
}

// Auxiliares de empaquetado del protocolo MQTT
function encodeUtf8(str) {
  return Array.from(Buffer.from(str, 'utf8'));
}

function decodeUtf8(bytes) {
  return Buffer.from(bytes).toString('utf8');
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
    if (remaining > 0) {
      encoded |= 128;
    }
    output.push(encoded);
  } while (remaining > 0);
  return output;
}

function makePacket(header, body) {
  return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]);
}

function toPacketIdBytes(packetId) {
  return [(packetId >> 8) & 0xff, packetId & 0xff];
}

// Configuración de Estados
const STATUS_IDLE = 'idle';
const STATUS_PREPARING = 'preparing';
const STATUS_ERROR = 'error';

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

let client = null;
let currentSocket = null;
let pingTimer = null;

// Conectar e inicializar cliente MQTT minimalista
function start() {
  const clientId = `esp32-kraken-simulator-${Math.random().toString(16).slice(2, 8)}`;
  console.log(`[ESP32 Simulator] Conectando con ClientID: ${clientId}`);
  
  const socket = new WebSocket(brokerUrl, 'mqtt');
  socket.binaryType = 'arraybuffer';
  currentSocket = socket;

  socket.onopen = () => {
    console.log('[ESP32 Simulator] Socket TCP/WS abierto. Enviando CONNECT...');
    const variableHeader = [
      ...encodeString('MQTT'),
      4, // Protocol Level (3.1.1)
      2, // Connect Flags (Clean Session)
      0, 30 // Keep Alive (30s)
    ];
    const payload = encodeString(clientId);
    socket.send(makePacket(0x10, [...variableHeader, ...payload]));
  };

  socket.onmessage = async (event) => {
    const bytes = new Uint8Array(event.data);
    if (bytes.length < 2) return;

    const packetType = bytes[0] >> 4;
    const remaining = decodeRemainingLength(bytes, 1);
    const bodyStart = 1 + remaining.bytesRead;
    const bodyEnd = bodyStart + remaining.value;

    if (packetType === 2) {
      console.log('[ESP32 Simulator] Conexión MQTT aceptada (CONNACK).');
      // Suscribirse a tópicos de comandos
      subscribe('penpito/kraken/command');
      subscribe('penpito/pumps/command');
      subscribe('penpito/motor/command');
      
      // Iniciar pings
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(makePacket(0xc0, []));
        }
      }, 15000);

      // Limpiar cualquier mensaje retenido viejo del broker (zero-length payload + retain = clear)
      publish('penpito/kraken/state', '', true);
      publish('penpito/kraken/presence', '', true);

      // Publicar presencia y estado inicial limpio
      publish('penpito/kraken/presence', 'online');
      publishState();
    }

    if (packetType === 3) {
      // Mensaje PUBLISH recibido
      let cursor = bodyStart;
      const topicLength = (bytes[cursor] << 8) | bytes[cursor + 1];
      cursor += 2;
      const topic = decodeUtf8(bytes.slice(cursor, cursor + topicLength));
      cursor += topicLength;
      const payload = decodeUtf8(bytes.slice(cursor, bodyEnd));
      
      handleCommand(topic, payload);
    }
  };

  socket.onclose = () => {
    console.log('[ESP32 Simulator] Conexión cerrada. Reintentando en 3s...');
    clearInterval(pingTimer);
    setTimeout(start, 3000);
  };

  socket.onerror = (err) => {
    console.error('[ESP32 Simulator] Error de conexión:', err.message || err);
  };
}

function decodeRemainingLength(packet, offset) {
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

function subscribe(topic) {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    const body = [0, 1, ...encodeString(topic), 0];
    currentSocket.send(makePacket(0x82, body));
  }
}

function publish(topic, payload, retain = false) {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    const body = [...encodeString(topic), ...encodeUtf8(payload)];
    const header = retain ? 0x31 : 0x30;
    currentSocket.send(makePacket(header, body));
  }
}

function publishState() {
  publish('penpito/kraken/state', JSON.stringify(machineState));
}

// Procesar comandos de la app
let prepTimeout = null;
function handleCommand(topic, payloadString) {
  console.log(`\n[ESP32 Simulator] Comando MQTT recibido: ${payloadString}`);
  try {
    const doc = JSON.parse(payloadString);
    const cmd = doc.cmd || '';
    const val = doc.val || '';
    const requestId = doc.requestId || '';

    const sendAck = (ok = true) => {
      if (requestId) {
        const ackTopic = topic + '/ack';
        const ackPayload = {
          requestId,
          ok,
          state: {
            isOn: machineState.isOn,
            status: machineState.status,
            currentRecipeId: machineState.currentRecipeId,
            requestedIceCount: machineState.requestedIceCount,
            activeStepId: machineState.activeStepId,
            completedStepIds: machineState.completedStepIds,
            skippedStepIds: machineState.skippedStepIds,
            isDrinkReady: machineState.isDrinkReady,
          }
        };
        publish(ackTopic, JSON.stringify(ackPayload));
        console.log(`[ESP32 Simulator] ACK enviado a ${ackTopic} (ok: ${ok})`);
      }
    };

    if (cmd === 'POWER') {
      machineState.isOn = (val === 'ON');
      if (!machineState.isOn) {
        clearTimeout(prepTimeout);
        machineState.status = STATUS_IDLE;
        machineState.currentRecipeId = null;
        machineState.activeStepId = null;
        machineState.completedStepIds = [];
        machineState.isDrinkReady = false;
      }
      publishState();
      sendAck(true);
    } else if (cmd === 'PREPARE') {
      if (!machineState.isOn) {
        console.log('[ESP32 Simulator] Máquina apagada, rechazando preparación.');
        sendAck(false);
        return;
      }
      if (machineState.status !== STATUS_IDLE) {
        console.log('[ESP32 Simulator] Máquina ocupada, rechazando preparación.');
        sendAck(false);
        return;
      }

      sendAck(true);
      const recipeId = val;
      const iceCount = doc.iceCount !== undefined ? doc.iceCount : 2;

      // Determinar requisitos de preparación según el trago
      const needsAgitation = recipeId === 'negroni' || recipeId === 'boulevardier' || recipeId === 'godfather' || recipeId === 'americano';
      const needsCarbonation = recipeId === 'piscola';

      // Definir qué pasos se omiten
      const skipped = [];
      if (iceCount === 0) skipped.push('ice_dispenser');
      if (!needsAgitation) skipped.push('agitation_system');
      if (!needsCarbonation) skipped.push('carbonated_station');

      // Crear la lista de pasos activos para este trago
      const steps = ['cup_dispenser'];
      if (iceCount > 0) steps.push('ice_dispenser');
      steps.push('alcohol_dispenser');
      if (needsAgitation) steps.push('agitation_system');
      if (needsCarbonation) steps.push('carbonated_station');
      steps.push('ready');

      console.log(`[ESP32 Simulator] Iniciando preparación de: ${recipeId} (Hielos: ${iceCount})`);
      console.log(`[ESP32 Simulator] Pasos activos: ${steps.join(', ')}`);
      console.log(`[ESP32 Simulator] Pasos omitidos: ${skipped.join(', ')}`);

      machineState.status = STATUS_PREPARING;
      machineState.currentRecipeId = recipeId;
      machineState.requestedIceCount = iceCount;
      machineState.isDrinkReady = false;
      machineState.completedStepIds = [];
      machineState.skippedStepIds = skipped;
      
      let currentStepIndex = 0;

      function nextStep() {
        if (currentStepIndex >= steps.length) {
          // Finalizado
          machineState.status = STATUS_IDLE;
          machineState.activeStepId = null;
          machineState.isDrinkReady = true;
          publishState();
          console.log('[ESP32 Simulator] ¡Trago finalizado y listo para retirar!');
          return;
        }

        const step = steps[currentStepIndex];
        console.log(`[ESP32 Simulator] Activo: ${step}`);
        machineState.activeStepId = step;
        publishState();

        currentStepIndex++;
        prepTimeout = setTimeout(() => {
          // Agregar al historial de completados si no es 'ready'
          if (step !== 'ready') {
            machineState.completedStepIds.push(step);
          }
          nextStep();
        }, 3000); // 3 segundos por fase
      }

      nextStep();
    } else if (cmd === 'TAKEN') {
      console.log('[ESP32 Simulator] Vaso retirado de la bandeja.');
      machineState.isDrinkReady = false;
      publishState();
      sendAck(true);
    } else {
      sendAck(true);
    }
  } catch (err) {
    console.error('[ESP32 Simulator] Error procesando comando:', err);
  }
}

// Iniciar simulador
start();
