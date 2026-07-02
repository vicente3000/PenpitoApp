import React from 'react';
import { StyleProp, StyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { Colors, Shadows } from '../../constants/Colors';

export interface CardProps extends ViewProps {
  style?: StyleProp<ViewStyle>;
  glow?: boolean;
}

export const Card = ({ children, style, glow = false, ...props }: CardProps) => {
  return (
    <View
      style={[
        styles.card,
        glow && styles.glow,
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    backgroundColor: Colors.surface,
    borderWidth: 1.2,
    borderColor: Colors.border,
    padding: 20,
    marginBottom: 16,
    ...Shadows.glass,
  },
  glow: {
    borderColor: Colors.primary,
    ...Shadows.glowPrimary,
  },
});
