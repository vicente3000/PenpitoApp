import { create } from 'zustand';

import { BottleInventory, DrinkPreparationOptions, Recipe } from '../models';
import { inventoryRepository } from '../repositories/InventoryRepository';
import { canPrepareRecipe, getInventoryShortage, getRecipeUsageMl } from '../utils/drinkConfig';
import { deviceService } from '../services/DeviceService';
import { parseBottleInventoryArray } from '../adapters/payloadParsers';

interface InventoryState {
  inventory: BottleInventory[];
  isLoading: boolean;
  error: string | null;
  isSubscribed: boolean;
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

const publishInventoryUpdate = (inventory: BottleInventory[]) => {
  try {
    deviceService.publish('penpito/inventory/state', JSON.stringify(inventory));
  } catch (e) {
    console.warn('[InventoryStore] Failed to publish inventory update:', e);
  }
};

export const useInventoryStore = create<InventoryState>((set, get) => ({
  inventory: [],
  isLoading: false,
  error: null,
  isSubscribed: false,
  loadInventory: async () => {
    set({ isLoading: true, error: null });
    try {
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory, isLoading: false });

      if (!get().isSubscribed) {
        set({ isSubscribed: true });
        deviceService.subscribeCustom('penpito/inventory/state', async (payload) => {
          let raw: unknown;
          try {
            raw = JSON.parse(payload);
          } catch (e) {
            console.warn('[InventoryStore] Payload de inventario no es JSON valido:', e);
            return;
          }
          const remoteInventory = parseBottleInventoryArray(raw);
          if (remoteInventory.length > 0) {
            for (const remoteBottle of remoteInventory) {
              try {
                await inventoryRepository.saveBottle(remoteBottle);
              } catch (e) {
                console.warn('[InventoryStore] No se pudo guardar botella remota:', e);
              }
            }
            try {
              const localInventory = await inventoryRepository.getAllBottles();
              set({ inventory: localInventory });
            } catch (e) {
              console.warn('[InventoryStore] Fallo refrescando inventario local:', e);
            }
          }
        });
      }
    } catch (error) {
      set({ error: 'Failed to load inventory', isLoading: false });
    }
  },
  refillBottle: async (id: string) => {
    try {
      await inventoryRepository.refillBottle(id);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
      publishInventoryUpdate(inventory);
    } catch (error) {
      set({ error: 'Failed to refill bottle' });
    }
  },
  updateBottleCapacity: async (id: string, capacityMl: number) => {
    try {
      await inventoryRepository.updateBottleCapacity(id, capacityMl);
      const inventory = await inventoryRepository.getAllBottles();
      set({ inventory });
      publishInventoryUpdate(inventory);
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
      publishInventoryUpdate(inventory);
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
      publishInventoryUpdate(inventory);
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
