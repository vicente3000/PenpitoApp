import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors } from '../constants/Colors';
import { DrinkOrder, SessionGuest, TableSession } from '../models';
import { useRecipeStore } from '../stores/RecipeStore';
import { formatCurrency, getOrderDisplayName } from '../utils/drinkConfig';
import { getOrderStatusLabel, preparationSteps } from '../utils/preparation';
import { formatTableLabel } from '../utils/tableQr';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog, DialogAction } from '../components/ui/Dialog';
import { deviceService } from '../services/DeviceService';
import { useAppStore } from '../stores/AppStore';

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
  const { machineState, isConnected, connectionSnapshot } = useAppStore();
  const [dialogVisible, setDialogVisible] = useState(false);
  const [billingTable, setBillingTable] = useState<{
    tableNumber: number;
    orders: DrinkOrder[];
    session: TableSession | null;
  } | null>(null);
  const [paymentMode, setPaymentMode] = useState<'total' | 'split' | 'individual'>('total');
  const [selectedPayee, setSelectedPayee] = useState<string | null>(null);
  const [customTipPercentage, setCustomTipPercentage] = useState<number>(10);
  const [splitCount, setSplitCount] = useState<number>(1);
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
          onPress: async () => {
            const success = await deviceService.sendCommand({ cmd: 'POWER', val: 'OFF', target: 'kraken' });
            showCustomDialog(
              success ? 'Máquina detenida' : 'Confirmación no recibida',
              success
                ? 'El comando de parada de emergencia fue confirmado por el hardware.'
                : 'Se envió la orden de parada pero el ESP32 no respondió a tiempo. Verifique físicamente el robot.',
              [{ text: 'Aceptar', variant: success ? 'primary' : 'danger' }]
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
    setBillingTable(table);
    setPaymentMode('total');
    setSelectedPayee(null);
    setCustomTipPercentage(table.session?.tip_percentage ?? 10);
    setSplitCount(table.session?.guests.length || 1);
  };

  const renderBillingDashboard = (table: {
    tableNumber: number;
    orders: DrinkOrder[];
    session: TableSession | null;
  }) => {
    const billableOrders = table.orders.filter((o) => o.status !== 'failed');
    const tableSubtotal = billableOrders.reduce(
      (total, order) => total + getRecipePriceLocal(order.recipe_id),
      0,
    );
    const tableTipPercentage = customTipPercentage;
    const tableTipAmount = Math.round(tableSubtotal * (tableTipPercentage / 100));
    const tableTotal = tableSubtotal + tableTipAmount;

    const drinkCounts: Record<string, number> = {};
    billableOrders.forEach((o) => {
      const name = getOrderDisplayName(o);
      drinkCounts[name] = (drinkCounts[name] || 0) + 1;
    });

    const numGuests = table.session?.guests.length || 1;
    const activeSplitCount = splitCount > 0 ? splitCount : 1;
    const equalSplit = Math.round(tableTotal / activeSplitCount);

    const guestBreakdown: Record<string, number> = {};
    table.orders.forEach((order) => {
      const gName = order.guest_name || 'Mesa';
      const price = getRecipePriceLocal(order.recipe_id);
      guestBreakdown[gName] = (guestBreakdown[gName] || 0) + price;
    });

    const handleConfirmPayment = () => {
      let confirmationMessage = '';
      if (paymentMode === 'total') {
        const payeeName = selectedPayee || 'Un cliente';
        confirmationMessage = `${payeeName} pagó la cuenta completa de ${formatCurrency(tableTotal)}.`;
      } else if (paymentMode === 'split') {
        confirmationMessage = `La cuenta de ${formatCurrency(tableTotal)} se dividió en partes iguales (${splitCount} personas). Pago registrado.`;
      } else {
        confirmationMessage = `Se registraron los consumos individuales de la mesa. Pago registrado.`;
      }

      clearTableOrders(table.tableNumber);
      clearTableSession(table.tableNumber);
      setBillingTable(null);
      setSelectedPayee(null);

      showCustomDialog(
        'Pago Registrado',
        confirmationMessage,
        [{ text: 'Aceptar', variant: 'primary' }]
      );
    };

    return (
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.eyebrow as any}>Cerrar Cuenta</Text>
            <Text style={styles.sectionTitle as any}>{formatTableLabel(table.tableNumber)}</Text>
          </View>
          <Button
            title="Volver"
            variant="outline"
            size="sm"
            onPress={() => {
              setBillingTable(null);
              setSelectedPayee(null);
            }}
          />
        </View>

        <Card style={styles.sectionCard as any}>
          <Text style={styles.groupTitle as any}>Detalle de Consumo</Text>
          <View style={{ marginTop: 8 }}>
            {Object.entries(drinkCounts).map(([name, count]) => (
              <View key={name} style={styles.billingItemRow}>
                <Text style={styles.billingItemName}>{count}x {name}</Text>
                <Text style={styles.billingItemPrice}>
                  {formatCurrency(count * getRecipePriceLocal(table.orders.find((o) => getOrderDisplayName(o) === name)?.recipe_id || ''))}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.billingDivider} />

          <View style={styles.summaryBreakdownRow}>
            <Text style={styles.summaryBreakdownLabel as any}>Subtotal</Text>
            <Text style={styles.summaryBreakdownValue as any}>{formatCurrency(tableSubtotal)}</Text>
          </View>
          <View style={styles.summaryBreakdownRow}>
            <Text style={styles.summaryBreakdownLabel as any}>Propina ({tableTipPercentage}%)</Text>
            <Text style={styles.summaryBreakdownValue as any}>{formatCurrency(tableTipAmount)}</Text>
          </View>
          <View style={styles.summaryBreakdownRow}>
            <Text style={styles.summaryBreakdownTotalLabel as any}>Total General</Text>
            <Text style={styles.summaryBreakdownTotalValue as any}>{formatCurrency(tableTotal)}</Text>
          </View>
        </Card>

        <Card style={styles.sectionCard as any}>
          <Text style={styles.groupTitle as any}>Propina de la Mesa</Text>
          <Text style={styles.sectionText}>Selecciona el porcentaje de propina a aplicar:</Text>
          
          <View style={styles.paymentModeTabs}>
            <Button
              key="tip-0"
              title="Sin Propina (0%)"
              variant={customTipPercentage === 0 ? 'secondary' : 'outline'}
              size="sm"
              onPress={() => setCustomTipPercentage(0)}
              style={styles.tabBtn}
            />
            <Button
              key="tip-10"
              title="Sugerida (10%)"
              variant={customTipPercentage === 10 ? 'secondary' : 'outline'}
              size="sm"
              onPress={() => setCustomTipPercentage(10)}
              style={styles.tabBtn}
            />
            <Button
              key="tip-15"
              title="Excelente (15%)"
              variant={customTipPercentage === 15 ? 'secondary' : 'outline'}
              size="sm"
              onPress={() => setCustomTipPercentage(15)}
              style={styles.tabBtn}
            />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 15, color: Colors.text, fontWeight: '600' }}>Otro Porcentaje:</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <TextInput
                keyboardType="numeric"
                style={styles.tipInput}
                value={String(customTipPercentage)}
                onChangeText={(val) => {
                  const clean = val.replace(/[^0-9]/g, '');
                  const parsed = Number(clean);
                  if (!isNaN(parsed) && parsed >= 0) {
                    setCustomTipPercentage(parsed);
                  } else if (clean === '') {
                    setCustomTipPercentage(0);
                  }
                }}
              />
              <Text style={{ fontSize: 16, color: Colors.text, marginLeft: 8, fontWeight: 'bold' }}>%</Text>
            </View>
          </View>
        </Card>

        <Card style={styles.sectionCard as any}>
          <Text style={styles.groupTitle as any}>Método de Pago (Asignado por Garzón)</Text>
          <Text style={styles.sectionText}>Selecciona cómo se dividirá o cancelará la cuenta:</Text>

          <View style={styles.paymentModeTabs}>
            <Button
              title="Pago Único"
              variant={paymentMode === 'total' ? 'primary' : 'outline'}
              size="sm"
              onPress={() => setPaymentMode('total')}
              style={styles.tabBtn}
            />
            <Button
              title="Partes Iguales"
              variant={paymentMode === 'split' ? 'primary' : 'outline'}
              size="sm"
              onPress={() => setPaymentMode('split')}
              style={styles.tabBtn}
            />
            <Button
              title="Individual"
              variant={paymentMode === 'individual' ? 'primary' : 'outline'}
              size="sm"
              onPress={() => setPaymentMode('individual')}
              style={styles.tabBtn}
            />
          </View>

          {paymentMode === 'total' && (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.inputLabel}>Selecciona el cliente responsable de toda la cuenta:</Text>
              {table.session?.guests.length ? (
                <View style={{ gap: 8, marginTop: 8 }}>
                  {table.session.guests.map((guest) => {
                    const isSelected = selectedPayee === guest.name;
                    return (
                      <Button
                        key={guest.id}
                        title={guest.name}
                        variant={isSelected ? 'secondary' : 'outline'}
                        size="sm"
                        onPress={() => setSelectedPayee(guest.name)}
                        style={{ alignSelf: 'stretch' }}
                      />
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.emptyText as any}>No hay clientes registrados en esta mesa.</Text>
              )}

              {selectedPayee && (
                <Text style={[styles.successBanner, { marginTop: 12 }]}>
                  💡 {selectedPayee} pagará la cuenta completa de {formatCurrency(tableTotal)}
                </Text>
              )}
            </View>
          )}

          {paymentMode === 'split' && (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.inputLabel}>División Equitativa</Text>
              <Text style={styles.sectionText}>
                Selecciona la cantidad de personas para dividir la cuenta de la mesa:
              </Text>
              
              <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 12, gap: 10, justifyContent: 'center' }}>
                <Button
                  key="split-minus"
                  title="-"
                  variant="outline"
                  onPress={() => setSplitCount(Math.max(1, splitCount - 1))}
                  style={{ width: 44, height: 44, minHeight: 44, paddingHorizontal: 0, justifyContent: 'center', alignItems: 'center' }}
                />
                <Text style={{ fontSize: 20, fontWeight: 'bold', color: Colors.text, width: 40, textAlign: 'center' }}>
                  {splitCount}
                </Text>
                <Button
                  key="split-plus"
                  title="+"
                  variant="outline"
                  onPress={() => setSplitCount(splitCount + 1)}
                  style={{ width: 44, height: 44, minHeight: 44, paddingHorizontal: 0, justifyContent: 'center', alignItems: 'center' }}
                />
              </View>

              <Text style={styles.splitAmountText}>
                {formatCurrency(equalSplit)} / persona
              </Text>
            </View>
          )}

          {paymentMode === 'individual' && (
            <View style={{ marginTop: 16 }}>
              <Text style={styles.inputLabel}>Consumo por Cliente</Text>
              <View style={{ gap: 12, marginTop: 8 }}>
                {Object.entries(guestBreakdown).map(([guest, amount]) => {
                  const guestTip = Math.round(amount * (tableTipPercentage / 100));
                  const guestTotal = amount + guestTip;
                  return (
                    <View key={guest} style={styles.individualGuestRow}>
                      <View>
                        <Text style={styles.individualGuestName}>{guest}</Text>
                        <Text style={styles.individualGuestMeta}>Consumo: {formatCurrency(amount)} + Propina</Text>
                      </View>
                      <Text style={styles.individualGuestTotal}>{formatCurrency(guestTotal)}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}
        </Card>

        <Button
          title="Registrar Pago y Cerrar Mesa"
          variant="primary"
          disabled={paymentMode === 'total' && !selectedPayee}
          onPress={handleConfirmPayment}
          style={{ backgroundColor: Colors.success, borderColor: Colors.success, marginVertical: 12 } as any}
        />

        <Button
          title="Cancelar y Volver"
          variant="outline"
          onPress={() => {
            setBillingTable(null);
            setSelectedPayee(null);
          }}
          style={{ marginBottom: 40 }}
        />

        <Dialog
          visible={dialogVisible}
          title={dialogConfig.title}
          message={dialogConfig.message}
          actions={dialogConfig.actions}
          onClose={() => setDialogVisible(false)}
        />
      </ScrollView>
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

  if (billingTable) {
    return renderBillingDashboard(billingTable);
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Persistant Emergency Stop Banner or Reactivation Banner */}
      {!machineState.isOn ? (
        <Card style={[styles.emergencyCard, { backgroundColor: 'rgba(239, 68, 68, 0.08)', borderColor: Colors.error }] as any}>
          <View style={styles.emergencyRow}>
            <FontAwesome name="exclamation-triangle" size={24} color={Colors.error} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: Colors.text }}>Maquina APAGADA</Text>
              <Text style={{ fontSize: 12, color: Colors.textMuted, marginTop: 2 }}>
                La corriente esta desactivada por seguridad o parada de emergencia.
              </Text>
            </View>
            {connectionSnapshot?.deviceOnline ? (
              <Button
                title="Encender"
                variant="primary"
                size="sm"
                onPress={async () => {
                  const success = await deviceService.sendCommand({ cmd: 'POWER', val: 'ON', target: 'kraken' });
                  if (success) {
                    showCustomDialog(
                      'Maquina Encendida',
                      'Se ha reactivado la corriente y reiniciado la maquina con exito.',
                      [{ text: 'Aceptar', variant: 'primary' }]
                    );
                  }
                }}
                style={{ backgroundColor: Colors.success, borderColor: Colors.success, minHeight: 32, paddingHorizontal: 12 } as any}
              />
            ) : (
              <Text style={{ fontSize: 12, color: Colors.textMuted, fontWeight: '600' }}>ESP32 fuera de linea</Text>
            )}
          </View>
        </Card>
      ) : connectionSnapshot?.deviceOnline ? (
        <PressableCardEmergency onPress={handleEmergencyStop} />
      ) : (
        <Card style={[styles.emergencyCard, { backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: '#F59E0B' }] as any}>
          <View style={styles.emergencyRow}>
            <FontAwesome name="exclamation-triangle" size={24} color="#F59E0B" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#F59E0B' }}>ESP32 fuera de linea</Text>
              <Text style={{ fontSize: 12, color: Colors.textMuted, marginTop: 2 }}>
                La maquina no responde en la red. Parada de emergencia no disponible.
              </Text>
            </View>
          </View>
        </Card>
      )}

      {connectionSnapshot && connectionSnapshot.broker !== 'connected' ? (
        <View style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', borderColor: Colors.error, borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center' }}>
          <FontAwesome name="wifi" size={18} color={Colors.error} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: Colors.error, fontWeight: 'bold', fontSize: 14 }}>Sin Conexion al Broker MQTT</Text>
            <Text style={{ color: Colors.textMuted, fontSize: 12, marginTop: 2 }}>El broker MQTT no responde. Verifica la red Wi-Fi o IP del servidor.</Text>
          </View>
        </View>
      ) : connectionSnapshot && !connectionSnapshot.deviceOnline ? (
        <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: '#F59E0B', borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center' }}>
          <FontAwesome name="exclamation-triangle" size={18} color="#F59E0B" style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#F59E0B', fontWeight: 'bold', fontSize: 14 }}>Broker Conectado - ESP32 Offline</Text>
            <Text style={{ color: Colors.textMuted, fontSize: 12, marginTop: 2 }}>La maquina no responde en la red. Puedes gestionar mesas pero las ordenes no se prepararan.</Text>
          </View>
        </View>
      ) : null}

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
          const billableOrders = table.orders.filter((o) => o.status !== 'failed');
          const tableSubtotal = billableOrders.reduce(
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
                    <Text style={styles.billRequestedText}>Esta mesa solicita la cuenta</Text>
                  </View>
                </View>
              )}
              <View style={styles.tableHeader}>
                <Text style={styles.tableTitle as any}>
                  {formatTableLabel(table.tableNumber)}
                  {table.orders.filter(o => o.status !== 'served' && o.status !== 'failed').length > 0 ? (
                    <Text style={{ fontSize: 14, fontWeight: 'normal', color: Colors.warning }}>
                      {` (${table.orders.filter(o => o.status !== 'served' && o.status !== 'failed').length} pendientes)`}
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 14, fontWeight: 'normal', color: Colors.success }}>
                      {` (Sin pendientes)`}
                    </Text>
                  )}
                </Text>
                <Button
                  title="Cobrar Mesa"
                  variant="primary"
                  size="sm"
                  onPress={() => handleCobrarMesa(table)}
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

              {/* Ocultado detalle de cuenta de la mesa activa en la pantalla general */}

              <View style={styles.ordersList}>
                {table.orders.filter((order) => order.status !== 'served').map((order) => (
                  <View key={order.id} style={styles.waiterOrderCard}>
                    <View style={styles.waiterOrderInfo}>
                      <Text style={styles.orderTitle as any}>{getOrderDisplayName(order)}</Text>
                      <Text style={styles.orderMeta as any}>
                        {order.guest_name ? `${order.guest_name} · ` : ''}
                        {order.status === 'queued' && 'En cola'}
                        {order.status === 'served' && 'Servido'}
                        {order.status === 'failed' && <Text style={{ color: Colors.error }}>No completado</Text>}
                        {order.status === 'ready' && (
                          <Text style={{ color: Colors.success, fontWeight: '800' }}>Listo para servir</Text>
                        )}
                        {order.status === 'preparing' && (
                          <Text style={{ color: Colors.warning, fontWeight: '800' }}>
                            {`Preparando · ${preparationSteps.find(s => s.id === order.active_step_id)?.title || 'Iniciando'}`}
                          </Text>
                        )}
                      </Text>
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
  billingItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceHighlight,
  },
  billingItemName: {
    fontSize: 16,
    color: Colors.text,
    fontWeight: '500',
  },
  billingItemPrice: {
    fontSize: 16,
    color: Colors.text,
    fontWeight: '600',
  },
  billingDivider: {
    height: 1.5,
    backgroundColor: Colors.border,
    marginVertical: 14,
  },
  paymentModeTabs: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 12,
  },
  tabBtn: {
    flex: 1,
  },
  splitAmountText: {
    fontSize: 22,
    fontWeight: 'bold',
    color: Colors.primary,
    textAlign: 'center',
    marginVertical: 16,
    padding: 12,
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
  },
  successBanner: {
    padding: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: Colors.success,
    borderWidth: 1,
    borderRadius: 16,
    color: Colors.success,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  individualGuestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
  },
  individualGuestName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: Colors.text,
  },
  individualGuestMeta: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  individualGuestTotal: {
    fontSize: 16,
    fontWeight: 'bold',
    color: Colors.primary,
  },
  tipInput: {
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1.2,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: Colors.text,
    fontSize: 16,
    fontWeight: 'bold',
    width: 80,
    textAlign: 'center',
  },
  sectionText: {
    color: Colors.textMuted,
    fontSize: 14,
    marginBottom: 12,
    lineHeight: 20,
  },
  inputLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 10,
  },
});
