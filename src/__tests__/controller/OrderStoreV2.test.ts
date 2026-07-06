import {
  projectOrdersForTable,
  mapStateToStatus,
} from '../../../src/stores/OrderStoreV2';
import { QueueSnapshot, PROTOCOL_VERSION, OrderState } from '../../../src/protocol/types';

function makeSnap(orders: Array<{ orderId: string; commandId: string; recipeId: string; state: OrderState; requestedAt: number; iceCount?: number }>): QueueSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    tableId: 1,
    orders: orders.map((o) => ({
      orderId: o.orderId,
      commandId: o.commandId,
      recipeId: o.recipeId,
      requestedAt: o.requestedAt,
      state: o.state,
      options: { iceCount: o.iceCount ?? 2 },
    })),
    activeOrder: null,
    generatedAt: 1,
  };
}

describe('OrderStoreV2 (proyección)', () => {
  it('proyecta un snapshot con tres pedidos a DrinkOrders', () => {
    const snap = makeSnap([
      { orderId: 'a', commandId: 'ca', recipeId: 'piscola', state: 'queued', requestedAt: 1000 },
      { orderId: 'b', commandId: 'cb', recipeId: 'negroni', state: 'preparing', requestedAt: 2000 },
      { orderId: 'c', commandId: 'cc', recipeId: 'piscola', state: 'ready', requestedAt: 3000 },
    ]);
    const map = new Map([[1, snap]]);
    const orders = projectOrdersForTable(map, 1);
    expect(orders).toHaveLength(3);
    expect(orders[0].status).toBe('queued');
    expect(orders[1].status).toBe('preparing');
    expect(orders[2].status).toBe('ready');
    expect(orders[2].is_drink_ready).toBe(true);
  });

  it('si la mesa no tiene snapshot, retorna []', () => {
    expect(projectOrdersForTable(new Map(), 99)).toEqual([]);
  });

  it('mapStateToStatus: cada OrderState se traduce correctamente', () => {
    expect(mapStateToStatus('queued')).toBe('queued');
    expect(mapStateToStatus('dispatching')).toBe('queued');
    expect(mapStateToStatus('accepted')).toBe('queued');
    expect(mapStateToStatus('preparing')).toBe('preparing');
    expect(mapStateToStatus('ready')).toBe('ready');
    expect(mapStateToStatus('served')).toBe('served');
    expect(mapStateToStatus('failed')).toBe('failed');
  });

  it('mantiene la misma referencia del array para el mismo QueueSnapshot (caching en WeakMap)', () => {
    const snap = makeSnap([
      { orderId: 'a', commandId: 'ca', recipeId: 'piscola', state: 'queued', requestedAt: 1000 },
    ]);
    const map = new Map([[1, snap]]);
    const orders1 = projectOrdersForTable(map, 1);
    const orders2 = projectOrdersForTable(map, 1);
    expect(orders1).toBe(orders2); // Referencia idéntica
  });
});
