import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AccessibilityInfo, BackHandler, findNodeHandle, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { motionDuration, motionEasing } from '@/theme/tokens';
import type { RemoteSessionListItem } from './sessionList';
import { MobileHome } from './HomeSurface';
import { SessionPaneDivider } from './SessionPaneDivider';

const DRAWER_CLOSE_DISTANCE_RATIO = 1 / 3;
const DRAWER_CLOSE_VELOCITY = -800;
const DRAWER_OPEN_DISTANCE_RATIO = 1 / 3;
const DRAWER_OPEN_VELOCITY = 800;
/** How far an elastic stretch can ever reach past a width limit. */
const DRAWER_STRETCH = 120;
/** Rightward travel on the dimmed area that turns the list into Home, mid-drag. */
const DRAWER_HOME_TRAVEL = 96;

/** Elastic overflow: follows the finger at first, then resists toward DRAWER_STRETCH. */
export function rubberBand(offset: number): number {
  'worklet';
  const magnitude = Math.abs(offset);
  return Math.sign(offset) * DRAWER_STRETCH * (1 - 1 / ((magnitude * 0.55) / DRAWER_STRETCH + 1));
}

/** Presentation shared by the drawer and a gesture outside it that pulls it out.
 * progress 0→1 = 收起→展开; dragX(≤0) 是左滑关闭的临时位移; tracking = 手指正在把它拉出来。 */
export type SessionListDrawerMotion = {
  progress: SharedValue<number>;
  dragX: SharedValue<number>;
  tracking: SharedValue<boolean>;
};

export function useSessionListDrawerMotion(initialProgress = 0): SessionListDrawerMotion {
  const progress = useSharedValue(initialProgress);
  const dragX = useSharedValue(0);
  const tracking = useSharedValue(false);
  return useMemo(() => ({ progress, dragX, tracking }), [progress, dragX, tracking]);
}

/** A rightward swipe on the task pulls the floating list out under the finger.
 * onOpen mounts it at once; releasing short of a third settles it back via onCancel.
 * onSettle follows either outcome. Keep `enabled` true until then: disabling a
 * running gesture cancels it. */
export function useSessionListDrawerOpenGesture({ motion, enabled, width, onOpen, onCancel, onSettle }: {
  motion: SessionListDrawerMotion;
  enabled: boolean;
  width: number;
  onOpen(): void;
  onCancel(): void;
  onSettle(): void;
}) {
  const insets = useSafeAreaInsets();
  const panelWidth = Math.max(1, width + insets.left);
  return useMemo(() => {
    const { progress, dragX, tracking } = motion;
    return Gesture.Pan().enabled(enabled)
      // Rightward only; vertical scrolling and leftward swipes keep their own owners.
      .activeOffsetX(16)
      .failOffsetX(-16)
      .failOffsetY([-16, 16])
      .onStart(() => {
        'worklet';
        cancelAnimation(progress);
        dragX.value = 0;
        progress.value = 0;
        tracking.value = true;
        runOnJS(onOpen)();
      })
      .onUpdate((event) => {
        'worklet';
        if (!tracking.value) return;
        progress.value = Math.max(0, Math.min(1, event.translationX / panelWidth));
      })
      .onEnd((event) => {
        'worklet';
        if (!tracking.value) return;
        tracking.value = false;
        if (progress.value > DRAWER_OPEN_DISTANCE_RATIO || event.velocityX > DRAWER_OPEN_VELOCITY) {
          progress.value = withTiming(1, { duration: motionDuration.enter, easing: Easing.bezier(...motionEasing.out) });
        } else {
          runOnJS(onCancel)();
        }
        runOnJS(onSettle)();
      })
      .onFinalize(() => {
        'worklet';
        if (!tracking.value) return;
        tracking.value = false;
        runOnJS(onCancel)();
        runOnJS(onSettle)();
      });
  }, [enabled, motion, onCancel, onOpen, onSettle, panelWidth]);
}

/** Container only: Home owns every list row, search, group, menu and subscription. */
export function SessionListDrawer({ currentSessionId, persistent = false, newSessionInSystemBar = false,
  onClose, onClosed, onSelectSession, runNavigation, newSessionActionRef, open, width, topInset, resize, motion,
}: {
  currentSessionId: string;
  /** Overrides the safe-area top where the task bar sits inside the status area (Duo). */
  topInset?: number;
  persistent?: boolean;
  newSessionInSystemBar?: boolean;
  onClose(): void;
  onClosed?(): void;
  /** Without an override, Home uses its normal navigation and task history. */
  onSelectSession?(item: RemoteSessionListItem): void;
  runNavigation(action: () => void): void;
  newSessionActionRef?: MutableRefObject<(() => void) | null>;
  open: boolean;
  width: number;
  /** Floating drawer only: its right edge drags the shared task-list width,
   * elastic past the bounds. Dragging the dimmed area right stretches the list
   * and, past a short distance, turns it into Home at full width (`home.width`). */
  resize?: {
    bounds: { min: number; max: number };
    onResize(width: number): void;
    home?: { width: number; open(): void };
  };
  /** Shared with a gesture outside the drawer that pulls it out. */
  motion?: SessionListDrawerMotion;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  const ownMotion = useSessionListDrawerMotion(open ? 1 : 0);
  const { progress, dragX, tracking } = motion ?? ownMotion;
  // Elastic overflow past a width limit; springs back and is never stored.
  const stretch = useSharedValue(0);
  const [stretchWidth, setStretchWidth] = useState(0);
  useAnimatedReaction(() => Math.round(stretch.value), (next, previous) => {
    if (next !== previous) runOnJS(setStretchWidth)(next);
  }, [stretch]);
  // Full width once the list becomes Home.
  const [homeWidth, setHomeWidth] = useState<number | null>(null);
  const shownWidth = homeWidth ?? Math.max(1, width + stretchWidth);
  const panelWidth = Math.max(1, shownWidth + insets.left);
  // A full-screen list becoming Home leaves without the slide-out.
  const dismissingRef = useRef(false);
  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const openRef = useRef(open);
  openRef.current = open;
  // 关闭收尾由 JS 生命周期负责,动画只负责视觉;先卸载 overlay。
  // onClosed 必须等 mounted=false 的 commit 完成,否则导航会和 GestureDetector/
  // Reanimated 子树卸载挤进同一帧(Android 原生 Screen 存在崩溃竞态)。背景焦点归还
  // 则由父级在 accessibility 隔离解除后的 commit effect 中完成。
  const finishClose = useCallback(() => {
    if (openRef.current) return;
    cancelAnimation(stretch);
    stretch.value = 0;
    setStretchWidth(0);
    setHomeWidth(null);
    setMounted(false);
  }, [stretch]);
  const previousPersistent = useRef(persistent);
  const columnCollapsed = useRef(false);
  useLayoutEffect(() => {
    if (previousPersistent.current && !persistent && !open) {
      // A disappearing column is not a modal exit: no scrim or focus isolation.
      columnCollapsed.current = true;
      cancelAnimation(progress);
      progress.value = 0;
      dragX.value = 0;
      setMounted(false);
    }
    previousPersistent.current = persistent;
  }, [persistent, open, progress, dragX]);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (!wasMounted || mounted) return;
    if (columnCollapsed.current) { columnCollapsed.current = false; return; }
    onClosedRef.current?.();
  }, [mounted]);
  // 打开后把读屏焦点移进主页内容区域:背后内容已按模态摘出读屏树,不移焦
  // VoiceOver/TalkBack 会停在已隐藏的节点上。延到入场动画结束再移,避免读出滑动中的几何。
  const homeContentRef = useRef<View>(null);
  useEffect(() => {
    if (!open || persistent) return;
    const timer = setTimeout(() => {
      const node = findNodeHandle(homeContentRef.current);
      if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
    }, motionDuration.enter);
    return () => clearTimeout(timer);
  }, [open, persistent]);

  // Only a new presentation clears it; width changes while open rerun the effect below.
  useEffect(() => {
    if (open) dismissingRef.current = false;
  }, [open]);
  useEffect(() => {
    // reduce-motion 约定:只有 === false 才播动画,null(首帧未知)按不播降级。
    const animate = reduceMotion === false && !persistent && !dismissingRef.current;
    if (open) {
      setMounted(true);
      // A finger is pulling it out; that gesture settles it.
      if (tracking.value) return;
      // 手势位移并回 progress,从当前视觉位置继续,不跳帧。
      const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
      progress.value = effective;
      dragX.value = 0;
      // 重浮层入场档(motionDuration.enter + out 曲线),与 DESIGN.md §14.4 双端同构。
      progress.value = animate
        ? withTiming(1, { duration: motionDuration.enter, easing: Easing.bezier(...motionEasing.out) })
        : 1;
      return;
    }
    if (!mountedRef.current) return;
    const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
    progress.value = effective;
    dragX.value = 0;
    if (!animate) {
      progress.value = 0;
      finishClose();
      return;
    }
    progress.value = withTiming(
      0,
      // 重浮层退场档(motionDuration.exit + in 曲线)。
      { duration: motionDuration.exit, easing: Easing.bezier(...motionEasing.in) },
    );
    // A cancelled/lost UI-thread completion must not leave an invisible modal eating taps.
    // Cleanup on reopen or layout change; navigation still waits for the unmount commit above.
    const closeTimer = setTimeout(finishClose, motionDuration.exit);
    return () => clearTimeout(closeTimer);
  }, [dragX, finishClose, open, panelWidth, progress, reduceMotion, persistent, tracking]);

  // Android 系统返回键:抽屉开着时先关抽屉,不冒泡成页面返回。
  useEffect(() => {
    if (!open || persistent) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, open, persistent]);

  const closeFromGesture = useCallback(() => onClose(), [onClose]);
  const home = resize?.home;
  const enterHome = useCallback(() => {
    if (!home) return;
    dismissingRef.current = true;
    setHomeWidth(home.width - insets.left);
    home.open();
  }, [home, insets.left]);
  const stretchTo = useCallback((overflow: number) => { stretch.value = rubberBand(overflow); }, [stretch]);
  const settleStretch = useCallback(() => {
    stretch.value = withTiming(0, { duration: motionDuration.base, easing: Easing.bezier(...motionEasing.out) });
  }, [stretch]);
  // Where a rightward drag on the dimmed area becomes Home, and whether it has.
  const homeAt = useSharedValue(DRAWER_HOME_TRAVEL);
  const homeEntered = useSharedValue(false);
  const gestures = useMemo(() => {
    // A leftward drag slides the panel; released past a third (or flicked) it closes,
    // otherwise it returns from where the finger left it.
    const settleSlide = (translationX: number, velocityX: number) => {
      'worklet';
      // Include the position inherited when a previous rebound was interrupted.
      const offsetX = (progress.value - 1) * panelWidth + Math.min(0, translationX);
      if (offsetX < -panelWidth * DRAWER_CLOSE_DISTANCE_RATIO || velocityX < DRAWER_CLOSE_VELOCITY) {
        runOnJS(closeFromGesture)();
        return;
      }
      // 未过阈回弹:位置插值档(fast + move 曲线)。
      const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
      cancelAnimation(progress);
      cancelAnimation(dragX);
      progress.value = effective;
      dragX.value = 0;
      progress.value = withTiming(1, { duration: motionDuration.fast, easing: Easing.bezier(...motionEasing.move) });
    };
    const panel = Gesture.Pan().enabled(!persistent)
      // 与内部 SectionList 纵向滚动的协调全靠激活窗口收窄:
      // - 只认「向左」(关闭方向)为激活条件,向右 16pt 直接判失败——右拖不该抢任何手势;
      // - 纵向 16pt 先到即失败,滚动优先;斜向手势必须横向分量先赢才归抽屉。
      .activeOffsetX(-16)
      .failOffsetX(16)
      .failOffsetY([-16, 16])
      .onStart(() => {
        'worklet';
        // A new horizontal drag takes over from the current rebound position.
        // Do not stop it on touch-down: vertical scrolling must leave it running.
        cancelAnimation(progress);
        cancelAnimation(dragX);
      })
      .onUpdate((event) => {
        'worklet';
        dragX.value = Math.min(0, event.translationX);
      })
      .onEnd((event) => {
        'worklet';
        settleSlide(event.translationX, event.velocityX);
      });
    // The dimmed area takes both directions: left slides the panel away like the
    // panel itself; right stretches the list and, a short way on, becomes Home.
    const scrim = Gesture.Pan().enabled(!persistent)
      .activeOffsetX([-16, 16])
      .failOffsetY([-16, 16])
      .onStart((event) => {
        'worklet';
        cancelAnimation(progress);
        cancelAnimation(dragX);
        cancelAnimation(stretch);
        homeEntered.value = false;
        // Starting close to the screen edge still leaves room to reach Home.
        const room = home ? home.width - (event.absoluteX - event.translationX) : 0;
        homeAt.value = Math.min(DRAWER_HOME_TRAVEL, Math.max(24, room * 0.6));
      })
      .onUpdate((event) => {
        'worklet';
        if (homeEntered.value) return;
        if (event.translationX <= 0) {
          stretch.value = 0;
          dragX.value = event.translationX;
          return;
        }
        dragX.value = 0;
        if (home && event.translationX >= homeAt.value) {
          homeEntered.value = true;
          runOnJS(enterHome)();
          return;
        }
        stretch.value = rubberBand(event.translationX);
      })
      .onEnd((event) => {
        'worklet';
        if (homeEntered.value) return;
        stretch.value = withTiming(0, { duration: motionDuration.base, easing: Easing.bezier(...motionEasing.out) });
        settleSlide(event.translationX, event.velocityX);
      });
    return { panel, scrim };
  }, [closeFromGesture, dragX, enterHome, home, homeAt, homeEntered, panelWidth, persistent, progress, stretch]);

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth)),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: Math.max(
          -panelWidth,
          Math.min(0, (progress.value - 1) * panelWidth + dragX.value),
        ),
      },
    ],
  }));


  if (!mounted) return null;
  return <View accessibilityViewIsModal={mounted && !persistent} pointerEvents="auto"
    style={[styles.overlay, persistent && { width: panelWidth }]} testID="sessionDrawer.overlay">
    {!persistent ? <GestureDetector gesture={gestures.scrim}>
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable accessibilityLabel={t('home.drawer.closeA11y')} accessibilityRole="button"
          onPress={onClose} style={styles.scrimPressable} testID="sessionDrawer.scrim" />
      </Animated.View>
    </GestureDetector> : null}
    <GestureDetector gesture={gestures.panel}>
      <Animated.View style={[styles.panel, { paddingLeft: insets.left, paddingTop: topInset ?? insets.top, width: panelWidth },
        !persistent && panelStyle]} testID="sessionDrawer.panel">
        {/* The host keeps the first navigation intent. Stop all list input during exit so a
            second selection cannot change preferences while its route is discarded. */}
        <View ref={homeContentRef} style={styles.content} pointerEvents={open ? 'auto' : 'none'}
          accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
          <MobileHome newSessionActionRef={newSessionActionRef} width={shownWidth} currentSessionId={currentSessionId}
            newSessionInSystemBar={newSessionInSystemBar} newSessionInHeader={!persistent}
            onSelectSession={onSelectSession} runNavigation={runNavigation} />
        </View>

      </Animated.View>
    </GestureDetector>
    {/* A sibling of the panel, so an edge drag never reaches the close gesture.
        It rides the panel's slide and stops taking touches once closing. */}
    {!persistent && resize ? <Animated.View pointerEvents={open ? 'box-none' : 'none'}
      style={[styles.edge, panelStyle]}>
      <SessionPaneDivider grip={false} width={width} bounds={resize.bounds} onResize={resize.onResize}
        left={panelWidth} top={topInset ?? insets.top} bottom={insets.bottom}
        elastic={{ onStretch: stretchTo, onSettle: settleStretch }} />
    </Animated.View> : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 40 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  scrimPressable: { flex: 1 },
  panel: { backgroundColor: colors.surface, borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth,
    position: 'absolute', top: 0, bottom: 0, left: 0 },
  content: { flex: 1, minHeight: 0 },
  edge: { ...StyleSheet.absoluteFill },
});
