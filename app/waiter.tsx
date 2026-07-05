import React, { useMemo, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors } from '../src/constants/Colors';
import { WaiterScreen } from '../src/screens/WaiterScreen';
import { useOrderStore } from '../src/stores/OrderStore';
import { useSessionStore } from '../src/stores/SessionStore';
import { DrinkOrder } from '../src/models';
import { deviceService } from '../src/services/DeviceService';

export default function WaiterRoute() {
  const {
    orders,
    deleteOrder,
    markOrderServed,
    clearTableOrders,
  } = useOrderStore();
  
  const {
    sessions,
    removeGuestFromTable,
    clearTableSession,
  } = useSessionStore();

  // Sincronizar todas las mesas (1-10) vía MQTT en la consola del mesero
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    for (let tableNum = 1; tableNum <= 10; tableNum++) {
      const unsubSession = deviceService.subscribeCustom(
        `penpito/table/${tableNum}/session`,
        (payload) => {
          try {
            const session = JSON.parse(payload);
            useSessionStore.getState().syncSessionFromNetwork(tableNum, session);
          } catch {
            // ignore
          }
        }
      );
      if (unsubSession) unsubs.push(unsubSession);

      const unsubOrders = deviceService.subscribeCustom(
        `penpito/table/${tableNum}/orders`,
        (payload) => {
          try {
            const parsedOrders = JSON.parse(payload);
            void useOrderStore.getState().syncOrdersFromNetwork(tableNum, parsedOrders);
          } catch {
            // ignore
          }
        }
      );
      if (unsubOrders) unsubs.push(unsubOrders);

      // Solicitar sincronización inicial
      deviceService.publish(
        `penpito/table/${tableNum}/request`,
        JSON.stringify({ type: 'SYNC_REQUEST' })
      );
    }

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, []);

  const queuedOrders = useMemo(() => orders.filter((o) => o.status === 'queued'), [orders]);
  const readyOrders = useMemo(() => orders.filter((o) => o.status === 'ready'), [orders]);

  const ordersByTable = useMemo(() => {
    const map = new Map<number, DrinkOrder[]>();
    orders.forEach((o) => {
      const list = map.get(o.table_number) ?? [];
      list.push(o);
      map.set(o.table_number, list);
    });
    return map;
  }, [orders]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <WaiterScreen
        clearTableOrders={clearTableOrders}
        clearTableSession={clearTableSession}
        onDeleteOrder={(order) => {
          void deleteOrder(order.id);
        }}
        onMarkServed={(id) => {
          void markOrderServed(id);
        }}
        onRemoveGuest={(tableNum, guest) => {
          removeGuestFromTable(tableNum, guest.id);
        }}
        onResetAccess={() => {
          router.replace('/');
        }}
        ordersByTable={ordersByTable}
        queuedOrdersCount={queuedOrders.length}
        readyOrdersCount={readyOrders.length}
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
