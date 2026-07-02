import React from 'react';
import { Modal, StyleSheet, Text, View, Pressable } from 'react-native';
import { Colors } from '../../constants/Colors';
import { Button } from './Button';

export interface DialogAction {
  text: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
}

export interface DialogProps {
  visible: boolean;
  title: string;
  message: string;
  actions: DialogAction[];
  onClose?: () => void;
}

export const Dialog = ({
  visible,
  title,
  message,
  actions,
  onClose,
}: DialogProps) => {
  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.container}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.actionsWrap}>
            {actions.map((action, idx) => (
              <Button
                key={idx}
                title={action.text}
                variant={action.variant || 'primary'}
                size="md"
                onPress={() => {
                  if (onClose) onClose();
                  if (action.onPress) action.onPress();
                }}
                style={styles.actionBtn}
              />
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  container: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: Colors.surface,
    borderRadius: 24,
    borderWidth: 1.2,
    borderColor: Colors.border,
    padding: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '900',
    color: Colors.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: 24,
  },
  actionsWrap: {
    width: '100%',
    gap: 10,
  },
  actionBtn: {
    width: '100%',
  },
});
