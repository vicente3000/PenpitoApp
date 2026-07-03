import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, View, ActivityIndicator, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors } from '../src/constants/Colors';
import { AdminScreen, Esp32DeviceKey, Esp32WifiConfig } from '../src/screens/AdminScreen';
import { AdminLoginScreen } from '../src/screens/AdminLoginScreen';
import { useSettingsStore } from '../src/stores/SettingsStore';
import { useInventoryStore } from '../src/stores/InventoryStore';
import { useOrderStore } from '../src/stores/OrderStore';
import { useAppStore } from '../src/stores/AppStore';
import { deviceService } from '../src/services/DeviceService';

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
  const { orders, markOrderServed } = useOrderStore();
  const { isConnected, machineState } = useAppStore();

  const [adminUnlocked, setAdminUnlocked] = useState(false);
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
      setPumpCalibrations(settings.pump_calibrations || [24.2, 23.1, 21.1, 24.0, 24.3, 15.9, 23.1]);
      setCarriagePositions(settings.carriage_positions || [3600, 2600, 800, 100, 1860, 1600, 1350, 1200]);
    }
  }, [settings]);

  const handleAdminLogin = () => {
    if (adminPassword === 'admin123') {
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

    // Sync calibrations with ESP32 via MQTT
    if (isConnected) {
      void deviceService.sendCommand({
        cmd: 'SET_CALIB',
        target: 'kraken',
        rates: nextCalibs,
        positions: nextPositions
      } as any);
    }

    setSettingsFeedback('Parámetros guardados y sincronizados.');
    setTimeout(() => setSettingsFeedback(''), 3000);
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
    const success = await deviceService.sendCommand({
      cmd: 'CONFIG_WIFI',
      val: deviceId,
      target: deviceId,
      ssid,
      password: config.password,
      mqttHost,
      mqttPort,
    });

    setEsp32Feedback(
      success
        ? 'Configuración enviada correctamente.'
        : 'Error al enviar la configuración.'
    );
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

  const preparingOrders = useMemo(() => orders.filter((o) => o.status === 'preparing'), [orders]);
  const readyOrders = useMemo(() => orders.filter((o) => o.status === 'ready'), [orders]);
  const servedOrdersCount = useMemo(() => orders.filter((o) => o.status === 'served').length, [orders]);

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
          machineState={machineState}
          settings={settings}
          onBack={() => router.replace('/')}
          onMarkServed={(id) => void markOrderServed(id)}
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
          pumpCalibrations={pumpCalibrations}
          setPumpCalibrations={setPumpCalibrations}
          carriagePositions={carriagePositions}
          setCarriagePositions={setCarriagePositions}
        />
      )}
    </SafeAreaView>
  );
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
