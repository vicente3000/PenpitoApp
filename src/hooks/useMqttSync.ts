import { useEffect } from 'react';
import { deviceService } from '../services/DeviceService';
import { useSessionStore } from '../stores/SessionStore';
import { useOrderStore } from '../stores/OrderStore';

export function useMqttSync(tableNumber: number | null) {
  useEffect(() => {
    if (tableNumber === null) {
      return;
    }

    const unsubSession = deviceService.subscribeCustom(
      `penpito/table/${tableNumber}/session`,
      (payload) => {
        try {
          const session = JSON.parse(payload);
          useSessionStore.getState().syncSessionFromNetwork(tableNumber, session);
        } catch {
          // ignore
        }
      }
    );

    const unsubOrders = deviceService.subscribeCustom(
      `penpito/table/${tableNumber}/orders`,
      (payload) => {
        try {
          const orders = JSON.parse(payload);
          void useOrderStore.getState().syncOrdersFromNetwork(tableNumber, orders);
        } catch {
          // ignore
        }
      }
    );

    const unsubSyncRequest = deviceService.subscribeCustom(
      `penpito/table/${tableNumber}/request`,
      (payload) => {
        try {
          const parsed = JSON.parse(payload);
          if (parsed && parsed.type === 'SYNC_REQUEST') {
            const mySession = useSessionStore
              .getState()
              .sessions.find((s) => s.table_number === tableNumber);
            const myOrders = useOrderStore
              .getState()
              .orders.filter((o) => o.table_number === tableNumber);

            if (mySession) {
              deviceService.publish(
                `penpito/table/${tableNumber}/session`,
                JSON.stringify(mySession)
              );
            }
            deviceService.publish(
              `penpito/table/${tableNumber}/orders`,
              JSON.stringify(myOrders)
            );
          }
        } catch {
          // ignore
        }
      }
    );

    // Solicitamos sincronizacion inicial
    deviceService.publish(
      `penpito/table/${tableNumber}/request`,
      JSON.stringify({ type: 'SYNC_REQUEST' })
    );

    return () => {
      unsubSession?.();
      unsubOrders?.();
      unsubSyncRequest?.();
    };
  }, [tableNumber]);
}
