import { useTaskDrawerPresentation } from './TaskDrawerPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useSessionListDrawerMotion, useSessionListDrawerOpenGesture } from './SessionListDrawer';

/** One lifecycle for every conversation: gesture ownership, exit fencing and deferred navigation. */
export function useConversationTaskDrawer({ enabled, persistent, width }: { enabled: boolean; persistent: boolean; width: number }) {
  const [sessionListDrawerOpen, setSessionListDrawerOpen] = useState(false);
  const [sessionListDrawerOverlayMounted, setSessionListDrawerOverlayMounted] = useState(false);
  const sessionListDrawerWidthRef = useRef(width);
  if (enabled) sessionListDrawerWidthRef.current = width;
  // Root-owned surfaces switch concurrently. Route-local fallbacks still wait
  // for the overlay unmount commit to avoid native Screen/gesture teardown races.
  const pendingDrawerNavigationRef = useRef<(() => void) | null>(null);
  // pending 只能拦住「首击本身就是导航」的连点;遮罩/back/左滑/当前任务先关闭时 pending
  // 仍为空。closing 从任一关闭入口同步置 true,完整覆盖退场 commit 前的快速二次点击。
  const sessionListDrawerClosingRef = useRef(false);
  // overlayMounted for gesture callbacks that can arrive before it renders.
  const sessionListDrawerShownRef = useRef(false);
  const openSessionListDrawer = useCallback(() => {
    if (!enabled || persistent || sessionListDrawerClosingRef.current) return;
    sessionListDrawerShownRef.current = true;
    setSessionListDrawerOverlayMounted(true);
    setSessionListDrawerOpen(true);
  }, [persistent, enabled]);
  // Floating mode: a rightward swipe on the task pulls the list out instead of
  // going back; let go too early and it slides back.
  const sessionListDrawerFloating = enabled && !persistent;
  const presentation = useTaskDrawerPresentation();
  const localMotion = useSessionListDrawerMotion();
  const sessionListDrawerMotion = presentation?.motion ?? localMotion;
  // Whether the drawer has rendered open since it was last released. A pull
  // cancelled before that (busy JS thread: open and cancel batched together)
  // leaves the drawer unmounted, so nothing would ever call onClosed.
  const sessionListDrawerOpenCommittedRef = useRef(false);
  useEffect(() => {
    if (sessionListDrawerOpen) sessionListDrawerOpenCommittedRef.current = true;
    else if (!sessionListDrawerOverlayMounted) sessionListDrawerOpenCommittedRef.current = false;
  }, [sessionListDrawerOpen, sessionListDrawerOverlayMounted]);
  const settleSessionListDrawerPull = useCallback(() => {
    if (!sessionListDrawerShownRef.current || sessionListDrawerClosingRef.current) return;
    if (!sessionListDrawerOpenCommittedRef.current) {
      sessionListDrawerShownRef.current = false;
      setSessionListDrawerOpen(false);
      setSessionListDrawerOverlayMounted(false);
      return;
    }
    sessionListDrawerClosingRef.current = true;
    setSessionListDrawerOpen(false);
  }, []);
  // Stays enabled while the finger that opened the list is still down.
  const [sessionListDrawerPulling, setSessionListDrawerPulling] = useState(false);
  const pullSessionListDrawer = useCallback(() => {
    setSessionListDrawerPulling(true);
    openSessionListDrawer();
  }, [openSessionListDrawer]);
  const endSessionListDrawerPull = useCallback(() => setSessionListDrawerPulling(false), []);
  const sessionListDrawerPullGesture = useSessionListDrawerOpenGesture({
    motion: sessionListDrawerMotion,
    enabled: sessionListDrawerFloating && (!sessionListDrawerOverlayMounted || sessionListDrawerPulling),
    width: sessionListDrawerWidthRef.current,
    onOpen: pullSessionListDrawer,
    onCancel: settleSessionListDrawerPull,
    onSettle: endSessionListDrawerPull,
  });
  const closeSessionListDrawer = useCallback(() => {
    if (!sessionListDrawerOverlayMounted) return;
    if (sessionListDrawerClosingRef.current) return;
    sessionListDrawerClosingRef.current = true;
    setSessionListDrawerOpen(false);
  }, [sessionListDrawerOverlayMounted]);
  // 旋转 / 分屏收窄回到窄屏形态时,抽屉没有入口也没有意义,直接关掉。
  useEffect(() => {
    if (!enabled && sessionListDrawerOverlayMounted) closeSessionListDrawer();
  }, [closeSessionListDrawer, sessionListDrawerOverlayMounted, enabled]);
  // 抽屉打开时由 SessionListDrawer 消费 Android back 并发起关闭;open=false 后该监听会
  // 卸载,但 overlay 仍要退场约 motionDuration.exit。这个窗口临时吞掉 back,避免原生
  // Screen 返回与 GestureDetector/Reanimated 子树卸载再次挤进同一帧。onClosed 提交
  // overlayMounted=false 后自动移除,正常返回链(含 useGuardedBack)随即恢复。
  useEffect(() => {
    if (Platform.OS !== 'android' || !sessionListDrawerOverlayMounted || sessionListDrawerOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [sessionListDrawerOpen, sessionListDrawerOverlayMounted]);
  const queueDrawerNavigation = useCallback((action: () => void) => {
    // closing 覆盖所有关闭来源,包括 pending 为空的纯关闭;首个意图获胜。
    if (presentation?.isExiting() || sessionListDrawerClosingRef.current || pendingDrawerNavigationRef.current) return;
    if (persistent && !sessionListDrawerOverlayMounted) { action(); return; }
    sessionListDrawerClosingRef.current = true;
    setSessionListDrawerOpen(false);
    // The account-level surface survives navigation: switch now while it slides
    // out. Older binaries keep their route-local teardown fence.
    if (presentation?.navigate(action)) return;
    pendingDrawerNavigationRef.current = action;
  }, [persistent, sessionListDrawerOverlayMounted, presentation]);
  const handleSessionListDrawerClosed = useCallback(() => {
    const action = pendingDrawerNavigationRef.current;
    sessionListDrawerClosingRef.current = false;
    setSessionListDrawerOpen(false);
    setSessionListDrawerPulling(false);
    setSessionListDrawerOverlayMounted(false);
    sessionListDrawerShownRef.current = false;
    if (!action) return;
    pendingDrawerNavigationRef.current = null;
    action();
  }, []);
  useEffect(() => {
    if (!persistent || !sessionListDrawerOverlayMounted) return;
    setSessionListDrawerOpen(false);
    closeSessionListDrawer();
  }, [persistent, sessionListDrawerOverlayMounted, closeSessionListDrawer]);
  return { sessionListDrawerOpen, sessionListDrawerOverlayMounted, sessionListDrawerWidthRef, sessionListDrawerClosingRef, pendingDrawerNavigationRef, openSessionListDrawer, closeSessionListDrawer, sessionListDrawerFloating, sessionListDrawerMotion, sessionListDrawerPullGesture, queueDrawerNavigation, handleSessionListDrawerClosed };
}
