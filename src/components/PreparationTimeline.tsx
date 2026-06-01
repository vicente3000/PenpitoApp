import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Colors, Shadows } from '../constants/Colors';
import { PreparationStepId } from '../models';
import { getPreparationProgress, preparationSteps } from '../utils/preparation';

type PreparationTimelineProps = {
  activeStepId?: PreparationStepId;
  completedStepIds: PreparationStepId[];
  skippedStepIds: PreparationStepId[];
  isReady: boolean;
};

export function PreparationTimeline({
  activeStepId,
  completedStepIds,
  skippedStepIds,
  isReady,
}: PreparationTimelineProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: getPreparationProgress(completedStepIds, activeStepId, isReady),
      duration: 450,
      useNativeDriver: false,
    }).start();
  }, [activeStepId, completedStepIds, isReady, progress]);

  const widthInterpolation = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.wrapper}>
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, { width: widthInterpolation }]} />
      </View>

      <View style={styles.list}>
        {preparationSteps.map((step, index) => {
          const isActive = activeStepId === step.id && !isReady;
          const isCompleted = completedStepIds.includes(step.id) || (isReady && step.id === 'ready');
          const isSkipped = skippedStepIds.includes(step.id);

          return (
            <View
              key={step.id}
              style={[
                styles.card,
                isActive && styles.cardActive,
                isCompleted && styles.cardDone,
                isSkipped && styles.cardSkipped,
              ]}>
              <View
                style={[
                  styles.iconWrap,
                  isActive && styles.iconWrapActive,
                  isCompleted && styles.iconWrapDone,
                  isSkipped && styles.iconWrapSkipped,
                ]}>
                <FontAwesome
                  name={step.icon}
                  size={18}
                  color={
                    isSkipped
                      ? Colors.textMuted
                      : isActive || isCompleted
                        ? Colors.background
                        : Colors.primary
                  }
                />
              </View>

              <View style={styles.content}>
                <Text style={styles.stepIndex}>Fase {index + 1}</Text>
                <Text style={styles.title}>{step.title}</Text>
                <Text style={styles.description}>{step.description}</Text>
              </View>

              <View style={styles.status}>
                {isSkipped ? (
                  <Text style={styles.statusSkipped}>Omitido</Text>
                ) : isCompleted ? (
                  <Text style={styles.statusDone}>Hecho</Text>
                ) : isActive ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Text style={styles.statusPending}>Pendiente</Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: Colors.surfaceHighlight,
    overflow: 'hidden',
    marginBottom: 16,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: Colors.primary,
  },
  list: {
    gap: 10,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 18,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cardActive: {
    borderColor: Colors.primary,
    backgroundColor: '#e2efec',
    ...Shadows.glowPrimary,
  },
  cardDone: {
    borderColor: '#b7d9c4',
    backgroundColor: '#edf7f0',
  },
  cardSkipped: {
    opacity: 0.7,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: '#e6f1ef',
    marginRight: 12,
  },
  iconWrapActive: {
    backgroundColor: Colors.primary,
  },
  iconWrapDone: {
    backgroundColor: Colors.success,
    borderColor: Colors.success,
  },
  iconWrapSkipped: {
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceHighlight,
  },
  content: {
    flex: 1,
  },
  stepIndex: {
    color: Colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  title: {
    marginTop: 2,
    fontSize: 15,
    fontWeight: '800',
    color: Colors.text,
  },
  description: {
    marginTop: 4,
    color: Colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  status: {
    minWidth: 82,
    alignItems: 'flex-end',
    marginLeft: 8,
  },
  statusPending: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  statusDone: {
    color: Colors.success,
    fontWeight: '800',
    fontSize: 12,
  },
  statusSkipped: {
    color: Colors.warning,
    fontWeight: '800',
    fontSize: 12,
  },
});
