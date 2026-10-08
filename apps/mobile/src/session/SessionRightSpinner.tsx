import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { LoaderCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { iconSize, iconStroke, motionDuration, useTheme } from '@/theme';

/**
 * 列表行右侧状态位的运行中转圈：与桌面右槽同款 LoaderCircle，中性色，1s 匀速旋转；
 * 任务行与伙伴 / 群聊行共用。减弱动效时静止。
 */
export function SessionRightSpinner({ testID }: { testID?: string }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const spin = useRef(new Animated.Value(0)).current;
  // 常驻循环:减弱动态效果(含首帧未知)下静止,只显示静态图标。
  const reduceMotion = useReduceMotionEnabled();
  useEffect(() => {
    if (reduceMotion !== false) return;
    const loop = Animated.loop(
      Animated.timing(spin, {
        duration: motionDuration.spinnerCycle,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      spin.setValue(0);
    };
  }, [reduceMotion, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View accessibilityLabel={t('devices.list.a11y.running')} style={{ transform: [{ rotate }] }} testID={testID}>
      <LoaderCircle color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
    </Animated.View>
  );
}
