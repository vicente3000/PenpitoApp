const mqtt = require('mqtt');

const host = process.env.PENPITO_MQTT_HOST || '192.168.243.219';
const tcpUrl = process.env.PENPITO_MQTT_URL || `mqtt://${host}:1883`;
const wsUrl = process.env.EXPO_PUBLIC_MQTT_WS_URL || `ws://${host}:9001`;

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function subscribe(client, topic) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  const tcp = mqtt.connect(tcpUrl, {
    clientId: `penpito_tcp_probe_${Date.now()}`,
    connectTimeout: 3000,
    reconnectPeriod: 0,
  });
  const ws = mqtt.connect(wsUrl, {
    clientId: `penpito_ws_probe_${Date.now()}`,
    connectTimeout: 3000,
    reconnectPeriod: 0,
  });

  try {
    await Promise.race([
      Promise.all([once(tcp, 'connect'), once(ws, 'connect')]),
      timeout(5000, 'connect timeout'),
    ]);
    console.log(`connected: ${tcpUrl} + ${wsUrl}`);

    const topic = `penpito/probe/${Date.now()}`;
    await subscribe(tcp, topic);
    const fromWs = new Promise((resolve) => {
      tcp.once('message', (receivedTopic, payload) => {
        resolve({ topic: receivedTopic, payload: payload.toString() });
      });
    });
    ws.publish(topic, 'hello-from-ws');
    const wsMessage = await Promise.race([fromWs, timeout(5000, 'ws->tcp timeout')]);
    console.log(`ws->tcp: ${wsMessage.topic} ${wsMessage.payload}`);

    await subscribe(ws, `${topic}/back`);
    const fromTcp = new Promise((resolve) => {
      ws.once('message', (receivedTopic, payload) => {
        resolve({ topic: receivedTopic, payload: payload.toString() });
      });
    });
    tcp.publish(`${topic}/back`, 'hello-from-tcp');
    const tcpMessage = await Promise.race([fromTcp, timeout(5000, 'tcp->ws timeout')]);
    console.log(`tcp->ws: ${tcpMessage.topic} ${tcpMessage.payload}`);
  } finally {
    tcp.end(true);
    ws.end(true);
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error.message}`);
  process.exit(1);
});
