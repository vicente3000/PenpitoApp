import { PenpitoAppMqttAdapter } from '../../adapters/PenpitoAppMqttAdapter';
import { makeCommandAck, PROTOCOL_VERSION } from '../../protocol/types';

/**
 * Tests del método submitAdminCommand del adapter.
 *
 * Simula el ciclo: app publica MOBILE_ADMIN_COMMAND → controller recibe
 * y reenvía a CONTROLLER_HARDWARE_COMMAND → hardware publica
 * HARDWARE_COMMAND_ACK → controller publica CONTROLLER_ADMIN_RESULT →
 * app recibe el resultado por commandId.
 */

class MockClient {
  published: Array<{ topic: string; payload: string }> = [];
  publish(topic: string, payload: string, _qos?: number, _retain?: boolean) {
    this.published.push({ topic, payload });
  }
  subscribe() {}
  disconnect() {}
}

function makeConnectedAdapter() {
  const adapter = new PenpitoAppMqttAdapter('ws://localhost:9001');
  // Forzar estado "conectado" sin abrir conexión real.
  (adapter as any).isConnected = true;
  (adapter as any).currentBrokerStatus = 'connected';
  (adapter as any).client = new MockClient();
  // Evitar que connect() intente abrir socket.
  (adapter as any).connect = () => Promise.resolve(true);
  return adapter;
}

describe('PenpitoAppMqttAdapter.submitAdminCommand', () => {
  it('publica en penpito/v2/mobile/admin/command con commandId preservado', async () => {
    const adapter = makeConnectedAdapter();
    const promise = adapter.submitAdminCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'admin-1',
      type: 'POWER',
      issuedBy: 'mobile',
      issuedAt: Date.now(),
      payload: { val: 'ON' },
    }, 200);
    // Esperar a que la promesa interna se ejecute.
    await new Promise((r) => setTimeout(r, 10));
    const mock = (adapter as any).client as MockClient;
    expect(mock.published).toHaveLength(1);
    const pub = mock.published[0];
    expect(pub.topic).toBe('penpito/v2/mobile/admin/command');
    const body = JSON.parse(pub.payload);
    expect(body.commandId).toBe('admin-1');
    expect(body.type).toBe('POWER');
    expect(body.issuedBy).toBe('mobile');
    expect(body.payload).toEqual({ val: 'ON' });
    await expect(promise).rejects.toThrow('admin_command_timeout');
  });

  it('rechaza envelope sin commandId', async () => {
    const adapter = makeConnectedAdapter();
    await expect(
      adapter.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: '',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      })
    ).rejects.toThrow('admin_command_invalid');
  });

  it('rechaza envelope sin type', async () => {
    const adapter = makeConnectedAdapter();
    await expect(
      adapter.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'cmd-1',
        type: '' as any,
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      })
    ).rejects.toThrow('admin_command_invalid');
  });

  it('resuelve la promesa cuando llega un admin/result con el mismo commandId', async () => {
    const adapter = makeConnectedAdapter();

    const promise = adapter.submitAdminCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'admin-2',
      type: 'POWER',
      issuedBy: 'mobile',
      issuedAt: Date.now(),
      payload: { val: 'ON' },
    }, 1000);

    // Esperar a que el body de la promesa se ejecute (registre el listener).
    await new Promise((r) => setTimeout(r, 0));

    // Inyectar un mensaje simulado: el controller publica admin/result.
    const ack = makeCommandAck({ commandId: 'admin-2', accepted: true, timestamp: Date.now() });
    (adapter as any).handleMessage(
      'penpito/v2/controller/admin/result',
      JSON.stringify(ack),
      false
    );

    const result = await promise;
    expect(result.accepted).toBe(true);
    expect(result.commandId).toBe('admin-2');
  });

  it('no resuelve con un admin/result de otro commandId', async () => {
    const adapter = makeConnectedAdapter();

    const promise = adapter.submitAdminCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'admin-3',
      type: 'CLEAN',
      issuedBy: 'mobile',
      issuedAt: Date.now(),
    }, 300);

    const otherAck = makeCommandAck({ commandId: 'admin-other', accepted: true, timestamp: Date.now() });
    (adapter as any).handleMessage(
      'penpito/v2/controller/admin/result',
      JSON.stringify(otherAck),
      false
    );

    await expect(promise).rejects.toThrow('admin_command_timeout');
  });
});

