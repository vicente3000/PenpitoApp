import { createOrderStoreV2, projectOrdersForTable } from '../../stores/OrderStoreV2';
import {
  PROTOCOL_VERSION,
  QueueSnapshot,
  HardwareState,
  OrderEvent,
  CommandAck,
  makeOrderEvent,
} from '../../protocol/types';
import { PenpitoAppMqttAdapter } from '../../adapters/PenpitoAppMqttAdapter';

/**
 * Tests del OrderStoreV2 usando un adapter simulado. Verificamos que la
 * proyección a DrinkOrder[] es correcta, que las acciones de submit/cancel/serve
 * delegan al adapter, y que el hardware autoritativo actualiza el store.
 */

class FakeAdapter {
  private queueListeners = new Set<(s: QueueSnapshot) => void>();
  private eventListeners = new Set<(e: OrderEvent) => void>();
  private hwListeners = new Set<(h: HardwareState) => void>();
  private connectionListeners = new Set<(s: any) => void>();
  private adminResultListeners = new Set<(a: CommandAck) => void>();

  // Captures
  submitCalls: any[] = [];
  cancelCalls: any[] = [];
  serveCalls: any[] = [];
  snapshotRequests: number[] = [];

  onQueueSnapshot(l: (s: QueueSnapshot) => void) { this.queueListeners.add(l); return () => this.queueListeners.delete(l); }
  onOrderEvent(l: (e: OrderEvent) => void) { this.eventListeners.add(l); return () => this.eventListeners.delete(l); }
  onHardwareAuthoritativeState(l: (h: HardwareState) => void) { this.hwListeners.add(l); return () => this.hwListeners.delete(l); }
  onConnectionChange(l: (s: any) => void) { this.connectionListeners.add(l); return () => this.connectionListeners.delete(l); }
  onAdminResult(l: (a: CommandAck) => void) { this.adminResultListeners.add(l); return () => this.adminResultListeners.delete(l); }

  async submitOrder(env: any) { this.submitCalls.push(env); return { commandId: env.commandId }; }
  async cancelOrder(tableId: number, orderId: string) { this.cancelCalls.push({ tableId, orderId }); }
  async markOrderServed(tableId: number, orderId: string) { this.serveCalls.push({ tableId, orderId }); }
  requestQueueSnapshot(tableId: number) { this.snapshotRequests.push(tableId); }

  // Helpers para inyectar mensajes
  emitQueueSnapshot(snap: QueueSnapshot) { for (const l of this.queueListeners) l(snap); }
  emitOrderEvent(e: OrderEvent) { for (const l of this.eventListeners) l(e); }
  emitHardware(h: HardwareState) { for (const l of this.hwListeners) l(h); }
  emitConnection(s: any) { for (const l of this.connectionListeners) l(s); }
}

function makeSnap(tableId: number, orders: Array<{ orderId: string; recipeId: string; state: any; requestedAt: number; iceCount?: number; guestName?: string }>): QueueSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    tableId,
    orders: orders.map((o) => ({
      orderId: o.orderId,
      commandId: `cmd-${o.orderId}`,
      recipeId: o.recipeId,
      requestedAt: o.requestedAt,
      state: o.state,
      guestName: o.guestName,
      options: { iceCount: o.iceCount ?? 2 },
    })),
    activeOrder: null,
    generatedAt: Date.now(),
  };
}

describe('OrderStoreV2 (con fake adapter)', () => {
  it('submitOrder construye un envelope v2 y delega al adapter', async () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    const r = await store.getState().submitOrder({
      tableId: 1,
      recipeId: 'piscola',
      guestName: 'Test',
      options: { iceCount: 3, alcoholOz: 1.5 },
    });
    expect(r.orderId).toMatch(/^ord_/);
    expect(r.commandId).toMatch(/^cmd_/);
    expect(adapter.submitCalls).toHaveLength(1);
    const env = adapter.submitCalls[0];
    expect(env.tableId).toBe(1);
    expect(env.recipeId).toBe('piscola');
    expect(env.guestName).toBe('Test');
    expect(env.options.iceCount).toBe(3);
    expect(env.options.alcoholOz).toBe(1.5);
    expect(env.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('cancelOrder y serveOrder delegan al adapter con los ids correctos', async () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    await store.getState().cancelOrder(3, 'ord_xyz');
    await store.getState().serveOrder(3, 'ord_xyz');
    expect(adapter.cancelCalls).toEqual([{ tableId: 3, orderId: 'ord_xyz' }]);
    expect(adapter.serveCalls).toEqual([{ tableId: 3, orderId: 'ord_xyz' }]);
  });

  it('requestSnapshot delega al adapter', () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    store.getState().requestSnapshot(5);
    expect(adapter.snapshotRequests).toEqual([5]);
  });

  it('snapshot entrante actualiza la proyección por mesa', () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    const snap = makeSnap(1, [
      { orderId: 'a', recipeId: 'piscola', state: 'queued', requestedAt: 1, iceCount: 2 },
      { orderId: 'b', recipeId: 'negroni', state: 'preparing', requestedAt: 2 },
      { orderId: 'c', recipeId: 'piscola', state: 'ready', requestedAt: 3 },
    ]);
    adapter.emitQueueSnapshot(snap);
    const projected = projectOrdersForTable(store.getState().snapshots, 1);
    expect(projected).toHaveLength(3);
    expect(projected[0].status).toBe('queued');
    expect(projected[1].status).toBe('preparing');
    expect(projected[2].status).toBe('ready');
    expect(projected[2].is_drink_ready).toBe(true);
    // hasInitialSnapshot
    expect(store.getState().hasInitialSnapshot.get(1)).toBe(true);
  });

  it('evento de pedido actualiza recentEvents', () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    const event = makeOrderEvent({
      type: 'PREPARATION_PROGRESS',
      orderId: 'ord_evt',
      tableId: 1,
      commandId: 'cmd_evt',
      sequence: 1,
    });
    adapter.emitOrderEvent(event);
    expect(store.getState().recentEvents.get('ord_evt')).toEqual(event);
  });

  it('hardware autoritativo actualiza el store', () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    const hw: HardwareState = {
      protocolVersion: PROTOCOL_VERSION,
      bootId: 'boot-x',
      isOn: true,
      status: 'preparing',
      activeOrderId: 'ord_hw',
      activeTableId: 1,
      activeCommandId: 'cmd_hw',
      stateSequence: 1,
      activeStepId: 'cup_dispenser',
      completedStepIds: [],
      skippedStepIds: [],
      isDrinkReady: false,
      errorMessage: null,
      startedAt: Date.now(),
      uptimeMs: 5000,
    };
    adapter.emitHardware(hw);
    expect(store.getState().hardware).toEqual(hw);
  });

  it('connection snapshot actualiza isConnected', () => {
    const adapter = new FakeAdapter();
    const store = createOrderStoreV2(adapter as unknown as PenpitoAppMqttAdapter);
    // Inicialmente disconnected.
    expect(store.getState().isConnected).toBe(false);
    // El adapter emite cambios y el store los refleja.
    adapter.emitConnection({ broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null });
    expect(store.getState().isConnected).toBe(true);
    adapter.emitConnection({ broker: 'disconnected', deviceOnline: false, lastDeviceMessageAt: null, error: null });
    expect(store.getState().isConnected).toBe(false);
    adapter.emitConnection({ broker: 'connected', deviceOnline: false, lastDeviceMessageAt: Date.now(), error: null });
    // isConnected requiere deviceOnline=true.
    expect(store.getState().isConnected).toBe(false);
    adapter.emitConnection({ broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null });
    expect(store.getState().isConnected).toBe(true);
  });
});
