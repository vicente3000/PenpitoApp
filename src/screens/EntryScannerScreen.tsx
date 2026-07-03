import React, { useState, useRef } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Shadows } from '../constants/Colors';
import { AppEntryQr } from '../models';
import { parseAccessQr } from '../utils/tableQr';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { resetDatabase } from '../repositories/LocalDatabase';
import { inventoryRepository } from '../repositories/InventoryRepository';
import { deviceService } from '../services/DeviceService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSessionStore } from '../stores/SessionStore';
import { useInventoryStore } from '../stores/InventoryStore';
import { useOrderStore } from '../stores/OrderStore';

interface EntryScannerScreenProps {
  onResolved: (entry: AppEntryQr) => void;
}

export function EntryScannerScreen({ onResolved }: EntryScannerScreenProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scannerPaused, setScannerPaused] = useState(false);
  const [scanError, setScanError] = useState('');
  const [showSim, setShowSim] = useState(false);

  const handleResetDb = async () => {
    try {
      // 1. Reiniciar SQLite (órdenes, configuraciones e inventario base)
      await resetDatabase();

      // 2. Limpiar AsyncStorage para mesas y nombres
      await AsyncStorage.removeItem('penpito.table.sessions');
      await AsyncStorage.removeItem('penpito.device.guestName');

      // 3. Recargar los almacenes Zustand a sus valores iniciales
      await useSessionStore.getState().loadSessions();
      await useInventoryStore.getState().loadInventory();
      await useOrderStore.getState().loadOrders();

      // 4. Publicar limpieza de mesas e inventario completo por MQTT a todos los celulares del local
      const remoteInventory = await inventoryRepository.getAllBottles();
      deviceService.publish('penpito/inventory/state', JSON.stringify(remoteInventory));
      
      for (let i = 1; i <= 10; i++) {
        deviceService.publish(`penpito/table/${i}/orders`, '[]');
        deviceService.publish(`penpito/table/${i}/session`, '{}');
      }

      setScanError('¡Éxito! Base de datos reiniciada y stock al 100% sincronizado en red.');
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setScanError(`Error al reiniciar: ${errMsg}`);
      console.error(e);
    }
  };

  const resolveRawValue = (value: string) => {
    const parsed = parseAccessQr(value);
    if (!parsed) {
      setScanError('QR no válido. Escanea un QR de mesa, mesero o administrador.');
      return;
    }

    setScanError('');
    setScannerPaused(true);
    onResolved(parsed);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable
          style={styles.bypassTrigger}
          onPress={() => setShowSim(prev => !prev)}
        >
          <FontAwesome
            name="cog"
            size={18}
            color={showSim ? Colors.primary : Colors.textMuted}
            style={{ opacity: 0.3 }}
          />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroCard}>
          <Image
            source={require('../../assets/images/penpito-logo.png')}
            style={styles.heroLogo}
            resizeMode="contain"
          />
        </View>

        <Card style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Escanea el QR de acceso</Text>
          <Text style={styles.sectionText}>
            El QR define automáticamente si la app entra como usuario de mesa, mesero o administrador.
          </Text>

          {permission == null ? (
            <View style={styles.cameraPlaceholder}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.cameraHelperText}>Preparando cámara...</Text>
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
              <Text style={styles.cameraPlaceholderTitle}>Permite la cámara</Text>
              <Text style={styles.cameraHelperText}>
                La cámara es necesaria para escanear el QR de acceso.
              </Text>
              {permission.canAskAgain ? (
                <Button
                  title="Permitir cámara"
                  variant="outline"
                  onPress={() => {
                    void requestPermission();
                  }}
                  style={styles.permissionBtn}
                />
              ) : null}
            </View>
          )}

          {scanError ? <Text style={styles.errorText}>{scanError}</Text> : null}

          {showSim && (
            <View style={styles.simContainer}>
              <Text style={[styles.sectionTitle, { fontSize: 16 }]}>Simulación para Demostración</Text>
              <Text style={[styles.sectionText, { fontSize: 13, marginBottom: 12 }]}>
                Usa estos accesos directos para probar la app en emuladores o si no tienes los códigos QR.
              </Text>
              <View style={styles.simRow}>
                <Button
                  title="Mesa 3"
                  variant="secondary"
                  size="sm"
                  onPress={() => onResolved({ type: 'table', table_number: 3, qr_value: 'PENPITO:MESA:03' })}
                  style={styles.simBtn}
                />
                <Button
                  title="Mesero"
                  variant="secondary"
                  size="sm"
                  onPress={() => onResolved({ type: 'waiter', qr_value: 'PENPITO:MESERO' })}
                  style={styles.simBtn}
                />
                <Button
                  title="Admin"
                  variant="secondary"
                  size="sm"
                  onPress={() => onResolved({ type: 'admin', qr_value: 'PENPITO:ADMIN' })}
                  style={styles.simBtn}
                />
              </View>

              <Button
                title="Reiniciar Base de Datos (Limpiar Todo)"
                variant="danger"
                size="sm"
                onPress={handleResetDb}
                style={{ marginTop: 16, width: '100%' }}
              />
            </View>
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 10,
    zIndex: 99,
  },
  bypassTrigger: {
    padding: 10,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroLogo: {
    width: '100%',
    height: 180,
  },
  sectionCard: {
    marginBottom: 16,
    padding: 20,
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
    marginBottom: 16,
  },
  cameraPlaceholder: {
    height: 280,
    borderRadius: 20,
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  cameraHelperText: {
    color: Colors.textMuted,
    fontSize: 13,
    marginTop: 10,
    textAlign: 'center',
  },
  cameraPlaceholderTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    marginTop: 12,
    marginBottom: 4,
  },
  permissionBtn: {
    marginTop: 16,
    width: '100%',
  },
  cameraShell: {
    height: 280,
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceHighlight,
  },
  cameraPreview: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  cameraOverlayTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  cameraOverlayText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 16,
  },
  cameraFrame: {
    width: 140,
    height: 140,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  errorText: {
    color: Colors.error,
    fontWeight: '700',
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
  },
  simContainer: {
    marginTop: 24,
    borderTopWidth: 1.2,
    borderTopColor: Colors.border,
    paddingTop: 20,
  },
  simRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  simBtn: {
    flex: 1,
  },
});
