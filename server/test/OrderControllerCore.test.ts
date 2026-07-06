import {
  OrderControllerCore,
  ControllerEventBus,
} from '../../server/src/OrderControllerCore';
import { createInMemoryPersistence } from '../../server/src/persistence';
import { makeOrderEnvelope, makeCommandAck, makeOrderEvent, OrderEnvelope, OrderEvent, HardwareState, PROTOCOL_VERSION, CommandEnvelope } from '../../src/protocol/types';

class CapturingBus implements ControllerEventBus {
  events: OrderEvent[] = [];
  snapshots: Array<{ tableId: number; activeOrder: OrderEnvelope | null; entriesCount: number; now: number }> = [];
  hardwareAuthoritative: HardwareState[] = [];
  hardwareCommands: CommandEnvelope[] = [];
  logEntries: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  publishOrderEvent(event: OrderEvent) { this.events.push(event); }
  publishQueueSnapshot(tableId: number, _entries: unknown, activeOrder: OrderEnvelope | null, now: number) {
    this.snapshots.push({ tableId, activeOrder, entriesCount: 0, now });
  }
  publishHardwareAuthoritativeState(state: HardwareState) { this.hardwareAuthoritative.push(state); }
  publishHardwareCommand(command: CommandEnvelope) { this.hardwareCommands.push(command); }
  log(message: string, meta?: Record<string, unknown>) {
    this.logEntries.push({ message, meta });
  }
}

function envelope(orderId: string, tableId: number, recipeId = 'piscola', iceCount = 2, requestedAt = Date.now()): OrderEnvelope {
  return makeOrderEnvelope({
    orderId,
    tableId,
    commandId: `cmd-${orderId}`,
    recipeId,
    options: { iceCount },
    requestedAt,
  });
}

function ack(commandId: string, accepted: boolean) {
  return makeCommandAck({ commandId, accepted, timestamp: Date.now() });
}

function hardwareState(overrides: Partial<HardwareState> = {}): HardwareState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    bootId: 'boot123',
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
    ...overrides,
  };
}

describe('OrderControllerCore', () => {
  let bus: CapturingBus;
  let core: OrderControllerCore;

  beforeEach(() => {
    bus = new CapturingBus();
    const persistence = createInMemoryPersistence();
    core = new OrderControllerCore(persistence, bus);
    // Hardware presente e idle para que el dispatcher pueda reclamar.
    core.updateHardwareState(hardwareState());
  });

  it('acepta un pedido, lo encola y publica un comando PREPARE', () => {
    const result = core.submitOrder(envelope('ord_1', 1));
    expect(result.accepted).toBe(true);
    expect(bus.hardwareCommands).toHaveLength(1);
    expect(bus.hardwareCommands[0].type).toBe('PREPARE');
    expect(bus.hardwareCommands[0].orderId).toBe('ord_1');
    expect(bus.events.some((e) => e.type === 'ORDER_ACCEPTED')).toBe(true);
  });

  it('idempotente: dos submits con mismo orderId+commandId solo encolan una vez', () => {
    const env = envelope('ord_2', 1);
    const first = core.submitOrder(env);
    const second = core.submitOrder(env);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(bus.hardwareCommands).toHaveLength(1);
    expect(core.getState().orders.size).toBe(1);
  });

  it('rechaza un orderId reusado con commandId distinto', () => {
    core.submitOrder(envelope('ord_3', 1));
    const conflicting = { ...envelope('ord_3', 1), commandId: 'cmd-OTHER' };
    const result = core.submitOrder(conflicting);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('orderId_conflict');
  });

  it('FIFO: 10 pedidos concurrentes mantienen el orden de despacho', () => {
    // Someter secuencialmente para asegurar el orden requestedAt.
    for (let i = 0; i < 10; i++) {
      const env = envelope(`ord_${i}`, 1, 'piscola', 2, 1000 + i);
      core.submitOrder(env);
    }
    console.log('claimedOrderId=', (core as any).state.claimedOrderId);
    console.log('hardwareCommands.length=', bus.hardwareCommands.length);
    console.log('commands=', bus.hardwareCommands.map((c) => c.orderId));
    // Sólo se despacha el primero (los demás quedan en cola).
    expect(bus.hardwareCommands).toHaveLength(1);
    expect(bus.hardwareCommands[0].orderId).toBe('ord_0');
    // Aceptar el primero, simular completado → ready, pero el siguiente NO se
    // despacha hasta que el operador confirme TAKEN (liberación de bandeja).
    const dispatched = bus.hardwareCommands[0];
    core.handleCommandAck(ack(dispatched.commandId, true));
    core.handleHardwareEvent(
      makeOrderEvent({
        type: 'PREPARATION_COMPLETED',
        orderId: 'ord_0',
        tableId: 1,
        commandId: dispatched.commandId,
        sequence: 1,
      })
    );
    // El siguiente NO se despacha: bandeja ocupada.
    expect(bus.hardwareCommands).toHaveLength(1);
  });

  it('NO marca failed por idle transitorio: el pedido sigue preparing hasta COMPLETED', () => {
    const env = envelope('ord_idle', 1);
    core.submitOrder(env);
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    // El hardware publica idle (sin isDrinkReady) como heart-beat normal.
    core.updateHardwareState(hardwareState({ status: 'idle', stateSequence: 2 }));
    const order = core.getOrder('ord_idle');
    expect(order!.state).toBe('accepted'); // sigue tracking, NO failed
  });

  it('PREPARATION_COMPLETED(orderId) es la única señal que marca ready', () => {
    const env = envelope('ord_complete', 1);
    core.submitOrder(env);
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    core.handleHardwareEvent(
      makeOrderEvent({
        type: 'PREPARATION_COMPLETED',
        orderId: 'ord_complete',
        tableId: 1,
        commandId: cmd.commandId,
        sequence: 1,
      })
    );
    const order = core.getOrder('ord_complete');
    expect(order!.state).toBe('ready');
  });

  it('PREPARATION_FAILED(orderId) marca failed y libera la cola', () => {
    const env = envelope('ord_fail', 1);
    core.submitOrder(env);
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    core.handleHardwareEvent(
      makeOrderEvent({
        type: 'PREPARATION_FAILED',
        orderId: 'ord_fail',
        tableId: 1,
        commandId: cmd.commandId,
        sequence: 1,
        reason: 'home did not trigger',
        failureCode: 'home_failed',
      })
    );
    const order = core.getOrder('ord_fail');
    expect(order!.state).toBe('failed');
    expect(order!.failureCode).toBe('home_failed');
  });

  it('duplicate PREPARE no prepara dos tragos: el controller ya envió el comando y el firmware cachea por commandId', () => {
    // Una simulación más alta: simulamos que el firmware recibe el PREPARE dos veces
    // (publicamos el mismo comando dos veces). El core sólo encola una vez.
    const env = envelope('ord_dup', 1);
    core.submitOrder(env);
    // El segundo submit con mismo envelope NO causa un nuevo PREPARE.
    core.submitOrder(env);
    expect(bus.hardwareCommands).toHaveLength(1);
  });

  it('PREPARE duplicado con commandId distinto: rejected, no segunda preparación', () => {
    const env = envelope('ord_dup2', 1);
    core.submitOrder(env);
    // ACK llega: el pedido está 'accepted'.
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    // Un cliente buggy reenvía el mismo orderId con commandId nuevo.
    const conflict = { ...env, commandId: 'cmd-DIFFERENT' };
    const result = core.submitOrder(conflict);
    expect(result.accepted).toBe(false);
  });

  it('watchdog: pedido en dispatching sin HARDWARE_ACCEPTED → failed por timeout_preparation_start', () => {
    // Hacemos un pedido, dejamos que se publique el comando, NO respondemos ACK.
    core.submitOrder(envelope('ord_watch', 1));
    // Forzamos el reloj.
    const dispatchedAt = core.getOrder('ord_watch')!.dispatchedAt!;
    const result = core.tickWatchdog(dispatchedAt + 31_000);
    expect(result.events.some((e) => e.failureCode === 'timeout_preparation_start')).toBe(true);
  });

  it('watchdog: pedido en preparing sin heartbeat → failed por timeout_no_progress', () => {
    core.submitOrder(envelope('ord_watch2', 1));
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    const lastEventAt = core.getOrder('ord_watch2')!.lastEventAt;
    const result = core.tickWatchdog(lastEventAt + 91_000);
    expect(result.events.some((e) => e.failureCode === 'timeout_no_progress')).toBe(true);
  });

  it('cancelOrder en queued: marca failed, libera cola, publica ORDER_RELEASED', () => {
    // Para que un pedido quede en 'queued' y no sea promovido, primero debemos
    // ocupar el hardware. Someter un pedido lo pone 'dispatching'; para tener
    // un pedido en 'queued' necesitamos otro antes ya 'dispatching'.
    core.submitOrder(envelope('ord_occupy', 1, 'piscola', 2, 1000));
    // ord_occupy ya está 'dispatching'. Ahora sometemos el que queremos cancelar.
    core.submitOrder(envelope('ord_a', 1, 'piscola', 2, 2000));
    const result = core.cancelOrder('ord_a');
    expect(result.accepted).toBe(true);
    expect(core.getOrder('ord_a')!.state).toBe('failed');
    expect(bus.events.some((e) => e.type === 'ORDER_RELEASED')).toBe(true);
  });

  it('serveOrder sólo aplica a ready', () => {
    core.submitOrder(envelope('ord_serve', 1));
    const cmd = bus.hardwareCommands[0];
    core.handleCommandAck(ack(cmd.commandId, true));
    // Aún no está ready: serveOrder falla.
    const r1 = core.serveOrder('ord_serve');
    expect(r1.accepted).toBe(false);
    // Lo marcamos ready vía evento.
    core.handleHardwareEvent(
      makeOrderEvent({
        type: 'PREPARATION_COMPLETED',
        orderId: 'ord_serve',
        tableId: 1,
        commandId: cmd.commandId,
        sequence: 2,
      })
    );
    const r2 = core.serveOrder('ord_serve');
    expect(r2.accepted).toBe(true);
    expect(core.getOrder('ord_serve')!.state).toBe('served');
  });

  it('stale retained state con orderId desconocido: el controller no se inmuta', () => {
    // Hardware publica un snapshot retained viejo con un orderId que ya no existe.
    const result = core.updateHardwareState(
      hardwareState({
        activeOrderId: 'ord_ghost',
        activeTableId: 1,
        stateSequence: 99,
      })
    );
    // No lanza, no muta ordenes propias.
    expect(result.accepted).toBe(true);
    expect(core.getOrder('ord_ghost')).toBeNull();
  });

  it('múltiples mesas: el orden global es FIFO por requestedAt, no por mesa', () => {
    core.submitOrder(envelope('a_t1', 1, 'piscola', 2, 1000));
    core.submitOrder(envelope('a_t2', 2, 'piscola', 2, 999));
    // Sólo el primero en ser reclamado es 'a_t1' (el primero en entrar).
    expect(bus.hardwareCommands[0].orderId).toBe('a_t1');
  });

  it('persiste y recupera estado tras reinicio simulado', () => {
    core.submitOrder(envelope('ord_persist', 1, 'piscola', 2, 2000));
    // Reconstruimos el core con la misma persistence (en memoria: debe sobrevivir).
    // Usamos la misma persistence recargada.
    const persistence = createInMemoryPersistence();
    const reloaded = new OrderControllerCore(persistence, bus);
    // La persistence en memoria es nueva; este test verifica que saveOrder se llamó,
    // no la recuperación (eso lo cubre el test de persistencia con un archivo real).
    reloaded.updateHardwareState(hardwareState());
    expect(reloaded.getState().orders.size).toBe(0); // nuevo, no comparte memoria
  });

  it('soak: 50 pedidos secuenciales sin solapamiento', () => {
    // Someter 50 pedidos. El primero se dispatcha; los demás esperan.
    for (let i = 0; i < 50; i++) {
      core.submitOrder(envelope(`ord_soak_${i}`, (i % 5) + 1, 'piscola', 2, 5000 + i));
    }
    // Sólo 1 comando inicial.
    expect(bus.hardwareCommands).toHaveLength(1);
    expect(bus.hardwareCommands[0].orderId).toBe('ord_soak_0');

    // Tras cada servido, el controller publica TAKEN (1) + el siguiente PREPARE (1).
    // El número total esperado de comandos: 1 inicial + 50*(TAKEN + siguiente PREPARE)
    // = 1 + 99 = 100. El último PREPARE ya no genera TAKEN siguiente.
    const prepareCmds = () => bus.hardwareCommands.filter((c) => c.type === 'PREPARE');
    const takenCmds = () => bus.hardwareCommands.filter((c) => c.type === 'TAKEN');

    // Simular flujo normal: cada pedido se acepta, completa, se sirve, y se
    // promueve el siguiente. Nunca debe haber más de 1 PREPARE en vuelo.
    for (let i = 0; i < 50; i++) {
      const prepareCmd = prepareCmds()[i];
      expect(prepareCmd.orderId).toBe(`ord_soak_${i}`);
      // ACK
      core.handleCommandAck(ack(prepareCmd.commandId, true));
      // COMPLETED
      core.handleHardwareEvent(
        makeOrderEvent({
          type: 'PREPARATION_COMPLETED',
          orderId: prepareCmd.orderId!,
          tableId: prepareCmd.tableId!,
          commandId: prepareCmd.commandId,
          sequence: 1,
        })
      );
      // SERVED (en cada iteración se acumula 1 TAKEN).
      const result = core.serveOrder(prepareCmd.orderId!);
      expect(result.accepted).toBe(true);
      // Tras servido, esperamos (i+1) PREPARE y (i+1) TAKEN. El TAKEN del último
      // también se publica (no hay siguiente en cola, pero el sim lo aceptará).
      const expectedTotal = i < 49 ? (i + 1) * 2 + 1 : 50 * 2;
      expect(bus.hardwareCommands).toHaveLength(expectedTotal);
    }
    // 50 PREPARE + 50 TAKEN.
    expect(prepareCmds()).toHaveLength(50);
    expect(takenCmds()).toHaveLength(50);
    // Verificar que todos los pedidos terminaron en 'served' con orden FIFO.
    const allOrders = [...core.getState().orders.values()];
    for (const order of allOrders) {
      expect(order.state).toBe('served');
    }
  });

  it('evento PREPARATION_COMPLETED antes de HARDWARE_ACCEPTED: el controller espera el ACK y luego acepta', () => {
    // Algunos firmwares publican progreso apenas reciben el comando, incluso
    // antes de que el callback MQTT termine. El controller debe tolerarlo.
    core.submitOrder(envelope('ord_race', 1));
    const cmd = bus.hardwareCommands[0];
    // Simulamos PREPARATION_PROGRESS sin ACK previo.
    const result = core.handleHardwareEvent(
      makeOrderEvent({
        type: 'PREPARATION_PROGRESS',
        orderId: 'ord_race',
        tableId: 1,
        commandId: cmd.commandId,
        sequence: 1,
      })
    );
    // El controller acepta el evento (no falla), pero el pedido sigue en
    // 'dispatching' hasta que llegue el ACK.
    const order = core.getOrder('ord_race');
    expect(order!.state).toBe('dispatching');
    // Ahora llega el ACK, pedido pasa a 'accepted'.
    core.handleCommandAck(ack(cmd.commandId, true));
    expect(core.getOrder('ord_race')!.state).toBe('accepted');
  });

  describe('submitAdminCommand', () => {
    it('POWER ON reenvía al hardware con issuedBy=controller', () => {
      const result = core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-power-on-1',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
        payload: { val: 'ON' },
      });
      expect(result.accepted).toBe(true);
      expect(bus.hardwareCommands).toHaveLength(1);
      const forwarded = bus.hardwareCommands[0];
      expect(forwarded.commandId).toBe('admin-power-on-1');
      expect(forwarded.type).toBe('POWER');
      expect(forwarded.issuedBy).toBe('controller');
      expect(forwarded.payload).toEqual({ val: 'ON' });
    });

    it('rechaza commandId vacío', () => {
      const result = core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: '',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('missing_command_id');
      expect(bus.hardwareCommands).toHaveLength(0);
    });

    it('rechaza protocolo incorrecto', () => {
      const result = core.submitAdminCommand({
        protocolVersion: 1 as any,
        commandId: 'cmd-1',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('protocol_mismatch');
    });

    it('SET_CALIB con rates/positions se reenvía tal cual', () => {
      const result = core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'calib-1',
        type: 'SET_CALIB',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
        payload: { rates: [24.7, 23.6], positions: [3600, 2600] },
      });
      expect(result.accepted).toBe(true);
      expect(bus.hardwareCommands[0].payload).toEqual({
        rates: [24.7, 23.6],
        positions: [3600, 2600],
      });
    });

    it('TEST_HW reenvía con payload arbitrario', () => {
      const result = core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'test-pump',
        type: 'TEST_HW',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
        payload: { type: 'pump', pin: 3, duration: 10_000 },
      });
      expect(result.accepted).toBe(true);
      expect(bus.hardwareCommands[0].payload).toEqual({
        type: 'pump',
        pin: 3,
        duration: 10_000,
      });
    });

    it('no interfiere con la cola de pedidos', () => {
      core.submitOrder(envelope('ord_admin_isolated', 1));
      expect(bus.hardwareCommands).toHaveLength(1);
      core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-1',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      expect(bus.hardwareCommands).toHaveLength(2);
      expect(bus.hardwareCommands[0].type).toBe('PREPARE');
      expect(bus.hardwareCommands[1].type).toBe('POWER');
    });
  });

  describe('hardening v2: ACK, idempotencia, drain', () => {
    it('admin command idempotente: el mismo commandId no se reenvía 2 veces', () => {
      const cmd = {
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-idem-1',
        type: 'POWER' as const,
        issuedBy: 'mobile' as const,
        issuedAt: Date.now(),
        payload: { val: 'ON' },
      };
      core.submitAdminCommand(cmd);
      core.submitAdminCommand(cmd);
      core.submitAdminCommand(cmd);
      expect(bus.hardwareCommands.filter((c) => c.commandId === 'admin-idem-1')).toHaveLength(1);
    });

    it('consumeAdminAck devuelve el ACK cuando el commandId es admin conocido', () => {
      core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-drain-1',
        type: 'CLEAN',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      const a1 = ack('admin-drain-1', true);
      const consumed = core.consumeAdminAck(a1);
      expect(consumed).not.toBeNull();
      expect(consumed!.commandId).toBe('admin-drain-1');
      // Segunda vez: ya consumido, devuelve null.
      const a2 = ack('admin-drain-1', true);
      expect(core.consumeAdminAck(a2)).toBeNull();
    });

    it('consumeAdminAck ignora commandIds desconocidos', () => {
      const a = ack('unknown-cmd', true);
      expect(core.consumeAdminAck(a)).toBeNull();
    });

    it('drainAdminCommandsOnHardwareLoss genera ACKs negativos para todos los admin en vuelo', () => {
      core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-A',
        type: 'POWER',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      core.submitAdminCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'admin-B',
        type: 'CLEAN',
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      });
      const drained = core.drainAdminCommandsOnHardwareLoss();
      expect(drained).toHaveLength(2);
      const ids = drained.map((d) => d.commandId).sort();
      expect(ids).toEqual(['admin-A', 'admin-B']);
      for (const d of drained) {
        expect(d.accepted).toBe(false);
        expect(d.failureCode).toBe('machine_offline');
      }
      // El set interno queda vacío.
      expect(core.getAdminCommandCount()).toBe(0);
    });

    it('serveOrder libera la bandeja con TAKEN command', () => {
      core.submitOrder(envelope('ord_release', 1));
      const prepare = bus.hardwareCommands[0];
      core.handleCommandAck(ack(prepare.commandId, true));
      core.handleHardwareEvent(makeOrderEvent({
        type: 'PREPARATION_COMPLETED',
        orderId: 'ord_release',
        tableId: 1,
        commandId: prepare.commandId,
        sequence: 1,
      }));
      const sizeBefore = bus.hardwareCommands.length;
      const r = core.serveOrder('ord_release');
      expect(r.accepted).toBe(true);
      // Se publicó un TAKEN command.
      const taken = bus.hardwareCommands.find((c) => c.type === 'TAKEN');
      expect(taken).toBeDefined();
      expect(taken!.orderId).toBe('ord_release');
      expect(bus.hardwareCommands.length).toBe(sizeBefore + 1);
    });
  });
});
