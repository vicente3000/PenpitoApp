import React from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Colors } from '../../constants/Colors';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface ButtonProps {
  onPress?: (event: GestureResponderEvent) => void;
  title: string;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<any>;
}

export const Button = ({
  onPress,
  title,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  style,
  textStyle,
}: ButtonProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
    };
  });

  const handlePressIn = () => {
    if (!disabled && !loading) {
      scale.value = withSpring(0.95, { damping: 15 });
    }
  };

  const handlePressOut = () => {
    if (!disabled && !loading) {
      scale.value = withSpring(1, { damping: 15 });
    }
  };

  const getVariantStyles = () => {
    switch (variant) {
      case 'primary':
        return {
          button: {
            backgroundColor: Colors.primary,
            borderColor: Colors.primary,
          },
          text: {
            color: '#ffffff',
          },
        };
      case 'secondary':
        return {
          button: {
            backgroundColor: Colors.surfaceHighlight,
            borderColor: Colors.surfaceHighlight,
          },
          text: {
            color: Colors.text,
          },
        };
      case 'outline':
        return {
          button: {
            backgroundColor: 'transparent',
            borderColor: Colors.borderHighlight,
            borderWidth: 1.5,
          },
          text: {
            color: Colors.primary,
          },
        };
      case 'danger':
        return {
          button: {
            backgroundColor: Colors.error,
            borderColor: Colors.error,
          },
          text: {
            color: '#ffffff',
          },
        };
      case 'ghost':
        return {
          button: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
          },
          text: {
            color: Colors.textMuted,
          },
        };
    }
  };

  const getSizeStyles = () => {
    switch (size) {
      case 'sm':
        return {
          button: {
            paddingVertical: 8,
            paddingHorizontal: 16,
            borderRadius: 12,
            minHeight: 44,
          },
          text: {
            fontSize: 13,
            fontWeight: '600',
          },
        };
      case 'md':
        return {
          button: {
            paddingVertical: 14,
            paddingHorizontal: 24,
            borderRadius: 18,
            minHeight: 48, // a11y touch target
          },
          text: {
            fontSize: 15,
            fontWeight: '700',
          },
        };
      case 'lg':
        return {
          button: {
            paddingVertical: 18,
            paddingHorizontal: 32,
            borderRadius: 24,
            minHeight: 56, // Large touch targets
          },
          text: {
            fontSize: 17,
            fontWeight: '800',
          },
        };
    }
  };

  const variantStyle = getVariantStyles();
  const sizeStyle = getSizeStyles();

  return (
    <AnimatedPressable
      onPress={disabled || loading ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        styles.buttonBase,
        variantStyle.button as any,
        sizeStyle.button,
        disabled && styles.disabledButton,
        style,
        animatedStyle,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled, checked: loading }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variantStyle.text.color} />
      ) : (
        <Text style={[styles.textBase, variantStyle.text, sizeStyle.text, textStyle]}>
          {title}
        </Text>
      )}
    </AnimatedPressable>
  );
};

const styles = StyleSheet.create({
  buttonBase: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  disabledButton: {
    opacity: 0.45,
  },
  textBase: {
    textAlign: 'center',
  },
});
