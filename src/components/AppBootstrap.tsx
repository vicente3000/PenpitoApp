import { useEffect } from 'react';
import { deviceService } from '../services/DeviceService';
import { useAppStore } from '../stores/AppStore';
import { useInventoryStore } from '../stores/InventoryStore';
import { useOrderStore } from '../stores/OrderStore';
import { useRecipeStore } from '../stores/RecipeStore';
import { useSessionStore } from '../stores/SessionStore';
import { useSettingsStore } from '../stores/SettingsStore';

export function AppBootstrap() {
  useEffect(() => {
    let isMounted = true;

    deviceService.onStateChange((state) => {
      useAppStore.getState().setMachineState(state);
      void useOrderStore.getState().syncFromMachine(state);
    });

    const initialize = async () => {
      await Promise.allSettled([
        useRecipeStore.getState().loadRecipes(),
        useInventoryStore.getState().loadInventory(),
        useSettingsStore.getState().loadSettings(),
        useOrderStore.getState().loadOrders(),
        useSessionStore.getState().loadSessions(),
      ]);

      const connected = await deviceService.connect();
      if (isMounted) {
        useAppStore.getState().setIsConnected(connected);
      }
    };

    void initialize();

    return () => {
      isMounted = false;
      useAppStore.getState().setIsConnected(false);
      void deviceService.disconnect();
    };
  }, []);

  return null;
}
