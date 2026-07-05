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
});
