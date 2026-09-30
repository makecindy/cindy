/**
 * SessionTransientNotice —— 会话页顶部的短暂提示(如「已复制路径」)。
 *
 * 会话页没有文件浏览器那样的底栏提示位,这里用一个不拦截触摸的浮层胶囊,
 * 显示约 1.5s 后自动消失。入场 / 退场走 motion token;系统开启「减弱动态效果」
 * (或偏好尚未查询到)时直接显示 / 隐藏,不播淡入淡出。
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { Text } from '@/components/AppText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  lineHeight,
  motionDuration,
  motionEasing,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

const SESSION_TRANSIENT_NOTICE_MS = 1500;

export interface SessionTransientNoticeValue {
  /** 每次提示递增,同文案连续触发也会重新计时。 */
  id: number;
  message: string;
}

export function SessionTransientNotice({
  notice,
  onDismiss,
  top,
}: {
  notice: SessionTransientNoticeValue | null;
  onDismiss: () => void;
  top: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReduceMotionEnabled();
  const animate = reduceMotion === false;
  const opacity = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState<SessionTransientNoticeValue | null>(notice);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!notice) return;
    setRendered(notice);
    opacity.stopAnimation();
    if (animate) {
      Animated.timing(opacity, {
        toValue: 1,
        duration: motionDuration.fast,
        easing: Easing.bezier(...motionEasing.out),
        useNativeDriver: true,
      }).start();
    } else {
      opacity.setValue(1);
    }
    const timer = setTimeout(() => onDismissRef.current(), SESSION_TRANSIENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [animate, notice, opacity]);

  useEffect(() => {
    if (notice || !rendered) return;
    if (!animate) {
      opacity.setValue(0);
      setRendered(null);
      return;
    }
    Animated.timing(opacity, {
      toValue: 0,
      duration: motionDuration.instant,
      easing: Easing.bezier(...motionEasing.in),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setRendered(null);
    });
  }, [animate, notice, opacity, rendered]);

  if (!rendered) return null;
  return (
    <View pointerEvents="none" style={[styles.host, { top }]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[styles.pill, { opacity }]}
        testID="session.transientNotice"
      >
        <Text style={styles.text}>{rendered.message}</Text>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  host: {
    alignItems: 'center',
    left: 0,
    paddingHorizontal: spacing.lg,
    position: 'absolute',
    right: 0,
  },
  pill: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: {
    color: colors.textPrimary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
});
