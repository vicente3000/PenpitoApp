import {
  PROTOCOL_VERSION,
  makeOrderEnvelope,
  makeOrderEvent,
  makeCommandEnvelope,
} from '../../../src/protocol/types';

describe('protocol/types', () => {
  it('expone PROTOCOL_VERSION=2', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('makeOrderEnvelope genera un envelope válido', () => {
    const env = makeOrderEnvelope({
      orderId: 'ord_1',
      tableId: 3,
      commandId: 'cmd_1',
      recipeId: 'piscola',
      guestName: 'Gael',
      groupId: 'grp_1',
      options: { iceCount: 4, alcoholOz: 1.5, piscolaIntensity: 'fuerte' },
      requestedAt: 1000,
    });
    expect(env).toEqual({
      protocolVersion: 2,
      orderId: 'ord_1',
      tableId: 3,
      commandId: 'cmd_1',
      recipeId: 'piscola',
      guestName: 'Gael',
      groupId: 'grp_1',
      options: { iceCount: 4, alcoholOz: 1.5, mixerOz: undefined, piscolaIntensity: 'fuerte' },
      requestedAt: 1000,
    });
  });

  it('makeOrderEvent rellena timestamp con Date.now()', () => {
    const before = Date.now();
    const event = makeOrderEvent({
      type: 'PREPARATION_COMPLETED',
      orderId: 'ord_1',
      tableId: 1,
      commandId: 'cmd_1',
      sequence: 7,
    });
    const after = Date.now();
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
    expect(event.type).toBe('PREPARATION_COMPLETED');
    expect(event.sequence).toBe(7);
  });

  it('makeCommandEnvelope requiere commandId y type', () => {
    const cmd = makeCommandEnvelope({
      commandId: 'cmd_x',
      type: 'PREPARE',
      orderId: 'ord_1',
      tableId: 1,
      payload: { recipeId: 'piscola', iceCount: 2 },
      issuedBy: 'controller',
    });
    expect(cmd.protocolVersion).toBe(2);
    expect(cmd.issuedAt).toBeGreaterThan(0);
    expect(cmd.issuedBy).toBe('controller');
  });
});
