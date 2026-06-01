import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PreparationTimeline } from '../components/PreparationTimeline';
import { Colors, Shadows } from '../constants/Colors';
import {
  AppEntryQr,
  BillSplitMethod,
  BottleInventory,
  DrinkOrder,
  DrinkPreparationOptions,
  MachineState,
  PiscolaIntensity,
  Recipe,
  SessionGuest,
  TableSession,
} from '../models';
import { useAppStore } from '../stores/AppStore';
import { useInventoryStore } from '../stores/InventoryStore';
import { useOrderStore } from '../stores/OrderStore';
import { useRecipeStore } from '../stores/RecipeStore';
import { useSessionStore } from '../stores/SessionStore';
import { useSettingsStore } from '../stores/SettingsStore';
import { formatMl, getDefaultIceCount, piscolaProfiles } from '../utils/drinkConfig';
import { getOrderStatusLabel } from '../utils/preparation';
import {
  formatTableLabel,
  parseAccessQr,
} from '../utils/tableQr';

type CartItem = {
  id: string;
  recipe: Recipe;
  options: DrinkPreparationOptions;
  quantity: number;
};

type SplitOption = {
  id: BillSplitMethod;
  title: string;
  description: string;
};

const splitOptions: SplitOption[] = [
  {
    id: 'pay_own',
    title: 'Cada uno paga lo suyo',
    description: 'Es la forma mas comun para cuentas itemizadas por persona o asiento.',
  },
  {
    id: 'equal_split',
    title: 'Dividir en partes iguales',
    description: 'Se reparte el total en partes iguales entre quienes participan de la mesa.',
  },
  {
    id: 'host_pays',
    title: 'Una persona paga todo',
    description: 'Una sola persona asume el total de la mesa y luego puede cobrar aparte.',
  },
];

const tipPercentageOptions = [0, 10, 15, 20];

function formatTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '';
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRecipeDefaultOptions(recipe: Recipe, intensity: PiscolaIntensity = 'normal'): DrinkPreparationOptions {
  if (recipe.id !== 'piscola') {
    return {
      iceCount: getDefaultIceCount(recipe.id),
    };
  }

  const profile = piscolaProfiles[intensity];
  return {
    iceCount: profile.defaultIceCount,
    alcoholOz: profile.alcoholOz,
    mixerOz: profile.mixerOz,
    piscolaIntensity: intensity,
  };
}

function buildCartItemLabel(recipe: Recipe, options: DrinkPreparationOptions) {
  if (recipe.id !== 'piscola') {
    return recipe.name;
  }

  const intensity = options.piscolaIntensity ?? 'normal';
  return `${recipe.name} ${piscolaProfiles[intensity].label}`;
}

function getDrinkCardImage(recipeId: string): ImageSourcePropType | null {
  switch (recipeId) {
    case 'piscola':
      return require('../../assets/images/drink-piscola-carousel.png');
    case 'whisky_rocks':
      return require('../../assets/images/drink-whisky-carousel.png');
    case 'negroni':
      return require('../../assets/images/drink-negroni-carousel.png');
    case 'gin_tonic':
      return require('../../assets/images/drink-gin-tonic-carousel.png');
    default:
      return null;
  }
}

function getRecipePrice(recipeId: string, settings: {
  piscola_price: number;
  whisky_rocks_price: number;
  negroni_price: number;
  gin_tonic_price: number;
}) {
  switch (recipeId) {
    case 'piscola':
      return settings.piscola_price;
    case 'whisky_rocks':
      return settings.whisky_rocks_price;
    case 'negroni':
      return settings.negroni_price;
    case 'gin_tonic':
      return settings.gin_tonic_price;
    default:
      return 0;
  }
}

function formatCurrency(amount: number) {
  return `$${amount.toLocaleString('es-CL')}`;
}

function getTipAmount(subtotal: number, tipPercentage: number) {
  return Math.round(subtotal * (tipPercentage / 100));
}

function getStatusAccent(status: DrinkOrder['status']) {
  if (status === 'ready') {
    return styles.statusReady;
  }
  if (status === 'served') {
    return styles.statusServed;
  }
  if (status === 'failed') {
    return styles.statusFailed;
  }
  return styles.statusQueued;
}

export function MainAppScreen() {
  const { machineState, isConnected } = useAppStore();
  const machineIsAvailable = isConnected || machineState.isOn;
  const { recipes, isLoading: recipesLoading } = useRecipeStore();
  const {
    inventory,
    isLoading: inventoryLoading,
    consumeForRecipe,
    refillBottle,
    recipeIsAvailable,
    restoreForRecipe,
    updateBottleCapacity,
  } = useInventoryStore();
  const { settings, updateSettings, isLoading: settingsLoading } = useSettingsStore();
  const {
    orders,
    createOrderBatch,
    deleteOrder,
    markOrderServed,
    clearTableOrders,
    isLoading: ordersLoading,
  } = useOrderStore();
  const {
    sessions,
    ensureTableSession,
    joinTable,
    setHostGuest,
    setSplitMethod,
    setTipPercentage,
    removeGuestFromTable,
    clearTableSession,
  } = useSessionStore();

  const [activeEntry, setActiveEntry] = useState<AppEntryQr | null>(null);
  const [guestNameInput, setGuestNameInput] = useState('');
  const [currentGuestId, setCurrentGuestId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [piscolaIntensity, setPiscolaIntensity] = useState<PiscolaIntensity>('normal');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminError, setAdminError] = useState('');
  const [bottleCapacityMl, setBottleCapacityMl] = useState('');
  const [dispenseSpeedMlS, setDispenseSpeedMlS] = useState('');
  const [iceDispenseTimeS, setIceDispenseTimeS] = useState('');
  const [autoCleanEnabled, setAutoCleanEnabled] = useState(true);
  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [inventoryFeedback, setInventoryFeedback] = useState('');
  const [bottleCapacityInputs, setBottleCapacityInputs] = useState<Record<string, string>>({});
  const [piscolaPrice, setPiscolaPrice] = useState('');
  const [whiskyPrice, setWhiskyPrice] = useState('');
  const [negroniPrice, setNegroniPrice] = useState('');
  const [ginTonicPrice, setGinTonicPrice] = useState('');

  useEffect(() => {
    if (!settings) {
      return;
    }

    setBottleCapacityMl(String(settings.bottle_capacity_ml));
    setDispenseSpeedMlS(String(settings.dispense_speed_ml_s));
    setIceDispenseTimeS(String(settings.ice_dispense_time_s));
    setAutoCleanEnabled(settings.auto_clean_enabled);
    setPiscolaPrice(String(settings.piscola_price));
    setWhiskyPrice(String(settings.whisky_rocks_price));
    setNegroniPrice(String(settings.negroni_price));
    setGinTonicPrice(String(settings.gin_tonic_price));
  }, [settings]);

  useEffect(() => {
    setBottleCapacityInputs((current) => {
      const nextInputs: Record<string, string> = {};
      inventory.forEach((bottle) => {
        nextInputs[bottle.id] = current[bottle.id] ?? String(Math.round(bottle.capacity_ml));
      });
      return nextInputs;
    });
  }, [inventory]);

  useEffect(() => {
    if (activeEntry?.type !== 'table') {
      setCurrentGuestId(null);
      setGuestNameInput('');
      setCart([]);
      setSelectedRecipeId(null);
      setPiscolaIntensity('normal');
      return;
    }

    ensureTableSession(activeEntry.table_number, activeEntry.qr_value);
  }, [activeEntry, ensureTableSession]);

  const selectedRecipe = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedRecipeId) ?? null,
    [recipes, selectedRecipeId]
  );

  const activeTableSession = useMemo(() => {
    if (activeEntry?.type !== 'table') {
      return null;
    }

    const session =
      sessions.find((entry) => entry.table_number === activeEntry.table_number) ?? {
        table_number: activeEntry.table_number,
        qr_value: activeEntry.qr_value,
        guests: [],
        split_method: 'pay_own' as BillSplitMethod,
        host_guest_id: undefined,
        tip_percentage: 0,
      };
    const knownNames = new Set(session.guests.map((guest) => guest.name.trim().toLowerCase()));
    const guestsFromOrders = orders
      .filter((order) => order.table_number === activeEntry.table_number && order.guest_name)
      .reduce<SessionGuest[]>((guests, order) => {
        const guestName = order.guest_name?.trim();
        if (!guestName || knownNames.has(guestName.toLowerCase())) {
          return guests;
        }

        knownNames.add(guestName.toLowerCase());
        guests.push({
          id: `order-guest-${activeEntry.table_number}-${guestName.toLowerCase().replace(/\s+/g, '-')}`,
          name: guestName,
          joined_at: order.requested_at,
        });
        return guests;
      }, []);

    return {
      ...session,
      guests: [...session.guests, ...guestsFromOrders],
    };
  }, [activeEntry, orders, sessions]);

  const currentGuest = useMemo(
    () => activeTableSession?.guests.find((guest) => guest.id === currentGuestId) ?? null,
    [activeTableSession, currentGuestId]
  );

  const ordersByTable = useMemo(() => {
    const grouped = new Map<number, DrinkOrder[]>();
    orders.forEach((order) => {
      const current = grouped.get(order.table_number) ?? [];
      current.push(order);
      grouped.set(order.table_number, current);
    });
    return grouped;
  }, [orders]);

  const readyOrders = useMemo(() => orders.filter((order) => order.status === 'ready'), [orders]);
  const queuedOrders = useMemo(() => orders.filter((order) => order.status === 'queued'), [orders]);
  const servedOrders = useMemo(() => orders.filter((order) => order.status === 'served'), [orders]);
  const preparingOrders = useMemo(() => orders.filter((order) => order.status === 'preparing'), [orders]);

  const isBootLoading =
    recipesLoading ||
    settingsLoading ||
    inventoryLoading ||
    ordersLoading ||
    !settings;

  const handleEntryResolved = (entry: AppEntryQr) => {
    setActiveEntry(entry);
    setAdminUnlocked(false);
    setAdminPassword('');
    setAdminError('');
  };

  const resetAccessToScanner = () => {
    setActiveEntry(null);
    setAdminUnlocked(false);
    setAdminPassword('');
    setAdminError('');
  };

  const confirmResetAccess = (message?: string) => {
    Alert.alert(
      'Volver al inicio',
      message ?? 'Esta seguro que desea salir y escanear otro QR?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Salir',
          style: 'destructive',
          onPress: resetAccessToScanner,
        },
      ]
    );
  };

  const handleJoinTable = () => {
    if (activeEntry?.type !== 'table') {
      return;
    }

    const cleanName = guestNameInput.trim();
    if (!cleanName) {
      Alert.alert('Nombre faltante', 'Ingresa tu nombre para asociar tus tragos a la mesa.');
      return;
    }

    const guest = joinTable(activeEntry.table_number, activeEntry.qr_value, cleanName);
    setCurrentGuestId(guest.id);
    setGuestNameInput(guest.name);
  };

  const handleAddCartItem = (recipe: Recipe, quantity: number) => {
    const cleanQuantity = Math.max(1, Math.round(quantity));
    const options = getRecipeDefaultOptions(
      recipe,
      recipe.id === 'piscola' ? piscolaIntensity : 'normal'
    );

    if (!recipe) {
      return;
    }

    const optionKey = JSON.stringify(options);

    setCart((current) => {
      const existingItem = current.find(
        (item) => item.recipe.id === recipe.id && JSON.stringify(item.options) === optionKey
      );

      if (existingItem) {
        return current.map((item) =>
          item.id === existingItem.id
            ? { ...item, quantity: item.quantity + cleanQuantity }
            : item
        );
      }

      return [
        ...current,
        {
          id: `${recipe.id}-${Date.now()}`,
          recipe,
          options,
          quantity: cleanQuantity,
        },
      ];
    });
  };

  const handleSubmitCart = async () => {
    if (!activeEntry || activeEntry.type !== 'table' || !activeTableSession || !currentGuest) {
      return;
    }

    if (!isConnected) {
      Alert.alert('Sistema iniciando', 'La barra todavia no esta lista para recibir pedidos.');
      return;
    }

    if (!machineIsAvailable) {
      Alert.alert('Barra no disponible', 'Espera un momento antes de enviar el pedido.');
      return;
    }

    if (cart.length === 0) {
      return;
    }

    const unavailable = cart.find(
      (item) => !recipeIsAvailable(item.recipe, item.options)
    );

    if (unavailable) {
      Alert.alert('Trago no disponible', `${unavailable.recipe.name} ya no tiene stock suficiente.`);
      return;
    }

    Alert.alert(
      'Confirmar pedido',
      `Vas a enviar ${cart.reduce((total, item) => total + item.quantity, 0)} tragos para ${formatTableLabel(
        activeEntry.table_number
      )}.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Realizar pedido',
          onPress: () => {
            void (async () => {
              await createOrderBatch({
                items: cart.map((item) => ({
                  recipe: item.recipe,
                  options: item.options,
                  quantity: item.quantity,
                  guest_name: currentGuest.name,
                })),
                table_number: activeEntry.table_number,
                qr_value: activeEntry.qr_value,
                split_method: activeTableSession.split_method,
                group_id: `table-${activeEntry.table_number}-${Date.now()}`,
              });

              for (const item of cart) {
                for (let index = 0; index < item.quantity; index += 1) {
                  await consumeForRecipe(item.recipe, item.options);
                }
              }

              setCart([]);
              Alert.alert('Pedido enviado', 'Tus tragos quedaron cargados para la mesa.');
            })();
          },
        },
      ]
    );
  };

  const getOrderOptions = (order: DrinkOrder): DrinkPreparationOptions => ({
    iceCount: order.ice_count,
    alcoholOz: order.alcohol_oz,
    mixerOz: order.mixer_oz,
    piscolaIntensity: order.piscola_intensity,
  });

  const handleDeleteOrder = (order: DrinkOrder, options: { queuedOnly?: boolean } = {}) => {
    if (order.status === 'preparing') {
      Alert.alert('Pedido en preparacion', 'No se puede eliminar un pedido que ya esta preparando la maquina.');
      return;
    }

    if (options.queuedOnly && order.status !== 'queued') {
      Alert.alert('Pedido no eliminable', 'Solo puedes eliminar pedidos que siguen en cola.');
      return;
    }

    Alert.alert('Eliminar pedido', `Quieres eliminar ${order.recipe_name}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const removedOrder = await deleteOrder(order.id);
            if (!removedOrder) {
              Alert.alert('No se pudo eliminar', 'El pedido ya esta en preparacion o no existe.');
              return;
            }

            if (removedOrder.status === 'queued') {
              const recipe = recipes.find((entry) => entry.id === removedOrder.recipe_id);
              if (recipe) {
                await restoreForRecipe(recipe, getOrderOptions(removedOrder));
              }
            }
          })();
        },
      }
    ]);
  };

  const handleSaveBottleCapacity = async (bottleId: string) => {
    const nextCapacity = Number(bottleCapacityInputs[bottleId]);
    if (!Number.isFinite(nextCapacity) || nextCapacity <= 0) {
      setInventoryFeedback('La capacidad de la botella debe ser mayor a 0 ml.');
      return;
    }

    await updateBottleCapacity(bottleId, Math.round(nextCapacity));
    setInventoryFeedback('Capacidad de botella actualizada.');
  };

  const handleAdminLogin = () => {
    if (adminPassword !== 'admin123') {
      setAdminError('Contrasena incorrecta.');
      return;
    }

    setAdminError('');
    setAdminUnlocked(true);
  };

  const handleSaveSettings = async () => {
    const nextBottleCapacity = Number(bottleCapacityMl);
    const nextDispenseSpeed = Number(dispenseSpeedMlS);
    const nextIceTime = Number(iceDispenseTimeS);
    const nextPiscolaPrice = Number(piscolaPrice);
    const nextWhiskyPrice = Number(whiskyPrice);
    const nextNegroniPrice = Number(negroniPrice);
    const nextGinTonicPrice = Number(ginTonicPrice);

    if (
      !Number.isFinite(nextBottleCapacity) ||
      !Number.isFinite(nextDispenseSpeed) ||
      !Number.isFinite(nextIceTime) ||
      !Number.isFinite(nextPiscolaPrice) ||
      !Number.isFinite(nextWhiskyPrice) ||
      !Number.isFinite(nextNegroniPrice) ||
      !Number.isFinite(nextGinTonicPrice) ||
      nextBottleCapacity <= 0 ||
      nextDispenseSpeed <= 0 ||
      nextIceTime <= 0 ||
      nextPiscolaPrice <= 0 ||
      nextWhiskyPrice <= 0 ||
      nextNegroniPrice <= 0 ||
      nextGinTonicPrice <= 0
    ) {
      setSettingsFeedback('Revisa parametros y precios. Todos deben ser mayores a 0.');
      return;
    }

    const nextSettings = {
      bottle_capacity_ml: Math.round(nextBottleCapacity),
      dispense_speed_ml_s: Number(nextDispenseSpeed.toFixed(1)),
      ice_dispense_time_s: Math.round(nextIceTime),
      auto_clean_enabled: autoCleanEnabled,
      piscola_price: Math.round(nextPiscolaPrice),
      whisky_rocks_price: Math.round(nextWhiskyPrice),
      negroni_price: Math.round(nextNegroniPrice),
      gin_tonic_price: Math.round(nextGinTonicPrice),
    };

    await updateSettings(nextSettings);
    setSettingsFeedback('Parametros guardados.');
  };

  if (isBootLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loaderText}>Preparando la carta...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!activeEntry) {
    return <EntryScannerScreen onResolved={handleEntryResolved} />;
  }

  if (activeEntry.type === 'waiter') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <WaiterScreen
          clearTableSession={(tableNumber) => {
            clearTableSession(tableNumber);
          }}
          clearTableOrders={(tableNumber) => {
            void clearTableOrders(tableNumber);
          }}
          onResetAccess={() => confirmResetAccess()}
          ordersByTable={ordersByTable}
          onMarkServed={(orderId) => {
            void markOrderServed(orderId);
          }}
          onDeleteOrder={(order) => handleDeleteOrder(order)}
          readyOrdersCount={readyOrders.length}
          queuedOrdersCount={queuedOrders.length}
          sessions={sessions}
          settings={settings}
          onRemoveGuest={(tableNumber, guest) => {
            const guestOrders = orders.filter(
              (order) => order.table_number === tableNumber && order.guest_name === guest.name
            );
            const hasActiveOrders = guestOrders.some((order) =>
              ['queued', 'preparing', 'ready'].includes(order.status)
            );

            if (hasActiveOrders) {
              Alert.alert(
                'Persona con pedidos activos',
                'No puedes sacar a esta persona mientras tenga pedidos en cola, en preparacion o listos. Cancela o sirve esos pedidos primero.'
              );
              return;
            }

            Alert.alert('Sacar persona', `Quieres sacar a ${guest.name} de ${formatTableLabel(tableNumber)}?`, [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Sacar',
                style: 'destructive',
                onPress: () => removeGuestFromTable(tableNumber, guest.id),
              },
            ]);
          }}
        />
      </SafeAreaView>
    );
  }

  if (activeEntry.type === 'admin') {
    return (
      <SafeAreaView style={styles.safeArea}>
        {!adminUnlocked ? (
          <AdminLoginScreen
            adminError={adminError}
            adminPassword={adminPassword}
            onBack={() => confirmResetAccess()}
            onLogin={handleAdminLogin}
            setAdminPassword={setAdminPassword}
          />
        ) : (
          <AdminScreen
            autoCleanEnabled={autoCleanEnabled}
            bottleCapacityMl={bottleCapacityMl}
            dispenseSpeedMlS={dispenseSpeedMlS}
            iceDispenseTimeS={iceDispenseTimeS}
            inventory={inventory}
            isConnected={isConnected}
            machineState={machineState}
            settings={settings}
            onBack={() => confirmResetAccess()}
            onMarkServed={(orderId) => {
              void markOrderServed(orderId);
            }}
            onRefillBottle={(bottleId) => {
              void refillBottle(bottleId);
            }}
            onSaveBottleCapacity={(bottleId) => {
              void handleSaveBottleCapacity(bottleId);
            }}
            onSaveSettings={() => {
              void handleSaveSettings();
            }}
            orders={orders}
            readyOrders={readyOrders}
            servedOrdersCount={servedOrders.length}
            preparingOrders={preparingOrders}
            setAutoCleanEnabled={setAutoCleanEnabled}
            setBottleCapacityMl={setBottleCapacityMl}
            setBottleCapacityInput={(bottleId, value) =>
              setBottleCapacityInputs((current) => ({ ...current, [bottleId]: value }))
            }
            setDispenseSpeedMlS={setDispenseSpeedMlS}
            setIceDispenseTimeS={setIceDispenseTimeS}
            setPiscolaPrice={setPiscolaPrice}
            setWhiskyPrice={setWhiskyPrice}
            setNegroniPrice={setNegroniPrice}
            setGinTonicPrice={setGinTonicPrice}
            settingsFeedback={settingsFeedback}
            inventoryFeedback={inventoryFeedback}
            bottleCapacityInputs={bottleCapacityInputs}
            piscolaPrice={piscolaPrice}
            whiskyPrice={whiskyPrice}
            negroniPrice={negroniPrice}
            ginTonicPrice={ginTonicPrice}
          />
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <UserPortalScreen
        activeOrders={orders.filter((order) => order.table_number === activeEntry.table_number)}
        cart={cart}
        currentGuestName={currentGuest?.name ?? ''}
        onResetAccess={() => {
          const activeTableOrders = orders.filter(
            (order) => order.table_number === activeEntry.table_number && order.status !== 'failed'
          );

          if (activeTableOrders.length === 0) {
            confirmResetAccess();
            return;
          }

          if (activeTableOrders.every((order) => order.status === 'queued')) {
            Alert.alert(
              'Pedido pendiente',
              'No puedes salir de esta mesa mientras haya pedidos en cola. Cancela los pedidos primero para poder escanear otro QR.'
            );
            return;
          }

          if (activeTableOrders.some((order) => order.status === 'served')) {
            Alert.alert(
              'Pedido servido',
              'No puedes salir de esta mesa porque ya hay tragos servidos. Habla con un mesero para que te saque de la mesa, limpie la mesa y cobre lo que se pidio.'
            );
            return;
          }

          Alert.alert(
            'Pedido en curso',
            'No puedes salir de esta mesa porque hay pedidos en preparacion o listos para servir. Habla con un mesero para revisar la mesa.'
          );
        }}
        onAddCartItem={handleAddCartItem}
        onJoinTable={handleJoinTable}
        onQuantityChange={(cartId, delta) => {
          setCart((current) =>
            current
              .map((item) =>
                item.id === cartId ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item
              )
              .filter(Boolean)
          );
        }}
        onRemoveCartItem={(cartId) => {
          setCart((current) => current.filter((item) => item.id !== cartId));
        }}
        onSelectRecipe={(recipe) => {
          setSelectedRecipeId(recipe.id);
          if (recipe.id === 'piscola') {
            setPiscolaIntensity('normal');
          }
        }}
        onSelectGuest={(guestId) => {
          const guest = activeTableSession?.guests.find((entry) => entry.id === guestId);
          setCurrentGuestId(guestId);
          setGuestNameInput(guest?.name ?? '');
          setCart([]);
        }}
        onStartNewGuest={() => {
          setCurrentGuestId(null);
          setGuestNameInput('');
          setCart([]);
        }}
        onSubmitCart={() => {
          void handleSubmitCart();
        }}
        onDeleteQueuedOrder={(order) => handleDeleteOrder(order, { queuedOnly: true })}
        recipeAvailability={(recipe) =>
          recipeIsAvailable(
            recipe,
            getRecipeDefaultOptions(recipe, recipe.id === 'piscola' ? piscolaIntensity : 'normal')
          )
        }
        recipes={recipes}
        settings={settings}
        selectedRecipe={selectedRecipe}
        session={activeTableSession}
        setGuestNameInput={setGuestNameInput}
        setHostGuest={(guestId) => setHostGuest(activeEntry.table_number, guestId)}
        setPiscolaIntensity={setPiscolaIntensity}
        setSplitMethod={(method) =>
          setSplitMethod(
            activeEntry.table_number,
            method,
            method === 'host_pays' ? currentGuestId ?? undefined : undefined
          )
        }
        setTipPercentage={(tipPercentage) => setTipPercentage(activeEntry.table_number, tipPercentage)}
        guestNameInput={guestNameInput}
        piscolaIntensity={piscolaIntensity}
        tableNumber={activeEntry.table_number}
      />
    </SafeAreaView>
  );
}

function EntryScannerScreen({ onResolved }: { onResolved: (entry: AppEntryQr) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannerPaused, setScannerPaused] = useState(false);
  const [scanError, setScanError] = useState('');

  const resolveRawValue = (value: string) => {
    const parsed = parseAccessQr(value);
    if (!parsed) {
      setScanError('QR no valido. Escanea un QR de mesa, mesero o administrador.');
      return;
    }

    setScanError('');
    setScannerPaused(true);
    onResolved(parsed);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroCard}>
          <Image
            source={require('../../assets/images/penpito-logo.png')}
            style={styles.heroLogo}
            resizeMode="contain"
          />
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Escanea el QR de acceso</Text>
          <Text style={styles.sectionText}>
            El QR define automaticamente si la app entra como usuario de mesa, mesero o administrador.
          </Text>

          {permission == null ? (
            <View style={styles.cameraPlaceholder}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.cameraHelperText}>Preparando camara...</Text>
            </View>
          ) : permission.granted ? (
            <View style={styles.cameraShell}>
              <CameraView
                style={styles.cameraPreview}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={scannerPaused ? undefined : ({ data }: BarcodeScanningResult) => resolveRawValue(data)}
              />
              <View style={styles.cameraOverlay}>
                <Text style={styles.cameraOverlayTitle}>PENPITO</Text>
                <Text style={styles.cameraOverlayText}>Escanea el QR de mesa, mesero o admin.</Text>
                <View style={styles.cameraFrame} />
              </View>
            </View>
          ) : (
            <View style={styles.cameraPlaceholder}>
              <FontAwesome name="camera" size={28} color={Colors.primary} />
              <Text style={styles.cameraPlaceholderTitle}>Permite la camara</Text>
              <Text style={styles.cameraHelperText}>
                La camara es necesaria para escanear el QR de acceso.
              </Text>
              {permission.canAskAgain ? (
                <TouchableOpacity
                  style={styles.secondaryActionButton}
                  onPress={() => {
                    void requestPermission();
                  }}>
                  <Text style={styles.secondaryActionButtonText}>Permitir camara</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}

          {scanError ? <Text style={styles.errorText}>{scanError}</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type UserPortalProps = {
  activeOrders: DrinkOrder[];
  cart: CartItem[];
  currentGuestName: string;
  guestNameInput: string;
  onResetAccess: () => void;
  onAddCartItem: (recipe: Recipe, quantity: number) => void;
  onJoinTable: () => void;
  onQuantityChange: (cartId: string, delta: number) => void;
  onRemoveCartItem: (cartId: string) => void;
  onSelectRecipe: (recipe: Recipe) => void;
  onSelectGuest: (guestId: string) => void;
  onStartNewGuest: () => void;
  onSubmitCart: () => void;
  onDeleteQueuedOrder: (order: DrinkOrder) => void;
  recipeAvailability: (recipe: Recipe) => boolean;
  recipes: Recipe[];
  settings: {
    piscola_price: number;
    whisky_rocks_price: number;
    negroni_price: number;
    gin_tonic_price: number;
  };
  selectedRecipe: Recipe | null;
  session: TableSession | null;
  setGuestNameInput: (value: string) => void;
  setHostGuest: (guestId?: string) => void;
  setPiscolaIntensity: (value: PiscolaIntensity) => void;
  setSplitMethod: (method: BillSplitMethod) => void;
  setTipPercentage: (tipPercentage: number) => void;
  piscolaIntensity: PiscolaIntensity;
  tableNumber: number;
};

function UserPortalScreen({
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
  const { width: viewportWidth } = useWindowDimensions();
  const carouselCardWidth = Math.min(Math.max(viewportWidth - 80, 264), 340);
  const carouselInterval = carouselCardWidth + 12;
  const carouselRef = useRef<ScrollView>(null);
  const loopingRecipes = useMemo(() => [...recipes, ...recipes, ...recipes], [recipes]);
  const groupedByGuest = useMemo(() => {
    const grouped = new Map<string, DrinkOrder[]>();
    activeOrders.forEach((order) => {
      const key = order.guest_name ?? 'Mesa';
      const current = grouped.get(key) ?? [];
      current.push(order);
      grouped.set(key, current);
    });
    return [...grouped.entries()];
  }, [activeOrders]);

  const cartTotal = useMemo(
    () => cart.reduce((total, item) => total + getRecipePrice(item.recipe.id, settings) * item.quantity, 0),
    [cart, settings]
  );

  const tableSubtotal = useMemo(
    () => activeOrders.reduce((total, order) => total + getRecipePrice(order.recipe_id, settings), 0),
    [activeOrders, settings]
  );

  const tableTipPercentage = session?.tip_percentage ?? 0;
  const tableTipAmount = useMemo(
    () => getTipAmount(tableSubtotal, tableTipPercentage),
    [tableSubtotal, tableTipPercentage]
  );
  const tableTotal = tableSubtotal + tableTipAmount;

  const hostGuestName = useMemo(
    () => session?.guests.find((guest) => guest.id === session.host_guest_id)?.name ?? '',
    [session]
  );
  const selectedRecipeLabel = useMemo(() => {
    if (!selectedRecipe) {
      return '';
    }

    return buildCartItemLabel(
      selectedRecipe,
      getRecipeDefaultOptions(
        selectedRecipe,
        selectedRecipe.id === 'piscola' ? piscolaIntensity : 'normal'
      )
    );
  }, [piscolaIntensity, selectedRecipe]);

  useEffect(() => {
    if (recipes.length === 0) {
      return;
    }

    requestAnimationFrame(() => {
      carouselRef.current?.scrollTo({
        x: recipes.length * carouselInterval,
        animated: false,
      });
    });
  }, [carouselInterval, recipes.length]);

  const handleCarouselMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (recipes.length === 0) {
      return;
    }

    const currentIndex = Math.round(event.nativeEvent.contentOffset.x / carouselInterval);
    if (currentIndex < recipes.length) {
      carouselRef.current?.scrollTo({
        x: (currentIndex + recipes.length) * carouselInterval,
        animated: false,
      });
      return;
    }

    if (currentIndex >= recipes.length * 2) {
      carouselRef.current?.scrollTo({
        x: (currentIndex - recipes.length) * carouselInterval,
        animated: false,
      });
    }
  };

  const splitSettingsSection = (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>Division de cuenta</Text>
      <Text style={styles.sectionText}>
        Tomamos tres formas habituales de pago usadas en restaurantes modernos: por consumo propio,
        reparto igualitario o un pagador principal.
      </Text>
      {splitOptions.map((option) => (
        <TouchableOpacity
          key={option.id}
          style={[
            styles.selectionRow,
            session?.split_method === option.id && styles.selectionRowActive,
          ]}
          onPress={() => setSplitMethod(option.id)}>
          <View style={styles.selectionRowContent}>
            <Text style={styles.selectionRowTitle}>{option.title}</Text>
            <Text style={styles.selectionRowText}>{option.description}</Text>
          </View>
          <FontAwesome
            name={session?.split_method === option.id ? 'check-circle' : 'circle-o'}
            size={18}
            color={session?.split_method === option.id ? Colors.primary : Colors.textMuted}
          />
        </TouchableOpacity>
      ))}

      {session?.split_method === 'host_pays' ? (
        <View style={styles.hostWrap}>
          <Text style={styles.inputLabel}>Pago total asignado</Text>
          <Text style={styles.sectionText}>
            {hostGuestName
              ? `${hostGuestName} paga toda la mesa.`
              : 'Quien active esta opcion queda como pagador principal.'}
          </Text>
          {currentGuestName ? (
            <TouchableOpacity
              style={styles.secondaryActionButton}
              onPress={() => {
                const me = session.guests.find((guest) => guest.name === currentGuestName);
                setHostGuest(me?.id);
              }}>
              <Text style={styles.secondaryActionButtonText}>Actualizar mi pago total</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow}>Vista de usuario</Text>
          <Text style={styles.sectionTitle}>{formatTableLabel(tableNumber)}</Text>
        </View>
        <TouchableOpacity style={styles.backChip} onPress={onResetAccess}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </TouchableOpacity>
      </View>

      {!currentGuestName ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Unete a la mesa</Text>
          <Text style={styles.sectionText}>
            El QR ya selecciono la mesa automaticamente. Solo falta tu nombre para asociar tus tragos.
          </Text>
          <TextInput
            placeholder="Tu nombre"
            placeholderTextColor={Colors.textMuted}
            style={styles.input}
            value={guestNameInput}
            onChangeText={setGuestNameInput}
          />
          <TouchableOpacity style={styles.primaryButton} onPress={onJoinTable}>
            <Text style={styles.primaryButtonText}>Entrar a la mesa</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {currentGuestName ? (
        <>
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Resumen de mesa</Text>
            <Text style={styles.sectionText}>
              Tu sesion esta vinculada a {formatTableLabel(tableNumber)} como {currentGuestName}.
            </Text>
            <View style={styles.guestList}>
              {session?.guests.map((guest) => (
                <TouchableOpacity
                  key={guest.id}
                  style={[
                    styles.guestChip,
                    guest.name === currentGuestName && styles.guestChipActive,
                  ]}
                  onPress={() => onSelectGuest(guest.id)}>
                  <Text
                    style={[
                      styles.guestChipText,
                      guest.name === currentGuestName && styles.guestChipTextActive,
                    ]}>
                    {guest.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.secondaryActionButton} onPress={onStartNewGuest}>
              <Text style={styles.secondaryActionButtonText}>Agregar otra persona</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Elige tragos</Text>
            <Text style={styles.sectionText}>
              Puedes agregar varios tragos al mismo pedido. La maquina los va tomando en cola.
            </Text>
            <ScrollView
              ref={carouselRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={carouselInterval}
              decelerationRate="fast"
              onMomentumScrollEnd={handleCarouselMomentumEnd}
              contentContainerStyle={styles.drinkCarouselContent}>
              {loopingRecipes.map((recipe, index) => {
                const available = recipeAvailability(recipe);
                const backgroundImage = getDrinkCardImage(recipe.id);
                const selected = selectedRecipe?.id === recipe.id;
                return (
                  <TouchableOpacity
                    key={`${recipe.id}-${index}`}
                    activeOpacity={0.88}
                    style={[
                      styles.drinkCard,
                      { width: carouselCardWidth },
                      selected && styles.drinkCardSelected,
                    ]}
                    onPress={() => onSelectRecipe(recipe)}>
                    {backgroundImage ? (
                      <ImageBackground
                        source={backgroundImage}
                        style={styles.drinkCardBackground}
                        imageStyle={styles.drinkCardBackgroundImage}>
                        <View style={styles.drinkCardOverlay}>
                          <View style={styles.drinkCardContent}>
                            <Text style={styles.drinkTitleOnImage}>{recipe.name}</Text>
                            <Text style={styles.drinkTextOnImage} numberOfLines={2}>
                              {recipe.description || 'Sin descripcion'}
                            </Text>
                            <Text style={styles.drinkTextOnImage}>Tiempo estimado: {recipe.est_time_seconds}s</Text>
                            <Text style={styles.drinkPriceOnImage}>{formatCurrency(getRecipePrice(recipe.id, settings))}</Text>
                          </View>
                          <View style={styles.drinkCardFooter}>
                            <Text
                              style={[
                                styles.statusPill,
                                available ? styles.statusPillAvailable : styles.statusPillUnavailable,
                              ]}>
                              {available ? 'Disponible' : 'Sin stock'}
                            </Text>
                            {selected ? (
                              <View style={styles.selectedDrinkBadge}>
                                <FontAwesome name="check" size={12} color="#fffdf9" />
                              </View>
                            ) : null}
                          </View>
                        </View>
                      </ImageBackground>
                    ) : (
                      <View style={styles.drinkCardInner}>
                        <View style={styles.drinkCardContent}>
                          <Text style={styles.drinkTitle}>{recipe.name}</Text>
                          <Text style={styles.drinkText} numberOfLines={2}>
                            {recipe.description || 'Sin descripcion'}
                          </Text>
                          <Text style={styles.drinkText}>Tiempo estimado: {recipe.est_time_seconds}s</Text>
                          <Text style={styles.drinkPrice}>{formatCurrency(getRecipePrice(recipe.id, settings))}</Text>
                        </View>
                        <Text
                          style={[
                            styles.statusPill,
                            available ? styles.statusPillAvailable : styles.statusPillUnavailable,
                          ]}>
                          {available ? 'Disponible' : 'Sin stock'}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {selectedRecipe ? (
              <View style={styles.selectionCard}>
                <Text style={styles.selectionTitle}>Agregar al pedido</Text>
                <Text style={styles.selectionText}>{selectedRecipeLabel}</Text>
                {selectedRecipe.id === 'piscola' ? (
                  <View style={styles.intensityRow}>
                    {(Object.keys(piscolaProfiles) as PiscolaIntensity[]).map((level) => (
                      <TouchableOpacity
                        key={level}
                        style={[
                          styles.intensityChip,
                          piscolaIntensity === level && styles.intensityChipActive,
                        ]}
                        onPress={() => setPiscolaIntensity(level)}>
                        <Text
                          style={[
                            styles.intensityChipText,
                            piscolaIntensity === level && styles.intensityChipTextActive,
                          ]}>
                          {piscolaProfiles[level].label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
                <TouchableOpacity style={styles.primaryButton} onPress={() => onAddCartItem(selectedRecipe, 1)}>
                  <Text style={styles.primaryButtonText}>Agregar al carrito</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Tu pedido actual</Text>
            {cart.length === 0 ? (
              <Text style={styles.sectionText}>Aun no agregas tragos al carrito.</Text>
            ) : (
              cart.map((item) => (
                <View key={item.id} style={styles.cartRow}>
                  <View style={styles.cartInfo}>
                    <Text style={styles.cartTitle}>{buildCartItemLabel(item.recipe, item.options)}</Text>
                    <Text style={styles.cartCaption}>Pedido por {currentGuestName}</Text>
                  </View>
                  <View style={styles.cartActions}>
                    <TouchableOpacity style={styles.countButton} onPress={() => onQuantityChange(item.id, -1)}>
                      <Text style={styles.countButtonText}>-</Text>
                    </TouchableOpacity>
                    <Text style={styles.countValue}>{item.quantity}</Text>
                    <TouchableOpacity style={styles.countButton} onPress={() => onQuantityChange(item.id, 1)}>
                      <Text style={styles.countButtonText}>+</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.removeButton} onPress={() => onRemoveCartItem(item.id)}>
                      <FontAwesome name="trash" size={14} color={Colors.error} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
            <View style={styles.totalSummary}>
              <Text style={styles.totalLabel}>Total del carrito</Text>
              <Text style={styles.totalValue}>{formatCurrency(cartTotal)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.primaryButton, cart.length === 0 && styles.disabledButton]}
              disabled={cart.length === 0}
              onPress={onSubmitCart}>
              <Text style={styles.primaryButtonText}>Enviar pedido ({cart.length} items)</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Lo elegido por la mesa</Text>
            {groupedByGuest.length === 0 ? (
              <Text style={styles.sectionText}>Todavia no hay tragos cargados para esta mesa.</Text>
            ) : (
              groupedByGuest.map(([guestName, guestOrders]) => (
                <View key={guestName} style={styles.groupCard}>
                  <Text style={styles.groupTitle}>{guestName}</Text>
                  {guestOrders.map((order) => (
                    <View key={order.id} style={styles.orderRow}>
                      <View style={styles.orderRowInfo}>
                        <Text style={styles.orderTitle}>{order.recipe_name}</Text>
                        <Text style={styles.orderMeta}>{getOrderStatusLabel(order.status)}</Text>
                      </View>
                      <View style={styles.orderActions}>
                        <Text style={[styles.statusBadge, getStatusAccent(order.status)]}>
                          {order.status === 'queued' ? 'En cola' : getOrderStatusLabel(order.status)}
                        </Text>
                        {order.status === 'queued' && order.guest_name === currentGuestName ? (
                          <TouchableOpacity style={styles.deleteSmallButton} onPress={() => onDeleteQueuedOrder(order)}>
                            <Text style={styles.deleteSmallButtonText}>Eliminar</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              ))
            )}
          </View>

          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Total y propina</Text>
            <Text style={styles.sectionText}>
              La propina se aplica al total compartido de la mesa y se refleja para todos quienes esten usando
              esta mesa.
            </Text>
            <View style={styles.intensityRow}>
              {tipPercentageOptions.map((tipOption) => (
                <TouchableOpacity
                  key={tipOption}
                  style={[
                    styles.intensityChip,
                    tableTipPercentage === tipOption && styles.intensityChipActive,
                  ]}
                  onPress={() => setTipPercentage(tipOption)}>
                  <Text
                    style={[
                      styles.intensityChipText,
                      tableTipPercentage === tipOption && styles.intensityChipTextActive,
                    ]}>
                    {tipOption}% propina
                  </Text>
                </TouchableOpacity>
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
          </View>

          {splitSettingsSection}
        </>
      ) : null}
    </ScrollView>
  );
}

function WaiterScreen({
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
  settings,
}: {
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
  settings: {
    piscola_price: number;
    whisky_rocks_price: number;
    negroni_price: number;
    gin_tonic_price: number;
  };
}) {
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
      <View style={styles.topBar}>
        <View>
          <Text style={styles.eyebrow}>Vista de mesero</Text>
          <Text style={styles.sectionTitle}>Mesas activas</Text>
        </View>
        <TouchableOpacity style={styles.backChip} onPress={onResetAccess}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.metricsRow}>
        <MetricCard label="Mesas" value={String(tables.length)} />
        <MetricCard label="Listos" value={String(readyOrdersCount)} accent="success" />
        <MetricCard label="En cola" value={String(queuedOrdersCount)} accent="warning" />
      </View>

      {tables.length === 0 ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionText}>No hay mesas con usuarios o tragos pendientes ahora mismo.</Text>
        </View>
      ) : (
        tables.map((table) => (
          <View key={table.tableNumber} style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>{formatTableLabel(table.tableNumber)}</Text>
            <View style={styles.groupCard}>
              <Text style={styles.groupTitle}>Personas en la mesa</Text>
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
                        <Text style={styles.orderTitle}>{guest.name}</Text>
                        <Text style={styles.orderMeta}>
                          {guestOrders.length === 0
                            ? 'Sin pedidos'
                            : `${guestOrders.length} pedido(s)${servedCount ? `, ${servedCount} servido(s)` : ''}`}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.deleteSmallButton, hasActiveOrders && styles.disabledOutlineButton]}
                        disabled={hasActiveOrders}
                        onPress={() => onRemoveGuest(table.tableNumber, guest)}>
                        <Text style={styles.deleteSmallButtonText}>Sacar</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.sectionText}>No hay personas registradas en esta mesa.</Text>
              )}
            </View>
            <View style={styles.billSummaryCard}>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownLabel}>Subtotal</Text>
                <Text style={styles.summaryBreakdownValue}>
                  {formatCurrency(
                    table.orders.reduce(
                      (total, order) => total + getRecipePrice(order.recipe_id, settings),
                      0
                    )
                  )}
                </Text>
              </View>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownLabel}>
                  Propina ({sessions.find((session) => session.table_number === table.tableNumber)?.tip_percentage ?? 0}%)
                </Text>
                <Text style={styles.summaryBreakdownValue}>
                  {formatCurrency(
                    getTipAmount(
                      table.orders.reduce(
                        (total, order) => total + getRecipePrice(order.recipe_id, settings),
                        0
                      ),
                      sessions.find((session) => session.table_number === table.tableNumber)?.tip_percentage ?? 0
                    )
                  )}
                </Text>
              </View>
              <View style={styles.summaryBreakdownRow}>
                <Text style={styles.summaryBreakdownTotalLabel}>Total a cobrar</Text>
                <Text style={styles.summaryBreakdownTotalValue}>
                  {formatCurrency(
                    (() => {
                      const subtotal = table.orders.reduce(
                        (total, order) => total + getRecipePrice(order.recipe_id, settings),
                        0
                      );
                      const tipPercentage =
                        sessions.find((session) => session.table_number === table.tableNumber)?.tip_percentage ?? 0;
                      return subtotal + getTipAmount(subtotal, tipPercentage);
                    })()
                  )}
                </Text>
              </View>
            </View>
            {table.orders.map((order) => (
              <View key={order.id} style={styles.waiterOrderCard}>
                <View style={styles.waiterOrderInfo}>
                  <Text style={styles.orderTitle}>{order.recipe_name}</Text>
                  <Text style={styles.orderMeta}>
                    {order.guest_name ? `${order.guest_name} · ` : ''}
                    {order.status === 'queued' ? 'En cola' : getOrderStatusLabel(order.status)}
                  </Text>
                  {order.status === 'preparing' || order.status === 'ready' ? (
                    <PreparationTimeline
                      activeStepId={order.active_step_id}
                      completedStepIds={order.completed_step_ids}
                      skippedStepIds={order.skipped_step_ids}
                      isReady={order.is_drink_ready}
                    />
                  ) : null}
                </View>
                {order.status === 'ready' ? (
                  <TouchableOpacity style={styles.primarySmallButton} onPress={() => onMarkServed(order.id)}>
                    <Text style={styles.primarySmallButtonText}>Marcar servido</Text>
                  </TouchableOpacity>
                ) : null}
                {order.status !== 'preparing' ? (
                  <TouchableOpacity style={styles.deleteOutlineButton} onPress={() => onDeleteOrder(order)}>
                    <Text style={styles.deleteOutlineButtonText}>Eliminar pedido</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
            <TouchableOpacity
              style={[
                styles.secondaryActionButton,
                table.orders.some((order) => ['queued', 'preparing', 'ready'].includes(order.status)) &&
                  styles.disabledOutlineButton,
              ]}
              disabled={table.orders.some((order) => ['queued', 'preparing', 'ready'].includes(order.status))}
              onPress={() => {
                clearTableOrders(table.tableNumber);
                clearTableSession(table.tableNumber);
              }}>
              <Text style={styles.secondaryActionButtonText}>Limpiar mesa</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function AdminLoginScreen({
  adminError,
  adminPassword,
  onBack,
  onLogin,
  setAdminPassword,
}: {
  adminError: string;
  adminPassword: string;
  onBack: () => void;
  onLogin: () => void;
  setAdminPassword: (value: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backChip} onPress={onBack}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.loginCard}>
        <Text style={styles.sectionTitle}>Ingreso administrador</Text>
        <Text style={styles.sectionText}>
          El QR admin ya te dejo en esta vista. Ahora valida la contrasena para cambiar parametros.
        </Text>
        <TextInput
          secureTextEntry
          placeholder="admin123"
          placeholderTextColor={Colors.textMuted}
          style={styles.input}
          value={adminPassword}
          onChangeText={setAdminPassword}
        />
        {adminError ? <Text style={styles.errorText}>{adminError}</Text> : null}
        <TouchableOpacity style={styles.primaryButton} onPress={onLogin}>
          <Text style={styles.primaryButtonText}>Entrar</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

type AdminScreenProps = {
  autoCleanEnabled: boolean;
  bottleCapacityMl: string;
  bottleCapacityInputs: Record<string, string>;
  dispenseSpeedMlS: string;
  iceDispenseTimeS: string;
  inventory: BottleInventory[];
  isConnected: boolean;
  machineState: MachineState;
  settings: {
    piscola_price: number;
    whisky_rocks_price: number;
    negroni_price: number;
    gin_tonic_price: number;
  };
  onBack: () => void;
  onMarkServed: (orderId: string) => void;
  onRefillBottle: (bottleId: string) => void;
  onSaveBottleCapacity: (bottleId: string) => void;
  onSaveSettings: () => void;
  orders: DrinkOrder[];
  preparingOrders: DrinkOrder[];
  readyOrders: DrinkOrder[];
  servedOrdersCount: number;
  setAutoCleanEnabled: (value: boolean) => void;
  setBottleCapacityInput: (bottleId: string, value: string) => void;
  setBottleCapacityMl: (value: string) => void;
  setDispenseSpeedMlS: (value: string) => void;
  setIceDispenseTimeS: (value: string) => void;
  setPiscolaPrice: (value: string) => void;
  setWhiskyPrice: (value: string) => void;
  setNegroniPrice: (value: string) => void;
  setGinTonicPrice: (value: string) => void;
  settingsFeedback: string;
  inventoryFeedback: string;
  piscolaPrice: string;
  whiskyPrice: string;
  negroniPrice: string;
  ginTonicPrice: string;
};

function AdminScreen({
  autoCleanEnabled,
  bottleCapacityMl,
  bottleCapacityInputs,
  dispenseSpeedMlS,
  iceDispenseTimeS,
  inventory,
  isConnected,
  machineState,
  settings,
  onBack,
  onMarkServed,
  onRefillBottle,
  onSaveBottleCapacity,
  onSaveSettings,
  orders,
  preparingOrders,
  readyOrders,
  servedOrdersCount,
  setAutoCleanEnabled,
  setBottleCapacityInput,
  setBottleCapacityMl,
  setDispenseSpeedMlS,
  setIceDispenseTimeS,
  setPiscolaPrice,
  setWhiskyPrice,
  setNegroniPrice,
  setGinTonicPrice,
  settingsFeedback,
  inventoryFeedback,
  piscolaPrice,
  whiskyPrice,
  negroniPrice,
  ginTonicPrice,
}: AdminScreenProps) {
  const recipeStats = useMemo(() => {
    const grouped = new Map<string, { name: string; count: number }>();
    orders.forEach((order) => {
      const current = grouped.get(order.recipe_id) ?? { name: order.recipe_name, count: 0 };
      current.count += 1;
      grouped.set(order.recipe_id, current);
    });
    return [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  }, [orders]);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backChip} onPress={onBack}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Estado de la maquina</Text>
        <Text style={styles.sectionText}>Conexion ESP32: {isConnected ? 'Activa' : 'Sin conexion'}</Text>
        <Text style={styles.sectionText}>Operacion: {machineState.status}</Text>
        <Text style={styles.sectionText}>La maquina queda disponible automaticamente al conectarse.</Text>
      </View>

      <View style={styles.metricsRow}>
        <MetricCard label="Pedidos" value={String(orders.length)} />
        <MetricCard label="Listos" value={String(readyOrders.length)} accent="warning" />
        <MetricCard label="Servidos" value={String(servedOrdersCount)} accent="success" />
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>KPIs rapidos</Text>
        {recipeStats.length === 0 ? (
          <Text style={styles.sectionText}>Todavia no hay consumos registrados.</Text>
        ) : (
          recipeStats.map((item, index) => (
            <View key={item.name} style={styles.orderRow}>
              <Text style={styles.orderTitle}>{index + 1}. {item.name}</Text>
              <Text style={styles.orderMeta}>{item.count} pedidos</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Precios actuales</Text>
        <Text style={styles.sectionText}>Piscola: {formatCurrency(settings.piscola_price)}</Text>
        <Text style={styles.sectionText}>Whisky: {formatCurrency(settings.whisky_rocks_price)}</Text>
        <Text style={styles.sectionText}>Negroni: {formatCurrency(settings.negroni_price)}</Text>
        <Text style={styles.sectionText}>Gin Tonic: {formatCurrency(settings.gin_tonic_price)}</Text>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Parametros de la maquina</Text>

        <Text style={styles.inputLabel}>Capacidad base por defecto (ml)</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={bottleCapacityMl} onChangeText={setBottleCapacityMl} />

        <Text style={styles.inputLabel}>Velocidad de dispensado (ml/s)</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={dispenseSpeedMlS} onChangeText={setDispenseSpeedMlS} />

        <Text style={styles.inputLabel}>Tiempo de hielo (s)</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={iceDispenseTimeS} onChangeText={setIceDispenseTimeS} />

        <Text style={styles.inputLabel}>Precio Piscola</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={piscolaPrice} onChangeText={setPiscolaPrice} />

        <Text style={styles.inputLabel}>Precio Whisky</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={whiskyPrice} onChangeText={setWhiskyPrice} />

        <Text style={styles.inputLabel}>Precio Negroni</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={negroniPrice} onChangeText={setNegroniPrice} />

        <Text style={styles.inputLabel}>Precio Gin Tonic</Text>
        <TextInput keyboardType="numeric" style={styles.input} value={ginTonicPrice} onChangeText={setGinTonicPrice} />

        <View style={styles.switchRow}>
          <Text style={styles.inputLabel}>Limpieza automatica</Text>
          <Switch
            trackColor={{ false: Colors.surfaceHighlight, true: Colors.primaryGlow }}
            thumbColor={autoCleanEnabled ? Colors.primary : Colors.textMuted}
            value={autoCleanEnabled}
            onValueChange={setAutoCleanEnabled}
          />
        </View>

        {settingsFeedback ? <Text style={styles.helperText}>{settingsFeedback}</Text> : null}
        <TouchableOpacity style={styles.primaryButton} onPress={onSaveSettings}>
          <Text style={styles.primaryButtonText}>Guardar parametros</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Liquidos de la maquina</Text>
        {inventoryFeedback ? <Text style={styles.helperText}>{inventoryFeedback}</Text> : null}
        {inventory.map((bottle) => (
          <View key={bottle.id} style={styles.inventoryCard}>
            <View style={styles.inventoryHeader}>
              <Text style={styles.inventoryName}>{bottle.display_name}</Text>
              <Text style={styles.inventoryAmount}>{formatMl(bottle.remaining_ml)}</Text>
            </View>
            <Text style={styles.inventoryCaption}>Capacidad actual: {formatMl(bottle.capacity_ml)}</Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFillStatic,
                  { width: `${Math.max(bottle.remaining_ml / bottle.capacity_ml, 0.04) * 100}%` },
                ]}
              />
            </View>
            <Text style={styles.inputLabel}>Capacidad de esta botella (ml)</Text>
            <TextInput
              keyboardType="numeric"
              style={styles.input}
              value={bottleCapacityInputs[bottle.id] ?? String(Math.round(bottle.capacity_ml))}
              onChangeText={(value) => setBottleCapacityInput(bottle.id, value)}
            />
            <TouchableOpacity style={styles.secondaryActionButton} onPress={() => onSaveBottleCapacity(bottle.id)}>
              <Text style={styles.secondaryActionButtonText}>Guardar capacidad</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryActionButton} onPress={() => onRefillBottle(bottle.id)}>
              <Text style={styles.secondaryActionButtonText}>Rellenar</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Pedidos listos</Text>
        {readyOrders.length === 0 ? (
          <Text style={styles.sectionText}>No hay pedidos listos por servir.</Text>
        ) : (
          readyOrders.map((order) => (
            <View key={order.id} style={styles.alertCard}>
              <View style={styles.alertTextWrap}>
                <Text style={styles.alertTitle}>{order.recipe_name}</Text>
                <Text style={styles.alertSubtitle}>
                  {formatTableLabel(order.table_number)} · {order.guest_name ?? 'Mesa completa'}
                </Text>
              </View>
              <TouchableOpacity style={styles.primarySmallButton} onPress={() => onMarkServed(order.id)}>
                <Text style={styles.primarySmallButtonText}>Marcar servido</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Pedidos en preparacion</Text>
        {preparingOrders.length === 0 ? (
          <Text style={styles.sectionText}>No hay preparaciones en curso.</Text>
        ) : (
          preparingOrders.map((order) => (
            <View key={order.id} style={styles.preparingCard}>
              <Text style={styles.orderTitle}>{order.recipe_name}</Text>
              <Text style={styles.orderMeta}>
                {formatTableLabel(order.table_number)} · {order.guest_name ?? 'Mesa'}
              </Text>
              <PreparationTimeline
                activeStepId={order.active_step_id}
                completedStepIds={order.completed_step_ids}
                skippedStepIds={order.skipped_step_ids}
                isReady={order.is_drink_ready}
              />
            </View>
          ))
        )}
      </View>
    </ScrollView>
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
    <View style={styles.metricCard}>
      <Text style={[styles.metricValue, { color: accentColor }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loaderText: {
    marginTop: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 44,
  },
  heroCard: {
    padding: 24,
    borderRadius: 26,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 20,
    ...Shadows.glass,
  },
  heroLogo: {
    width: '100%',
    height: 180,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  eyebrow: {
    color: Colors.primary,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  sectionCard: {
    marginBottom: 16,
    padding: 20,
    borderRadius: 24,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.glass,
  },
  loginCard: {
    marginTop: 18,
    padding: 22,
    borderRadius: 24,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.glass,
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: Colors.text,
    marginBottom: 8,
  },
  sectionText: {
    color: Colors.textMuted,
    lineHeight: 22,
    marginBottom: 8,
  },
  cameraShell: {
    height: 280,
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: '#ebe0d1',
  },
  cameraPreview: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: 'rgba(245, 239, 230, 0.14)',
  },
  cameraOverlayTitle: {
    color: Colors.text,
    fontWeight: '900',
    fontSize: 18,
  },
  cameraOverlayText: {
    color: '#314155',
    marginTop: 4,
    lineHeight: 19,
  },
  cameraFrame: {
    alignSelf: 'center',
    width: 180,
    height: 180,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: Colors.primary,
    backgroundColor: 'transparent',
    marginBottom: 14,
  },
  cameraPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    marginBottom: 12,
  },
  cameraPlaceholderTitle: {
    marginTop: 10,
    color: Colors.text,
    fontWeight: '800',
    fontSize: 16,
  },
  cameraHelperText: {
    marginTop: 8,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  inputLabel: {
    color: Colors.text,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 6,
  },
  input: {
    backgroundColor: '#fcf8f2',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: Colors.text,
    fontSize: 16,
    marginBottom: 10,
  },
  primaryButton: {
    marginTop: 6,
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.glowPrimary,
  },
  secondaryButton: {
    backgroundColor: Colors.secondary,
  },
  disabledButton: {
    backgroundColor: Colors.surfaceHighlight,
    opacity: 0.55,
    shadowOpacity: 0,
    elevation: 0,
  },
  primaryButtonText: {
    color: '#fffdf9',
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  backChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backChipText: {
    color: Colors.text,
    marginLeft: 8,
    fontWeight: '700',
  },
  errorText: {
    color: Colors.error,
    marginBottom: 8,
    fontWeight: '700',
  },
  helperText: {
    color: Colors.primary,
    marginTop: 2,
    marginBottom: 10,
    fontWeight: '700',
  },
  guestList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  guestChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: Colors.surfaceHighlight,
    marginRight: 8,
    marginBottom: 8,
  },
  guestChipActive: {
    backgroundColor: Colors.primary,
  },
  guestChipText: {
    color: Colors.text,
    fontWeight: '700',
  },
  guestChipTextActive: {
    color: '#fffdf9',
  },
  selectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    padding: 14,
    marginTop: 10,
  },
  selectionRowActive: {
    borderColor: Colors.primary,
    backgroundColor: '#e7f2f0',
  },
  selectionRowContent: {
    flex: 1,
    marginRight: 10,
  },
  selectionRowTitle: {
    color: Colors.text,
    fontWeight: '800',
    marginBottom: 4,
  },
  selectionRowText: {
    color: Colors.textMuted,
    lineHeight: 18,
  },
  hostWrap: {
    marginTop: 12,
  },
  drinkCarouselContent: {
    paddingTop: 4,
    paddingRight: 4,
    paddingBottom: 4,
  },
  drinkCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    marginTop: 12,
    marginRight: 12,
    height: 240,
    minHeight: 240,
    overflow: 'hidden',
    ...Shadows.glowSecondary,
  },
  drinkCardSelected: {
    borderColor: Colors.primary,
    backgroundColor: '#e7f2f0',
  },
  drinkCardInner: {
    flex: 1,
    minHeight: 240,
    justifyContent: 'space-between',
    padding: 16,
  },
  drinkCardBackground: {
    flex: 1,
    minHeight: 240,
  },
  drinkCardBackgroundImage: {
    borderRadius: 17,
  },
  drinkCardOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: 'rgba(20, 16, 12, 0.28)',
  },
  drinkCardContent: {
    marginBottom: 10,
  },
  drinkTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 4,
  },
  drinkText: {
    color: Colors.textMuted,
    lineHeight: 19,
  },
  drinkPrice: {
    marginTop: 6,
    color: Colors.primary,
    fontWeight: '900',
  },
  drinkTitleOnImage: {
    color: '#fff9f3',
    fontSize: 21,
    fontWeight: '900',
    marginBottom: 4,
  },
  drinkTextOnImage: {
    color: 'rgba(255, 249, 243, 0.88)',
    lineHeight: 19,
  },
  drinkPriceOnImage: {
    marginTop: 6,
    color: '#ffe0a8',
    fontWeight: '900',
  },
  drinkCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  selectedDrinkBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primary,
  },
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    fontWeight: '800',
    overflow: 'hidden',
  },
  statusPillAvailable: {
    backgroundColor: '#eaf5ee',
    color: Colors.success,
  },
  statusPillUnavailable: {
    backgroundColor: '#f6eddc',
    color: Colors.warning,
  },
  selectionCard: {
    marginTop: 16,
    padding: 16,
    borderRadius: 20,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  selectionTitle: {
    color: Colors.primary,
    fontWeight: '900',
    fontSize: 16,
    marginBottom: 8,
  },
  selectionText: {
    color: Colors.text,
    fontWeight: '800',
    fontSize: 18,
  },
  intensityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 14,
    marginBottom: 8,
  },
  intensityChip: {
    marginRight: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  intensityChipActive: {
    borderColor: Colors.primary,
    backgroundColor: '#e6f1ef',
  },
  intensityChipText: {
    color: Colors.textMuted,
    fontWeight: '700',
  },
  intensityChipTextActive: {
    color: Colors.primary,
  },
  cartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  cartInfo: {
    flex: 1,
    marginRight: 12,
  },
  cartTitle: {
    color: Colors.text,
    fontWeight: '800',
  },
  cartCaption: {
    color: Colors.textMuted,
    marginTop: 4,
  },
  totalSummary: {
    marginTop: 8,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#f1e7da',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  billSummaryCard: {
    marginTop: 8,
    marginBottom: 10,
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#f1e7da',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  summaryBreakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    gap: 12,
  },
  summaryBreakdownLabel: {
    color: Colors.textMuted,
    fontWeight: '700',
    flex: 1,
  },
  summaryBreakdownValue: {
    color: Colors.text,
    fontWeight: '800',
  },
  summaryBreakdownTotalLabel: {
    color: Colors.text,
    fontWeight: '900',
    flex: 1,
  },
  summaryBreakdownTotalValue: {
    color: Colors.primary,
    fontWeight: '900',
    fontSize: 18,
  },
  totalLabel: {
    color: Colors.text,
    fontWeight: '800',
  },
  totalValue: {
    color: Colors.primary,
    fontWeight: '900',
    fontSize: 18,
  },
  cartActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  countButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surfaceHighlight,
  },
  countButtonText: {
    color: Colors.text,
    fontWeight: '900',
    fontSize: 16,
  },
  countValue: {
    minWidth: 28,
    textAlign: 'center',
    color: Colors.text,
    fontWeight: '800',
  },
  removeButton: {
    marginLeft: 8,
    padding: 8,
  },
  deleteSmallButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.error,
    backgroundColor: Colors.surface,
  },
  deleteSmallButtonText: {
    color: Colors.error,
    fontWeight: '900',
    fontSize: 12,
  },
  groupCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  groupTitle: {
    color: Colors.primary,
    fontWeight: '900',
    marginBottom: 10,
  },
  guestManagementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  guestManagementInfo: {
    flex: 1,
    marginRight: 10,
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  orderRowInfo: {
    flex: 1,
    marginRight: 10,
  },
  orderActions: {
    alignItems: 'flex-end',
    gap: 8,
  },
  orderTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  orderMeta: {
    marginTop: 4,
    color: Colors.textMuted,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    fontWeight: '800',
    overflow: 'hidden',
  },
  statusQueued: {
    backgroundColor: '#f3ead8',
    color: Colors.warning,
  },
  statusReady: {
    backgroundColor: '#eaf5ee',
    color: Colors.success,
  },
  statusServed: {
    backgroundColor: '#e6f1ef',
    color: Colors.primary,
  },
  statusFailed: {
    backgroundColor: '#f7e5e0',
    color: Colors.error,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  metricCard: {
    width: '31%',
    padding: 16,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.glass,
  },
  metricValue: {
    fontSize: 26,
    fontWeight: '900',
    marginBottom: 4,
  },
  metricLabel: {
    color: Colors.textMuted,
    fontWeight: '700',
  },
  waiterOrderCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  waiterOrderInfo: {
    gap: 10,
  },
  primarySmallButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: Colors.primary,
    marginTop: 10,
  },
  primarySmallButtonText: {
    color: '#fffdf9',
    fontWeight: '900',
  },
  deleteOutlineButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.error,
    backgroundColor: Colors.surface,
    marginTop: 8,
  },
  deleteOutlineButtonText: {
    color: Colors.error,
    fontWeight: '900',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  inventoryCard: {
    marginTop: 12,
    padding: 16,
    borderRadius: 18,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  inventoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inventoryName: {
    flex: 1,
    color: Colors.text,
    fontWeight: '800',
    marginRight: 10,
  },
  inventoryAmount: {
    color: Colors.primary,
    fontWeight: '900',
  },
  inventoryCaption: {
    color: Colors.textMuted,
    marginTop: 6,
    marginBottom: 10,
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: Colors.surfaceHighlight,
    marginBottom: 12,
  },
  progressFillStatic: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: Colors.primary,
  },
  secondaryActionButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  disabledOutlineButton: {
    opacity: 0.45,
  },
  secondaryActionButtonText: {
    color: Colors.primary,
    fontWeight: '900',
  },
  alertCard: {
    marginTop: 12,
    padding: 16,
    borderRadius: 18,
    backgroundColor: '#fbf3e4',
    borderWidth: 1,
    borderColor: '#e7d1a2',
  },
  alertTextWrap: {
    marginBottom: 12,
  },
  alertTitle: {
    color: Colors.text,
    fontWeight: '900',
    fontSize: 17,
  },
  alertSubtitle: {
    marginTop: 4,
    color: Colors.textMuted,
  },
  preparingCard: {
    marginTop: 12,
    padding: 16,
    borderRadius: 18,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
});
