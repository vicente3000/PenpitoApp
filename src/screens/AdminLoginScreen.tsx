import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors } from '../constants/Colors';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

interface AdminLoginScreenProps {
  adminError: string;
  adminPassword: string;
  onBack: () => void;
  onLogin: () => void;
  setAdminPassword: (value: string) => void;
}

export function AdminLoginScreen({
  adminError,
  adminPassword,
  onBack,
  onLogin,
  setAdminPassword,
}: AdminLoginScreenProps) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.topBar}>
        <Pressable style={styles.backChip} onPress={onBack}>
          <FontAwesome name="qrcode" size={14} color={Colors.text} />
          <Text style={styles.backChipText}>Otro QR</Text>
        </Pressable>
      </View>

      <Card style={styles.loginCard}>
        <Text style={styles.sectionTitle}>Ingreso administrador</Text>
        <Text style={styles.sectionText}>
          El QR admin ya te dejó en esta vista. Ahora valida la contraseña para cambiar parámetros.
        </Text>
        <TextInput
          secureTextEntry
          placeholder="admin123"
          placeholderTextColor={Colors.textMuted}
          style={styles.input}
          value={adminPassword}
          onChangeText={setAdminPassword}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {adminError ? <Text style={styles.errorText}>{adminError}</Text> : null}
        <Button
          title="Entrar"
          variant="primary"
          onPress={onLogin}
          style={styles.loginBtn}
        />
      </Card>
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
    justifyContent: 'flex-start',
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
  loginCard: {
    marginTop: 18,
    padding: 24,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: Colors.text,
    marginBottom: 8,
  },
  sectionText: {
    color: Colors.textMuted,
    lineHeight: 20,
    fontSize: 14,
    marginBottom: 20,
  },
  input: {
    backgroundColor: Colors.surfaceHighlight,
    borderWidth: 1.2,
    borderColor: Colors.border,
    borderRadius: 16,
    padding: 14,
    color: Colors.text,
    fontSize: 15,
    marginBottom: 20,
  },
  errorText: {
    color: Colors.error,
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 16,
    textAlign: 'center',
  },
  loginBtn: {
    width: '100%',
  },
}) as any;
