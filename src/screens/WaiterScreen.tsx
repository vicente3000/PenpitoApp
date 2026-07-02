import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors } from '../constants/Colors';
import { DrinkOrder, SessionGuest, TableSession } from '../models';
import { useRecipeStore } from '../stores/RecipeStore';
import { formatCurrency } from '../utils/drinkConfig';
import { getOrderStatusLabel } from '../utils/preparation';
import { formatTableLabel } from '../utils/tableQr';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog, DialogAction } from '../components/ui/Dialog';
import { PreparationTimeline } from '../components/PreparationTimeline';
import { deviceService } from '../services/DeviceService';

function PressableCardEmergency({ onPress }: { onPress: () => void }) {
  return (
    <Card style={styles.emergencyCard as any} glow={true}>
      <View style={styles.emergencyRow}>
        <FontAwesome name="exclamation-triangle" size={24} color="#ffffff" />
        <View style={styles.emergencyTextWrap}>
          <Text style={styles.emergencyTitle as any}>PARADA DE EMERGENCIA</Text>
          <Text style={styles.emergencySubtitle as any}>Presiona para apagar la máquina de inmediato</Text>
        </View>
        <Button
          title="DETENER"
          variant="danger"
          size="sm"
          onPress={onPress}
          style={styles.stopBtn}
        />
      </View>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  accent = 'primary',
}: {
  label: string;
  value: string;
  accent?: 'primary' | 'success' | 'warning';
}) {
  const accentColor =
    accent === 'success' ? Colors.success : accent === 'warning' ? Colors.warning : Colors.primary;

  return (
    <Card style={styles.metricCard as any}>
      <Text style={[styles.metricValue as any, { color: accentColor }]}>{value}</Text>
      <Text style={styles.metricLabel as any}>{label}</Text>
    </Card>
  );
}

export interface WaiterScreenProps {
  clearTableOrders: (tableNumber: number) => void;
  clearTableSession: (tableNumber: number) => void;
  onDeleteOrder: (order: DrinkOrder) => void;
  onMarkServed: (orderId: string) => void;
  onRemoveGuest: (tableNumber: number, guest: SessionGuest) => void;
  onResetAccess: () => void;
  ordersByTable: Map<number, DrinkOrder[]>;
  queuedOrdersCount: number;
  readyOrdersCount: number;
  sessions: TableSession[];
}

export function WaiterScreen({
  clearTableOrders,
  clearTableSession,
  onDeleteOrder,
  onMarkServed,
  onRemoveGuest,
  onResetAccess,
  ordersByTable,
  queuedOrdersCount,
  readyOrdersCount,
  sessions,
}: WaiterScreenProps) {
  const { recipes } = useRecipeStore();
  const [dialogVisible, setDialogVisible] = useState(false);
  const [dialogConfig, setDialogConfig] = useState({
    title: '',
    message: '',
    actions: [] as DialogAction[],
  });

  const showCustomDialog = (title: string, message: string, actions: DialogAction[]) => {
    setDialogConfig({ title, message, actions });
    setDialogVisible(true);
  };

  const getRecipePriceLocal = (recipeId: string) => {
    const r = recipes.find((rec) => rec.id === recipeId);
    return r?.price ?? 0;
  };

  const handleEmergencyStop = () => {
    showCustomDialog(
      'PARADA DE EMERGENCIA',
      '¿Estás seguro de que deseas detener la máquina de inmediato? Esta acción cortará la corriente de las bombas y motores.',
      [
        { text: 'Cancelar', variant: 'outline' },
        {
          text: 'DETENER KRAKEN',
          variant: 'danger',
          onPress: () => {
            void deviceService.sendCommand({ cmd: 'POWER', val: 'OFF', target: 'kraken' });
            showCustomDialog(
              'Detenido',
              'Comando de parada de emergencia enviado con éxito.',
              [{ text: 'Aceptar', variant: 'primary' }]
            );
          },
        },
      ]
    );
  };

  const handleCobrarMesa = (table: {
    tableNumber: number;
    orders: DrinkOrder[];
    session: TableSession | null;
  }) => {
    const tableSubtotal = table.orders.reduce(
      (total, order) => total + getRecipePriceLocal(order.recipe_id),
      0
    );
    const tableTipAmount = Math.round(tableSubtotal * 0.10);
    const tableTotal = tableSubtotal + tableTipAmount;

    const guestBreakdown: Record<string, number> = {};
    table.orders.forEach((order) => {
      const gName = order.guest_name || 'Mesa';
      const price = getRecipePriceLocal(order.recipe_id);
      guestBreakdown[gName] = (guestBreakdown[gName] || 0) + price;
    });

    const numGuests = table.session?.guests.length || 1;
    const equalSplit = Math.round(tableTotal / numGuests);

    let message = `Subtotal Consumido: ${formatCurrency(tableSubtotal)}\n`;
    message += `Propina Sugerida (10%): ${formatCurrency(tableTipAmount)}\n`;
    message += `Total a Cobrar: ${formatCurrency(tableTotal)}\n\n`;
    message += `══════ MÉTODOS DE PAGO ══════\n\n`;
    message += `1. Cuenta Completa:\n`;
    message += `   - Un pago único de ${formatCurrency(tableTotal)}\n\n`;

    if (numGuests > 1) {
      message += `2. Partes Iguales (${numGuests} personas):\n`;
      message += `   - ${formatCurrency(equalSplit)} por persona\n\n`;
    }

    message += `3. Consumo Individual (Consumo + 10% propina):\n`;
    Object.entries(guestBreakdown).forEach(([guest, amount]) => {
      const guestTip = Math.round(amount * 0.10);
      const guestTotal = amount + guestTip;
      message += `   - ${guest}: ${formatCurrency(guestTotal)} (Consumo: ${formatCurrency(amount)})\n`;
    });

    showCustomDialog(
      `Cobro de ${formatTableLabel(table.tableNumber)}`,
      message,
      [
        { text: 'Volver', variant: 'outline' },
        {
          text: 'Registrar Pago y Cerrar Mesa',
          variant: 'primary',
          onPress: () => {
            clearTableOrders(table.tableNumber);
            clearTableSession(table.tableNumber);
            setTimeout(() => {
              showCustomDialog(
                'Mesa cerrada',
                `El pago de la ${formatTableLabel(table.tableNumber)} ha sido registrado. La mesa se liberó correctamente.`,
                [{ text: 'Aceptar', variant: 'primary' }]
              );
            }, 500);
          }
        }
      ]
    );
  };

  const sessionByTable = new Map(sessions.map((session) => [session.table_number, session]));
  const tableNumbers = new Set<number>([
    ...ordersByTable.keys(),
    ...sessions.filter((session) => session.guests.length > 0).map((session) => session.table_number),
  ]);
  const tables = [...tableNumbers]
    .map((tableNumber) => ({
      tableNumber,
      orders: ordersByTable.get(tableNumber) ?? [],
      session: sessionByTable.get(tableNumber) ?? null,
    }))
    .filter((table) => table.orders.length > 0 || (table.session?.guests.length ?? 0) > 0)
    .sort((a, b) => a.tableNumber - b.tableNumber);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Persistant Emergency Stop Banner */}
      <PressableCardEmergency onPress={handleEmergencyStop} />

      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow as any}>Consola del Personal</Text>
          <Text style={styles.sectionTitle as any}>Mesas Activas</Text>
        </View>
        <Button
          title="Otro QR"
          variant="secondary"
          size="sm"
          onPress={onResetAccess}
          style={styles.qrBtn}
        />
      </View>

      <View style={styles.metricsRow}>
        <MetricCard label="Mesas" value={String(tables.length)} />
        <MetricCard label="Listos" value={String(readyOrdersCount)} accent="success" />
        <MetricCard label="En Cola" value={String(queuedOrdersCount)} accent="warning" />
      </View>

      {tables.length === 0 ? (
        <Card style={styles.sectionCard as any}>
          <Text style={styles.emptyText as any}>No hay mesas activas ni comandas en cola en este momento.</Text>
        </Card>
      ) : (
        tables.map((table) => {
          const tableTipPercentage = table.session?.tip_percentage ?? 0;
          const tableSubtotal = table.orders.reduce(
            (total, order) => total + getRecipePriceLocal(order.recipe_id),
            0
          );
          const tableTipAmount = Math.round(tableSubtotal * (tableTipPercentage / 100));
          const tableTotal = tableSubtotal + tableTipAmount;

          return (
            <Card key={table.tableNumber} style={styles.sectionCard as any}>
              {table.session?.bill_requested && (
                <View style={styles.billRequestedBanner}>
                  <View style={styles.billRequestedLeft}>
                    <FontAwesome name="bell" size={16} color="#c46a4a" />
                    <Text style={styles.billRequestedText}>Solicita la Cuenta</Text>
                  </View>
                  <Button
                    title="Cobrar Mesa"
                    variant="primary"
                    size="sm"
                    onPress={() => handleCobrarMesa(table)}
                    style={styles.cobrarBtn}
                  />
                </View>
              )}
              <View style={styles.tableHeader}>
                <Text style={styles.tableTitle as any}>{formatTableLabel(table.tableNumber)}</Text>
                <Button
                  title="Limpiar Mesa"
                  variant="outline"
                  size="sm"
                  disabled={table.orders.some((order) => ['queued', 'preparing', 'ready'].includes(order.status))}
                  onPress={() => {
                    showCustomDialog(
                      'Limpiar Mesa',
                      `¿Estás seguro de que deseas cerrar la sesión y borrar las comandas de la ${formatTableLabel(table.tableNumber)}?`,
                      [
                        { text: 'Cancelar', variant: 'outline' },
                        {
                          text: 'Limpiar',
                          variant: 'danger',
                          onPress: () => {
                            clearTableOrders(table.tableNumber);
                            clearTableSession(table.tableNumber);
                          },
                        },
                      ]
                    );
                  }}
                  style={styles.cleanBtn}
                />
              </View>

              <View style={styles.groupCard}>
                <Text style={styles.groupTitle as any}>Clientes en la mesa</Text>
                {table.session?.guests.length ? (
                  table.session.guests.map((guest) => {
                    const guestOrders = table.orders.filter((order) => order.guest_name === guest.name);
                    const hasActiveOrders = guestOrders.some((order) =>
                      ['queued', 'preparing', 'ready'].includes(order.status)
                    );
                    const servedCount = guestOrders.filter((order) => order.status === 'served').length;

                    return (
                      <View key={guest.id} style={styles.guestManagementRow}>
                        <View style={styles.guestManagementInfo}>
                          <Text style={styles.guestName as any}>{guest.name}</Text>
                          <Text style={styles.guestMeta as any}>
                            {guestOrders.length === 0
                              ? 'Sin pedidos'
                              : `${guestOrders.length} pedido(s)${servedCount ? ` · ${servedCount} servido(s)` : ''}`}
                          </Text>
                        </View>
                        <Button
                          title="Sacar"
                          variant="ghost"
                          size="sm"
                          disabled={hasActiveOrders}
                          onPress={() => {
                            showCustomDialog(
                              'Sacar Persona',
                              `¿Deseas retirar a ${guest.name} de la mesa?`,
                              [
                                { text: 'Cancelar', variant: 'outline' },
                                {
                                  text: 'Retirar',
                                  variant: 'danger',
                                  onPress: () => onRemoveGuest(table.tableNumber, guest),
                                },
                              ]
                            );
                          }}
                          style={styles.removeGuestBtn}
                          textStyle={styles.removeGuestBtnText}
                        />
                      </View>
                    );
                  })
                ) : (
                  <Text style={styles.emptyText as any}>No hay personas registradas.</Text>
                )}
              </View>

              {table.orders.length > 0 && (
                <View style={styles.billSummaryCard}>
                  <View style={styles.summaryBreakdownRow}>
                    <Text style={styles.summaryBreakdownLabel as any}>Subtotal</Text>
                    <Text style={styles.summaryBreakdownValue as any}>{formatCurrency(tableSubtotal)}</Text>
                  </View>
                  <View style={styles.summaryBreakdownRow}>
                    <Text style={styles.summaryBreakdownLabel as any}>Propina ({tableTipPercentage}%)</Text>
                    <Text style={styles.summaryBreakdownValue as any}>{formatCurrency(tableTipAmount)}</Text>
                  </View>
                  <View style={styles.summaryBreakdownRow}>
                    <Text style={styles.summaryBreakdownTotalLabel as any}>Total a cobrar</Text>
                    <Text style={styles.summaryBreakdownTotalValue as any}>{formatCurrency(tableTotal)}</Text>
                  </View>
                </View>
              )}

              <View style={styles.ordersList}>
                {table.orders.map((order) => (
                  <View key={order.id} style={styles.waiterOrderCard}>
                    <View style={styles.waiterOrderInfo}>
                      <Text style={styles.orderTitle as any}>{order.recipe_name}</Text>
                      <Text style={styles.orderMeta as any}>
                        {order.guest_name ? `${order.guest_name} · ` : ''}
                        {order.status === 'queued' ? 'En cola' : getOrderStatusLabel(order.status)}
                      </Text>
                      {(order.status === 'preparing' || order.status === 'ready') && (
                        <View style={styles.timelineWrap}>
                          <PreparationTimeline
                            activeStepId={order.active_step_id}
                            completedStepIds={order.completed_step_ids}
                            skippedStepIds={order.skipped_step_ids}
                            isReady={order.is_drink_ready}
                          />
                        </View>
                      )}
                    </View>
                    <View style={styles.orderActions}>
                      {order.status === 'ready' && (
                        <Button
                          title="Servido"
                          variant="primary"
                          size="sm"
                          onPress={() => onMarkServed(order.id)}
                          style={styles.actionBtn}
                        />
                      )}
                      {order.status !== 'preparing' && (
                        <Button
                          title="Eliminar"
                          variant="outline"
                          size="sm"
                          onPress={() => {
                            showCustomDialog(
                              'Eliminar pedido',
                              '¿Deseas eliminar esta comanda del sistema?',
                              [
                                { text: 'Cancelar', variant: 'outline' },
                                { text: 'Eliminar', variant: 'danger', onPress: () => onDeleteOrder(order) }
                              ]
                            );
                          }}
                          style={[styles.actionBtn, styles.deleteBtn]}
                          textStyle={styles.deleteBtnText}
                        />
                      )}
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          );
        })
      )}

      {/* Global Dialog */}
      <Dialog
        visible={dialogVisible}
        title={dialogConfig.title}
        message={dialogConfig.message}
        actions={dialogConfig.actions}
        onClose={() => setDialogVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    padding: 20,
    paddingBottom: 44,
  },
  emergencyCard: {
    backgroundColor: Colors.error,
    borderColor: '#ff4d4d',
    padding: 16,
    marginBottom: 20,
  },
  emergencyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  emergencyTextWrap: {
    flex: 1,
  },
  emergencyTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  emergencySubtitle: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  stopBtn: {
    backgroundColor: '#000000',
    borderColor: '#000000',
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  eyebrow: {
    color: Colors.primary,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 12,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: Colors.text,
  },
  qrBtn: {
    paddingHorizontal: 16,
    minHeight: 40,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  metricCard: {
    flex: 1,
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 0,
  },
  metricValue: {
    fontSize: 24,
    fontWeight: '900',
  },
  metricLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 4,
    fontWeight: '600',
  },
  sectionCard: {
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1.2,
    borderBottomColor: Colors.border,
    paddingBottom: 12,
    marginBottom: 14,
  },
  tableTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: Colors.text,
  },
  cleanBtn: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  emptyText: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginVertical: 12,
  },
  groupCard: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.secondary,
    marginBottom: 10,
  },
  guestManagementRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  guestManagementInfo: {
    flex: 1,
  },
  guestName: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  guestMeta: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  removeGuestBtn: {
    minHeight: 28,
    paddingHorizontal: 10,
  },
  removeGuestBtnText: {
    fontSize: 11,
    color: Colors.error,
  },
  billSummaryCard: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 14,
    marginBottom: 14,
  },
  summaryBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  summaryBreakdownLabel: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  summaryBreakdownValue: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  summaryBreakdownTotalLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  summaryBreakdownTotalValue: {
    color: Colors.primary,
    fontSize: 15,
    fontWeight: '900',
  },
  ordersList: {
    gap: 10,
  },
  waiterOrderCard: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  waiterOrderInfo: {
    flex: 1,
    marginBottom: 12,
  },
  orderTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  orderMeta: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  timelineWrap: {
    marginTop: 12,
  },
  orderActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    minHeight: 38,
    borderRadius: 12,
  },
  deleteBtn: {
    borderColor: Colors.borderHighlight,
  },
  deleteBtnText: {
    color: Colors.error,
  },
  billRequestedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fffaf4',
    padding: 12,
    borderRadius: 16,
    borderWidth: 1.2,
    borderColor: '#c46a4a',
    marginBottom: 14,
  },
  billRequestedLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  billRequestedText: {
    color: '#c46a4a',
    fontSize: 13,
    fontWeight: '800',
  },
  cobrarBtn: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
});
