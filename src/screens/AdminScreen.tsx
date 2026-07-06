import React, { useState, useMemo, useEffect } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors } from '../constants/Colors';
import {
  BottleInventory,
  DrinkOrder,
  MachineSettings,
  MachineState,
  Recipe,
} from '../models';
import { useRecipeStore } from '../stores/RecipeStore';
import { formatCurrency, formatMl } from '../utils/drinkConfig';
import { getOrderStatusLabel } from '../utils/preparation';
import { formatTableLabel } from '../utils/tableQr';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Dialog, DialogAction } from '../components/ui/Dialog';
import { PreparationTimeline } from '../components/PreparationTimeline';
import { ConnectionSnapshot } from '../adapters/ICommunicationAdapter';

export type Esp32DeviceKey = 'kraken';

export type Esp32WifiConfig = {
  ssid: string;
  password: string;
  mqttHost: string;
  mqttPort: string;
};

export interface AdminScreenProps {
  autoCleanEnabled: boolean;
  dispenseSpeedMlS: string;
  iceDispenseTimeS: string;
  inventory: BottleInventory[];
  isConnected: boolean;
  connectionSnapshot?: ConnectionSnapshot;
  machineState: MachineState;
  settings: MachineSettings | null;
  onBack: () => void;
  onMarkServed: (orderId: string) => void;
  onDeleteOrder?: (orderId: string) => void;
  onRefillBottle: (bottleId: string) => void;
  onSaveSettings: (overrideSpeed?: number, updatedCalibs?: number[], updatedPositions?: number[]) => void;
  orders: DrinkOrder[];
  preparingOrders: DrinkOrder[];
  readyOrders: DrinkOrder[];
  servedOrdersCount: number;
  setAutoCleanEnabled: (value: boolean) => void;
  setDispenseSpeedMlS: (value: string) => void;
  setIceDispenseTimeS: (value: string) => void;
  settingsFeedback: string;
  inventoryFeedback: string;
  esp32WifiConfig: Record<Esp32DeviceKey, Esp32WifiConfig>;
  esp32Feedback: string;
  setEsp32ConfigValue: (deviceId: Esp32DeviceKey, field: keyof Esp32WifiConfig, value: string) => void;
  onSendEsp32Config: (deviceId: Esp32DeviceKey) => void;
  onTestPumpCalib?: (pumpIdx: number) => Promise<boolean>;
  onSendTestHw?: (payload: Record<string, unknown>) => Promise<unknown>;
  onPowerOn?: () => Promise<boolean>;
  onPowerOff?: () => Promise<boolean>;
  onClean?: () => Promise<boolean>;
  onEmergencyStop?: () => Promise<boolean>;
  pumpCalibrations: number[];
  setPumpCalibrations: React.Dispatch<React.SetStateAction<number[]>>;
  carriagePositions: number[];
  setCarriagePositions: React.Dispatch<React.SetStateAction<number[]>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AdminScreen({
  autoCleanEnabled,
  dispenseSpeedMlS,
  iceDispenseTimeS,
  inventory,
  isConnected,
  connectionSnapshot,
  machineState,
  settings,
  onBack,
  onMarkServed,
  onDeleteOrder,
  onRefillBottle,
  onSaveSettings,
  orders,
  preparingOrders,
  readyOrders,
  servedOrdersCount,
  setAutoCleanEnabled,
  setDispenseSpeedMlS,
  setIceDispenseTimeS,
  settingsFeedback,
  inventoryFeedback,
  esp32WifiConfig,
  esp32Feedback,
  setEsp32ConfigValue,
  onSendEsp32Config,
  onTestPumpCalib,
  onSendTestHw,
  onPowerOn,
  onPowerOff,
  onClean,
  onEmergencyStop,
  pumpCalibrations,
  setPumpCalibrations,
  carriagePositions,
  setCarriagePositions,
}: AdminScreenProps) {
  const { recipes, updateRecipePrice } = useRecipeStore();
  const [recipePrices, setRecipePrices] = useState<Record<string, string>>({});
  
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

  // Caudal & Actuadores testing hardware state
  const [testPumpNum, setTestPumpNum] = useState('1');
  const [testServoNum, setTestServoNum] = useState('1');
  const [testServoAngle, setTestServoAngle] = useState('90');
  const [testMotorSteps, setTestMotorSteps] = useState('100');
  const [testMotorAbsPos, setTestMotorAbsPos] = useState('1000');
  
  // Spoon travel and stir custom durations
  const [spoonTravelTimeMs, setSpoonTravelTimeMs] = useState('2500');
  const [spoonStirIntervalMs, setSpoonStirIntervalMs] = useState('400');
  
  // R385 Pump Calibration state
  const [grams10s, setGrams10s] = useState('');
  const [calculatedFlowRate, setCalculatedFlowRate] = useState<number | null>(null);
  const [calculatedTime30ml, setCalculatedTime30ml] = useState<number | null>(null);
  const [attempt1, setAttempt1] = useState('');
  const [attempt2, setAttempt2] = useState('');
  const [attempt3, setAttempt3] = useState('');
  const [calibFeedback, setCalibFeedback] = useState('');

  const [stirring, setStirring] = useState(false);
  const [localFeedback, setLocalFeedback] = useState('');

  const [localCalibs, setLocalCalibs] = useState<string[]>([]);
  const [localPositions, setLocalPositions] = useState<string[]>([]);

  useEffect(() => {
    if (pumpCalibrations && pumpCalibrations.length > 0) {
      setLocalCalibs(pumpCalibrations.map(String));
    }
  }, [pumpCalibrations]);

  useEffect(() => {
    if (carriagePositions && carriagePositions.length > 0) {
      setLocalPositions(carriagePositions.map(String));
    }
  }, [carriagePositions]);

  const handleSaveCalibrations = () => {
    const parsedCalibs = localCalibs.map(Number);
    const parsedPositions = localPositions.map(Number);

    if (parsedCalibs.some(isNaN) || parsedCalibs.some(c => c <= 0)) {
      setCalibFeedback('Los caudales de las bombas deben ser números válidos mayores a 0.');
      return;
    }
    if (parsedPositions.some(isNaN) || parsedPositions.some(p => p < 0 || p > 4000)) {
      setCalibFeedback('Las posiciones de riel deben ser números válidos entre 0 y 4000.');
      return;
    }

    setPumpCalibrations(parsedCalibs);
    setCarriagePositions(parsedPositions);
    onSaveSettings(undefined, parsedCalibs, parsedPositions);
    setCalibFeedback('Calibraciones guardadas y sincronizadas.');
    setTimeout(() => setCalibFeedback(''), 4000);
  };

  const handleTestPumpCalib = async (pumpIdx: number) => {
    const pumpNum = pumpIdx + 1;
    setLocalFeedback(`Preparando prueba para Bomba ${pumpNum}...`);

    if (!onTestPumpCalib) {
      setLocalFeedback('Función de prueba no disponible en este momento.');
      return;
    }

    setLocalFeedback(`Posicionando carro y probando Bomba ${pumpNum} por 10 segundos...`);
    const ok = await onTestPumpCalib(pumpIdx);

    if (ok) {
      setLocalFeedback(`Prueba de Bomba ${pumpNum} finalizada. Mide la cantidad en ml y usa la calculadora.`);
      setTestPumpNum(String(pumpNum));
    } else {
      setLocalFeedback(`Error al probar la Bomba ${pumpNum}.`);
    }
  };

  const handleApplyCalculatedFlow = () => {
    const pIdx = Number(testPumpNum) - 1;
    const ml = Number(grams10s);
    if (pIdx < 0 || pIdx > 6 || isNaN(ml) || ml <= 0 || ml > 500) {
      setCalibFeedback('Ingresa una bomba válida (1-7) y cantidad obtenida válida.');
      return;
    }
    const newRate = Number((ml / 10.0).toFixed(1));
    const nextCalibs = [...localCalibs];
    nextCalibs[pIdx] = String(newRate);
    setLocalCalibs(nextCalibs);
    setCalibFeedback(`Caudal de Bomba ${pIdx + 1} actualizado localmente a ${newRate} ml/s. Presiona Guardar.`);
  };

  // Sync internal recipe price fields
  useEffect(() => {
    const prices: Record<string, string> = {};
    recipes.forEach((r) => {
      prices[r.id] = String(r.price);
    });
    setRecipePrices(prices);
  }, [recipes]);

  const handleSaveRecipePriceLocal = async (recipeId: string) => {
    const val = recipePrices[recipeId];
    const numeric = parseInt(val, 10);
    if (isNaN(numeric) || numeric < 0) {
      showCustomDialog('Valor no válido', 'El precio debe ser un número positivo.', [
        { text: 'Aceptar', variant: 'outline' },
      ]);
      return;
    }
    await updateRecipePrice(recipeId, numeric);
    showCustomDialog('Guardado', 'El precio fue actualizado exitosamente.', [
      { text: 'Aceptar', variant: 'primary' },
    ]);
  };

  const getPumpPosition = (pumpNum: number): number => {
    if (pumpNum === 1 || pumpNum === 2) return 1860;
    if (pumpNum === 3 || pumpNum === 4) return 1600;
    if (pumpNum === 5 || pumpNum === 6) return 1350;
    if (pumpNum === 7) return 1200;
    return 1860;
  };

  const handleSendTestHw = async (payload: {
    type: 'pump' | 'servo' | 'servo_cont' | 'motor' | 'motor_home' | 'full_test' | 'dry_test' | 'motor_abs' | 'vaso_test' | 'hielo_test' | 'cuchara_test';
    pin?: number;
    val?: number;
    duration?: number;
  }) => {
    // 1. Validations
    if (payload.type === 'pump') {
      const pin = payload.pin ?? 1;
      if (pin < 1 || pin > 7) {
        showCustomDialog('Límite de seguridad', 'El número de bomba debe ser entre 1 y 7.', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }
      if (payload.duration && (payload.duration < 100 || payload.duration > 30000)) {
        showCustomDialog('Límite de seguridad', 'La duración debe estar entre 100ms y 30s.', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }

      // Automatically position the carriage before activating the pump
      const targetPos = getPumpPosition(pin);
      setLocalFeedback(`Posicionando carro en ${targetPos} pasos para Bomba ${pin}...`);
      if (onSendTestHw) {
        try {
          await onSendTestHw({ type: 'motor_abs', val: targetPos });
        } catch {
          setLocalFeedback('Error al posicionar el carro. Operación cancelada.');
          return;
        }
      } else {
        return;
      }

      // Wait 2.5 seconds for the carriage to reach the target position
      await sleep(2500);
    }

    if (payload.type === 'servo') {
      const pin = payload.pin ?? 1;
      if (pin < 1 || pin > 3) {
        showCustomDialog('Límite de seguridad', 'El número de servo debe ser entre 1 y 3 (1: Vaso, 2: Hielo A, 3: Hielo B).', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }
      const angle = payload.val ?? 0;
      if (angle < 0 || angle > 180) {
        showCustomDialog('Límite de seguridad', 'El ángulo del servo debe estar entre 0° y 180°.', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }
    }

    if (payload.type === 'motor') {
      const steps = payload.val ?? 0;
      if (steps < -2000 || steps > 2000) {
        showCustomDialog('Límite de seguridad', 'Los pasos relativos del motor deben estar entre -2000 y 2000.', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }
    }

    if (payload.type === 'motor_abs') {
      const pos = payload.val ?? 0;
      if (pos < 0 || pos > 4000) {
        showCustomDialog('Límite de seguridad', 'La posición absoluta del motor debe estar entre 0 y 4000 pasos.', [
          { text: 'Aceptar', variant: 'outline' }
        ]);
        return;
      }
    }

    setLocalFeedback(`Enviando comando: ${payload.type}...`);
    if (!onSendTestHw) {
      setLocalFeedback('Función de prueba no disponible.');
      return;
    }
    try {
      await onSendTestHw(payload);
      setLocalFeedback('Comando enviado correctamente.');
    } catch {
      setLocalFeedback('Fallo al enviar comando.');
    }
    setTimeout(() => setLocalFeedback(''), 4000);
  };

  const handleCalculateFlow = () => {
    const grams = Number(grams10s);
    if (isNaN(grams) || grams <= 0 || grams > 200) {
      setCalibFeedback("Ingresa un valor válido entre 1 y 200 gramos/ml.");
      return;
    }
    const flow = grams / 10.0;
    const time = 30.0 / flow;
    setCalculatedFlowRate(flow);
    setCalculatedTime30ml(time);
    setCalibFeedback(`Caudal calculado: ${flow.toFixed(2)} ml/s. Est. 30ml en ${time.toFixed(2)}s.`);
  };

  const handleAjustarVelocidad = () => {
    const a1 = Number(attempt1);
    const a2 = Number(attempt2);
    const a3 = Number(attempt3);
    if (
      isNaN(a1) || isNaN(a2) || isNaN(a3) ||
      a1 <= 0 || a1 > 200 ||
      a2 <= 0 || a2 > 200 ||
      a3 <= 0 || a3 > 200
    ) {
      setCalibFeedback("Ingresa valores válidos entre 1 y 200 ml para los 3 intentos.");
      return;
    }

    const avg = (a1 + a2 + a3) / 3.0;
    const currentSpeed = Number(dispenseSpeedMlS);
    if (isNaN(currentSpeed) || currentSpeed <= 0) {
      setCalibFeedback("Velocidad de dispensado actual no es válida.");
      return;
    }

    // new_speed = current_speed * (avg / 30)
    const nextSpeed = currentSpeed * (avg / 30.0);
    setDispenseSpeedMlS(nextSpeed.toFixed(1));
    
    showCustomDialog(
      'Ajustar Calibración',
      `El promedio de tus 3 intentos es de ${avg.toFixed(1)}ml. Se recalculará la velocidad de dispensado a ${nextSpeed.toFixed(1)} ml/s. ¿Guardar parámetro en settings?`,
      [
        { text: 'Cancelar', variant: 'outline' },
        {
          text: 'Guardar',
          variant: 'primary',
          onPress: () => {
            onSaveSettings(nextSpeed);
            setCalibFeedback(`Velocidad de dispensado guardada: ${nextSpeed.toFixed(1)} ml/s.`);
          }
        }
      ]
    );
  };

  const handleSpoonBajar = async () => {
    if (stirring) return;
    setStirring(true);
    setLocalFeedback("Bajando cuchara para prueba...");
    const travelTime = Number(spoonTravelTimeMs);
    try {
      if (!onSendTestHw) return;
      await onSendTestHw({ type: 'servo_cont', val: 100, duration: travelTime });
      await sleep(travelTime + 100);
      setLocalFeedback("Cuchara abajo.");
    } catch (err) {
      setLocalFeedback("Error al bajar.");
    } finally {
      setStirring(false);
      setTimeout(() => setLocalFeedback(''), 4000);
    }
  };

  const handleSpoonSubir = async () => {
    if (stirring) return;
    setStirring(true);
    setLocalFeedback("Subiendo cuchara para prueba...");
    const travelTime = Number(spoonTravelTimeMs);
    try {
      if (!onSendTestHw) return;
      await onSendTestHw({ type: 'servo_cont', val: -100, duration: travelTime });
      await sleep(travelTime + 100);
      setLocalFeedback("Cuchara arriba.");
    } catch (err) {
      setLocalFeedback("Error al subir.");
    } finally {
      setStirring(false);
      setTimeout(() => setLocalFeedback(''), 4000);
    }
  };

  const handleStirOnly = async () => {
    if (stirring) return;
    setStirring(true);
    setLocalFeedback("Probando oscilación de mezcla (Revolviendo)...");
    const stirTime = Number(spoonStirIntervalMs);
    try {
      if (!onSendTestHw) return;
      for (let i = 0; i < 4; i++) {
        await onSendTestHw({ type: 'servo_cont', val: -100, duration: stirTime });
        await sleep(stirTime + 50);

        await onSendTestHw({ type: 'servo_cont', val: 100, duration: stirTime });
        await sleep(stirTime + 50);
      }
      // Stop
      await onSendTestHw({ type: 'servo_cont', val: 0, duration: 0 });
      setLocalFeedback("Prueba de oscilación completada.");
    } catch (err) {
      setLocalFeedback("Error durante la oscilación.");
    } finally {
      setStirring(false);
      setTimeout(() => setLocalFeedback(''), 4000);
    }
  };

  const handleMixCycle = async () => {
    if (stirring) return;
    setStirring(true);
    setLocalFeedback("Iniciando ciclo de mezcla...");
    const travelTime = Number(spoonTravelTimeMs);
    const stirTime = Number(spoonStirIntervalMs);
    try {
      if (!onSendTestHw) return;
      // 1. Bajar
      setLocalFeedback("1/3 Bajando cuchara...");
      await onSendTestHw({ type: 'servo_cont', val: 100, duration: travelTime });
      await sleep(travelTime + 100);

      // 2. Alternar rápido (oscilar)
      setLocalFeedback("2/3 Revolviendo (Alternando subir/bajar rápido)...");
      for (let i = 0; i < 4; i++) {
        await onSendTestHw({ type: 'servo_cont', val: -100, duration: stirTime });
        await sleep(stirTime + 50);

        await onSendTestHw({ type: 'servo_cont', val: 100, duration: stirTime });
        await sleep(stirTime + 50);
      }

      // 3. Subir
      setLocalFeedback("3/3 Subiendo cuchara...");
      await onSendTestHw({ type: 'servo_cont', val: -100, duration: travelTime });
      await sleep(travelTime + 100);

      // 4. Detener
      await onSendTestHw({ type: 'servo_cont', val: 0, duration: 0 });

      setLocalFeedback("Mezclado finalizado con éxito.");
    } catch (err) {
      setLocalFeedback("Error durante la prueba de mezcla.");
    } finally {
      setStirring(false);
      setTimeout(() => setLocalFeedback(''), 4000);
    }
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
            try {
              if (onEmergencyStop) await onEmergencyStop();
            } catch {
              // ignore
            }
            setTimeout(() => {
              showCustomDialog(
                'Detenido',
                'Comando de parada de emergencia enviado con éxito.',
                [{ text: 'Aceptar', variant: 'primary' }]
              );
            }, 500);
          },
        },
      ]
    );
  };

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
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Emergency Stop Banner or Reactivation Banner */}
      {!machineState.isOn ? (
        <Card style={[styles.emergencyCard, { backgroundColor: 'rgba(239, 68, 68, 0.08)', borderColor: Colors.error }]} glow={false}>
          <View style={styles.emergencyRow}>
            <FontAwesome name="exclamation-triangle" size={24} color={Colors.error} />
            <View style={[styles.emergencyTextWrap, { marginLeft: 12 }]}>
              <Text style={[styles.emergencyTitle, { color: Colors.text }]}>MAQUINA APAGADA</Text>
              <Text style={[styles.emergencySubtitle, { color: Colors.textMuted }]}>La corriente del dosificador esta desactivada.</Text>
            </View>
            {connectionSnapshot?.deviceOnline ? (
              <Button
                title="ENCENDER"
                variant="primary"
                size="sm"
                onPress={async () => {
                  let success = false;
                  try {
                    if (onPowerOn) success = await onPowerOn();
                  } catch {
                    success = false;
                  }
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
        <Card style={styles.emergencyCard} glow>
          <View style={styles.emergencyRow}>
            <FontAwesome name="exclamation-triangle" size={24} color="#ffffff" />
            <View style={styles.emergencyTextWrap}>
              <Text style={styles.emergencyTitle}>PARADA DE EMERGENCIA</Text>
              <Text style={styles.emergencySubtitle}>Detiene de inmediato todo hardware activo</Text>
            </View>
            <Button
              title="DETENER"
              variant="danger"
              size="sm"
              onPress={handleEmergencyStop}
              style={styles.stopBtn}
            />
          </View>
        </Card>
      ) : (
        <Card style={[styles.emergencyCard, { backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: '#F59E0B' }]} glow={false}>
          <View style={styles.emergencyRow}>
            <FontAwesome name="exclamation-triangle" size={24} color="#F59E0B" />
            <View style={styles.emergencyTextWrap}>
              <Text style={[styles.emergencyTitle, { color: '#F59E0B' }]}>ESP32 fuera de linea</Text>
              <Text style={[styles.emergencySubtitle, { color: Colors.textMuted }]}>La maquina no responde en la red. Parada de emergencia no disponible.</Text>
            </View>
          </View>
        </Card>
      )}

      <View style={styles.topBar}>
        <Pressable style={styles.backChip} onPress={onBack}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </Pressable>
      </View>

      {connectionSnapshot && connectionSnapshot.broker !== 'connected' ? (
        <View style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', borderColor: Colors.error, borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center' }}>
          <FontAwesome name="wifi" size={18} color={Colors.error} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: Colors.error, fontWeight: 'bold', fontSize: 14 }}>Sin Conexion al Broker MQTT</Text>
            <Text style={{ color: Colors.textMuted, fontSize: 12, marginTop: 2 }}>Verifica la red local o la direccion IP y puerto del broker.</Text>
          </View>
        </View>
      ) : connectionSnapshot && !connectionSnapshot.deviceOnline ? (
        <View style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', borderColor: '#F59E0B', borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center' }}>
          <FontAwesome name="exclamation-triangle" size={18} color="#F59E0B" style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#F59E0B', fontWeight: 'bold', fontSize: 14 }}>Broker Conectado - ESP32 Offline</Text>
            <Text style={{ color: Colors.textMuted, fontSize: 12, marginTop: 2 }}>El broker esta activo pero la maquina ESP32 no reporta presencia en la red.</Text>
          </View>
        </View>
      ) : null}

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Estado de la maquina</Text>
        <Text style={styles.sectionText}>Conexion ESP32: {isConnected ? 'Activa y Online' : connectionSnapshot?.broker === 'connected' ? 'Broker OK, ESP32 Offline' : 'Sin conexion a broker'}</Text>
        <Text style={styles.sectionText}>Operacion actual: {machineState.status.toUpperCase()}</Text>
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Conexión WiFi & Broker</Text>
        {esp32Feedback ? <Text style={styles.feedbackText}>{esp32Feedback}</Text> : null}
        <View style={styles.deviceConfigBlock}>
          <Text style={styles.deviceTitle}>Controlador Penpito (ESP32)</Text>

          <Text style={styles.inputLabel}>SSID WiFi</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            value={esp32WifiConfig['kraken']?.ssid || ''}
            onChangeText={(value) => setEsp32ConfigValue('kraken', 'ssid', value)}
          />

          <Text style={styles.inputLabel}>Clave WiFi</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
            value={esp32WifiConfig['kraken']?.password || ''}
            onChangeText={(value) => setEsp32ConfigValue('kraken', 'password', value)}
          />

          <Text style={styles.inputLabel}>MQTT Broker Host</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            value={esp32WifiConfig['kraken']?.mqttHost || ''}
            onChangeText={(value) => setEsp32ConfigValue('kraken', 'mqttHost', value)}
          />

          <Text style={styles.inputLabel}>MQTT Port</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            value={esp32WifiConfig['kraken']?.mqttPort || ''}
            onChangeText={(value) => setEsp32ConfigValue('kraken', 'mqttPort', value)}
          />

          <Button
            title="Enviar Configuración"
            variant="outline"
            size="sm"
            onPress={() => onSendEsp32Config('kraken')}
            style={styles.sendBtn}
          />
        </View>
      </Card>

      <View style={styles.metricsRow}>
        <MetricCard label="Pedidos" value={String(orders.length)} />
        <MetricCard label="Listos" value={String(readyOrders.length)} accent="warning" />
        <MetricCard label="Servidos" value={String(servedOrdersCount)} accent="success" />
      </View>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Ranking de Consumos</Text>
        {recipeStats.length === 0 ? (
          <Text style={styles.sectionText}>No hay registros de consumos aún.</Text>
        ) : (
          recipeStats.map((item, idx) => (
            <View key={item.name} style={styles.statsRow}>
              <Text style={styles.statsName}>{idx + 1}. {item.name}</Text>
              <Text style={styles.statsCount}>{item.count} pedidos</Text>
            </View>
          ))
        )}
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Precios de Coctelería</Text>
        <Text style={styles.sectionText}>Modifica los precios que se le muestran al cliente directamente en la carta:</Text>
        {recipes.map((r) => (
          <View key={r.id} style={styles.priceEditRow}>
            <Text style={styles.priceEditLabel}>{r.name}</Text>
            <View style={styles.priceEditInputWrap}>
              <TextInput
                keyboardType="numeric"
                style={styles.priceEditInput}
                value={recipePrices[r.id] ?? ''}
                onChangeText={(val) => setRecipePrices(p => ({ ...p, [r.id]: val }))}
              />
              <Button
                title="Actualizar"
                variant="outline"
                size="sm"
                onPress={() => handleSaveRecipePriceLocal(r.id)}
                style={styles.priceSaveBtn}
              />
            </View>
          </View>
        ))}
      </Card>



      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Configuración General de Operación</Text>
        {settingsFeedback ? (
          <View style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', borderColor: Colors.success, borderWidth: 1, padding: 12, borderRadius: 8, marginBottom: 16 }}>
            <Text style={{ color: Colors.success, fontWeight: '600', fontSize: 14 }}>{settingsFeedback}</Text>
          </View>
        ) : null}
        <Text style={styles.sectionText}>Ajusta las velocidades generales y funciones automáticas del equipo:</Text>
        
        <Text style={styles.inputLabel}>Velocidad por Defecto (ml/s)</Text>
        <TextInput
          keyboardType="numeric"
          style={styles.input}
          value={dispenseSpeedMlS}
          onChangeText={setDispenseSpeedMlS}
        />

        <Text style={styles.inputLabel}>Tiempo de Hielo por Defecto (s)</Text>
        <TextInput
          keyboardType="numeric"
          style={styles.input}
          value={iceDispenseTimeS}
          onChangeText={setIceDispenseTimeS}
        />

        <Button
          title="Guardar Configuración General"
          variant="primary"
          size="md"
          onPress={() => onSaveSettings()}
          style={{ marginTop: 8 } as any}
        />
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Calibración de Caudal de Bombas</Text>
        <Text style={styles.sectionText}>Configura el caudal (ml por segundo) para cada bomba individualmente:</Text>

        {localCalibs.map((rate, idx) => {
          const pumpNames = [
            'B1 (Pisco)',
            'B2 (Amaretto)',
            'B3 (Gin)',
            'B4 (Coca-Cola)',
            'B5 (Vermut Rosso)',
            'B6 (Whisky)',
            'B7 (Campari)',
          ];
          return (
            <View key={idx} style={styles.priceEditRow}>
              <Text style={styles.priceEditLabel}>{pumpNames[idx] || `Bomba ${idx + 1}`}</Text>
              <View style={styles.priceEditInputWrap}>
                <TextInput
                  keyboardType="numeric"
                  style={styles.priceEditInput}
                  value={rate}
                  onChangeText={(val) => {
                    const next = [...localCalibs];
                    next[idx] = val;
                    setLocalCalibs(next);
                  }}
                />
                <Button
                  title="Test 10s"
                  variant="outline"
                  size="sm"
                  onPress={() => handleTestPumpCalib(idx)}
                  style={styles.priceSaveBtn}
                />
              </View>
            </View>
          );
        })}

        {/* CALCULADORA DE CAUDAL INTEGRADA */}
        <View style={[styles.hwTestBlock, { marginTop: 20, backgroundColor: Colors.surfaceHighlight, padding: 12, borderRadius: 16 }]}>
          <Text style={styles.hwBlockTitle}>Calculadora de Flujo R385</Text>
          <Text style={styles.sectionText}>Usa esta sección después del test de 10s para actualizar el caudal medido:</Text>
          
          <View style={styles.attemptsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Bomba (1-7)</Text>
              <TextInput
                keyboardType="numeric"
                style={styles.input}
                value={testPumpNum}
                onChangeText={setTestPumpNum}
              />
            </View>
            <View style={{ flex: 1.5, marginLeft: 10 }}>
              <Text style={styles.inputLabel}>ml obtenidos en 10s</Text>
              <TextInput
                keyboardType="numeric"
                style={styles.input}
                placeholder="Ej: 240"
                value={grams10s}
                onChangeText={setGrams10s}
              />
            </View>
          </View>

          <Button
            title="Aplicar Caudal a la Bomba"
            variant="secondary"
            size="sm"
            onPress={handleApplyCalculatedFlow}
            style={{ marginTop: 10 }}
          />
        </View>
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Calibración de Posiciones del Riel</Text>
        <Text style={styles.sectionText}>Configura las coordenadas (pasos desde Home) para cada estación física:</Text>

        {localPositions.map((pos, idx) => {
          const positionLabels = [
            'Vasos (POS_CUP)',
            'Hielo (POS_ICE)',
            'Agitador (POS_STIR)',
            'Listo (POS_READY)',
            'Pisco/Amaretto (B1-B2)',
            'Gin/Mixer (B3-B4)',
            'Vermut/Whisky (B5-B6)',
            'Campari (B7)',
          ];
          return (
            <View key={idx} style={styles.priceEditRow}>
              <Text style={styles.priceEditLabel}>{positionLabels[idx] || `Estación ${idx + 1}`}</Text>
              <View style={styles.priceEditInputWrap}>
                <TextInput
                  keyboardType="numeric"
                  style={styles.priceEditInput}
                  value={pos}
                  onChangeText={(val) => {
                    const next = [...localPositions];
                    next[idx] = val;
                    setLocalPositions(next);
                  }}
                />
                <Button
                  title="Mover"
                  variant="outline"
                  size="sm"
                  onPress={() => handleSendTestHw({
                    type: 'motor_abs',
                    val: Number(pos)
                  })}
                  style={styles.priceSaveBtn}
                />
              </View>
            </View>
          );
        })}

        {calibFeedback ? <Text style={styles.calibFeedbackText}>{calibFeedback}</Text> : null}
        
        <Button
          title="Guardar y Sincronizar Calibración"
          variant="primary"
          onPress={handleSaveCalibrations}
          style={[styles.saveSettingsBtn, { marginTop: 16 }]}
        />
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Diagnósticos y Control Manual</Text>
        <Text style={styles.sectionText}>Prueba y calibra los actuadores físicos mediante señales directas MQTT.</Text>
        
        {localFeedback ? (
          <Text style={styles.localFeedbackText}>{localFeedback}</Text>
        ) : null}

        {/* SERVOS */}
        <View style={styles.hwTestBlock}>
          <Text style={styles.hwBlockTitle}>Prueba de Servomotores</Text>
          <Text style={styles.inputLabel}>Seleccionar Servo (1: Vaso, 2: Hielo A, 3: Hielo B)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="1"
            value={testServoNum}
            onChangeText={setTestServoNum}
          />
          <Text style={styles.inputLabel}>Ángulo de destino (0 - 180°)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="90"
            value={testServoAngle}
            onChangeText={setTestServoAngle}
          />
          <View style={styles.rowButtons}>
            <Button
              title="0°"
              variant="secondary"
              size="sm"
              onPress={() => {
                setTestServoAngle('0');
                void handleSendTestHw({ type: 'servo', pin: Number(testServoNum), val: 0 });
              }}
              style={styles.rowBtn3}
            />
            <Button
              title="90°"
              variant="secondary"
              size="sm"
              onPress={() => {
                setTestServoAngle('90');
                void handleSendTestHw({ type: 'servo', pin: Number(testServoNum), val: 90 });
              }}
              style={styles.rowBtn3}
            />
            <Button
              title="180°"
              variant="secondary"
              size="sm"
              onPress={() => {
                setTestServoAngle('180');
                void handleSendTestHw({ type: 'servo', pin: Number(testServoNum), val: 180 });
              }}
              style={styles.rowBtn3}
            />
          </View>
          <Button
            title="Mover Servo"
            variant="outline"
            onPress={() => handleSendTestHw({
              type: 'servo',
              pin: Number(testServoNum),
              val: Number(testServoAngle)
            })}
            style={styles.moveBtn}
          />
        </View>

        {/* AGITADOR CUCHARA MEZCLADORA */}
        <View style={styles.hwTestBlock}>
          <Text style={styles.hwBlockTitle}>Agitador (Cuchara Mezcladora)</Text>
          <Text style={styles.sectionText}>Prueba el recorrido vertical del agitador para evitar límites mecánicos, u oscila la mezcla de forma independiente.</Text>
          
          <Text style={styles.inputLabel}>Tiempo de Viaje Bajar/Subir (ms)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="2500"
            value={spoonTravelTimeMs}
            onChangeText={setSpoonTravelTimeMs}
          />

          <Text style={styles.inputLabel}>Intervalo de Mezcla Oscilante (ms)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="400"
            value={spoonStirIntervalMs}
            onChangeText={setSpoonStirIntervalMs}
          />

          <View style={styles.rowButtons}>
            <Button
              title="Bajar Cuchara"
              variant="outline"
              size="sm"
              disabled={stirring}
              onPress={handleSpoonBajar}
              style={styles.rowBtn}
            />
            <Button
              title="Subir Cuchara"
              variant="outline"
              size="sm"
              disabled={stirring}
              onPress={handleSpoonSubir}
              style={styles.rowBtn}
            />
          </View>

          <View style={styles.rowButtons}>
            <Button
              title="Probar Mezcla (Oscilar)"
              variant="secondary"
              size="sm"
              disabled={stirring}
              onPress={handleStirOnly}
              style={styles.rowBtn}
            />
            <Button
              title="Ciclo Mezcla Completo"
              variant="primary"
              size="sm"
              disabled={stirring}
              onPress={handleMixCycle}
              style={styles.rowBtn}
            />
          </View>
        </View>

        {/* MOTOR RIEL */}
        <View style={styles.hwTestBlock}>
          <Text style={styles.hwBlockTitle}>Calibración Riel Lineal (NEMA17)</Text>
          <Text style={styles.inputLabel}>Pasos a mover (Ej: 200, -200)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="100"
            value={testMotorSteps}
            onChangeText={setTestMotorSteps}
          />
          <View style={styles.rowButtons}>
            <Button
              title="Mover (Relativo)"
              variant="outline"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'motor',
                val: Number(testMotorSteps)
              })}
              style={styles.rowBtn}
            />
            <Button
              title="Ejecutar Home"
              variant="outline"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'motor_home'
              })}
              style={styles.rowBtn}
            />
          </View>

          <Text style={[styles.inputLabel, { marginTop: 12 }]}>Ir a Posición Absoluta (Pasos desde Home)</Text>
          <TextInput
            keyboardType="numeric"
            style={styles.input}
            placeholder="1000"
            value={testMotorAbsPos}
            onChangeText={setTestMotorAbsPos}
          />
          <Button
            title="Mover a Posición Absoluta"
            variant="outline"
            size="sm"
            onPress={() => handleSendTestHw({
              type: 'motor_abs',
              val: Number(testMotorAbsPos)
            })}
            style={{ marginTop: 4 }}
          />
        </View>

        {/* PRUEBAS INDIVIDUALES DE MÓDULOS */}
        <View style={styles.hwTestBlock}>
          <Text style={styles.hwBlockTitle}>Prueba de Módulos Individuales</Text>
          <Text style={styles.sectionText}>Prueba cada mecanismo de forma aislada en su posición física actual sin mover el carro.</Text>
          <View style={{ gap: 8, marginTop: 8 }}>
            <Button
              title="Probar Módulo Vaso"
              variant="outline"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'vaso_test'
              })}
            />
            <Button
              title="Probar Módulo Hielo"
              variant="outline"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'hielo_test'
              })}
            />
            <Button
              title="Probar Módulo Cuchara"
              variant="outline"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'cuchara_test'
              })}
            />
          </View>
        </View>

        {/* PRUEBA COMPLETA DE MÁQUINA */}
        <View style={styles.hwTestBlock}>
          <Text style={styles.hwBlockTitle}>Prueba de Máquina Completa (MX)</Text>
          <Text style={styles.sectionText}>Ejecuta la secuencia de diagnóstico completa de forma inalámbrica (vaso, cuchara, hielo, bombas y retorno final a home).</Text>
          <View style={{ gap: 8, marginTop: 8 }}>
            <Button
              title="Iniciar Secuencia Completa (Con Agua)"
              variant="primary"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'full_test'
              })}
            />
            <Button
              title="Iniciar Recorrido en Seco (Sin Agua)"
              variant="secondary"
              size="sm"
              onPress={() => handleSendTestHw({
                type: 'dry_test'
              })}
            />
          </View>
        </View>
      </Card>

      <Card style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>Nivel de Líquidos e Inventario</Text>
        {inventoryFeedback ? <Text style={styles.feedbackText}>{inventoryFeedback}</Text> : null}
        {inventory.map((bottle) => {
          const ratio = bottle.remaining_ml / bottle.capacity_ml;
          return (
            <View key={bottle.id} style={styles.bottleCard}>
              <View style={styles.bottleHeader}>
                <Text style={styles.bottleName}>{bottle.display_name}</Text>
                <Text style={styles.bottleRemaining}>{formatMl(bottle.remaining_ml)}</Text>
              </View>
              <Text style={styles.bottleCapacity}>Capacidad Máxima: 1.000 ml (1L)</Text>
              
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.max(ratio * 100, 4)}%` },
                    ratio < 0.2 && { backgroundColor: Colors.error }
                  ]}
                />
              </View>

              <View style={styles.rowButtons}>
                <Button
                  title="Rellenar Botella"
                  variant="primary"
                  size="sm"
                  onPress={() => onRefillBottle(bottle.id)}
                  style={[styles.rowBtn, { flex: 1 }]}
                />
              </View>
            </View>
          );
        })}
      </Card>

      {/* Global Dialog */}
      <Dialog
        visible={dialogVisible}
        title={dialogConfig.title}
        message={dialogConfig.message}
        actions={dialogConfig.actions}
        onClose={() => setDialogVisible(false)}
      />
      </ScrollView>
    </KeyboardAvoidingView>
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
    <Card style={styles.metricCard}>
      <Text style={[styles.metricValue, { color: accentColor }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </Card>
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
    marginBottom: 20,
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
  sectionCard: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: Colors.text,
    marginBottom: 10,
  },
  sectionText: {
    color: Colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  deviceConfigBlock: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  deviceTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.secondary,
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textMuted,
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 10,
    color: Colors.text,
    fontSize: 14,
  },
  sendBtn: {
    marginTop: 14,
    width: '100%',
  },
  feedbackText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 12,
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
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  statsName: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  statsCount: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  priceEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  priceEditLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
  },
  priceEditInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  priceEditInput: {
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: Colors.text,
    fontSize: 14,
    width: 80,
    textAlign: 'right',
  },
  priceSaveBtn: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 8,
  },
  switchLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
  },
  saveSettingsBtn: {
    marginTop: 16,
    width: '100%',
  },
  localFeedbackText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 12,
  },
  hwTestBlock: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  hwBlockTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.secondary,
    marginBottom: 8,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  rowBtn: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
  },
  rowBtn3: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
  },
  moveBtn: {
    marginTop: 10,
    width: '100%',
    minHeight: 38,
    borderRadius: 10,
  },
  bottleCard: {
    backgroundColor: Colors.surfaceHighlight,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  bottleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  bottleName: {
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  bottleRemaining: {
    fontSize: 15,
    fontWeight: '900',
    color: Colors.primary,
  },
  bottleCapacity: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 10,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
    marginBottom: 14,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.success,
    borderRadius: 4,
  },
  calibResultBlock: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginTop: 12,
  },
  calibResultText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  attemptsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    marginBottom: 12,
  },
  calibFeedbackText: {
    color: Colors.primary,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
  },
}) as any;
