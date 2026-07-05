import { useInventoryStore } from '../../stores/InventoryStore';
import { inventoryRepository } from '../../repositories/InventoryRepository';
import { deviceService } from '../../services/DeviceService';
import { Recipe, BottleInventory } from '../../models';

// Mockear repositorios y servicios externos
jest.mock('../../repositories/InventoryRepository', () => ({
  inventoryRepository: {
    getAllBottles: jest.fn(),
    refillBottle: jest.fn(),
    updateBottleCapacity: jest.fn(),
    consumeIngredients: jest.fn(),
    restoreIngredients: jest.fn(),
    saveBottle: jest.fn(),
  },
}));

jest.mock('../../services/DeviceService', () => ({
  deviceService: {
    publish: jest.fn(),
    subscribeCustom: jest.fn(),
  },
}));

describe('InventoryStore', () => {
  const mockBottles: BottleInventory[] = [
    { id: '1', ingredient_name: 'Pisco', display_name: 'Pisco Alto', capacity_ml: 1000, remaining_ml: 500 },
    { id: '2', ingredient_name: 'Coca-Cola', display_name: 'Coca-Cola 1.5L', capacity_ml: 1500, remaining_ml: 1200 },
  ];

  const mockRecipe: Recipe = {
    id: 'custom_recipe',
    name: 'Custom Drink',
    description: 'Bebida personalizada',
    items: [
      { ingredient_name: 'Pisco', amount_ml: 100 },
      { ingredient_name: 'Coca-Cola', amount_ml: 200 },
    ],
    est_time_seconds: 20,
    abv: 14,
    is_available: true,
    price: 3500,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reiniciar estado del store de Zustand antes de cada test si fuese necesario
    useInventoryStore.setState({
      inventory: [],
      isLoading: false,
      error: null,
      isSubscribed: false,
    });
  });

  describe('loadInventory', () => {
    it('should load bottles successfully and update the store', async () => {
      (inventoryRepository.getAllBottles as jest.Mock).mockResolvedValue(mockBottles);

      const promise = useInventoryStore.getState().loadInventory();
      expect(useInventoryStore.getState().isLoading).toBe(true);

      await promise;

      expect(inventoryRepository.getAllBottles).toHaveBeenCalledTimes(1);
      expect(useInventoryStore.getState().inventory).toEqual(mockBottles);
      expect(useInventoryStore.getState().isLoading).toBe(false);
      expect(useInventoryStore.getState().error).toBeNull();
    });

    it('should handle loading error and set error message', async () => {
      (inventoryRepository.getAllBottles as jest.Mock).mockRejectedValue(new Error('DB Error'));

      await useInventoryStore.getState().loadInventory();

      expect(useInventoryStore.getState().isLoading).toBe(false);
      expect(useInventoryStore.getState().inventory).toEqual([]);
      expect(useInventoryStore.getState().error).toBe('Failed to load inventory');
    });
  });

  describe('refillBottle', () => {
    it('should refill the bottle and publish inventory update', async () => {
      const updatedBottles = [
        { ...mockBottles[0], remaining_ml: 1000 },
        mockBottles[1],
      ];
      (inventoryRepository.refillBottle as jest.Mock).mockResolvedValue(undefined);
      (inventoryRepository.getAllBottles as jest.Mock).mockResolvedValue(updatedBottles);

      await useInventoryStore.getState().refillBottle('1');

      expect(inventoryRepository.refillBottle).toHaveBeenCalledWith('1');
      expect(useInventoryStore.getState().inventory).toEqual(updatedBottles);
      expect(deviceService.publish).toHaveBeenCalledWith('penpito/inventory/state', JSON.stringify(updatedBottles));
    });
  });

  describe('updateBottleCapacity', () => {
    it('should update the capacity, refresh local inventory, and publish the state', async () => {
      const updatedBottles = [
        { ...mockBottles[0], capacity_ml: 1200 },
        mockBottles[1],
      ];
      (inventoryRepository.updateBottleCapacity as jest.Mock).mockResolvedValue(undefined);
      (inventoryRepository.getAllBottles as jest.Mock).mockResolvedValue(updatedBottles);

      await useInventoryStore.getState().updateBottleCapacity('1', 1200);

      expect(inventoryRepository.updateBottleCapacity).toHaveBeenCalledWith('1', 1200);
      expect(useInventoryStore.getState().inventory).toEqual(updatedBottles);
    });
  });

  describe('consumeForRecipe', () => {
    it('should consume ingredients and update state', async () => {
      const updatedBottles = [
        { ...mockBottles[0], remaining_ml: 400 }, // Pisco - 100
        { ...mockBottles[1], remaining_ml: 1000 }, // Coca-Cola - 200
      ];
      (inventoryRepository.consumeIngredients as jest.Mock).mockResolvedValue(undefined);
      (inventoryRepository.getAllBottles as jest.Mock).mockResolvedValue(updatedBottles);

      await useInventoryStore.getState().consumeForRecipe(mockRecipe);

      expect(inventoryRepository.consumeIngredients).toHaveBeenCalledWith([
        { ingredient_name: 'Pisco', amount_ml: 100 },
        { ingredient_name: 'Coca-Cola', amount_ml: 200 },
      ]);
      expect(useInventoryStore.getState().inventory).toEqual(updatedBottles);
    });
  });

  describe('restoreForRecipe', () => {
    it('should restore ingredients to inventory and publish updates', async () => {
      const updatedBottles = [
        { ...mockBottles[0], remaining_ml: 600 },
        { ...mockBottles[1], remaining_ml: 1400 },
      ];
      (inventoryRepository.restoreIngredients as jest.Mock).mockResolvedValue(undefined);
      (inventoryRepository.getAllBottles as jest.Mock).mockResolvedValue(updatedBottles);

      await useInventoryStore.getState().restoreForRecipe(mockRecipe);

      expect(inventoryRepository.restoreIngredients).toHaveBeenCalledWith([
        { ingredient_name: 'Pisco', amount_ml: 100 },
        { ingredient_name: 'Coca-Cola', amount_ml: 200 },
      ]);
      expect(useInventoryStore.getState().inventory).toEqual(updatedBottles);
    });
  });

  describe('recipeIsAvailable and getRecipeShortage', () => {
    it('should return true if inventory has enough ingredients', () => {
      useInventoryStore.setState({ inventory: mockBottles });
      const available = useInventoryStore.getState().recipeIsAvailable(mockRecipe);
      expect(available).toBe(true);
    });

    it('should return false and list shortage if ingredients are insufficient', () => {
      const lowInventory = [
        { ...mockBottles[0], remaining_ml: 50 }, // Pisco (se requieren 100)
        mockBottles[1],
      ];
      useInventoryStore.setState({ inventory: lowInventory });
      const available = useInventoryStore.getState().recipeIsAvailable(mockRecipe);
      expect(available).toBe(false);

      const shortage = useInventoryStore.getState().getRecipeShortage(mockRecipe);
      expect(shortage).toHaveLength(1);
      expect(shortage[0]).toEqual({
        ingredient_name: 'Pisco',
        display_name: 'Pisco Alto',
        missing_ml: 50,
        remaining_ml: 50,
        required_ml: 100,
      });
    });
  });
});
