import { useEffect } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';

/**
 * 语音胶囊宽度换档的局部动画参数(尺寸变化档 + move 曲线)。
 * 按钮锚点(MobileComposerInputRow 的 floatingVoiceButtonStyle)与工具排占位
 * (ComposerToolbarVoiceSlot)共用同一份参数,保证两处宽度始终同段运动——
 * 曾经用 LayoutAnimation 实现,但它是全局的且与键盘竞态会冻结无关视图,
 * 已改为 Reanimated 局部驱动(见 useComposerCardTransition 注释)。
 */
const VOICE_PILL_WIDTH_TIMING = {
  duration: motionDuration.base,
  easing: Easing.bezier(...motionEasing.move),
} as const;

/**
 * 语音胶囊宽度的局部过渡 style(34 → 72 / 80 两档)。
 *
 * 返回 Reanimated 动画 style:width 跟随 `width` 参数 withTiming 过渡,
 * 可中断重定向、只作用于挂它的那一个视图。reduce-motion(含首帧缓存未知
 * 窗口)直切,对齐 useReduceMotion「只有 === false 才播」的约定。
 *
 * 消费方必须是 Reanimated 的 Animated 组件;width 为 null / undefined 时
 * 返回的 style 不含 width(由消费方的静态样式兜底)。
 */
export function useVoiceRecordingPillWidthStyle(width: number | null | undefined) {
  const animatedWidth = useSharedValue(width ?? 0);

  useEffect(() => {
    if (width == null) return;
    if (getCachedReduceMotionEnabled() !== false) {
      animatedWidth.value = width;
      return;
    }
    animatedWidth.value = withTiming(width, VOICE_PILL_WIDTH_TIMING);
  }, [animatedWidth, width]);

  return useAnimatedStyle(
    () => (width == null ? {} : { width: animatedWidth.value }),
    [width == null],
  );
}
