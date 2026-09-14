/**
 * useModalFadeLifecycle —— RN `<Modal>` 淡入淡出生命周期共用 hook。
 *
 * 抽自 SheetModal / 首页 DeviceMenuModal 的重复实现,统一管:
 *  - mounted:关闭动画播完才翻 false(调用方把它接到 Modal 的 visible,避免面板/背板瞬间消失的空白帧,规则 7);
 *  - progress:0→1 的共用动画进度(背板 opacity / 面板 translateY 都由它驱动,useNativeDriver);
 *  - 进场时机:**首挂时进场动画不在 effect 里与 setMounted 同帧起**——iOS 原生 Modal 呈现晚 1-2 帧,
 *    同帧 start 会吃掉动画起点帧。progress 保持 0,等调用方把 `onShowStartIn` 接到 `<Modal onShow>`
 *    后由原生呈现回调触发;淡出中途重开(Modal 未卸载,onShow 不会再触发)则在 effect 里立即起;
 *  - onClosed:等 Modal 从树上真正卸载(mounted 翻 false 的 commit 完成)后再触发——若在动画回调里
 *    同步触发,第二个 Modal 的挂载会和本 Modal 的卸载挤进同一个 commit,iOS 上 present-during-dismiss
 *    仍可能把新弹窗吞掉。onClosed 走 ref,身份变化不重跑 effect。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';

export interface ModalFadeLifecycleOptions {
  /** 进场时长(ms)。docs/design-rules/cindy-design-system.md §14.4:纯透明度过渡 ≤150ms。 */
  inMs: number;
  /** 退场时长(ms),习惯上略短于进场。 */
  outMs: number;
  /** 淡出动画完成、Modal 真正卸载后触发(如需在关闭后再开另一个 Modal)。 */
  onClosed?: () => void;
}

export interface ModalFadeLifecycle {
  /** 接到 `<Modal visible>`:开启立即 true,关闭等淡出播完才 false。 */
  mounted: boolean;
  /** 0→1 动画进度(ref 稳定,可安全进 useMemo 依赖)。 */
  progress: Animated.Value;
  /** 接到 `<Modal onShow>`:原生呈现完成后才起进场动画(见头注释 iOS 首帧问题)。 */
  onShowStartIn: () => void;
}

export function useModalFadeLifecycle(
  visible: boolean,
  { inMs, outMs, onClosed }: ModalFadeLifecycleOptions,
): ModalFadeLifecycle {
  const reduceMotion = useReduceMotionEnabled();
  const animate = reduceMotion === false;
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  // Modal 原生层是否已呈现(onShow 已触发且尚未卸载):决定重开时进场动画由谁起。
  const shownRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  const startIn = useCallback(() => {
    progress.stopAnimation();
    if (!animate) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      duration: inMs,
      easing: Easing.out(Easing.quad),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [animate, inMs, progress]);

  const onShowStartIn = useCallback(() => {
    shownRef.current = true;
    // onShow 与 visible 翻 false 存在竞态窗口(极快开关):已经在关就别再拉起进场。
    if (visibleRef.current) startIn();
  }, [startIn]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // 首挂等 onShow;淡出中途重开(原生层还在,onShow 不会再来)立即起进场。
      if (shownRef.current) startIn();
    } else {
      if (!mountedRef.current) return; // 从未打开/已完全关闭:无需播退场。
      progress.stopAnimation();
      if (!animate) {
        progress.setValue(0);
        setMounted(false);
        return;
      }
      Animated.timing(progress, {
        duration: outMs,
        easing: Easing.in(Easing.quad),
        toValue: 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        // finished 之外还要复核 visibleRef:退场自然完成的瞬间用户恰好重开时,
        // 迟到的回调不能把刚重开的 Modal 卸掉(快速连点会丢面板/输入态)。
        if (finished && !visibleRef.current) setMounted(false);
      });
    }
    return () => progress.stopAnimation();
  }, [visible, progress, outMs, startIn, animate]);

  // onClosed 延迟到 mounted 翻 false 的 commit 之后(见头注释)。
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (wasMounted && !mounted) {
      shownRef.current = false;
      onClosedRef.current?.();
    }
  }, [mounted]);

  return { mounted, progress, onShowStartIn };
}
