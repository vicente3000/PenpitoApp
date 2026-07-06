import React, { useMemo, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors } from '../src/constants/Colors';
import { WaiterScreen } from '../src/screens/WaiterScreen';
import { useSessionStore } from '../src/stores/SessionStore';
import { DrinkOrder } from '../src/models';
import {
  useAllTables,
  useOrderActions,
  useControllerConnection,
  useControllerHardware,
  useForceSnapshotOnConnect,
} from '../src/hooks/useOrderStoreV2';
import { useAdminController } from '../src/hooks/useAdminController';

export default function WaiterRoute() {
  const ordersByTable = useAllTables();
  const { serveOrder, cancelOrder } = useOrderActions();
  const { isConnected, snapshot: connectionSnapshot } = useControllerConnection();
  const hardware = useControllerHardware();
  const admin = useAdminController();

  useForceSnapshotOnConnect();

  const {
    sessions,
    removeGuestFromTable,
    clearTableSession,
  } = useSessionStore();

  // En la nueva arquitectura, "cobrar mesa" cancela los pedidos pending.
  // El controller no maneja sesiones (es responsabilidad de la app).
  // Los pedidos activos (dispatching/accepted/preparing) NO se cancelan aquí:
  // el operador debe esperar a que el trago salga y marcarlo como 'served'
  // antes de cobrar. Los pedidos 'queued'/'failed' se cancelan siempre.
  const clearTableOrders = (tableNumber: number) => {
    const tableOrders = ordersByTable.get(tableNumber) ?? [];
    for (const order of tableOrders) {
      if (order.status === 'queued' || order.status === 'failed') {
        void cancelOrder(tableNumber, order.id);
      }
    }
  };

  // Para la métrica global necesitamos aplanar la lista.
  const allOrders = useMemo(() => {
    const out: DrinkOrder[] = [];
    for (const list of ordersByTable.values()) out.push(...list);
    return out;
  }, [ordersByTable]);

  const queuedOrdersCount = useMemo(() => allOrders.filter((o) => o.status === 'queued').length, [allOrders]);
  const readyOrdersCount = useMemo(() => allOrders.filter((o) => o.status === 'ready').length, [allOrders]);

  // Adaptar el snapshot al tipo legacy que WaiterScreen espera.
  const legacyConnectionSnapshot = useMemo(
    () => ({
      broker: connectionSnapshot.broker,
      deviceOnline: connectionSnapshot.deviceOnline,
      lastDeviceMessageAt: connectionSnapshot.lastDeviceMessageAt,
      error: connectionSnapshot.error,
    }),
    [connectionSnapshot]
  );

  const machineState = useMemo(
    () => ({
      isOn: !!hardware?.isOn,
      status: (hardware?.status ?? 'idle') as 'idle' | 'preparing' | 'cleaning' | 'error',
      errorMessage: hardware?.errorMessage ?? undefined,
      currentRecipeId: hardware?.activeOrderId ?? undefined,
      activeStepId: hardware?.activeStepId as any,
      completedStepIds: (hardware?.completedStepIds ?? []) as any,
      skippedStepIds: (hardware?.skippedStepIds ?? []) as any,
      isDrinkReady: !!hardware?.isDrinkReady,
    }),
    [hardware]
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <WaiterScreen
        isConnected={isConnected}
        connectionSnapshot={legacyConnectionSnapshot as any}
        machineState={machineState as any}
        onMarkServed={(id) => {
          // Encontrar la mesa del pedido
          for (const [tableId, list] of ordersByTable) {
            if (list.some((o) => o.id === id)) {
              void serveOrder(tableId, id);
              return;
            }
          }
        }}
        onRemoveGuest={(tableNum, guest) => {
          removeGuestFromTable(tableNum, guest.id);
        }}
        onResetAccess={() => {
          router.replace('/');
        }}
        onDeleteOrder={(order) => {
          void cancelOrder(order.table_number, order.id);
        }}
        onPowerOn={async () => {
          try {
            const ack = await admin.powerOn();
            return ack.accepted;
          } catch {
            return false;
          }
        }}
        onEmergencyStop={async () => {
          try {
            const ack = await admin.emergencyStop();
            return ack.accepted;
          } catch {
            return false;
          }
        }}
        clearTableSession={clearTableSession}
        clearTableOrders={clearTableOrders}
        ordersByTable={ordersByTable}
        queuedOrdersCount={queuedOrdersCount}
        readyOrdersCount={readyOrdersCount}
        sessions={sessions}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
