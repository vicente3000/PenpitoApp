import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { WaiterScreen, WaiterScreenProps } from '../../screens/WaiterScreen';
import { useRecipeStore } from '../../stores/RecipeStore';
import { DrinkOrder, TableSession } from '../../models';

// Mockear stores
jest.mock('../../stores/RecipeStore', () => ({
  useRecipeStore: jest.fn(),
}));

describe('WaiterScreen Component', () => {
  const mockClearTableOrders = jest.fn();
  const mockClearTableSession = jest.fn();
  const mockOnDeleteOrder = jest.fn();
  const mockOnMarkServed = jest.fn();
  const mockOnRemoveGuest = jest.fn();
  const mockOnResetAccess = jest.fn();

  const mockRecipes = [
    { id: 'piscola', name: 'Piscola', price: 3500 },
    { id: 'negroni', name: 'Negroni', price: 4000 },
  ];

  const mockSessions: TableSession[] = [
    {
      table_number: 1,
      qr_value: 'qr-mesa-1',
      guests: [
        { id: 'g1', name: 'Gael', joined_at: 1000 },
        { id: 'g2', name: 'Ignacio', joined_at: 2000 },
      ],
      split_method: 'equal_split',
      tip_percentage: 10,
    },
  ];

  const mockOrders: DrinkOrder[] = [
    {
      id: 'piscola-1',
      recipe_id: 'piscola',
      recipe_name: 'Piscola',
      table_number: 1,
      qr_value: 'qr-mesa-1',
      requested_at: Date.now(),
      status: 'ready',
      ice_count: 2,
      completed_step_ids: [],
      skipped_step_ids: [],
      is_drink_ready: true,
      est_time_seconds: 45,
      split_method: 'equal_split',
    },
    {
      id: 'negroni-2',
      recipe_id: 'negroni',
      recipe_name: 'Negroni',
      table_number: 1,
      qr_value: 'qr-mesa-1',
      requested_at: Date.now(),
      status: 'queued',
      ice_count: 3,
      completed_step_ids: [],
      skipped_step_ids: [],
      is_drink_ready: false,
      est_time_seconds: 45,
      split_method: 'equal_split',
    },
  ];

  const ordersByTable = new Map<number, DrinkOrder[]>();
  ordersByTable.set(1, mockOrders);

  const defaultProps: WaiterScreenProps = {
    isConnected: true,
    connectionSnapshot: { broker: 'connected', deviceOnline: true, lastDeviceMessageAt: Date.now(), error: null },
    machineState: { status: 'idle', isDrinkReady: false, isOn: true },
    clearTableOrders: mockClearTableOrders,
    clearTableSession: mockClearTableSession,
    onDeleteOrder: mockOnDeleteOrder,
    onMarkServed: mockOnMarkServed,
    onRemoveGuest: mockOnRemoveGuest,
    onResetAccess: mockOnResetAccess,
    ordersByTable,
    queuedOrdersCount: 1,
    readyOrdersCount: 1,
    sessions: mockSessions,
    onPowerOn: jest.fn().mockResolvedValue(true),
    onEmergencyStop: jest.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (useRecipeStore as unknown as jest.Mock).mockReturnValue({
      recipes: mockRecipes,
    });
  });

  it('should render the screen title, emergency stop card, and metrics cards', async () => {
    await render(<WaiterScreen {...defaultProps} />);

    // Verificar Título
    expect(screen.getByText('Consola del Personal')).toBeTruthy();

    // Tarjeta de parada de emergencia
    expect(screen.getByText('PARADA DE EMERGENCIA')).toBeTruthy();
    expect(screen.getByText('Presiona para apagar la máquina de inmediato')).toBeTruthy();

    // Métrica de órdenes listas / en cola
    expect(screen.getByText('Listos')).toBeTruthy();
    expect(screen.getByText('En Cola')).toBeTruthy();
  });

  it('should publish an emergency stop MQTT command when the DETENER button is pressed', async () => {
    await render(<WaiterScreen {...defaultProps} />);
    const detenerButton = screen.getByText('DETENER');

    fireEvent.press(detenerButton);

    const confirmarButton = await screen.findByText('DETENER KRAKEN');
    fireEvent.press(confirmarButton);

    expect(defaultProps.onEmergencyStop).toHaveBeenCalled();
  });

  it('should render list of tables with guest count and order list', async () => {
    await render(<WaiterScreen {...defaultProps} />);

    // Verificar nombre de mesa usando regex (para matchear 'Mesa 1 (2 pendientes)')
    expect(screen.getByText(/Mesa 1/)).toBeTruthy();

    // Clientes listados
    expect(screen.getByText('Gael')).toBeTruthy();
    expect(screen.getByText('Ignacio')).toBeTruthy();

    // Pedidos listados
    expect(screen.getByText('Piscola')).toBeTruthy();
    expect(screen.getByText('Negroni')).toBeTruthy();
  });

  it('should trigger onMarkServed when clicking the Servido button for ready drinks', async () => {
    await render(<WaiterScreen {...defaultProps} />);
    const servidoButton = screen.getByText('Servido');

    fireEvent.press(servidoButton);

    expect(mockOnMarkServed).toHaveBeenCalledWith('piscola-1');
  });
});
