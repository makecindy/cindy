import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';

/**
 * 首页玻璃菜单(范围菜单、显示设置、搜索筛选)共用的淡入淡出时长,喂给
 * useModalFadeLifecycle。三者都是 HomeMenuScrim + HomeGlassMenuPanel 的轻浮层,
 * 按 DESIGN.md §14.4「Light overlay」取 fast 入场 / instant 退场(退场快于入场)。
 * 减弱动态效果(含尚未查询到的首帧)直接显示 / 消失,不播过渡。
 */
export function useHomeMenuFadeTiming(): { inMs: number; outMs: number } {
  const reduceMotion = useReduceMotionEnabled();
  return reduceMotion === false
    ? { inMs: motionDuration.fast, outMs: motionDuration.instant }
    : { inMs: 0, outMs: 0 };
}
