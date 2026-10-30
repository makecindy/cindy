import { useEffect, type ReactNode } from 'react';
import type { Insets } from 'react-native';
import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';

/**
 * 录音胶囊宽度的过渡(§14.4 尺寸变化档:motionDuration.base + motionEasing.move)。
 *
 * 原先靠 RN LayoutAnimation.configureNext,但 Reanimated 接管了 Fabric 挂载层,
 * LayoutAnimation 在本 App 里是静默 no-op,胶囊展开 / 收回一直是跳变。这里改为
 * Reanimated 直接驱动宽度:语音按钮外框与工具排占位各用一份,同一次渲染里起跑、
 * 同时长同曲线,胶囊向左生长与左邻按钮的让位在同一段运动里完成。系统开启
 * 「减弱动态效果」时直接落位。
 */
export function useVoicePillWidthStyle(width: number) {
  const animated = useSharedValue(width);
  useEffect(() => {
    animated.value = getCachedReduceMotionEnabled() === false
      ? withTiming(width, { duration: motionDuration.base, easing: Easing.bezier(...motionEasing.move) })
      : width;
  }, [animated, width]);
  return useAnimatedStyle(() => ({ width: animated.value }));
}

/**
 * 语音按钮外框:宽度随胶囊平滑变化,按钮本身撑满外框(width: '100%')。
 * 外框成了按钮的直接父视图,而 hitSlop 不会越过直接父视图的边界,所以调用方要把
 * 按钮的 hitSlop 同样传给外框,收起态 34pt 麦克风的命中区才不会缩小。
 */
export function VoicePillWidthFrame({ children, hitSlop, width }: { children: ReactNode; hitSlop?: number | Insets; width: number }) {
  const style = useVoicePillWidthStyle(width);
  return <Reanimated.View hitSlop={hitSlop} style={style}>{children}</Reanimated.View>;
}
