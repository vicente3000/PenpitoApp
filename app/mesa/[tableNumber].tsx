import React, { useState, useEffect, useRef } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/constants/Colors';
import { UserPortalScreen } from '../../src/screens/UserPortalScreen';
import { useRecipeStore } from '../../src/stores/RecipeStore';
import { useInventoryStore } from '../../src/stores/InventoryStore';
import { useSettingsStore } from '../../src/stores/SettingsStore';
import { useOrderStore } from '../../src/stores/OrderStore';
import { useSessionStore } from '../../src/stores/SessionStore';
import { Recipe, DrinkPreparationOptions, PiscolaIntensity } from '../../src/models';
import { getRecipeDefaultOptions } from '../../src/utils/drinkConfig';
import { Dialog, DialogAction } from '../../src/components/ui/Dialog';

export default function TableRoute() {
  const { tableNumber: tableNumberParam } = useLocalSearchParams();
  const tableNumber = parseInt(String(tableNumberParam), 10);

  const submittingRef = useRef(false);
  const { recipes } = useRecipeStore();
  const { inventory, recipeIsAvailable, consumeForRecipe } = useInventoryStore();
  const { settings } = useSettingsStore();
  const { orders, createOrderBatch, deleteOrder } = useOrderStore();
  const {
    sessions,
    ensureTableSession,
    joinTable,
    setHostGuest,
    setSplitMethod,
    setTipPercentage,
    deviceGuestName,
    setDeviceGuestName,
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
    const session = ensureTableSession(tableNumber, `PENPITO:MESA:${String(tableNumber).padStart(2, '0')}`);
    
    if (deviceGuestName) {
      const cleanName = deviceGuestName.trim();
      const existingGuest = session.guests.find(
        (g) => g.name.trim().toLowerCase() === cleanName.toLowerCase()
      );
      if (existingGuest) {
        setCurrentGuestId(existingGuest.id);
        setGuestNameInput(existingGuest.name);
      } else {
        const guest = joinTable(tableNumber, session.qr_value, cleanName);
        setCurrentGuestId(guest.id);
        setGuestNameInput(guest.name);
      }
    } else {
      setCurrentGuestId(null);
      setGuestNameInput('');
    }
  }, [tableNumber, deviceGuestName]);

  const handleJoinTable = () => {
    if (!guestNameInput.trim()) {
      showCustomDialog('Nombre requerido', 'Por favor ingresa tu nombre.', [
        { text: 'Aceptar', variant: 'primary' }
      ]);
      return;
    }
    const session = ensureTableSession(tableNumber, `PENPITO:MESA:${String(tableNumber).padStart(2, '0')}`);
    const guest = joinTable(tableNumber, session.qr_value, guestNameInput);
    setCurrentGuestId(guest.id);
    void setDeviceGuestName(guest.name);
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

    showCustomDialog(
      'Confirmar pedido',
      `Vas a enviar ${cart.reduce((total, item) => total + item.quantity, 0)} tragos a tu mesa.`,
      [
        { text: 'Cancelar', variant: 'outline' },
        {
          text: 'Pedir tragos',
          variant: 'primary',
          onPress: async () => {
            await createOrderBatch({
              items: cart.map((item) => ({
                recipe: item.recipe,
                options: item.options,
                quantity: item.quantity,
                guest_name: currentGuest.name,
              })),
              table_number: tableNumber,
              qr_value: `PENPITO:MESA:${String(tableNumber).padStart(2, '0')}`,
              split_method: activeTableSession.split_method,
              group_id: `table-${tableNumber}-${Date.now()}`,
            });

            for (const item of cart) {
              for (let index = 0; index < item.quantity; index += 1) {
                await consumeForRecipe(item.recipe, item.options);
              }
            }

            setCart([]);
            setTimeout(() => {
              showCustomDialog('Pedido enviado', 'Tus tragos han sido agregados a la mesa.', [
                { text: 'Aceptar', variant: 'primary' }
              ]);
            }, 500);
          },
        },
      ]
    );
  };

  const handleResetAccess = () => {
    router.replace('/' as any);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <UserPortalScreen
        activeOrders={orders.filter((o) => o.table_number === tableNumber)}
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
        onDeleteQueuedOrder={(order) => deleteOrder(order.id)}
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
