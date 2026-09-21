import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AccessibilityInfo, BackHandler, findNodeHandle, Pressable, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { motionDuration, motionEasing } from '@/theme/tokens';
import type { RemoteSessionListItem } from './sessionList';
import { MobileHome } from './HomeSurface';

const DRAWER_CLOSE_DISTANCE_RATIO = 1 / 3;
const DRAWER_CLOSE_VELOCITY = -800;

/** Container only: Home owns every list row, search, group, menu and subscription. */
export function SessionListDrawer({ currentSessionId, persistent = false, newSessionInSystemBar = false,
  onClose, onClosed, onSelectSession, runNavigation, newSessionActionRef, open, width,
}: {
  currentSessionId: string;
  persistent?: boolean;
  newSessionInSystemBar?: boolean;
  onClose(): void;
  onClosed?(): void;
  onSelectSession(item: RemoteSessionListItem): void;
  runNavigation(action: () => void): void;
  newSessionActionRef?: MutableRefObject<(() => void) | null>;
  open: boolean;
  width: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  const panelWidth = Math.max(1, width + insets.left);
  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const openRef = useRef(open);
  openRef.current = open;
  // progress 0→1 = 收起→展开;dragX(≤0)是手势拖拽的临时位移,松手后归零或并入 progress。
  const progress = useSharedValue(open ? 1 : 0);
  const dragX = useSharedValue(0);
  // 关闭收尾由 JS 生命周期负责,动画只负责视觉;先卸载 overlay。
  // onClosed 必须等 mounted=false 的 commit 完成,否则导航会和 GestureDetector/
  // Reanimated 子树卸载挤进同一帧(Android 原生 Screen 存在崩溃竞态)。背景焦点归还
  // 则由父级在 accessibility 隔离解除后的 commit effect 中完成。
  const finishClose = useCallback(() => {
    if (openRef.current) return;
    setMounted(false);
  }, []);
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

  useEffect(() => {
    // reduce-motion 约定:只有 === false 才播动画,null(首帧未知)按不播降级。
    const animate = reduceMotion === false && !persistent;
    if (open) {
      setMounted(true);
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
  }, [dragX, finishClose, open, panelWidth, progress, reduceMotion, persistent]);

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
  const panGesture = useMemo(
    () =>
      Gesture.Pan().enabled(!persistent)
        // 与内部 SectionList 纵向滚动的协调全靠激活窗口收窄:
        // - 只认「向左」(关闭方向)为激活条件,向右 16pt 直接判失败——右拖不该抢任何手势;
        // - 纵向 16pt 先到即失败,滚动优先;斜向手势必须横向分量先赢才归抽屉。
        .activeOffsetX(-16)
        .failOffsetX(16)
        .failOffsetY([-16, 16])
        .onUpdate((event) => {
          'worklet';
          dragX.value = Math.min(0, event.translationX);
        })
        .onEnd((event) => {
          'worklet';
          const shouldClose =
            event.translationX < -panelWidth * DRAWER_CLOSE_DISTANCE_RATIO ||
            event.velocityX < DRAWER_CLOSE_VELOCITY;
          if (shouldClose) {
            runOnJS(closeFromGesture)();
          } else {
            // 未过阈回弹:位置插值档(fast + move 曲线)。
            dragX.value = withTiming(0, {
              duration: motionDuration.fast,
              easing: Easing.bezier(...motionEasing.move),
            });
          }
        }),
    [closeFromGesture, dragX, panelWidth, persistent],
  );

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
    {!persistent ? <Animated.View style={[styles.scrim, scrimStyle]}>
      <Pressable accessibilityLabel={t('home.drawer.closeA11y')} accessibilityRole="button"
        onPress={onClose} style={styles.scrimPressable} testID="sessionDrawer.scrim" />
    </Animated.View> : null}
    <GestureDetector gesture={panGesture}>
      <Animated.View style={[styles.panel, { paddingLeft: insets.left, paddingTop: insets.top, width: panelWidth },
        !persistent && panelStyle]} testID="sessionDrawer.panel">
        <View ref={homeContentRef} style={styles.content}>
          <MobileHome onDismiss={persistent ? undefined : onClose} newSessionActionRef={newSessionActionRef} width={width} currentSessionId={currentSessionId}
            newSessionInSystemBar={newSessionInSystemBar} onSelectSession={onSelectSession} runNavigation={runNavigation} />
        </View>

      </Animated.View>
    </GestureDetector>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 40 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  scrimPressable: { flex: 1 },
  panel: { backgroundColor: colors.surface, borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth,
    position: 'absolute', top: 0, bottom: 0, left: 0 },
  content: { flex: 1, minHeight: 0 },
});
