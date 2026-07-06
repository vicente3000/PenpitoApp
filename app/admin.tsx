import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors } from '../src/constants/Colors';
import { AdminScreen, Esp32DeviceKey, Esp32WifiConfig } from '../src/screens/AdminScreen';
import { AdminLoginScreen } from '../src/screens/AdminLoginScreen';
import { useSettingsStore } from '../src/stores/SettingsStore';
import { useInventoryStore } from '../src/stores/InventoryStore';
import { DrinkOrder } from '../src/models';
import {
  useAllTables,
  useOrderActions,
  useControllerConnection,
  useControllerHardware,
  useForceSnapshotOnConnect,
} from '../src/hooks/useOrderStoreV2';
import { useAdminController } from '../src/hooks/useAdminController';

const defaultEsp32WifiConfig: Record<Esp32DeviceKey, Esp32WifiConfig> = {
  kraken: { ssid: '', password: '', mqttHost: '', mqttPort: '1883' },
};

export default function AdminRoute() {
  const { settings, updateSettings, isLoading: settingsLoading } = useSettingsStore();
  const {
    inventory,
    isLoading: inventoryLoading,
    refillBottle,
  } = useInventoryStore();
  const ordersByTable = useAllTables();
  const { serveOrder, cancelOrder } = useOrderActions();
  const { isConnected, snapshot: connectionSnapshot } = useControllerConnection();
  const hardware = useControllerHardware();
  const admin = useAdminController();

  useForceSnapshotOnConnect();

  const [adminUnlocked, setAdminUnlocked] = useState(__DEV__);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminError, setAdminError] = useState('');

  const [dispenseSpeedMlS, setDispenseSpeedMlS] = useState('');
  const [iceDispenseTimeS, setIceDispenseTimeS] = useState('');
  const [autoCleanEnabled, setAutoCleanEnabled] = useState(true);
  const [pumpCalibrations, setPumpCalibrations] = useState<number[]>([]);
  const [carriagePositions, setCarriagePositions] = useState<number[]>([]);

  const [settingsFeedback, setSettingsFeedback] = useState('');
  const [inventoryFeedback, setInventoryFeedback] = useState('');
  const [esp32Feedback, setEsp32Feedback] = useState('');

  const [esp32WifiConfigState, setEsp32WifiConfigState] = useState<Record<Esp32DeviceKey, Esp32WifiConfig>>(defaultEsp32WifiConfig);

  // Sync settings when loaded
  useEffect(() => {
    if (settings) {
      setDispenseSpeedMlS(String(settings.dispense_speed_ml_s));
      setIceDispenseTimeS(String(settings.ice_dispense_time_s));
      setAutoCleanEnabled(settings.auto_clean_enabled);
      setPumpCalibrations(settings.pump_calibrations || [24.7, 23.6, 20.6, 24.3, 23.8, 16.1, 23.6]);
      setCarriagePositions(settings.carriage_positions || [3600, 2600, 800, 100, 1860, 1600, 1350, 1200]);
    }
  }, [settings]);

  const handleAdminLogin = () => {
    const expectedPassword = process.env.EXPO_PUBLIC_ADMIN_PASSWORD || 'admin123';
    if (adminPassword === expectedPassword) {
      setAdminUnlocked(true);
      setAdminError('');
    } else {
      setAdminError('Contraseña incorrecta.');
    }
  };

  const handleSaveSettings = async (overrideSpeed?: number, updatedCalibs?: number[], updatedPositions?: number[]) => {
    const nextDispenseSpeed = overrideSpeed !== undefined ? overrideSpeed : Number(dispenseSpeedMlS);
    const nextIceTime = Number(iceDispenseTimeS);

    if (
      !Number.isFinite(nextDispenseSpeed) ||
      !Number.isFinite(nextIceTime) ||
      nextDispenseSpeed <= 0 ||
      nextIceTime <= 0
    ) {
      setSettingsFeedback('Revisa parámetros. Todos deben ser mayores a 0.');
      return;
    }

    const nextCalibs = updatedCalibs || pumpCalibrations;
    const nextPositions = updatedPositions || carriagePositions;

    const nextSettings = {
      bottle_capacity_ml: 1000, // Hardcoded to 1L
      dispense_speed_ml_s: Number(nextDispenseSpeed.toFixed(1)),
      ice_dispense_time_s: Math.round(nextIceTime),
      auto_clean_enabled: autoCleanEnabled,
      pump_calibrations: nextCalibs,
      carriage_positions: nextPositions,
    };

    await updateSettings(nextSettings);

    if (isConnected) {
      try {
        await admin.setCalibration(nextCalibs, nextPositions);
        setSettingsFeedback('Parámetros guardados y sincronizados con ESP32.');
      } catch (err) {
        setSettingsFeedback(`Guardado local. Error al sincronizar con ESP32: ${String(err)}`);
      }
    } else {
      setSettingsFeedback('Parámetros guardados (ESP32 no conectado).');
    }
    setTimeout(() => setSettingsFeedback(''), 4000);
  };

  const handleRefillBottle = async (bottleId: string) => {
    await refillBottle(bottleId);
    setInventoryFeedback('Botella rellenada.');
    setTimeout(() => setInventoryFeedback(''), 3000);
  };

  const handleSendEsp32Config = async (deviceId: Esp32DeviceKey) => {
    const config = esp32WifiConfigState[deviceId];
    const ssid = config.ssid.trim();
    const mqttHost = config.mqttHost.trim();
    const mqttPort = Number(config.mqttPort);

    if (!ssid || !mqttHost || !Number.isFinite(mqttPort) || mqttPort <= 0) {
      setEsp32Feedback('Completa SSID, broker MQTT y puerto.');
      return;
    }

    setEsp32Feedback('Enviando configuración...');
    try {
      await admin.configWifi(ssid, config.password, mqttHost, mqttPort);
      setEsp32Feedback('Configuración enviada correctamente.');
    } catch (err) {
      setEsp32Feedback(`Error al enviar la configuración: ${String(err)}`);
    }
    setTimeout(() => setEsp32Feedback(''), 4000);
  };

  const setEsp32ConfigValue = (deviceId: Esp32DeviceKey, field: keyof Esp32WifiConfig, value: string) => {
    setEsp32WifiConfigState((current) => ({
      ...current,
      [deviceId]: {
        ...current[deviceId],
        [field]: value,
      },
    }));
  };

  // Aplanar orders para el panel
  const orders = useMemo<DrinkOrder[]>(() => {
    const out: DrinkOrder[] = [];
    for (const list of ordersByTable.values()) out.push(...list);
    return out;
  }, [ordersByTable]);

  const preparingOrders = useMemo(() => orders.filter((o) => o.status === 'preparing'), [orders]);
  const readyOrders = useMemo(() => orders.filter((o) => o.status === 'ready'), [orders]);
  const servedOrdersCount = useMemo(() => orders.filter((o) => o.status === 'served').length, [orders]);

  const machineState = useMemo(
    () => ({
      isOn: !!hardware?.isOn,
      status: (hardware?.status ?? 'idle') as 'idle' | 'preparing' | 'cleaning' | 'error',
      errorMessage: hardware?.errorMessage ?? undefined,
      currentRecipeId: hardware?.activeOrderId ?? undefined,
      activeStepId: hardware?.activeStepId as any,
      completedStepIds: (hardware?.completedStepIds ?? []) as any,
      skippedStepIds: (hardware?.skippedStepIds ?? []) as any,
      isDrinkReady: !!hardware?.isDrinkReady,
    }),
    [hardware]
  );

  if (settingsLoading || inventoryLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loader}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loaderText}>Cargando administración...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {!adminUnlocked ? (
        <AdminLoginScreen
          adminError={adminError}
          adminPassword={adminPassword}
          onBack={() => router.replace('/')}
          onLogin={handleAdminLogin}
          setAdminPassword={setAdminPassword}
        />
      ) : (
        <AdminScreen
          autoCleanEnabled={autoCleanEnabled}
          dispenseSpeedMlS={dispenseSpeedMlS}
          iceDispenseTimeS={iceDispenseTimeS}
          inventory={inventory}
          isConnected={isConnected}
          connectionSnapshot={connectionSnapshot as any}
          machineState={machineState as any}
          settings={settings}
          onBack={() => router.replace('/')}
          onMarkServed={(id) => {
            for (const [tableId, list] of ordersByTable) {
              if (list.some((o) => o.id === id)) {
                void serveOrder(tableId, id);
                return;
              }
            }
          }}
          onDeleteOrder={(id) => {
            for (const [tableId, list] of ordersByTable) {
              const o = list.find((x) => x.id === id);
              if (o) {
                void cancelOrder(tableId, id);
                return;
              }
            }
          }}
          onRefillBottle={handleRefillBottle}
          onSaveSettings={handleSaveSettings}
          orders={orders}
          preparingOrders={preparingOrders}
          readyOrders={readyOrders}
          servedOrdersCount={servedOrdersCount}
          setAutoCleanEnabled={setAutoCleanEnabled}
          setDispenseSpeedMlS={setDispenseSpeedMlS}
          setIceDispenseTimeS={setIceDispenseTimeS}
          settingsFeedback={settingsFeedback}
          inventoryFeedback={inventoryFeedback}
          esp32WifiConfig={esp32WifiConfigState}
          esp32Feedback={esp32Feedback}
          setEsp32ConfigValue={setEsp32ConfigValue}
          onSendEsp32Config={handleSendEsp32Config}
          onTestPumpCalib={async (pumpIdx: number) => {
            const pumpNum = pumpIdx + 1;
            try {
              await admin.sendTestMotorAbs(getPumpPosition(pumpNum));
              await sleep(2500);
              await admin.sendTestPump(pumpNum, 10_000);
              return true;
            } catch {
              return false;
            }
          }}
          onSendTestHw={async (payload) => admin.testHardware(payload as any)}
          onPowerOn={async () => {
            try {
              const ack = await admin.powerOn();
              return ack.accepted;
            } catch {
              return false;
            }
          }}
          onPowerOff={async () => {
            try {
              const ack = await admin.powerOff();
              return ack.accepted;
            } catch {
              return false;
            }
          }}
          onClean={async () => {
            try {
              const ack = await admin.clean();
              return ack.accepted;
            } catch {
              return false;
            }
          }}
          onEmergencyStop={async () => {
            try {
              const ack = await admin.emergencyStop();
              return ack.accepted;
            } catch {
              return false;
            }
          }}
          pumpCalibrations={pumpCalibrations}
          setPumpCalibrations={setPumpCalibrations}
          carriagePositions={carriagePositions}
          setCarriagePositions={setCarriagePositions}
        />
      )}
    </SafeAreaView>
  );
}

function getPumpPosition(pumpNum: number): number {
  if (pumpNum === 1 || pumpNum === 2) return 1860;
  if (pumpNum === 3 || pumpNum === 4) return 1600;
  if (pumpNum === 5 || pumpNum === 6) return 1350;
  if (pumpNum === 7) return 1200;
  return 1860;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loaderText: {
    marginTop: 12,
    color: Colors.textMuted,
    fontSize: 14,
  },
});
