import { KrakenMqttAdapter } from '../../adapters/KrakenMqttAdapter';
import { DeviceCommand, MachineState } from '../../models';

describe('KrakenMqttAdapter', () => {
  let adapter: KrakenMqttAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    // @ts-ignore
    global.WebSocket.mockInstances.length = 0;
    adapter = new KrakenMqttAdapter('ws://test-broker:9001');
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('should initialize with correct default state', () => {
    expect(adapter).toBeDefined();
  });

  describe('connect', () => {
    it('should create WebSocket instance and establish connection successfully', async () => {
      const connectPromise = adapter.connect();

      // Obtener la instancia del WebSocket simulado
      // @ts-ignore
      const socketInstance = global.WebSocket.mockInstances[0];
      expect(socketInstance).toBeDefined();
      expect(socketInstance.url).toBe('ws://test-broker:9001');

      // Simular CONNACK exitoso de MQTT (packetType = 2, returnCode = 0)
      // Trama mínima de CONNACK: [0x20, 0x02, 0x00, 0x00]
      const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
      
      // Llamar al onmessage con los bytes de CONNACK
      socketInstance.onmessage({ data: connack.buffer });

      const result = await connectPromise;
      expect(result).toBe(true);
    });

    it('should fail and return false if WebSocket connection drops or rejects', async () => {
      const connectPromise = adapter.connect();
      // @ts-ignore
      const socketInstance = global.WebSocket.mockInstances[0];

      // Simular error de WebSocket
      socketInstance.onerror();
      socketInstance.onclose();

      const result = await connectPromise;
      expect(result).toBe(false);
    });
  });

  describe('sendCommand', () => {
    it('should send a command, wait for ACK topic and resolve to true', async () => {
      // 1. Conectar primero
      const connectPromise = adapter.connect();
      // @ts-ignore
      const socketInstance = global.WebSocket.mockInstances[0];
      socketInstance.onmessage({ data: new Uint8Array([0x20, 0x02, 0x00, 0x00]).buffer });
      await connectPromise;

      // 2. Enviar comando
      const command: DeviceCommand = { cmd: 'PREPARE', val: 'piscola' };
      const sendPromise = adapter.sendCommand(command);

      // Dar tiempo a que se resuelvan las microtareas internas de sendCommand (como connect y publish)
      await Promise.resolve();
      await Promise.resolve();

      // El adaptador debería haber llamado a publish
      expect(socketInstance.send).toHaveBeenCalled();

      // Busquemos en las llamadas a send el JSON enviado para obtener el requestId autogenerado
      const sentPackets = socketInstance.send.mock.calls;
      let requestId = '';
      for (const call of sentPackets) {
        const bytes = call[0] as Uint8Array;
        // Intentar extraer strings
        const text = new TextDecoder().decode(bytes);
        const match = text.match(/"requestId":"(cmd-[a-zA-Z0-9-]+)"/);
        if (match) {
          requestId = match[1];
          break;
        }
      }

      expect(requestId).not.toBe('');

      // 3. Simular que llega la confirmación (ACK) con el requestId correspondiente por websocket
      // El payload contiene el JSON del ack: {"requestId":"...", "ok":true}
      // Para simular el parseo simplificado de handleMessage de la clase, inyectamos el tópico y payload
      // simulando un paquete PUBLISH de MQTT (packetType = 3)
      // Para evitar construir bytes MQTT complejos en JS puro dentro del test, podemos llamar directamente
      // al método handleMessage privado si es necesario o bien construir un paquete PUBLISH básico.
      // Dado que handleMessage es privado, podemos inyectar un paquete que el parser entienda:
      // Tópico: penpito/kraken/command/ack o penpito/pumps/command/ack
      // Payload: {"requestId":"requestId_generado","ok":true}
      
      // Acceder al handleMessage directamente para simplificar el testing de la lógica interna de ACK
      // @ts-ignore
      adapter.handleMessage('penpito/kraken/command/ack', JSON.stringify({ requestId, ok: true }));

      const success = await sendPromise;
      expect(success).toBe(true);
    });

    it('should format QoS 1 PUBLISH packets with topic name before packet identifier according to MQTT 3.1.1 spec', async () => {
      const connectPromise = adapter.connect();
      // @ts-ignore
      const socketInstance = global.WebSocket.mockInstances[0];
      socketInstance.onmessage({ data: new Uint8Array([0x20, 0x02, 0x00, 0x00]).buffer });
      await connectPromise;

      const command: DeviceCommand = { cmd: 'PREPARE', val: 'negroni' };
      void adapter.sendCommand(command);
      await Promise.resolve();
      await Promise.resolve();

      const sentPackets = socketInstance.send.mock.calls;
      let qos1Packet: Uint8Array | null = null;
      for (const call of sentPackets) {
        const bytes = call[0] as Uint8Array;
        if (bytes[0] === 0x32) { // PUBLISH QoS 1
          qos1Packet = bytes;
          break;
        }
      }

      expect(qos1Packet).not.toBeNull();
      if (qos1Packet) {
        // En MQTT 3.1.1, después del header y remaining length, los primeros 2 bytes del variable header son la longitud del topic
        const topicLen = (qos1Packet[2] << 8) | qos1Packet[3];
        const topicBytes = qos1Packet.slice(4, 4 + topicLen);
        const topicStr = new TextDecoder().decode(topicBytes);
        expect(topicStr).toBe('penpito/kraken/command');
        // Los siguientes 2 bytes son el Packet Identifier
        const packetId = (qos1Packet[4 + topicLen] << 8) | qos1Packet[5 + topicLen];
        expect(typeof packetId).toBe('number');
        expect(packetId).toBeGreaterThan(0);
      }
    });
  });

  describe('state change notifications', () => {
    it('should trigger stateChangeCallback when receiving a state update topic', () => {
      const stateCallback = jest.fn();
      adapter.onStateChange(stateCallback);

      const nextState: MachineState = {
        isOn: true,
        status: 'preparing',
        currentRecipeId: 'piscola',
        requestedIceCount: 2,
        isDrinkReady: false,
        completedStepIds: [],
        skippedStepIds: [],
      };

      // Simular la llegada de un payload de estado
      // @ts-ignore
      adapter.handleMessage('penpito/kraken/state', JSON.stringify(nextState));

      expect(stateCallback).toHaveBeenCalledTimes(2); // Una vez al registrarse (onStateChange llama a fireStateChange) y otra al recibir el mensaje
      expect(stateCallback).toHaveBeenLastCalledWith(nextState);
    });
  });

  describe('presence (LWT retained)', () => {
    it('should mark device offline on retained LWT payload "offline"', () => {
      const cb = jest.fn();
      adapter.onConnectionChange(cb);

      // @ts-ignore
      adapter.handleMessage('penpito/kraken/presence', 'offline', true);

      const lastSnapshot = cb.mock.calls.at(-1)?.[0];
      expect(lastSnapshot.deviceOnline).toBe(false);
      expect(lastSnapshot.lastDeviceMessageAt).toBeNull();
    });

    it('should mark device online on retained payload "online"', () => {
      const cb = jest.fn();
      adapter.onConnectionChange(cb);

      // @ts-ignore
      adapter.handleMessage('penpito/kraken/presence', 'online', true);

      const lastSnapshot = cb.mock.calls.at(-1)?.[0];
      expect(lastSnapshot.deviceOnline).toBe(true);
      expect(typeof lastSnapshot.lastDeviceMessageAt).toBe('number');
    });

    it('should not mutate MachineState.status when broker connection fails', async () => {
      const stateCb = jest.fn();
      adapter.onStateChange(stateCb);
      const initialStatus = stateCb.mock.calls[0][0].status;

      const connectPromise = adapter.connect();
      // @ts-ignore
      const socketInstance = global.WebSocket.mockInstances[0];
      socketInstance.onerror();
      socketInstance.onclose();
      await connectPromise;

      // La app no deberia reportar que la maquina entro en 'error'.
      const lastState = stateCb.mock.calls.at(-1)?.[0];
      expect(lastState.status).toBe(initialStatus);
    });
  });
});
