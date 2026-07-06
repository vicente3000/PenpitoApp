/**
 * Test E2E: simulación del ciclo completo de un pedido bajo v2.
 *
 *  1. La app somete un pedido (OrderControllerCore.submitOrder).
 *  2. El controller genera un PREPARE command al hardware.
 *  3. El hardware confirma con HARDWARE_ACCEPTED (vía CommandAck).
 *  4. El hardware publica PREPARATION_PROGRESS.
 *  5. El hardware publica PREPARATION_COMPLETED.
 *  6. La app (o el mesero) llama serveOrder → ORDER_SERVED.
 *  7. El controller libera la cola, intenta reclamar el siguiente.
 *
 * En paralelo, el controller reenvía admin commands al hardware.
 */

import {
  OrderControllerCore,
  ControllerEventBus,
} from '../src/OrderControllerCore';
import { createInMemoryPersistence } from '../src/persistence';
import {
  CommandEnvelope,
  HardwareState,
  makeCommandAck,
  makeOrderEnvelope,
  makeOrderEvent,
  OrderEvent,
  OrderEnvelope,
  PROTOCOL_VERSION,
} from '../../src/protocol/types';

class CapturingBus implements ControllerEventBus {
  hardwareCommands: CommandEnvelope[] = [];
  events: OrderEvent[] = [];
  publishOrderEvent(event: OrderEvent) { this.events.push(event); }
  publishQueueSnapshot(_t: number, _e: any, _a: OrderEnvelope | null, _n: number) {}
  publishHardwareAuthoritativeState(_s: HardwareState) {}
  publishHardwareCommand(command: CommandEnvelope) { this.hardwareCommands.push(command); }
  log() {}
}

function hwOn(): HardwareState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    bootId: 'boot1',
    isOn: true,
    status: 'idle',
    activeOrderId: null,
    activeTableId: null,
    activeCommandId: null,
    stateSequence: 1,
    activeStepId: null,
    completedStepIds: [],
    skippedStepIds: [],
    isDrinkReady: false,
    errorMessage: null,
    startedAt: null,
    uptimeMs: 1000,
  };
}

function envelope(orderId: string, tableId: number, recipeId: string, requestedAt: number): OrderEnvelope {
  return makeOrderEnvelope({
    orderId,
    tableId,
    commandId: `cmd-${orderId}`,
    recipeId,
    options: { iceCount: 2 },
    requestedAt,
  });
}

describe('E2E: ciclo completo de un pedido v2', () => {
  let core: OrderControllerCore;
  let bus: CapturingBus;

  beforeEach(() => {
    bus = new CapturingBus();
    core = new OrderControllerCore(createInMemoryPersistence(), bus);
    // El ESP32 está encendido y reporta su estado.
    core.updateHardwareState(hwOn());
  });

  it('submit → PREPARE → ACCEPTED → PROGRESS → COMPLETED → SERVED', () => {
    // 1. La app somete el pedido.
    const env = envelope('ord_e2e_1', 1, 'piscola', Date.now());
    const submit = core.submitOrder(env);
    expect(submit.accepted).toBe(true);

    // 2. El controller genera un PREPARE al hardware.
    const prepare = bus.hardwareCommands[0];
    expect(prepare.type).toBe('PREPARE');
    expect(prepare.orderId).toBe('ord_e2e_1');
    expect(prepare.tableId).toBe(1);
    expect(prepare.issuedBy).toBe('controller');

    // 3. El hardware confirma con HARDWARE_ACCEPTED (vía CommandAck).
    const ack = makeCommandAck({ commandId: prepare.commandId, accepted: true, timestamp: Date.now() });
    core.handleCommandAck(ack);

    const order = core.getOrder('ord_e2e_1')!;
    expect(order.state).toBe('accepted');

    // El hardware publica state con activeOrderId.
    core.updateHardwareState({
      ...hwOn(),
      activeOrderId: 'ord_e2e_1',
      activeTableId: 1,
      activeCommandId: prepare.commandId,
      stateSequence: 2,
    });

    // 4. PROGRESS.
    core.handleHardwareEvent(makeOrderEvent({
      type: 'PREPARATION_PROGRESS',
      orderId: 'ord_e2e_1',
      tableId: 1,
      commandId: prepare.commandId,
      sequence: 1,
    }));

    // 5. COMPLETED.
    core.handleHardwareEvent(makeOrderEvent({
      type: 'PREPARATION_COMPLETED',
      orderId: 'ord_e2e_1',
      tableId: 1,
      commandId: prepare.commandId,
      sequence: 2,
    }));

    expect(core.getOrder('ord_e2e_1')!.state).toBe('ready');

    // 6. El mesero marca como servido.
    const served = core.serveOrder('ord_e2e_1');
    expect(served.accepted).toBe(true);
    expect(core.getOrder('ord_e2e_1')!.state).toBe('served');
  });

  it('admin POWER ON/OFF en paralelo no afecta la cola', () => {
    // Sometemos un pedido.
    core.submitOrder(envelope('ord_e2e_2', 2, 'negroni', Date.now()));
    expect(bus.hardwareCommands).toHaveLength(1);

    // POWER ON en paralelo.
    core.submitAdminCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'admin-power-1',
      type: 'POWER',
      issuedBy: 'mobile',
      issuedAt: Date.now(),
      payload: { val: 'ON' },
    });
    expect(bus.hardwareCommands).toHaveLength(2);
    expect(bus.hardwareCommands[1].type).toBe('POWER');

    // CLEAN.
    core.submitAdminCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: 'admin-clean-1',
      type: 'CLEAN',
      issuedBy: 'mobile',
      issuedAt: Date.now(),
    });
    expect(bus.hardwareCommands).toHaveLength(3);
    expect(bus.hardwareCommands[2].type).toBe('CLEAN');

    // La cola sigue intacta: el pedido sigue en 'dispatching'.
    expect(core.getOrder('ord_e2e_2')!.state).toBe('dispatching');
  });

  it('FIFO entre mesas: el orden global es por orden de sometimiento', () => {
    // El FIFO del controller es por orden de submit (fifoKey monotónico),
    // no por requestedAt. Eso refleja el orden real en que la app somete.
    core.submitOrder(envelope('ord_table1', 1, 'piscola', 1000));
    core.submitOrder(envelope('ord_table2', 2, 'negroni', 500)); // requestedAt más antiguo, pero sometido después
    core.submitOrder(envelope('ord_table3', 3, 'piscola', 2000));

    // El primer comando generado debe ser el primero sometido (ord_table1).
    const firstPrepare = bus.hardwareCommands.find((c) => c.type === 'PREPARE')!;
    expect(firstPrepare.orderId).toBe('ord_table1');
  });
});
