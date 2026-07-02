import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors } from '../src/constants/Colors';
import { WaiterScreen } from '../src/screens/WaiterScreen';
import { useOrderStore } from '../src/stores/OrderStore';
import { useSessionStore } from '../src/stores/SessionStore';
import { DrinkOrder } from '../src/models';

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
