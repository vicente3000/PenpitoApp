import React, { useState, useEffect, useRef } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/constants/Colors';
import { UserPortalScreen } from '../../src/screens/UserPortalScreen';
import { useRecipeStore } from '../../src/stores/RecipeStore';
import { useInventoryStore } from '../../src/stores/InventoryStore';
import { useSettingsStore } from '../../src/stores/SettingsStore';
import { useSessionStore } from '../../src/stores/SessionStore';
import { Recipe, DrinkPreparationOptions, PiscolaIntensity } from '../../src/models';
import { getRecipeDefaultOptions, getRecipeUsageMl } from '../../src/utils/drinkConfig';
import { Button } from '../../src/components/ui/Button';
import { Dialog, DialogAction } from '../../src/components/ui/Dialog';
import { getDeviceId } from '../../src/services/DeviceIdentityService';
import {
  useTableOrders,
  useOrderActions,
} from '../../src/hooks/useOrderStoreV2';

export default function TableRoute() {
  const { tableNumber: tableNumberParam } = useLocalSearchParams();
  const tableNumber = parseInt(String(tableNumberParam), 10);

  const submittingRef = useRef(false);
  const { recipes } = useRecipeStore();
  const { inventory, recipeIsAvailable } = useInventoryStore();
  const { settings } = useSettingsStore();
  const orders = useTableOrders(tableNumber);
  const { submitOrder, cancelOrder } = useOrderActions();
  const {
    sessions,
    ensureTableSession,
    joinTable,
    setHostGuest,
    setSplitMethod,
    setTipPercentage,
    deviceGuestName,
    setDeviceGuestName,
    deviceTableNumber,
    setDeviceTableNumber,
  } = useSessionStore();

  const [guestNameInput, setGuestNameInput] = useState('');
  const [currentGuestId, setCurrentGuestId] = useState<string | null>(null);
  const [cart, setCart] = useState<{ id: string; recipe: Recipe; options: DrinkPreparationOptions; quantity: number }[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [piscolaIntensity, setPiscolaIntensity] = useState<PiscolaIntensity>('normal');

  // Custom dialogs state
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

  const activeTableSession = sessions.find((s) => s.table_number === tableNumber) || null;
  const currentGuest = activeTableSession?.guests.find((g) => g.id === currentGuestId) || null;
  const currentGuestName = currentGuest?.name ?? '';

  // Autologin guest if already stored
  useEffect(() => {
    if (isNaN(tableNumber)) return;

    void setDeviceTableNumber(tableNumber);
    const sessionQr = `PENPITO:MESA:${String(tableNumber).padStart(2, '0')}`;
    const session = ensureTableSession(tableNumber, sessionQr);

    if (deviceGuestName) {
      const cleanName = deviceGuestName.trim();
      const deviceId = useSessionStore.getState().deviceId;

      const existingByDevice = deviceId
        ? session.guests.find((g) => g.device_id === deviceId)
        : undefined;

      if (existingByDevice) {
        setCurrentGuestId(existingByDevice.id);
        setGuestNameInput(existingByDevice.name);
        return;
      }

      const existingByName = session.guests.find(
        (g) => g.name.trim().toLowerCase() === cleanName.toLowerCase()
      );

      if (existingByName && !existingByName.device_id) {
        setCurrentGuestId(existingByName.id);
        setGuestNameInput(existingByName.name);
      } else if (!existingByName) {
        void (async () => {
          const guest = await joinTable(tableNumber, sessionQr, cleanName);
          setCurrentGuestId(guest.id);
          setGuestNameInput(guest.name);
        })();
      } else {
        setCurrentGuestId(null);
        setGuestNameInput('');
      }
    } else {
      setCurrentGuestId(null);
      setGuestNameInput('');
    }
  }, [tableNumber, deviceGuestName]);

  const wasOnThisTable = deviceTableNumber === tableNumber;
  const sessionExists = sessions.some((s) => s.table_number === tableNumber);

  useEffect(() => {
    if (!deviceGuestName || !wasOnThisTable || sessionExists) return;

    void setDeviceGuestName(null);
    setCurrentGuestId(null);
    setGuestNameInput('');
    setCart([]);

    const title = 'Mesa pagada';
    const msg = 'La cuenta de esta mesa ha sido pagada. Tu sesion ha finalizado.';

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(msg);
      router.replace('/' as any);
    } else {
      Alert.alert(title, msg, [
        { text: 'Aceptar', onPress: () => router.replace('/' as any) }
      ]);
    }
  }, [sessionExists, deviceGuestName, wasOnThisTable]);

  const handleJoinTable = async () => {
    if (!guestNameInput.trim()) {
      showCustomDialog('Nombre requerido', 'Por favor ingresa tu nombre.', [
        { text: 'Aceptar', variant: 'primary' }
      ]);
      return;
    }
    const session = ensureTableSession(tableNumber, `PENPITO:MESA:${String(tableNumber).padStart(2, '0')}`);
    const guest = await joinTable(tableNumber, session.qr_value, guestNameInput);
    setCurrentGuestId(guest.id);
    void setDeviceGuestName(guest.name);
    void setDeviceTableNumber(tableNumber);
  };

  const handleStartNewGuest = () => {
    void setDeviceGuestName(null);
    setCurrentGuestId(null);
    setGuestNameInput('');
    setCart([]);
  };

  const handleChangeGuestName = (newName: string) => {
    if (!currentGuestId) return;
    const cleanName = newName.trim();
    if (!cleanName) return;
    useSessionStore.getState().changeGuestName(tableNumber, currentGuestId, cleanName);
    void setDeviceGuestName(cleanName);
    setGuestNameInput(cleanName);
  };

  const handleAddCartItem = (recipe: Recipe, quantity: number) => {
    const defaultOpts = getRecipeDefaultOptions(recipe, recipe.id === 'piscola' ? piscolaIntensity : 'normal');
    const existing = cart.find(
      (item) => item.recipe.id === recipe.id && JSON.stringify(item.options) === JSON.stringify(defaultOpts)
    );

    if (existing) {
      setCart((current) =>
        current.map((item) =>
          item.id === existing.id ? { ...item, quantity: item.quantity + quantity } : item
        )
      );
    } else {
      setCart((current) => [
        ...current,
        {
          id: `${recipe.id}-${Date.now()}`,
          recipe,
          options: defaultOpts,
          quantity,
        },
      ]);
    }
    setSelectedRecipe(null);
  };

  const handleSubmitCart = async () => {
    if (!activeTableSession || !currentGuest) return;

    if (cart.length === 0) return;

    const unavailable = cart.find((item) => !recipeIsAvailable(item.recipe, item.options));
    if (unavailable) {
      showCustomDialog(
        'Trago no disponible',
        `${unavailable.recipe.name} ya no tiene suficiente stock en este momento.`,
        [{ text: 'Aceptar', variant: 'outline' }]
      );
      return;
    }

    const totalUsages: Record<string, number> = {};
    for (const item of cart) {
      const usages = getRecipeUsageMl(item.recipe, item.options);
      for (const u of usages) {
        totalUsages[u.ingredient_name] = (totalUsages[u.ingredient_name] || 0) + u.amount_ml * item.quantity;
      }
    }

    for (const [ingName, totalNeeded] of Object.entries(totalUsages)) {
      const bottle = inventory.find((b) => b.ingredient_name === ingName);
      if (!bottle || bottle.remaining_ml < totalNeeded) {
        const available = bottle ? Math.round(bottle.remaining_ml) : 0;
        showCustomDialog(
          'Stock insuficiente en carrito',
          `El total de tu pedido requiere ${Math.round(totalNeeded)}ml de ${ingName}, pero solo quedan ${available}ml en la máquina. Por favor reduce las cantidades.`,
          [{ text: 'Entendido', variant: 'outline' }]
        );
        return;
      }
    }

    showCustomDialog(
      'Confirmar pedido',
      `Vas a enviar ${cart.reduce((total, item) => total + item.quantity, 0)} tragos a tu mesa.`,
      [
        { text: 'Cancelar', variant: 'outline' },
        {
          text: 'Pedir tragos',
          variant: 'primary',
          onPress: async () => {
            if (submittingRef.current) return;
            submittingRef.current = true;
            try {
              const groupId = `table-${tableNumber}-${Date.now()}`;
              for (const item of cart) {
                for (let q = 0; q < item.quantity; q++) {
                  await submitOrder({
                    tableId: tableNumber,
                    recipeId: item.recipe.id,
                    guestName: currentGuest.name,
                    groupId,
                    options: {
                      iceCount: item.options.iceCount ?? 0,
                      alcoholOz: item.options.alcoholOz,
                      mixerOz: item.options.mixerOz,
                      piscolaIntensity: item.options.piscolaIntensity,
                    },
                  });
                }
              }

              setCart([]);
              setTimeout(() => {
                showCustomDialog('Pedido enviado', 'Tus tragos han sido agregados a la mesa.', [
                  { text: 'Aceptar', variant: 'primary' }
                ]);
              }, 500);
            } catch (err) {
              showCustomDialog('Error al enviar', String(err), [
                { text: 'Aceptar', variant: 'outline' }
              ]);
            } finally {
              submittingRef.current = false;
            }
          },
        },
      ]
    );
  };

  const handleResetAccess = () => {
    router.replace('/' as any);
  };

  if (isNaN(tableNumber) || tableNumber <= 0) {
    return (
      <SafeAreaView style={[styles.safeArea, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <Text style={{ fontSize: 18, fontWeight: 'bold', color: Colors.text, marginBottom: 8 }}>Mesa no válida</Text>
        <Text style={{ fontSize: 14, color: Colors.textMuted, textAlign: 'center', marginBottom: 20 }}>
          El número de mesa especificado no existe o es inválido. Por favor escanea un código QR válido.
        </Text>
        <Button title="Volver al inicio" variant="primary" onPress={() => router.replace('/' as any)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <UserPortalScreen
        activeOrders={orders}
        cart={cart}
        currentGuestName={currentGuestName}
        guestNameInput={guestNameInput}
        onResetAccess={handleResetAccess}
        onAddCartItem={handleAddCartItem}
        onJoinTable={handleJoinTable}
        onQuantityChange={(cartId, delta) => {
          setCart((c) =>
            c.map((item) => (item.id === cartId ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item))
          );
        }}
        onRemoveCartItem={(cartId) => {
          setCart((c) => c.filter((item) => item.id !== cartId));
        }}
        onSelectRecipe={setSelectedRecipe}
        onSelectGuest={(guestId) => {
          const guest = activeTableSession?.guests.find((g) => g.id === guestId);
          setCurrentGuestId(guestId);
          setGuestNameInput(guest?.name ?? '');
          setCart([]);
        }}
        onStartNewGuest={handleStartNewGuest}
        onSubmitCart={handleSubmitCart}
        onDeleteQueuedOrder={(order) => {
          void cancelOrder(tableNumber, order.id);
        }}
        onChangeGuestName={handleChangeGuestName}
        onRequestBill={(requested) => useSessionStore.getState().requestBill(tableNumber, requested)}
        recipeAvailability={(recipe) =>
          recipeIsAvailable(recipe, getRecipeDefaultOptions(recipe, recipe.id === 'piscola' ? piscolaIntensity : 'normal'))
        }
        recipes={recipes}
        settings={settings}
        selectedRecipe={selectedRecipe}
        session={activeTableSession}
        setGuestNameInput={setGuestNameInput}
        setHostGuest={(guestId) => setHostGuest(tableNumber, guestId)}
        setPiscolaIntensity={setPiscolaIntensity}
        setSplitMethod={(method) => setSplitMethod(tableNumber, method)}
        setTipPercentage={(tip) => setTipPercentage(tableNumber, tip)}
        piscolaIntensity={piscolaIntensity}
        tableNumber={tableNumber}
      />

      {/* Global Dialog */}
      <Dialog
        visible={dialogVisible}
        title={dialogConfig.title}
        message={dialogConfig.message}
        actions={dialogConfig.actions}
        onClose={() => setDialogVisible(false)}
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
