import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { deviceService } from '../services/DeviceService';
import { useAppStore } from '../stores/AppStore';
import { useInventoryStore } from '../stores/InventoryStore';
import { useOrderStore } from '../stores/OrderStore';
import { useRecipeStore } from '../stores/RecipeStore';
import { useSessionStore } from '../stores/SessionStore';
import { useSettingsStore } from '../stores/SettingsStore';
import { getDeviceId } from '../services/DeviceIdentityService';
import { getOrCreateOrderStoreV2 } from '../hooks/useOrderStoreV2';

export function AppBootstrap() {
  useEffect(() => {
    let isMounted = true;

    // Adapter v2 (autoritativo): snapshots de cola y estado del hardware.
    // La app NO publica comandos de hardware: solo sometimiento de pedidos
    // y comandos administrativos que el controller reenvía.
    const orderStoreV2 = getOrCreateOrderStoreV2();

    const unsubV2Connection = deviceService.penpitoAdapter.onConnectionChange((snapshot) => {
      if (!isMounted) return;
      useAppStore.getState().setConnectionSnapshot(snapshot);
      if (snapshot.broker === 'connected') {
        for (let tableId = 1; tableId <= 10; tableId++) {
          orderStoreV2.getState().requestSnapshot(tableId);
        }
      }
    });

    // Hardware autoritativo publicado por el controller.
    const unsubHwAuth = orderStoreV2.subscribe(() => {
      if (!isMounted) return;
      const hw = orderStoreV2.getState().hardware;
      if (hw) {
        useAppStore.getState().setMachineState({
          isOn: hw.isOn,
          status: hw.status,
          errorMessage: hw.errorMessage ?? undefined,
          currentRecipeId: hw.activeOrderId ?? undefined,
          activeStepId: (hw.activeStepId ?? undefined) as any,
          completedStepIds: hw.completedStepIds as any,
          skippedStepIds: hw.skippedStepIds as any,
          isDrinkReady: hw.isDrinkReady,
        });
      }
    });

    // Legacy: se mantiene solo para InventoryStore v1 (publicación de refill)
    // y para sesiones/inventory compartidos en red local. NO maneja la cola.
    const unsubLegacyConnection = deviceService.legacyAdapter.onConnectionChange((snapshot) => {
      if (isMounted) {
        const current = useAppStore.getState().connectionSnapshot;
        // Solo actualizamos si la info del v2 está vacía o es peor.
        if (current.broker === 'disconnected' && snapshot.broker !== 'disconnected') {
          useAppStore.getState().setConnectionSnapshot(snapshot);
        }
      }
    });

    const initialize = async () => {
      await Promise.allSettled([
        useRecipeStore.getState().loadRecipes(),
        useInventoryStore.getState().loadInventory(),
        useSettingsStore.getState().loadSettings(),
        useOrderStore.getState().loadOrders(),
        useSessionStore.getState().loadSessions(),
        getDeviceId(),
      ]);

      if (isMounted) {
        await deviceService.connect();
      }
    };

    void initialize();

    const appStateSub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' && isMounted) {
        void deviceService.connect();
        if (orderStoreV2.getState().isConnected) {
          for (let tableId = 1; tableId <= 10; tableId++) {
            orderStoreV2.getState().requestSnapshot(tableId);
          }
        }
      }
    });

    return () => {
      isMounted = false;
      appStateSub.remove();
      unsubV2Connection();
      unsubHwAuth();
      unsubLegacyConnection();
      void deviceService.disconnect();
    };
  }, []);

  return null;
}
