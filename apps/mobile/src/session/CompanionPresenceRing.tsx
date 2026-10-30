import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, radius, useTheme } from '@/theme';

/** Opacity range and half-period of the running breath; the task row's MobileVendorIcon uses the same values. */
const BREATH_MIN = 0.3;
const BREATH_HALF_MS = 750;
const REDUCED_OPACITY = 0.8;

/**
 * 伙伴「在做事」的呼吸环：头像外一圈 statusAccent 描边，透明度在 0.3 与 1 之间呼吸（与任务行运行中
 * 图标同一组参数）。结束时 150ms 淡出后卸载；减弱动效时静止在 0.8，结束时直接移除。只画环，不占布局：
 * 调用方把它放在 position: relative 的头像容器里，`gap` 是环内缘到头像的距离。
 */
export function CompanionPresenceRing({ active, gap = 2, width = 2 }: { active: boolean; gap?: number; width?: number }) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotionEnabled();
  const opacity = useRef(new Animated.Value(active ? BREATH_MIN : 0)).current;
  const [mounted, setMounted] = useState(active);
  const mountedRef = useRef(active); mountedRef.current = mounted;

  useEffect(() => {
    opacity.stopAnimation();
    if (!active) {
      if (!mountedRef.current) return;
      if (reduceMotion !== false) { setMounted(false); return; }
      const fade = Animated.timing(opacity, { toValue: 0, duration: motionDuration.fast, easing: Easing.in(Easing.ease), useNativeDriver: true });
      fade.start(({ finished }) => { if (finished) setMounted(false); });
      return () => fade.stop();
    }
    setMounted(true);
    if (reduceMotion !== false) {
      opacity.setValue(REDUCED_OPACITY);
      return;
    }
    opacity.setValue(BREATH_MIN);
    const breathe = (toValue: number) => Animated.timing(opacity, { toValue, duration: BREATH_HALF_MS, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([breathe(1), breathe(BREATH_MIN)]));
    loop.start();
    return () => loop.stop();
  }, [active, opacity, reduceMotion]);

  if (!mounted) return null;
  const inset = -(gap + width);
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    testID="companion.presenceRing"
    style={[styles.ring, { top: inset, right: inset, bottom: inset, left: inset, borderWidth: width, borderColor: colors.statusAccent, opacity }]} />;
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderRadius: radius.pill },
});
