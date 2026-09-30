import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react-native';
import { GlassView } from 'expo-glass-effect';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Text } from '@/components/AppText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { useLiquidGlassAvailable } from '@/session/useLiquidGlassAvailable';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, lineHeight, motionDuration, motionEasing, radius, spacing, typeScale } from '@/theme/tokens';

/** Floating sibling of the composer, with a single tap target and swipe dismissal. */
export function PromptRecommendation({ prompt, onAccept, onDismiss }: {
  prompt: string;
  onAccept(): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const glass = useLiquidGlassAvailable();
  const reduceMotion = useReduceMotionEnabled();
  const { width } = useWindowDimensions();
  const translation = useSharedValue(0);
  const origin = useSharedValue(0);
  const dismissing = useSharedValue(false);
  useEffect(() => () => cancelAnimation(translation), [translation]);
  const gesture = useMemo(() => Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-8, 8])
    .onStart(() => {
      if (dismissing.value) return;
      cancelAnimation(translation);
      origin.value = translation.value;
    })
    .onUpdate((event) => {
      if (!dismissing.value) translation.value = origin.value + event.translationX;
    })
    .onEnd((event, successful) => {
      if (!successful || dismissing.value) return;
      const distance = translation.value;
      const dismiss = Math.abs(distance) > Math.min(90, width * 0.25)
        || (Math.abs(distance) > 24 && Math.abs(event.velocityX) > 550 && distance * event.velocityX > 0);
      if (dismiss) {
        dismissing.value = true;
        // The swipe is committed even if hiding/unmounting cancels its exit.
        translation.value = withTiming(Math.sign(distance) * width, {
          duration: reduceMotion === false ? motionDuration.fast : 0,
          easing: Easing.bezier(...motionEasing.in),
        }, () => { scheduleOnRN(onDismiss); });
      }
    })
    .onFinalize(() => {
      if (!dismissing.value) translation.value = withTiming(0, {
        duration: reduceMotion === false ? motionDuration.base : 0,
        easing: Easing.bezier(...motionEasing.out),
      });
    }), [dismissing, onDismiss, origin, reduceMotion, translation, width]);
  // UIKit glass cannot be faded through an ancestor without losing its material.
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translation.value }] }));
  const content = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={prompt}
      accessibilityActions={[{ name: 'dismiss', label: t('session.common.dismissRecommendation') }]}
      onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === 'dismiss') onDismiss(); }}
      onAccessibilityEscape={onDismiss}
      onPress={() => { if (!dismissing.value) onAccept(); }}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      testID="session.promptRecommendationAction"
    >
      <Sparkles color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
      <Text numberOfLines={1} style={styles.text}>{prompt}</Text>
    </Pressable>
  );
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.root, animatedStyle]} testID="session.promptRecommendation">
        {glass ? (
          <GlassView colorScheme={mode} glassEffectStyle="regular" isInteractive={false} style={styles.glass}>
            {content}
          </GlassView>
        ) : <View style={styles.fallback}>{content}</View>}
      </Animated.View>
    </GestureDetector>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { marginHorizontal: spacing.sm, marginBottom: spacing.sm },
  glass: { borderRadius: radius.pill, overflow: 'hidden' },
  fallback: {
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderTranslucent,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.72 },
  text: { flex: 1, color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
