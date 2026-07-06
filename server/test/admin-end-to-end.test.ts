/**
 * Test de integración: el core reenvía un admin command al hardware
 * (publishHardwareCommand) y maneja el hardware_ack.
 *
 * Aquí no testeamos el wiring de main.ts; eso queda para el wiring real
 * con el broker MQTT. El test verifica que el core:
 *  - Acepta admin commands de la app.
 *  - Los reenvía al bus con issuedBy=controller.
 *  - El hardware_ack correspondiente se procesa (y main.ts lo republica
 *    por admin/result si el ACK no tiene activeOrderId).
 */

import {
  OrderControllerCore,
  ControllerEventBus,
} from '../src/OrderControllerCore';
import { createInMemoryPersistence } from '../src/persistence';
import {
  CommandAck,
  CommandEnvelope,
  HardwareState,
  makeCommandAck,
  makeOrderEnvelope,
  OrderEnvelope,
  OrderEvent,
  PROTOCOL_VERSION,
} from '../../src/protocol/types';

class CapturingBus implements ControllerEventBus {
  hardwareCommands: CommandEnvelope[] = [];
  hardwareAuthoritative: HardwareState[] = [];
  events: OrderEvent[] = [];

  publishOrderEvent(event: OrderEvent) { this.events.push(event); }
  publishQueueSnapshot(_t: number, _e: any, _a: OrderEnvelope | null, _n: number) {}
  publishHardwareAuthoritativeState(state: HardwareState) { this.hardwareAuthoritative.push(state); }
  publishHardwareCommand(command: CommandEnvelope) { this.hardwareCommands.push(command); }
  log() { /* noop */ }
}

function adminCmd(commandId: string, type: CommandEnvelope['type'], payload?: Record<string, unknown>): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    type,
    issuedBy: 'mobile',
    issuedAt: Date.now(),
    ...(payload ? { payload } : {}),
  };
}

describe('Integración: admin command end-to-end (core + bus)', () => {
  let core: OrderControllerCore;
  let bus: CapturingBus;

  beforeEach(() => {
    bus = new CapturingBus();
    const persistence = createInMemoryPersistence();
    core = new OrderControllerCore(persistence, bus);
  });

  it('POWER ON: core.submitAdminCommand → bus.publishHardwareCommand', () => {
    const r = core.submitAdminCommand(adminCmd('pwr-1', 'POWER', { val: 'ON' }));
    expect(r.accepted).toBe(true);
    expect(bus.hardwareCommands).toHaveLength(1);
    const fwd = bus.hardwareCommands[0];
    expect(fwd.commandId).toBe('pwr-1');
    expect(fwd.type).toBe('POWER');
    expect(fwd.issuedBy).toBe('controller');
    expect(fwd.payload).toEqual({ val: 'ON' });
  });

  it('CLEAN: reenvía al hardware', () => {
    core.submitAdminCommand(adminCmd('clean-1', 'CLEAN'));
    expect(bus.hardwareCommands).toHaveLength(1);
    expect(bus.hardwareCommands[0].type).toBe('CLEAN');
  });

  it('hardware ACK admin: handleCommandAck no encuentra el order (es admin) y devuelve unknown_command, sin efectos colaterales', () => {
    core.submitAdminCommand(adminCmd('pwr-2', 'POWER', { val: 'OFF' }));
    expect(bus.hardwareCommands).toHaveLength(1);
    // El hardware confirma con un CommandAck sin orderId. El controller no tiene
    // un orderId asociado, por lo que handleCommandAck devuelve unknown_command.
    // En main.ts, este ACK se republica por admin/result para que la app lo vea.
    const ack = makeCommandAck({ commandId: 'pwr-2', accepted: true, timestamp: Date.now() });
    const r = core.handleCommandAck(ack);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('unknown_command');
    // No debe haberse publicado ningún OrderEvent.
    expect(bus.events).toHaveLength(0);
  });

  it('admin command rechazado: no se publica hardware command', () => {
    const r = core.submitAdminCommand(adminCmd('', 'POWER'));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('missing_command_id');
    expect(bus.hardwareCommands).toHaveLength(0);
  });

  it('admin command no interfiere con la cola de pedidos', () => {
    // Someter un pedido: el core intenta reclamar; sin hardware encendido,
    // no genera comando PREPARE.
    const env = makeOrderEnvelope({
      orderId: 'ord_int_1',
      tableId: 1,
      commandId: 'cmd_ord_1',
      recipeId: 'piscola',
      options: { iceCount: 2 },
      requestedAt: Date.now(),
    });
    core.submitOrder(env);
    // Someter un admin command: el core lo reenvía al bus.
    core.submitAdminCommand(adminCmd('clean-1', 'CLEAN'));

    // El bus solo recibió el admin command.
    const types = bus.hardwareCommands.map((c) => c.type);
    expect(types).toEqual(['CLEAN']);
  });
});
