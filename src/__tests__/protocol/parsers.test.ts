import {
  parseOrderEnvelope,
  parseOrderEvent,
  parseCommandEnvelope,
  parseCommandAck,
  parseHardwareState,
  parseQueueSnapshot,
} from '../../../src/protocol/parsers';
import { PROTOCOL_VERSION } from '../../../src/protocol/types';

describe('protocol/parsers', () => {
  describe('parseOrderEnvelope', () => {
    it('rechaza un payload sin protocolVersion correcto', () => {
      expect(
        parseOrderEnvelope({ protocolVersion: 1, orderId: 'a', tableId: 1, commandId: 'c', recipeId: 'r' })
      ).toBeNull();
    });

    it('rechaza payload sin campos requeridos', () => {
      expect(parseOrderEnvelope({ protocolVersion: 2 })).toBeNull();
      expect(
        parseOrderEnvelope({ protocolVersion: 2, orderId: '', tableId: 1, commandId: 'c', recipeId: 'r' })
      ).toBeNull();
      expect(
        parseOrderEnvelope({ protocolVersion: 2, orderId: 'a', tableId: 0, commandId: 'c', recipeId: 'r' })
      ).toBeNull();
    });

    it('parsea correctamente un envelope válido', () => {
      const env = parseOrderEnvelope({
        protocolVersion: 2,
        orderId: 'ord_1',
        tableId: 3,
        commandId: 'cmd_1',
        recipeId: 'negroni',
        guestName: 'Gael',
        groupId: 'g1',
        requestedAt: 1000,
        options: { iceCount: 3, alcoholOz: 2.5, mixerOz: 1, piscolaIntensity: 'normal' },
      });
      expect(env).not.toBeNull();
      expect(env!.options.iceCount).toBe(3);
      expect(env!.options.alcoholOz).toBe(2.5);
      expect(env!.options.piscolaIntensity).toBe('normal');
    });

    it('clampa iceCount fuera de rango', () => {
      const env = parseOrderEnvelope({
        protocolVersion: 2,
        orderId: 'ord_1',
        tableId: 1,
        commandId: 'cmd_1',
        recipeId: 'r',
        requestedAt: 1,
        options: { iceCount: 99 },
      });
      expect(env!.options.iceCount).toBeLessThanOrEqual(20);
    });
  });

  describe('parseOrderEvent', () => {
    it('rechaza type desconocido', () => {
      const ev = parseOrderEvent({
        protocolVersion: 2,
        type: 'BOGUS',
        orderId: 'o',
        tableId: 1,
        commandId: 'c',
        sequence: 0,
        timestamp: 1,
      });
      expect(ev).toBeNull();
    });

    it('acepta PREPARATION_COMPLETED y PREPARATION_FAILED', () => {
      expect(
        parseOrderEvent({
          protocolVersion: 2,
          type: 'PREPARATION_COMPLETED',
          orderId: 'o',
          tableId: 1,
          commandId: 'c',
          sequence: 1,
          timestamp: 1,
        })
      ).not.toBeNull();
      const failed = parseOrderEvent({
        protocolVersion: 2,
        type: 'PREPARATION_FAILED',
        orderId: 'o',
        tableId: 1,
        commandId: 'c',
        sequence: 1,
        timestamp: 1,
        failureCode: 'home_failed',
        reason: 'home did not trigger',
      });
      expect(failed!.failureCode).toBe('home_failed');
    });
  });

  describe('parseCommandEnvelope', () => {
    it('rechaza issuedBy inválido', () => {
      expect(
        parseCommandEnvelope({
          protocolVersion: 2,
          type: 'PREPARE',
          commandId: 'c',
          issuedAt: 1,
          issuedBy: 'rogue',
        })
      ).toBeNull();
    });

    it('acepta issuedBy=mobile|controller', () => {
      for (const issuedBy of ['mobile', 'controller'] as const) {
        const env = parseCommandEnvelope({
          protocolVersion: 2,
          type: 'PREPARE',
          commandId: 'c',
          issuedAt: 1,
          issuedBy,
        });
        expect(env).not.toBeNull();
      }
    });
  });

  describe('parseCommandAck', () => {
    it('rechaza payload sin commandId', () => {
      expect(parseCommandAck({ protocolVersion: 2, accepted: true, timestamp: 0 })).toBeNull();
    });

    it('rechaza protocolVersion incorrecto', () => {
      expect(parseCommandAck({ protocolVersion: 1, commandId: 'c', accepted: true, timestamp: 0 })).toBeNull();
    });

    it('acepta commandId + accepted + reason', () => {
      const ack = parseCommandAck({
        protocolVersion: PROTOCOL_VERSION,
        commandId: 'c',
        accepted: false,
        reason: 'machine_busy',
        failureCode: 'machine_busy',
        timestamp: 1,
      });
      expect(ack!.accepted).toBe(false);
      expect(ack!.failureCode).toBe('machine_busy');
    });
  });

  describe('parseHardwareState', () => {
    it('rechaza state inválido', () => {
      expect(
        parseHardwareState({
          protocolVersion: 2,
          bootId: 'b',
          isOn: true,
          status: 'not-a-state',
          stateSequence: 0,
          uptimeMs: 0,
        })
      ).toBeNull();
    });

    it('normaliza activeOrderId null cuando no es string', () => {
      const s = parseHardwareState({
        protocolVersion: 2,
        bootId: 'b',
        isOn: true,
        status: 'idle',
        stateSequence: 0,
        uptimeMs: 0,
        activeOrderId: 42,
      });
      expect(s!.activeOrderId).toBeNull();
    });
  });

  describe('parseQueueSnapshot', () => {
    it('filtra orders con state inválido', () => {
      const snap = parseQueueSnapshot({
        protocolVersion: 2,
        tableId: 1,
        generatedAt: 1,
        orders: [
          { orderId: 'a', commandId: 'c', recipeId: 'r', requestedAt: 1, state: 'queued', options: { iceCount: 0 } },
          { orderId: 'b', commandId: 'c', recipeId: 'r', requestedAt: 1, state: 'BOGUS', options: { iceCount: 0 } },
        ],
        activeOrder: null,
      });
      expect(snap!.orders).toHaveLength(1);
      expect(snap!.orders[0].orderId).toBe('a');
    });
  });
});
