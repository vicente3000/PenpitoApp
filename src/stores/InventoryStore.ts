import { create } from 'zustand';

import { BottleInventory, DrinkPreparationOptions, Recipe } from '../models';
import { inventoryRepository } from '../repositories/InventoryRepository';
import { canPrepareRecipe, getInventoryShortage, getRecipeUsageMl } from '../utils/drinkConfig';

interface InventoryState {
  inventory: BottleInventory[];
  isLoading: boolean;
  error: string | null;
  loadInventory: () => Promise<void>;
  refillBottle: (id: string) => Promise<void>;
  updateBottleCapacity: (id: string, capacityMl: number) => Promise<void>;
  consumeForRecipe: (recipe: Recipe, options?: DrinkPreparationOptions) => Promise<void>;
  restoreForRecipe: (recipe: Recipe, options?: DrinkPreparationOptions) => Promise<void>;
  recipeIsAvailable: (recipe: Recipe, options?: DrinkPreparationOptions) => boolean;
  getRecipeShortage: (
    recipe: Recipe,
    options?: DrinkPreparationOptions
  ) => Array<{
    ingredient_name: string;
    display_name: string;
    missing_ml: number;
    remaining_ml: number;
    required_ml: number;
  }>;
}

export const useInventoryStore = create<InventoryState>((set, get) => ({
  inventory: [],
  isLoading: false,
  error: null,
  loadInventory: async () => {
    set({ isLoading: true, error: null });
    try {
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load inventory', isLoading: false });
    }
  },
  refillBottle: async (id: string) => {
    try {
      await inventoryRepository.refillBottle(id);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
    } catch (error) {
      set({ error: 'Failed to refill bottle' });
    }
  },
  updateBottleCapacity: async (id: string, capacityMl: number) => {
    try {
      await inventoryRepository.updateBottleCapacity(id, capacityMl);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
    } catch (error) {
      set({ error: 'Failed to update bottle capacity' });
    }
  },
  consumeForRecipe: async (recipe: Recipe, options: DrinkPreparationOptions = {}) => {
    try {
      const usages = getRecipeUsageMl(recipe, options);
      await inventoryRepository.consumeIngredients(usages);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
    } catch (error) {
      set({ error: 'Failed to update inventory after preparation' });
    }
  },
  restoreForRecipe: async (recipe: Recipe, options: DrinkPreparationOptions = {}) => {
    try {
      const usages = getRecipeUsageMl(recipe, options);
      await inventoryRepository.restoreIngredients(usages);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
    } catch (error) {
      set({ error: 'Failed to restore inventory after cancelled order' });
    }
  },
  recipeIsAvailable: (recipe: Recipe, options: DrinkPreparationOptions = {}) => {
    return canPrepareRecipe(get().inventory, recipe, options);
  },
  getRecipeShortage: (recipe: Recipe, options: DrinkPreparationOptions = {}) => {
    return getInventoryShortage(get().inventory, recipe, options);
  },
}));
