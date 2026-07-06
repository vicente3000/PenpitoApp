import { useOrderStore } from '../../stores/OrderStore';
import { orderRepository } from '../../repositories/OrderRepository';
import { commandQueueService } from '../../services/CommandQueueService';
import { deviceService } from '../../services/DeviceService';
import { useAppStore } from '../../stores/AppStore';
import { useSessionStore } from '../../stores/SessionStore';
import { Recipe, DrinkOrder, MachineState } from '../../models';

// Mockear dependencias
jest.mock('../../repositories/OrderRepository', () => ({
  orderRepository: {
    getAllOrders: jest.fn(),
    saveOrder: jest.fn(),
    deleteOrder: jest.fn(),
  },
}));

jest.mock('../../services/CommandQueueService', () => ({
  commandQueueService: {
    enqueue: jest.fn(),
    clear: jest.fn(),
  },
}));

jest.mock('../../services/DeviceService', () => ({
  deviceService: {
    publish: jest.fn(),
  },
}));

jest.mock('../../stores/AppStore', () => ({
  useAppStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../stores/SessionStore', () => ({
  useSessionStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../stores/RecipeStore', () => ({
  useRecipeStore: {
    getState: jest.fn().mockReturnValue({
      recipes: [
        { id: 'piscola', name: 'Piscola', est_time_seconds: 20 },
      ],
    }),
  },
}));

jest.mock('../../stores/InventoryStore', () => ({
  useInventoryStore: {
    getState: jest.fn().mockReturnValue({
      consumeForRecipe: jest.fn().mockResolvedValue(undefined),
      restoreForRecipe: jest.fn().mockResolvedValue(undefined),
      recipeIsAvailable: jest.fn().mockReturnValue(true),
    }),
  },
}));

describe('OrderStore', () => {
  const mockRecipe: Recipe = {
    id: 'piscola',
    name: 'Piscola',
    description: 'Pisco con Coca-Cola',
    items: [],
    est_time_seconds: 20,
    abv: 14,
    is_available: true,
    price: 3500,
  };

  const mockOrder: DrinkOrder = {
    id: 'piscola-12345',
    recipe_id: 'piscola',
    recipe_name: 'Piscola',
    table_number: 1,
    qr_value: 'qr-mesa-1',
    requested_at: Date.now(),
    status: 'queued',
    ice_count: 2,
    completed_step_ids: [],
    skipped_step_ids: ['agitation_system'],
    is_drink_ready: false,
    est_time_seconds: 45,
    queued_at: Date.now(),
    split_method: 'equal_split',
    guest_name: 'Gael',
    group_id: 'group-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useOrderStore.setState({
      orders: [],
      activeOrderId: null,
      isLoading: false,
      error: null,
    });

    // Mock por defecto para AppStore
    (useAppStore.getState as jest.Mock).mockReturnValue({
      machineState: { status: 'idle', isDrinkReady: false },
      isConnected: true,
      connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    });

    // Mock por defecto para SessionStore
    (useSessionStore.getState as jest.Mock).mockReturnValue({
      sessions: [{ table_number: 1, guests: [{ name: 'Gael' }] }],
    });

    (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);
  });

  describe('loadOrders', () => {
    it('should load orders and detect the active (preparing) order', async () => {
      const activeOrder = { ...mockOrder, id: 'preparing-1', status: 'preparing' as const };
      const ordersList = [mockOrder, activeOrder];
      (orderRepository.getAllOrders as jest.Mock).mockResolvedValue(ordersList);

      await useOrderStore.getState().loadOrders();

      expect(orderRepository.getAllOrders).toHaveBeenCalledTimes(1);
      expect(useOrderStore.getState().orders).toEqual(ordersList);
      expect(useOrderStore.getState().activeOrderId).toBe('preparing-1');
      expect(useOrderStore.getState().isLoading).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      (orderRepository.getAllOrders as jest.Mock).mockRejectedValue(new Error('DB read error'));

      await useOrderStore.getState().loadOrders();

      expect(useOrderStore.getState().error).toBe('Failed to load orders');
      expect(useOrderStore.getState().isLoading).toBe(false);
    });
  });

  describe('createOrderBatch', () => {
    it('should create orders, save them to repo, publish status and trigger next prep', async () => {
      (orderRepository.saveOrder as jest.Mock).mockResolvedValue(undefined);
      (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);

      const created = await useOrderStore.getState().createOrderBatch({
        items: [{ recipe: mockRecipe, options: { iceCount: 2 }, quantity: 1, guest_name: 'Gael' }],
        table_number: 1,
        qr_value: 'qr-mesa-1',
        split_method: 'equal_split',
      });

      expect(created).toHaveLength(1);
      expect(created[0].recipe_id).toBe('piscola');
      expect(useOrderStore.getState().orders[0].status).toBe('preparing'); // Porque la máquina está libre y se gatilló preparación
      expect(orderRepository.saveOrder).toHaveBeenCalled();
      expect(deviceService.publish).toHaveBeenCalled();
      expect(commandQueueService.enqueue).toHaveBeenCalledWith({
        cmd: 'PREPARE',
        val: 'piscola',
        iceCount: 2,
        alcoholOz: undefined,
        mixerOz: undefined,
      });
    });
  });

  describe('triggerNextQueuedOrder', () => {
    it('should not trigger anything if the machine is disconnected', async () => {
      (useAppStore.getState as jest.Mock).mockReturnValue({
        machineState: { status: 'idle', isDrinkReady: false },
        isConnected: false,
      });

      useOrderStore.setState({ orders: [mockOrder] });

      const triggered = await useOrderStore.getState().triggerNextQueuedOrder();
      expect(triggered).toBe(false);
      expect(commandQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should not trigger if there is already an active preparing order', async () => {
      const activeOrder = { ...mockOrder, id: 'active-1', status: 'preparing' as const };
      useOrderStore.setState({ orders: [activeOrder, mockOrder] });

      const triggered = await useOrderStore.getState().triggerNextQueuedOrder();
      expect(triggered).toBe(false);
      expect(commandQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should trigger preparation of the next queued order if the machine is ready', async () => {
      (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);
      useOrderStore.setState({ orders: [mockOrder] });

      const triggered = await useOrderStore.getState().triggerNextQueuedOrder();
      expect(triggered).toBe(true);
      expect(commandQueueService.enqueue).toHaveBeenCalled();
      expect(useOrderStore.getState().activeOrderId).toBe(mockOrder.id);
      expect(useOrderStore.getState().orders.find(o => o.id === mockOrder.id)?.status).toBe('preparing');
    });
  });
});

describe('OrderStore - syncFromMachine lifecycle', () => {
  const baseOrder: DrinkOrder = {
    id: 'order-1',
    recipe_id: 'negroni',
    recipe_name: 'Negroni',
    table_number: 1,
    qr_value: 'qr-1',
    requested_at: Date.now(),
    status: 'preparing' as const,
    ice_count: 3,
    completed_step_ids: [],
    skipped_step_ids: [],
    is_drink_ready: false,
    est_time_seconds: 22,
    split_method: 'equal_split',
    queued_at: Date.now(),
    started_at: Date.now(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    useOrderStore.setState({ orders: [], activeOrderId: null, isLoading: false, error: null });
    (useAppStore.getState as jest.Mock).mockReturnValue({
      machineState: { status: 'idle', isDrinkReady: false, activeStepId: undefined, completedStepIds: [], skippedStepIds: [], currentRecipeId: undefined },
      isConnected: true,
      connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    });
    (useSessionStore.getState as jest.Mock).mockReturnValue({
      sessions: [{ table_number: 1, guests: [{ name: 'Gael' }] }],
    });
    (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);
    (orderRepository.saveOrder as jest.Mock).mockResolvedValue(undefined);
    await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'idle', isDrinkReady: false });
  });

  describe('idle machine with queued orders', () => {
    it('should trigger next queued order when machine is idle and no active order', async () => {
      const queued = { ...baseOrder, id: 'queued-1', status: 'queued' as const, started_at: undefined };
      useOrderStore.setState({ orders: [queued] });

      await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'idle', isDrinkReady: false });

      expect(commandQueueService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'PREPARE' }));
      expect(useOrderStore.getState().orders[0].status).toBe('preparing');
      expect(useOrderStore.getState().activeOrderId).toBe('queued-1');
    });

    it('should send TAKEN if machine is idle but has drink ready with no local ready order', async () => {
      const queued = { ...baseOrder, id: 'queued-1', status: 'queued' as const, started_at: undefined };
      useOrderStore.setState({ orders: [queued] });

      await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'idle', isDrinkReady: true });

      expect(commandQueueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: 'TAKEN', target: 'kraken' })
      );
      expect(useOrderStore.getState().orders[0].status).toBe('queued');
    });
  });

  describe('recovery: machine preparing with queued orders but no activeOrderId', () => {
    it('should bind a queued order with started_at when machine is preparing', async () => {
      const queued = { ...baseOrder, id: 'queued-1', status: 'queued' as const, recipe_id: 'negroni', started_at: 1000 };
      useOrderStore.setState({ orders: [queued] });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'preparing',
        isDrinkReady: false,
        currentRecipeId: 'negroni',
        activeStepId: 'cup_dispenser',
        completedStepIds: [],
        skippedStepIds: [],
      });

      expect(orderRepository.saveOrder).toHaveBeenCalled();
      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('preparing');
      expect(updated.active_step_id).toBe('cup_dispenser');
      expect(useOrderStore.getState().activeOrderId).toBe('queued-1');
    });

    it('should bind a queued order without started_at when machine is preparing (recovery fix)', async () => {
      const queued = { ...baseOrder, id: 'queued-1', status: 'queued' as const, recipe_id: 'negroni', started_at: undefined };
      useOrderStore.setState({ orders: [queued] });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'preparing',
        isDrinkReady: false,
        currentRecipeId: 'negroni',
        activeStepId: 'cup_dispenser',
        completedStepIds: [],
        skippedStepIds: [],
      });

      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('preparing');
      expect(orderRepository.saveOrder).toHaveBeenCalled();
      expect(useOrderStore.getState().activeOrderId).toBe('queued-1');
    });

    it('should bind a queued order as ready when machine has isDrinkReady (recovery enabled for ready status)', async () => {
      const queued = { ...baseOrder, id: 'queued-1', status: 'queued' as const, recipe_id: 'negroni', started_at: 1000 };
      useOrderStore.setState({ orders: [queued] });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'idle',
        isDrinkReady: true,
        currentRecipeId: 'negroni',
        activeStepId: undefined,
        completedStepIds: ['cup_dispenser', 'ice_dispenser', 'alcohol_dispenser', 'agitation_system'],
        skippedStepIds: ['carbonated_station'],
      });

      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('ready');
    });
  });

  describe('active order state transitions', () => {
    it('should update step info when machine is preparing', async () => {
      const active = { ...baseOrder, status: 'preparing' as const };
      useOrderStore.setState({ orders: [active], activeOrderId: 'order-1' });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'preparing',
        isDrinkReady: false,
        activeStepId: 'alcohol_dispenser',
        completedStepIds: ['cup_dispenser', 'ice_dispenser'],
        skippedStepIds: ['carbonated_station'],
      });

      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('preparing');
      expect(updated.active_step_id).toBe('alcohol_dispenser');
      expect(updated.completed_step_ids).toEqual(['cup_dispenser', 'ice_dispenser']);
    });

    it('should transition to ready when machine reports isDrinkReady', async () => {
      const active = { ...baseOrder, status: 'preparing' as const };
      useOrderStore.setState({ orders: [active], activeOrderId: 'order-1' });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'idle',
        isDrinkReady: true,
        activeStepId: undefined,
        completedStepIds: ['cup_dispenser', 'ice_dispenser', 'alcohol_dispenser', 'agitation_system'],
        skippedStepIds: ['carbonated_station'],
      });

      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('ready');
      expect(updated.is_drink_ready).toBe(true);
    });

    it('should mark order as failed if machine goes idle without isDrinkReady while order was preparing', async () => {
      const active = { ...baseOrder, status: 'preparing' as const, started_at: Date.now() - 6000 };
      useOrderStore.setState({ orders: [active], activeOrderId: 'order-1' });

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'idle',
        isDrinkReady: false,
        activeStepId: undefined,
        completedStepIds: [],
        skippedStepIds: [],
      });

      const updated = useOrderStore.getState().orders[0];
      expect(updated.status).toBe('failed');
    });

    it('should skip persistence when machine state has not changed', async () => {
      const active = { ...baseOrder, status: 'preparing' as const, active_step_id: 'cup_dispenser' as const, started_at: 1000, skipped_step_ids: ['carbonated_station' as const] };
      useOrderStore.setState({ orders: [active], activeOrderId: 'order-1' });
      (orderRepository.saveOrder as jest.Mock).mockClear();

      await useOrderStore.getState().syncFromMachine({
        isOn: true,
        status: 'preparing',
        isDrinkReady: false,
        activeStepId: 'cup_dispenser',
        completedStepIds: [],
        skippedStepIds: ['carbonated_station'],
      });

      expect(orderRepository.saveOrder).not.toHaveBeenCalled();
    });
  });
});

describe('OrderStore - markOrderServed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrderStore.setState({ orders: [], activeOrderId: null });
    (useAppStore.getState as jest.Mock).mockReturnValue({
      machineState: { status: 'idle', isDrinkReady: false },
      isConnected: true,
      connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    });
    (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);
    (orderRepository.saveOrder as jest.Mock).mockResolvedValue(undefined);
  });

  it('should send TAKEN command and update status to served', async () => {
    const readyOrder: DrinkOrder = {
      id: 'ready-1', recipe_id: 'piscola', recipe_name: 'Piscola', table_number: 1,
      qr_value: 'qr-1', requested_at: Date.now(), status: 'ready', ice_count: 2,
      completed_step_ids: [], skipped_step_ids: [], is_drink_ready: true,
      est_time_seconds: 20, split_method: 'equal_split', queued_at: Date.now(),
      started_at: Date.now(), finished_at: Date.now(),
    };
    useOrderStore.setState({ orders: [readyOrder], activeOrderId: 'ready-1' });

    await useOrderStore.getState().markOrderServed('ready-1');

    expect(commandQueueService.enqueue).toHaveBeenCalledWith({
      cmd: 'TAKEN',
      val: '',
      target: 'kraken',
    });
    expect(useOrderStore.getState().orders[0].status).toBe('served');
    expect(useOrderStore.getState().activeOrderId).toBe('ready-1');

    await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'idle', isDrinkReady: false });
    expect(useOrderStore.getState().activeOrderId).toBeNull();
  });
});

describe('OrderStore - triggerInProgress concurrent guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrderStore.setState({ orders: [], activeOrderId: null });
    (useAppStore.getState as jest.Mock).mockReturnValue({
      machineState: { status: 'idle', isDrinkReady: false },
      isConnected: true,
      connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    });
    (useSessionStore.getState as jest.Mock).mockReturnValue({
      sessions: [{ table_number: 1, guests: [{ name: 'Gael' }] }],
    });
  });

  it('should prevent concurrent triggerNextQueuedOrder calls', async () => {
    (commandQueueService.enqueue as jest.Mock).mockImplementation(
      () => new Promise<boolean>(r => setTimeout(() => r(true), 100))
    );

    const queued: DrinkOrder = {
      id: 'q-1', recipe_id: 'piscola', recipe_name: 'Piscola', table_number: 1,
      qr_value: 'qr-1', requested_at: Date.now(), status: 'queued', ice_count: 2,
      completed_step_ids: [], skipped_step_ids: [], is_drink_ready: false,
      est_time_seconds: 20, split_method: 'equal_split', queued_at: Date.now(),
    };
    useOrderStore.setState({ orders: [queued] });

    const [first, second] = await Promise.all([
      useOrderStore.getState().triggerNextQueuedOrder(),
      useOrderStore.getState().triggerNextQueuedOrder(),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(commandQueueService.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('OrderStore - multi-drink sequential', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOrderStore.setState({ orders: [], activeOrderId: null });
    (useAppStore.getState as jest.Mock).mockReturnValue({
      machineState: { status: 'idle', isDrinkReady: false },
      isConnected: true,
      connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    });
    (useSessionStore.getState as jest.Mock).mockReturnValue({
      sessions: [{ table_number: 1, guests: [{ name: 'Gael' }] }],
    });
    (commandQueueService.enqueue as jest.Mock).mockResolvedValue(true);
    (orderRepository.saveOrder as jest.Mock).mockResolvedValue(undefined);
  });

  it('should process 3 drinks one at a time', async () => {
    const q1: DrinkOrder = {
      id: 'q-1', recipe_id: 'negroni', recipe_name: 'Negroni', table_number: 1,
      qr_value: 'qr-1', requested_at: 1000, status: 'queued', ice_count: 3,
      completed_step_ids: [], skipped_step_ids: ['carbonated_station'], is_drink_ready: false,
      est_time_seconds: 22, split_method: 'equal_split', queued_at: 1000,
    };
    const q2: DrinkOrder = {
      id: 'q-2', recipe_id: 'piscola', recipe_name: 'Piscola', table_number: 1,
      qr_value: 'qr-1', requested_at: 2000, status: 'queued', ice_count: 4,
      completed_step_ids: [], skipped_step_ids: ['agitation_system'], is_drink_ready: false,
      est_time_seconds: 28, split_method: 'equal_split', queued_at: 2000,
    };
    const q3: DrinkOrder = {
      id: 'q-3', recipe_id: 'whisky_rocks', recipe_name: 'Whisky a las Rocas', table_number: 1,
      qr_value: 'qr-1', requested_at: 3000, status: 'queued', ice_count: 3,
      completed_step_ids: [], skipped_step_ids: ['agitation_system', 'carbonated_station'], is_drink_ready: false,
      est_time_seconds: 15, split_method: 'equal_split', queued_at: 3000,
    };

    useOrderStore.setState({ orders: [q1, q2, q3] });

    // Trigger first drink
    await useOrderStore.getState().triggerNextQueuedOrder();

    // First drink should be preparing
    expect(useOrderStore.getState().orders.find(o => o.id === 'q-1')?.status).toBe('preparing');
    expect(useOrderStore.getState().orders.find(o => o.id === 'q-2')?.status).toBe('queued');
    expect(useOrderStore.getState().orders.find(o => o.id === 'q-3')?.status).toBe('queued');
    expect(commandQueueService.enqueue).toHaveBeenCalledTimes(1);

    // Second trigger should be blocked by active order
    const blocked = await useOrderStore.getState().triggerNextQueuedOrder();
    expect(blocked).toBe(false);
    expect(commandQueueService.enqueue).toHaveBeenCalledTimes(1);

    // Machine finishes drink 1 → ready
    await useOrderStore.getState().syncFromMachine({
        isOn: true,
      status: 'idle', isDrinkReady: true,
      completedStepIds: ['cup_dispenser', 'ice_dispenser', 'alcohol_dispenser', 'agitation_system'],
      skippedStepIds: ['carbonated_station'],
    });

    expect(useOrderStore.getState().orders.find(o => o.id === 'q-1')?.status).toBe('ready');

    // Mark drink 1 as served → should trigger drink 2
    await useOrderStore.getState().markOrderServed('q-1');
    expect(useOrderStore.getState().orders.find(o => o.id === 'q-1')?.status).toBe('served');

    // After TAKEN, machine is idle + no drink ready → auto-trigger next via syncFromMachine
    await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'idle', isDrinkReady: false });

    expect(useOrderStore.getState().orders.find(o => o.id === 'q-2')?.status).toBe('preparing');
    expect(useOrderStore.getState().orders.find(o => o.id === 'q-3')?.status).toBe('queued');
  });

  it('should clean up orphaned preparing orders and not mark them as failed', async () => {
    const q1: DrinkOrder = {
      id: 'q-1', recipe_id: 'negroni', recipe_name: 'Negroni', table_number: 1,
      qr_value: 'qr-1', requested_at: 1000, status: 'preparing', ice_count: 3,
      completed_step_ids: [], skipped_step_ids: [], is_drink_ready: false,
      est_time_seconds: 22, split_method: 'equal_split', started_at: Date.now(),
    };
    const orphan: DrinkOrder = {
      id: 'orphan-1', recipe_id: 'piscola', recipe_name: 'Piscola', table_number: 1,
      qr_value: 'qr-2', requested_at: 2000, status: 'preparing', ice_count: 4,
      completed_step_ids: [], skipped_step_ids: [], is_drink_ready: false,
      est_time_seconds: 28, split_method: 'equal_split', started_at: Date.now() - 10000,
    };

    useOrderStore.setState({ orders: [q1, orphan], activeOrderId: 'q-1' });

    // When syncFromMachine is called while q1 is preparing, orphan should be cleaned up and reset to queued!
    await useOrderStore.getState().syncFromMachine({ isOn: true, status: 'preparing', isDrinkReady: false });

    const orphanAfter = useOrderStore.getState().orders.find(o => o.id === 'orphan-1');
    expect(orphanAfter?.status).toBe('queued');
    expect(orphanAfter?.started_at).toBeUndefined();
  });
});
