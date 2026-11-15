import { TaskDrawerPresentation, useTaskDrawerPresentation } from './TaskDrawerPresentation';
import { SharedTaskListContent, useSharedTaskList } from './SharedTaskList';
import { useIsFocused } from 'expo-router/react-navigation';
import type { ViewInstance } from 'react-native';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ComponentProps } from 'react';
import { AccessibilityInfo, BackHandler, findNodeHandle, Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, runOnJS, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector, GestureHandlerRootView } from '@/platform/gestureHandler';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { motionDuration, motionEasing } from '@/theme/tokens';
import type { RemoteSessionListItem } from './sessionList';
import { MobileHome } from './HomeSurface';
import { PaneEdgeInsetProvider, usePaneEdgeInset, useSessionPaneDivider } from './SessionPaneDivider';
import { NativeHistoryHost, NativeHistorySlot, NativeTaskDrawerHost, taskDrawerHandoffAvailable } from './NativeResidentHistory';
import { HomePresentationFocus } from './HomePresentationFocus';
import { LocalHomeList } from './ResidentHomeList';

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
  /** The released pull still owns its UI-thread settlement. */
  settling: SharedValue<boolean>;
};

export function useSessionListDrawerMotion(initialProgress = 0): SessionListDrawerMotion {
  const progress = useSharedValue(initialProgress);
  const dragX = useSharedValue(0);
  const tracking = useSharedValue(false);
  const settling = useSharedValue(false);
  return useMemo(() => ({ progress, dragX, tracking, settling }), [progress, dragX, tracking, settling]);
}

/** A rightward swipe on the task pulls the floating list out under the finger.
 * onOpen mounts it at once; releasing short of a third settles it back via onCancel.
 * onSettle reports whether the release committed the opening. Keep `enabled`
 * true until then: disabling a running gesture cancels it. */
export function useSessionListDrawerOpenGesture({ motion, enabled, width, onOpen, onCancel, onSettle }: {
  motion: SessionListDrawerMotion;
  enabled: boolean;
  width: number;
  onOpen(): void;
  onCancel(): void;
  onSettle(opened: boolean): void;
}) {
  const insets = useSafeAreaInsets();
  const panelWidth = Math.max(1, width + insets.left);
  const reduceMotion = useReduceMotionEnabled();
  return useMemo(() => {
    const { progress, dragX, tracking, settling } = motion;
    return Gesture.Pan().enabled(enabled)
      // Rightward only; vertical scrolling and leftward swipes keep their own owners.
      .activeOffsetX(16)
      .failOffsetX(-16)
      .failOffsetY([-16, 16])
      .onStart((event) => {
        'worklet';
        cancelAnimation(progress);
        settling.value = false;
        dragX.value = 0;
        progress.value = Math.max(0, Math.min(1, event.translationX / panelWidth));
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
        // The release can carry the last movement before onUpdate delivered it.
        const released = Math.max(0, Math.min(1, event.translationX / panelWidth));
        progress.value = released;
        const opened = released > DRAWER_OPEN_DISTANCE_RATIO || event.velocityX > DRAWER_OPEN_VELOCITY;
        if (opened) {
          settling.value = reduceMotion === false && released < 1;
          progress.value = settling.value
            ? withTiming(1, { duration: motionDuration.enter * (1 - released), easing: Easing.bezier(...motionEasing.out) }, () => {
              settling.value = false;
            })
            : 1;
        } else {
          runOnJS(onCancel)();
        }
        runOnJS(onSettle)(opened);
      })
      .onFinalize(() => {
        'worklet';
        if (!tracking.value) return;
        tracking.value = false;
        runOnJS(onCancel)();
        runOnJS(onSettle)(false);
      });
  }, [enabled, motion, onCancel, onOpen, onSettle, panelWidth, reduceMotion]);
}

/** Container only: Home owns every list row, search, group, menu and subscription. */
export function SessionListDrawer(props: ComponentProps<typeof SessionListDrawerSurface>) {
  const presentation = useTaskDrawerPresentation();
  if (!presentation) return <SessionListDrawerSurface {...props} />;
  return <TaskDrawerPresentation element={<SessionListDrawerSurface {...props} motion={presentation.motion} />} />;
}

export function SessionListDrawerSurface({ currentSessionId, persistent = false, newSessionInSystemBar = false, aboveSystemBar = false,
  onClose, onClosed, onSelectSession, runNavigation, newSessionActionRef, open, width, topInset, resize, motion, retainedHeight, onColumnReady, retainPresentation = false,
}: {
  currentSessionId: string;
  /** The root owns this exit even after the originating route loses focus. */
  retainPresentation?: boolean;
  /** Overrides the safe-area top where the task bar sits inside the status area (Duo). */
  topInset?: number;
  persistent?: boolean;
  newSessionInSystemBar?: boolean;
  /** Floating drawer only: present it in its own window, over the task's
   * system bar, so the bar stays in place under the scrim. Popovers the list
   * opens are presented from that window and stay on top of it. */
  aboveSystemBar?: boolean;
  /** Retain one native Home at this content height across floating/column
   * presentations. Omit when the route/inner screen no longer owns it. */
  retainedHeight?: number;
  onClose(): void;
  onClosed?(): void;
  /** Called after the previous floating window has handed off and unmounted. */
  onColumnReady?(): void;
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
  const window = useAdaptiveWindow();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  const sharedList = useSharedTaskList();
  const focused = useIsFocused();
  const localSurfaceId = `task-drawer:${useId()}`;
  const surfaceId = sharedList?.surfaceId ?? localSurfaceId;
  const ownMotion = useSessionListDrawerMotion(open ? 1 : 0);
  const { progress, dragX, tracking, settling } = motion ?? ownMotion;
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
  const retainHome = !!NativeHistoryHost && !!NativeHistorySlot
    && retainedHeight !== undefined && retainedHeight > 0;
  const [prepared, setPrepared] = useState(false);
  if (retainHome && mounted && !prepared) setPrepared(true);
  useEffect(() => {
    if (!retainHome) { setPrepared(false); return; }
    if (prepared) return;
    // Keep the extra list creation out of the task's initial navigation commit.
    // A pull before idle still mounts synchronously through `mounted` above.
    const handle = requestIdleCallback(() => setPrepared(true));
    return () => cancelIdleCallback(handle);
  }, [retainHome, prepared]);
  // Derive the opening mount before committing children. Waiting for an effect
  // adds an empty commit before Home can mount for the first gesture.
  if (open && !mounted) setMounted(true);
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
    settling.value = false;
    cancelAnimation(stretch);
    stretch.value = 0;
    setStretchWidth(0);
    setHomeWidth(null);
    setMounted(false);
  }, [settling, stretch]);
  // Keep the old transparent Modal alive until UIKit confirms that the same
  // content/controller reached the column. Never duplicate Home or use a timer
  // to guess when its native destination is ready.
  const presentation = useRef({ aboveSystemBar, panelWidth, top: topInset ?? insets.top });
  const [presentedPersistent, setPresentedPersistent] = useState(persistent);
  const [handoff, setHandoff] = useState<{ width: number; top: number } | null>(null);
  if (presentedPersistent !== persistent) {
    if (persistent && presentation.current.aboveSystemBar && mounted
      && retainHome && NativeTaskDrawerHost && taskDrawerHandoffAvailable) {
      setHandoff({ width: presentation.current.panelWidth, top: presentation.current.top });
    } else setHandoff(null);
    setPresentedPersistent(persistent);
  }
  useLayoutEffect(() => {
    presentation.current = { aboveSystemBar, panelWidth, top: topInset ?? insets.top };
  });
  if (handoff && !retainHome) setHandoff(null);
  const persistentRef = useRef(persistent);
  persistentRef.current = persistent;
  const finishHandoff = useCallback(() => {
    // An acknowledgment from an earlier rotation must not finish a newer one.
    setHandoff(current => persistentRef.current && current === handoff ? null : current);
  }, [handoff]);
  useEffect(() => {
    if (persistent && !handoff) onColumnReady?.();
  }, [persistent, handoff, onColumnReady]);
  const previousPersistent = useRef(persistent);
  const columnCollapsed = useRef(false);
  const collapsingColumn = previousPersistent.current && !persistent && !open;
  useLayoutEffect(() => {
    if (!previousPersistent.current && persistent) {
      // A column takes over at its full layout width, including when rotation
      // interrupts a pull, rebound, resize or stretch toward Home.
      cancelAnimation(progress);
      cancelAnimation(dragX);
      cancelAnimation(stretch);
      progress.value = 1;
      dragX.value = 0;
      tracking.value = false;
      settling.value = false;
      stretch.value = 0;
      setStretchWidth(0);
      setHomeWidth(null);
    }
    if (previousPersistent.current && !persistent && !open) {
      // A disappearing column is not a modal exit: no scrim or focus isolation.
      columnCollapsed.current = true;
      cancelAnimation(progress);
      progress.value = 0;
      dragX.value = 0;
      setMounted(false);
    }
    previousPersistent.current = persistent;
  }, [persistent, open, progress, dragX, stretch, tracking, settling]);
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
  const homeContentRef = useRef<ViewInstance>(null);
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
      // Keep the gesture's ownership through release, not just finger-down.
      // A busy JS thread may only commit open after the native settle started;
      // replaying admission here would rewind/restart that in-flight animation.
      if (tracking.value || settling.value) return;
      // 手势位移并回 progress,从当前视觉位置继续,不跳帧。
      const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
      progress.value = effective;
      dragX.value = 0;
      // 重浮层入场档(motionDuration.enter + out 曲线),与 DESIGN.md §14.4 双端同构。
      progress.value = animate && effective < 1
        ? withTiming(1, { duration: motionDuration.enter * (1 - effective), easing: Easing.bezier(...motionEasing.out) })
        : 1;
      return;
    }
    if (!mountedRef.current) return;
    const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
    progress.value = effective;
    dragX.value = 0;
    if (!animate || effective === 0) {
      progress.value = 0;
      finishClose();
      return;
    }
    // The finger already covered part of the travel. Do not replay a full exit
    // for a nearly closed panel (including an aborted opening pull).
    const remainingDuration = motionDuration.exit * effective;
    progress.value = withTiming(
      0,
      // 重浮层退场档(motionDuration.exit + in 曲线)。
      { duration: remainingDuration, easing: Easing.bezier(...motionEasing.in) },
    );
    // A cancelled/lost UI-thread completion must not leave an invisible modal eating taps.
    // Cleanup on reopen or layout change; navigation still waits for the unmount commit above.
    const closeTimer = setTimeout(finishClose, remainingDuration);
    return () => clearTimeout(closeTimer);
  }, [dragX, finishClose, open, panelWidth, progress, reduceMotion, persistent, tracking, settling]);

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
  // One live coordinate for the visible panel and both gesture boundaries.
  // Reading it at touch-down also covers interrupted opening/closing rebounds.
  // Subscribe directly to the shared values. Reanimated does not discover
  // mapper inputs hidden inside a captured callback's closure.
  const panelOffset = useDerivedValue(() => persistent ? 0 : Math.max(-panelWidth,
    Math.min(0, (progress.value - 1) * panelWidth + dragX.value)));
  const getEdgeLeft = useCallback(() => {
    'worklet';
    return panelWidth + panelOffset.value;
  }, [panelOffset, panelWidth]);
  // The floating drawer's right edge resizes it without a visible grip. Its
  // gesture sits on the overlay, above both the panel and the dimmed area, so
  // taps near the edge still reach list rows and close the drawer.
  const edge = useSessionPaneDivider({
    enabled: !persistent && open && !!resize, width, bounds: resize?.bounds ?? null,
    left: panelWidth, getLeft: getEdgeLeft, top: topInset ?? insets.top, bottom: insets.bottom,
    onResize: resize?.onResize ?? ignoreResize, elastic: { onStretch: stretchTo, onSettle: settleStretch },
  });
  // Where a rightward drag on the dimmed area becomes Home, and whether it has.
  const homeAt = useSharedValue(DRAWER_HOME_TRAVEL);
  const homeEntered = useSharedValue(false);
  const edgeInset = edge.rowInset;
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
      progress.value = withTiming(1, { duration: motionDuration.fast * (1 - effective), easing: Easing.bezier(...motionEasing.move) });
    };
    // Both leave the edge's drag band to resizing: on a coarse move all three
    // can activate at once, and the deeper panel/dimmed area would win.
    const panel = Gesture.Pan().enabled(!persistent)
      .hitSlop({ right: -edgeInset })
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
      .onTouchesDown((event, manager) => {
        'worklet';
        const touch = event.allTouches[0];
        if (edgeInset && touch && touch.x < getEdgeLeft() + edgeInset) manager.fail();
      })
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
  }, [closeFromGesture, dragX, edgeInset, enterHome, getEdgeLeft, home, homeAt, homeEntered, panelWidth, persistent, progress, stretch]);

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth)),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: panelOffset.value,
      },
    ],
  }));


  // A docked column sits beside the side-by-side edge, which publishes its own inset.
  const residentEdgeInset = usePaneEdgeInset();
  // A handoff shell can render beside the live overlay; it needs its own detector gesture.
  const idleEdgeGesture = useMemo(() => Gesture.Pan().enabled(false), []);

  // Home reads both callbacks when a row is used, so their identity is not list
  // content. Keep the element stable: opening, closing or an outer layout render
  // must not render every row again just before the panel has to appear.
  const homeHost = useRef({ onSelectSession, runNavigation });
  homeHost.current = { onSelectSession, runNavigation };
  const selectHomeSession = useCallback((item: RemoteSessionListItem) => homeHost.current.onSelectSession?.(item), []);
  const runHomeNavigation = useCallback((action: () => void) => homeHost.current.runNavigation(action), []);
  const selectsSession = !!onSelectSession;
  const homeContent = useMemo(() => <PaneEdgeInsetProvider value={persistent ? residentEdgeInset : edge.rowInset}><MobileHome newSessionActionRef={newSessionActionRef} width={shownWidth} currentSessionId={currentSessionId}
    newSessionInSystemBar={newSessionInSystemBar} newSessionInHeader={!persistent}
    onSelectSession={selectsSession ? selectHomeSession : undefined} runNavigation={runHomeNavigation} /></PaneEdgeInsetProvider>,
  [newSessionActionRef, shownWidth, currentSessionId, newSessionInSystemBar, persistent, residentEdgeInset, edge.rowInset, selectsSession, selectHomeSession, runHomeNavigation]);
  // Remove a collapsed column in this render, before Home receives width=0.
  // The layout effect still settles motion and suppresses modal-close callbacks.
  // The existing native host keeps Fabric ownership while its plain content
  // container docks into the Modal. A local focus boundary pauses background
  // work without hiding/recreating every native view on the next reveal.
  // There is still only one sidebar Home; the Modal contains a docking slot.
  const RetainedHost = NativeTaskDrawerHost ?? NativeHistoryHost;
  const retainedHome = retainHome && (prepared || mounted) && RetainedHost ? sharedList
    ? <SharedTaskListContent retainPresentation={retainPresentation} width={shownWidth} height={retainedHeight!} active={mounted && !collapsingColumn} onDock={persistent && handoff ? finishHandoff : undefined}>{homeContent}</SharedTaskListContent>
    : <RetainedHost key="home" surfaceId={surfaceId}
    testID="sessionDrawer.retainedHost" pointerEvents="none" accessibilityElementsHidden
    style={{ position: 'absolute', width: shownWidth, height: retainedHeight }}>
    <LocalHomeList><HomePresentationFocus active={mounted && !collapsingColumn}>{homeContent}</HomePresentationFocus></LocalHomeList>
  </RetainedHost> : null;
  if (!mounted || collapsingColumn || sharedList && retainHome && persistent && !handoff) return <>{retainedHome}</>;
  const panel = (handoffShell: boolean) => <Animated.View style={[styles.panel, { paddingLeft: insets.left, paddingTop: topInset ?? insets.top, width: panelWidth },
        (!persistent || handoffShell) && panelStyle,
        handoffShell && { width: handoff!.width, paddingTop: handoff!.top, backgroundColor: 'transparent', borderRightWidth: 0 },
      ]} testID="sessionDrawer.panel">
        {/* The host keeps the first navigation intent. Stop all list input during exit so a
            second selection cannot change preferences while its route is discarded. */}
        <View ref={homeContentRef} style={styles.content} pointerEvents={open ? 'auto' : 'none'}
          accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
          {retainHome && NativeHistorySlot ? <NativeHistorySlot surfaceId={surfaceId} selected={!handoffShell && (!sharedList || (focused || retainPresentation) && !persistent)}
            onDock={persistent && !handoffShell && taskDrawerHandoffAvailable ? finishHandoff : undefined}
            testID="sessionDrawer.retainedSlot" style={styles.content} /> : homeContent}
        </View>

      </Animated.View>;
  const overlay = (handoffShell = false) => <GestureDetector gesture={handoffShell ? idleEdgeGesture : edge.gesture}>
  <View accessibilityViewIsModal={mounted && !persistent} pointerEvents={handoffShell ? "none" : "auto"}
    style={[styles.overlay, persistent && { width: panelWidth }]} testID="sessionDrawer.overlay">
    {!persistent ? <GestureDetector gesture={gestures.scrim}>
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable accessibilityLabel={t('home.drawer.closeA11y')} accessibilityRole="button"
          onPress={onClose} style={styles.scrimPressable} testID="sessionDrawer.scrim" />
      </Animated.View>
    </GestureDetector> : null}
    {persistent && retainHome && NativeTaskDrawerHost && !handoffShell ? panel(false)
      : <GestureDetector gesture={gestures.panel}>{panel(handoffShell)}</GestureDetector>}
    {/* The edge's accessibility element rides the panel's slide. */}
    {edge.edge && !handoffShell ? <Animated.View pointerEvents="box-none" style={[styles.edge, panelStyle]}>
      {edge.edge}
    </Animated.View> : null}
  </View>
  </GestureDetector>;
  // Stable sibling keys preserve the old Modal and its slot while the column
  // mounts alongside it. Its transparent shell cannot cover the newly docked list.
  return <>{retainedHome}
    {(!persistent && aboveSystemBar) || handoff ? <Modal key="floating" animationType="none" transparent visible onRequestClose={onClose}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}>
      {/* Modal's first Fabric layout can still carry the pre-unfold window
          size. Use the same live geometry as the task, without waiting for the
          modal controller's bounds callback or shrinking to that stale parent. */}
      <GestureHandlerRootView style={[styles.window, { width: window.width, height: window.height }]}>{overlay(!!handoff)}</GestureHandlerRootView>
    </Modal> : null}
    {persistent || !aboveSystemBar ? <View key="column" pointerEvents="box-none" style={StyleSheet.absoluteFill}>{overlay()}</View> : null}
  </>;

}

function ignoreResize() {}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 40 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  scrimPressable: { flex: 1 },
  panel: { backgroundColor: colors.surface, borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth,
    position: 'absolute', top: 0, bottom: 0, left: 0 },
  content: { flex: 1, minHeight: 0 },
  edge: { ...StyleSheet.absoluteFill },
  window: { flexGrow: 0, flexShrink: 0 },
});
