import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors, Shadows } from '../constants/Colors';
import {
  BillSplitMethod,
  DrinkOrder,
  DrinkPreparationOptions,
  MachineSettings,
  PiscolaIntensity,
  Recipe,
  TableSession,
} from '../models';
import { useMqttSync } from '../hooks/useMqttSync';
import {
  buildCartItemLabel,
  formatCurrency,
  getRecipeDefaultOptions,
  piscolaProfiles,
} from '../utils/drinkConfig';
import { getOrderStatusLabel } from '../utils/preparation';
import { formatTableLabel } from '../utils/tableQr';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { DrinkGrid } from '../components/ui/DrinkGrid';
import { Dialog, DialogAction } from '../components/ui/Dialog';

export interface UserPortalProps {
  activeOrders: DrinkOrder[];
  cart: {
    id: string;
    recipe: Recipe;
    options: DrinkPreparationOptions;
    quantity: number;
  }[];
  currentGuestName: string;
  guestNameInput: string;
  onResetAccess: () => void;
  onAddCartItem: (recipe: Recipe, quantity: number) => void;
  onJoinTable: () => void;
  onQuantityChange: (cartId: string, delta: number) => void;
  onRemoveCartItem: (cartId: string) => void;
  onSelectRecipe: (recipe: Recipe | null) => void;
  onSelectGuest: (guestId: string) => void;
  onStartNewGuest: () => void;
  onSubmitCart: () => void;
  onDeleteQueuedOrder: (order: DrinkOrder) => void;
  recipeAvailability: (recipe: Recipe) => boolean;
  recipes: Recipe[];
  settings: MachineSettings | null;
  selectedRecipe: Recipe | null;
  session: TableSession | null;
  setGuestNameInput: (text: string) => void;
  setHostGuest: (guestId?: string) => void;
  setPiscolaIntensity: (intensity: PiscolaIntensity) => void;
  setSplitMethod: (method: BillSplitMethod) => void;
  setTipPercentage: (tip: number) => void;
  piscolaIntensity: PiscolaIntensity;
  tableNumber: number;
}

const splitOptions = [
  {
    id: 'pay_own' as const,
    title: 'Cada uno paga lo suyo',
    description: 'Cada persona de la mesa paga los tragos que ordenó.',
  },
  {
    id: 'equal_split' as const,
    title: 'Dividir en partes iguales',
    description: 'Se reparte el total en partes iguales entre quienes participan de la mesa.',
  },
  {
    id: 'host_pays' as const,
    title: 'Una persona paga todo',
    description: 'Una sola persona asume el total de la mesa y luego puede cobrar aparte.',
  },
];

const tipPercentageOptions = [0, 10, 15, 20];

export function UserPortalScreen({
  activeOrders,
  cart,
  currentGuestName,
  guestNameInput,
  onResetAccess,
  onAddCartItem,
  onJoinTable,
  onQuantityChange,
  onRemoveCartItem,
  onSelectRecipe,
  onSelectGuest,
  onStartNewGuest,
  onSubmitCart,
  onDeleteQueuedOrder,
  recipeAvailability,
  recipes,
  settings,
  selectedRecipe,
  session,
  setGuestNameInput,
  setHostGuest,
  setPiscolaIntensity,
  setSplitMethod,
  setTipPercentage,
  piscolaIntensity,
  tableNumber,
}: UserPortalProps) {
  // Sync state via custom hook
  useMqttSync(tableNumber);

  // Custom modal dialog state
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

  const groupedByGuest = useMemo(() => {
    const map = new Map<string, DrinkOrder[]>();
    activeOrders.forEach((order) => {
      const key = order.guest_name ?? 'Mesa';
      const list = map.get(key) ?? [];
      list.push(order);
      map.set(key, list);
    });
    return [...map.entries()];
  }, [activeOrders]);

  const cartTotal = useMemo(() => {
    return cart.reduce((total, item) => total + (item.recipe.price ?? 0) * item.quantity, 0);
  }, [cart]);

  const tableSubtotal = useMemo(() => {
    return activeOrders.reduce((total, order) => {
      const r = recipes.find(rec => rec.id === order.recipe_id);
      return total + (r?.price ?? 0);
    }, 0);
  }, [activeOrders, recipes]);

  const tableTipPercentage = session?.tip_percentage ?? 0;
  const tableTipAmount = Math.round(tableSubtotal * (tableTipPercentage / 100));
  const tableTotal = tableSubtotal + tableTipAmount;

  const hostGuestName = useMemo(() => {
    return session?.guests.find((g) => g.id === session.host_guest_id)?.name ?? '';
  }, [session]);

  const selectedRecipeLabel = useMemo(() => {
    if (!selectedRecipe) return '';
    return buildCartItemLabel(
      selectedRecipe,
      getRecipeDefaultOptions(
        selectedRecipe,
        selectedRecipe.id === 'piscola' ? piscolaIntensity : 'normal'
      )
    );
  }, [piscolaIntensity, selectedRecipe]);

  const splitSettingsSection = (
    <Card style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>División de cuenta</Text>
      <Text style={styles.sectionText}>
        Elige cómo repartir el total de los pedidos en la mesa:
      </Text>
      {splitOptions.map((option) => (
        <Pressable
          key={option.id}
          style={[
            styles.selectionRow,
            session?.split_method === option.id && styles.selectionRowActive,
          ]}
          onPress={() => setSplitMethod(option.id)}
        >
          <View style={styles.selectionRowContent}>
            <Text style={styles.selectionRowTitle}>{option.title}</Text>
            <Text style={styles.selectionRowText}>{option.description}</Text>
          </View>
          <FontAwesome
            name={session?.split_method === option.id ? 'check-circle' : 'circle-o'}
            size={20}
            color={session?.split_method === option.id ? Colors.primary : Colors.textMuted}
          />
        </Pressable>
      ))}

      {session?.split_method === 'host_pays' && (
        <View style={styles.hostWrap}>
          <Text style={styles.inputLabel}>Pago total asignado</Text>
          <Text style={styles.sectionText}>
            {hostGuestName
              ? `${hostGuestName} paga toda la mesa.`
              : 'Quien active esta opción queda como pagador principal.'}
          </Text>
          {currentGuestName ? (
            <Button
              title="Ser el pagador principal"
              variant="outline"
              size="sm"
              onPress={() => {
                const me = session.guests.find((g) => g.name === currentGuestName);
                setHostGuest(me?.id);
              }}
              style={styles.hostBtn}
            />
          ) : null}
        </View>
      )}
    </Card>
  );

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow}>Portal del Cliente</Text>
          <Text style={styles.sectionTitle}>{formatTableLabel(tableNumber)}</Text>
        </View>
        <Pressable style={styles.backChip} onPress={onResetAccess}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </Pressable>
      </View>

      {!currentGuestName ? (
        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Únete a la mesa</Text>
          <Text style={styles.sectionText}>
            Ingresa tu nombre para comenzar a pedir tragos en esta mesa.
          </Text>
          <TextInput
            placeholder="Tu nombre"
            placeholderTextColor={Colors.textMuted}
            style={styles.input}
            value={guestNameInput}
            onChangeText={setGuestNameInput}
            autoCorrect={false}
          />
          <Button
            title="Entrar a la mesa"
            variant="primary"
            onPress={onJoinTable}
            style={styles.joinBtn}
          />
        </Card>
      ) : (
        <>
          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Integrantes de mesa</Text>
            <View style={styles.guestList}>
              {session?.guests.map((g) => (
                <View
                  key={g.id}
                  style={[
                    styles.guestChip,
                    g.name === currentGuestName && styles.guestChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.guestChipText,
                      g.name === currentGuestName && styles.guestChipTextActive,
                    ]}
                  >
                    {g.name}
                  </Text>
                </View>
              ))}
            </View>
            <Button
              title="Cerrar sesión / Salir"
              variant="ghost"
              size="sm"
              onPress={() => {
                showCustomDialog(
                  'Cerrar sesión',
                  '¿Estás seguro que deseas salir de esta mesa?',
                  [
                    { text: 'Cancelar', variant: 'outline' },
                    { text: 'Salir', variant: 'danger', onPress: onStartNewGuest }
                  ]
                );
              }}
              style={styles.logoutBtn}
            />
          </Card>

          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Carta de Coctelería</Text>
            <Text style={styles.sectionText}>
              Selecciona el trago para configurar su preparación y agregarlo al pedido.
            </Text>
            <DrinkGrid
              recipes={recipes}
              onSelectRecipe={onSelectRecipe}
              recipeAvailability={recipeAvailability}
              selectedRecipeId={selectedRecipe?.id}
            />

            {selectedRecipe && (
              <View style={styles.recipeConfigContainer}>
                <Text style={styles.configSubtitle}>Configuración del coctel</Text>
                <Text style={styles.configLabel}>{selectedRecipeLabel}</Text>
                {selectedRecipe.id === 'piscola' && (
                  <View style={styles.intensityRow}>
                    {(Object.keys(piscolaProfiles) as PiscolaIntensity[]).map((level) => (
                      <Pressable
                        key={level}
                        style={[
                          styles.intensityChip,
                          piscolaIntensity === level && styles.intensityChipActive,
                        ]}
                        onPress={() => setPiscolaIntensity(level)}
                      >
                        <Text
                          style={[
                            styles.intensityChipText,
                            piscolaIntensity === level && styles.intensityChipTextActive,
                          ]}
                        >
                          {piscolaProfiles[level].label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                <Button
                  title="Agregar al carrito"
                  variant="primary"
                  onPress={() => onAddCartItem(selectedRecipe, 1)}
                  style={styles.addCartBtn}
                />
              </View>
            )}
          </Card>

          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Tu pedido actual</Text>
            {cart.length === 0 ? (
              <Text style={styles.emptyCartText}>Tu carrito está vacío.</Text>
            ) : (
              cart.map((item) => (
                <View key={item.id} style={styles.cartRow}>
                  <View style={styles.cartInfo}>
                    <Text style={styles.cartTitle}>{buildCartItemLabel(item.recipe, item.options)}</Text>
                    <Text style={styles.cartCaption}>Para {currentGuestName}</Text>
                  </View>
                  <View style={styles.cartActions}>
                    <Pressable
                      style={styles.countButton}
                      onPress={() => onQuantityChange(item.id, -1)}
                    >
                      <Text style={styles.countButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.countValue}>{item.quantity}</Text>
                    <Pressable
                      style={styles.countButton}
                      onPress={() => onQuantityChange(item.id, 1)}
                    >
                      <Text style={styles.countButtonText}>+</Text>
                    </Pressable>
                    <Pressable
                      style={styles.removeButton}
                      onPress={() => onRemoveCartItem(item.id)}
                    >
                      <FontAwesome name="trash" size={16} color={Colors.error} />
                    </Pressable>
                  </View>
                </View>
              ))
            )}
            <View style={styles.totalSummary}>
              <Text style={styles.totalLabel}>Subtotal Carrito</Text>
              <Text style={styles.totalValue}>{formatCurrency(cartTotal)}</Text>
            </View>
            <Button
              title={`Enviar pedido (${cart.reduce((t, i) => t + i.quantity, 0)} tragos)`}
              variant="primary"
              disabled={cart.length === 0}
              onPress={onSubmitCart}
              style={styles.submitCartBtn}
            />
          </Card>

          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Tragos en la mesa</Text>
            {groupedByGuest.length === 0 ? (
              <Text style={styles.emptyOrdersText}>Aún no hay pedidos registrados en esta mesa.</Text>
            ) : (
              groupedByGuest.map(([gName, guestOrders]) => (
                <View key={gName} style={styles.groupCard}>
                  <Text style={styles.groupTitle}>{gName}</Text>
                  {guestOrders.map((order) => (
                    <View key={order.id} style={styles.orderRow}>
                      <View style={styles.orderRowInfo}>
                        <Text style={styles.orderTitle}>{order.recipe_name}</Text>
                        <Text style={styles.orderMeta}>{getOrderStatusLabel(order.status)}</Text>
                      </View>
                      <View style={styles.orderActions}>
                        <Text
                          style={[
                            styles.statusBadge,
                            order.status === 'ready' && styles.statusReady,
                            order.status === 'served' && styles.statusServed,
                            order.status === 'failed' && styles.statusFailed,
                          ]}
                        >
                          {order.status === 'queued' ? 'En cola' : getOrderStatusLabel(order.status)}
                        </Text>
                        {order.status === 'queued' && order.guest_name === currentGuestName && (
                          <Button
                            title="Eliminar"
                            variant="ghost"
                            size="sm"
                            onPress={() => {
                              showCustomDialog(
                                'Cancelar trago',
                                '¿Deseas quitar este trago de la cola?',
                                [
                                  { text: 'Mantener', variant: 'outline' },
                                  { text: 'Cancelar trago', variant: 'danger', onPress: () => onDeleteQueuedOrder(order) }
                                ]
                              );
                            }}
                            style={styles.deleteOrderBtn}
                            textStyle={styles.deleteOrderBtnText}
                          />
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              ))
            )}
          </Card>

          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Total y propina</Text>
            <Text style={styles.sectionText}>
              Selecciona el porcentaje de propina para la mesa:
            </Text>
            <View style={styles.intensityRow}>
              {tipPercentageOptions.map((tipOption) => (
                <Pressable
                  key={tipOption}
                  style={[
                    styles.intensityChip,
                    tableTipPercentage === tipOption && styles.intensityChipActive,
                  ]}
                  onPress={() => setTipPercentage(tipOption)}
                >
                  <Text
                    style={[
                      styles.intensityChipText,
                      tableTipPercentage === tipOption && styles.intensityChipTextActive,
                    ]}
                  >
                    {tipOption}%
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.billSummaryCard}>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownLabel}>Subtotal mesa</Text>
                <Text style={styles.summaryBreakdownValue}>{formatCurrency(tableSubtotal)}</Text>
              </View>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownLabel}>Propina ({tableTipPercentage}%)</Text>
                <Text style={styles.summaryBreakdownValue}>{formatCurrency(tableTipAmount)}</Text>
              </View>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownTotalLabel}>Total con propina</Text>
                <Text style={styles.summaryBreakdownTotalValue}>{formatCurrency(tableTotal)}</Text>
              </View>
            </View>
          </Card>

          {splitSettingsSection}
        </>
      )}

      {/* Global Dialog Component */}
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
  sectionText: {
    color: Colors.textMuted,
    lineHeight: 20,
    fontSize: 14,
    marginBottom: 16,
  },
  sectionCard: {
    marginBottom: 16,
  },
  backChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surfaceHighlight,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backChipText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1.2,
    borderColor: Colors.border,
    borderRadius: 16,
    padding: 14,
    color: Colors.text,
    fontSize: 15,
    marginBottom: 16,
  },
  joinBtn: {
    width: '100%',
  },
  logoutBtn: {
    marginTop: 12,
  },
  guestList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  guestChip: {
    backgroundColor: Colors.surfaceHighlight,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  guestChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  guestChipText: {
    color: Colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  guestChipTextActive: {
    color: Colors.primary,
    fontWeight: '700',
  },
  recipeConfigContainer: {
    marginTop: 20,
    borderTopWidth: 1.2,
    borderTopColor: Colors.border,
    paddingTop: 16,
  },
  configSubtitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    marginBottom: 8,
  },
  configLabel: {
    fontSize: 14,
    color: Colors.textMuted,
    marginBottom: 12,
  },
  intensityRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  intensityChip: {
    flex: 1,
    backgroundColor: Colors.surfaceHighlight,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  intensityChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  intensityChipText: {
    color: Colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  intensityChipTextActive: {
    color: Colors.primary,
    fontWeight: '800',
  },
  addCartBtn: {
    width: '100%',
  },
  emptyCartText: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginVertical: 16,
  },
  cartRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  cartInfo: {
    flex: 1,
    paddingRight: 12,
  },
  cartTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  cartCaption: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  cartActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  countButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  countButtonText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  countValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '800',
    minWidth: 20,
    textAlign: 'center',
  },
  removeButton: {
    padding: 8,
    marginLeft: 4,
  },
  totalSummary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 20,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '900',
    color: Colors.primary,
  },
  submitCartBtn: {
    width: '100%',
  },
  emptyOrdersText: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginVertical: 16,
  },
  groupCard: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingBottom: 8,
  },
  groupTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.secondary,
    marginBottom: 8,
  },
  orderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  orderRowInfo: {
    flex: 1,
    paddingRight: 12,
  },
  orderTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  orderMeta: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  orderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textMuted,
    backgroundColor: Colors.surfaceHighlight,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    overflow: 'hidden',
  },
  statusReady: {
    color: '#ffffff',
    backgroundColor: Colors.primary,
  },
  statusServed: {
    color: '#ffffff',
    backgroundColor: Colors.success,
  },
  statusFailed: {
    color: '#ffffff',
    backgroundColor: Colors.error,
  },
  deleteOrderBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    minHeight: 28,
  },
  deleteOrderBtnText: {
    fontSize: 11,
    color: Colors.error,
  },
  billSummaryCard: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
  },
  summaryBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryBreakdownLabel: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  summaryBreakdownValue: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  summaryBreakdownTotalLabel: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  summaryBreakdownTotalValue: {
    color: Colors.primary,
    fontSize: 16,
    fontWeight: '900',
  },
  selectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 16,
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1.2,
    borderColor: Colors.border,
    marginBottom: 10,
  },
  selectionRowActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryGlow,
  },
  selectionRowContent: {
    flex: 1,
    paddingRight: 16,
  },
  selectionRowTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 2,
  },
  selectionRowText: {
    fontSize: 11,
    color: Colors.textMuted,
    lineHeight: 15,
  },
  hostWrap: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.text,
    marginBottom: 4,
  },
  hostBtn: {
    marginTop: 8,
    width: '100%',
  },
}) as any;
