import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { radius, spacing, useThemedStyles, type ThemeColors } from '@/theme';

/** Desktop `thinking-dot-wave`: 1.2s cycle, 0.2s stagger, opacity 0.25 ↔ 1. */
const CYCLE_MS = 1200;
const STAGGER_MS = 200;
const DIM = 0.25;
const REDUCED_OPACITY = 0.6;
/** 4pt dots; a tiny glyph measured in points, not an icon or radius step. */
const DOT_SIZE = 4;

function Dot({ index, animate }: { index: number; animate: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const opacity = useRef(new Animated.Value(animate ? DIM : REDUCED_OPACITY)).current;
  useEffect(() => {
    if (!animate) { opacity.setValue(REDUCED_OPACITY); return; }
    opacity.setValue(DIM);
    const rise = Animated.timing(opacity, { toValue: 1, duration: CYCLE_MS * 0.4, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const fall = Animated.timing(opacity, { toValue: DIM, duration: CYCLE_MS * 0.6, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const run = Animated.sequence([Animated.delay(index * STAGGER_MS), Animated.loop(Animated.sequence([rise, fall]))]);
    run.start();
    return () => run.stop();
  }, [animate, index, opacity]);
  return <Animated.View style={[styles.dot, { opacity }]} />;
}

/** 工作中的三点波动，取代系统 ActivityIndicator；减弱动效时三点静止。 */
export function ThinkingDots() {
  const styles = useThemedStyles(makeStyles);
  const animate = useReduceMotionEnabled() === false;
  return <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="companion.thinkingDots">
    {[0, 1, 2].map((index) => <Dot key={index} index={index} animate={animate} />)}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs - 1 },
  dot: { width: DOT_SIZE, height: DOT_SIZE, borderRadius: radius.pill, backgroundColor: colors.textTertiary },
});
