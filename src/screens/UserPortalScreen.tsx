import React, { useMemo, useState, useEffect } from 'react';
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
import {
  buildCartItemLabel,
  formatCurrency,
  getOrderDisplayName,
  getRecipeDefaultOptions,
  piscolaProfiles,
} from '../utils/drinkConfig';
import { getOrderStatusLabel, preparationSteps } from '../utils/preparation';
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
  onChangeGuestName: (newName: string) => void;
  onRequestBill: (requested: boolean) => void;
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
  onChangeGuestName,
  onRequestBill,
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

  // Name editing states
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(currentGuestName);

  useEffect(() => {
    setEditedName(currentGuestName);
  }, [currentGuestName]);

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
    return activeOrders
      .filter((order) => order.status !== 'failed')
      .reduce((total, order) => {
      const r = recipes.find(rec => rec.id === order.recipe_id);
      return total + (r?.price ?? 0);
    }, 0);
  }, [activeOrders, recipes]);

  const tableTipAmount = Math.round(tableSubtotal * 0.10); // Suggested 10%
  const tableTotal = tableSubtotal + tableTipAmount;

  const handleAskForBill = () => {
    showCustomDialog(
      'Pedir la Cuenta',
      `Subtotal consumido: ${formatCurrency(tableSubtotal)}\nPropina sugerida (10%): ${formatCurrency(tableTipAmount)}\nTotal estimado: ${formatCurrency(tableTotal)}\n\n¿Deseas solicitar la cuenta al mesero? El garzón se acercará a tu mesa para realizar el cobro y gestionar la división del pago.`,
      [
        { text: 'Cancelar', variant: 'outline' },
        {
          text: 'Pedir Cuenta',
          variant: 'primary',
          onPress: () => {
            onRequestBill(true);
            setTimeout(() => {
              showCustomDialog(
                'Solicitud enviada',
                'El garzón va en camino con tu cuenta. ¡Muchas gracias por tu visita!',
                [{ text: 'Aceptar', variant: 'primary' }]
              );
            }, 500);
          }
        }
      ]
    );
  };

  const getLiveOrderStatusLabel = (order: DrinkOrder) => {
    if (order.status === 'preparing') {
      const stepTitle = preparationSteps.find((step) => step.id === order.active_step_id)?.title;
      return `Preparando · ${stepTitle ?? 'Iniciando'}`;
    }
    if (order.status === 'queued') return 'En cola';
    return getOrderStatusLabel(order.status);
  };

  const handleSaveName = () => {
    const clean = editedName.trim();
    if (!clean) {
      showCustomDialog('Nombre requerido', 'El nombre no puede estar vacío.', [
        { text: 'Aceptar', variant: 'outline' }
      ]);
      return;
    }
    onChangeGuestName(clean);
    setIsEditingName(false);
  };

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

          {isEditingName ? (
            <View style={styles.editNameRow}>
              <TextInput
                placeholder="Nuevo nombre"
                placeholderTextColor={Colors.textMuted}
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                value={editedName}
                onChangeText={setEditedName}
                autoCorrect={false}
              />
              <Button
                title="Guardar"
                variant="primary"
                size="sm"
                onPress={handleSaveName}
                style={styles.saveNameBtn}
              />
              <Button
                title="Cancelar"
                variant="outline"
                size="sm"
                onPress={() => setIsEditingName(false)}
                style={styles.cancelNameBtn}
              />
            </View>
          ) : (
            <View style={styles.actionsNameRow}>
              <Button
                title="Cambiar mi nombre"
                variant="outline"
                size="sm"
                onPress={() => {
                  setEditedName(currentGuestName);
                  setIsEditingName(true);
                }}
                style={styles.actionNameBtn}
              />
              <Button
                title="Salir de la mesa"
                variant="ghost"
                size="sm"
                onPress={() => {
                  showCustomDialog(
                    'Salir de la mesa',
                    '¿Estás seguro que deseas salir de esta mesa?',
                    [
                      { text: 'Cancelar', variant: 'outline' },
                      { text: 'Salir', variant: 'danger', onPress: onStartNewGuest }
                    ]
                  );
                }}
                style={styles.actionNameBtn}
              />
            </View>
          )}
        </Card>
      )}

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Carta de Coctelería</Text>
        <Text style={styles.sectionText}>
          Presiona cualquier trago para agregarlo directamente a tu pedido:
        </Text>
        <DrinkGrid
          recipes={recipes}
          onSelectRecipe={(recipe) => {
            if (!currentGuestName) {
              showCustomDialog(
                'Únete a la mesa',
                'Debes ingresar tu nombre e unirte a la mesa para comenzar a pedir tragos.',
                [{ text: 'Aceptar', variant: 'primary' }]
              );
              return;
            }
            if (recipe.id === 'piscola') {
              onSelectRecipe(recipe);
            } else {
              onSelectRecipe(null);
              onAddCartItem(recipe, 1);
            }
          }}
          recipeAvailability={recipeAvailability}
          selectedRecipeId={selectedRecipe?.id}
        />

        {selectedRecipe?.id === 'piscola' && (
          <View style={styles.recipeConfigContainer}>
            <Text style={styles.configSubtitle}>¿Cómo prefieres tu Piscola?</Text>
            <Text style={styles.configLabel}>Selecciona la intensidad de la combinación:</Text>
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
            <Button
              title="Agregar Piscola al carrito"
              variant="primary"
              onPress={() => {
                if (!currentGuestName) {
                  showCustomDialog(
                    'Únete a la mesa',
                    'Debes ingresar tu nombre e unirte a la mesa para comenzar a pedir tragos.',
                    [{ text: 'Aceptar', variant: 'primary' }]
                  );
                  return;
                }
                onAddCartItem(selectedRecipe, 1);
                onSelectRecipe(null);
              }}
              style={styles.addCartBtn}
            />
          </View>
        )}
      </Card>

      {!!currentGuestName && (
        <>
          <Card style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Tu pedido actual</Text>
            {cart.length === 0 ? (
              <Text style={styles.emptyCartText}>Tu carrito está vacío. Presiona tragos en la carta para agregar.</Text>
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
                        <Text style={styles.orderTitle}>{getOrderDisplayName(order)}</Text>
                        <Text style={styles.orderMeta}>{getLiveOrderStatusLabel(order)}</Text>
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
                          {order.status === 'preparing' ? 'Preparando' : getLiveOrderStatusLabel(order)}
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

          {activeOrders.length > 0 && (
            <Card style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Total de la mesa</Text>
              <Text style={styles.sectionText}>
                Si deseas cerrar la mesa o pagar lo consumido, solicita la cuenta y el garzón vendrá a realizar el cobro.
              </Text>
              <View style={styles.billSummaryCard}>
                <View style={styles.summaryBreakdownRow}>
                  <Text style={styles.summaryBreakdownLabel}>Subtotal Consumido</Text>
                  <Text style={styles.summaryBreakdownValue}>{formatCurrency(tableSubtotal)}</Text>
                </View>
                <View style={styles.summaryBreakdownRow}>
                  <Text style={styles.summaryBreakdownLabel}>Propina sugerida (10%)</Text>
                  <Text style={styles.summaryBreakdownValue}>{formatCurrency(tableTipAmount)}</Text>
                </View>
                <View style={styles.summaryBreakdownRow}>
                  <Text style={styles.summaryBreakdownTotalLabel}>Total estimado</Text>
                  <Text style={styles.summaryBreakdownTotalValue}>{formatCurrency(tableTotal)}</Text>
                </View>
              </View>
              {session?.bill_requested ? (
                <View style={styles.billRequestedBanner}>
                  <FontAwesome name="bell" size={16} color="#c46a4a" />
                  <Text style={styles.billRequestedText}>
                    Cuenta solicitada. El garzón está en camino.
                  </Text>
                </View>
              ) : (
                <Button
                  title="Pedir la cuenta al garzón"
                  variant="primary"
                  onPress={handleAskForBill}
                  style={[styles.submitCartBtn, { marginTop: 14 }]}
                />
              )}
            </Card>
          )}
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
  guestList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
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
  editNameRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    alignItems: 'center',
  },
  saveNameBtn: {
    minHeight: 44,
    paddingHorizontal: 16,
  },
  cancelNameBtn: {
    minHeight: 44,
    paddingHorizontal: 16,
  },
  actionsNameRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  actionNameBtn: {
    flex: 1,
    minHeight: 36,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  countButtonText: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  countValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '800',
    minWidth: 24,
    textAlign: 'center',
  },
  removeButton: {
    padding: 12,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  billRequestedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#fffaf4',
    padding: 14,
    borderRadius: 16,
    marginTop: 14,
    borderWidth: 1.2,
    borderColor: '#c46a4a',
  },
  billRequestedText: {
    color: '#c46a4a',
    fontSize: 13,
    fontWeight: '800',
  },
}) as any;
