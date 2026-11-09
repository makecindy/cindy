import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, type ViewInstance } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { measure, runOnJS, runOnUI, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { Gesture } from '@/platform/gestureHandler';
import { COMPOSER_TEXT_LINE_HEIGHT, COMPOSER_TEXT_VERTICAL_PADDING } from '@/session/composerTextMetrics';
import {
  COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD,
  applyComposerResizeDrag,
  composerCollapseProgress,
  composerOpenCollapseProgress,
  composerOpenDragTranslation,
  buildComposerResizeGestureConfig,
  buildComposerResizeTouchHandlers,
  computeComposerResizeBounds,
  resolveComposerBodyDrag,
  resolveComposerInputHeight,
  settleComposerResizeDrag,
  shouldCommitComposerOpenDrag,
  shouldDismissComposerDuringDrag,
  shouldDismissComposerOnRelease,
  type ComposerTextScrollEdge,
} from '@/session/composerResize';
import { composerPullTranslation, type ComposerPullEvent, type ComposerPullThroughBridge } from '@/session/composerPullThrough';

const isStoreClient = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const BODY_DRAG_IDLE = 0;
const BODY_DRAG_PENDING = 1;
const BODY_DRAG_ACTIVE = 2;

export interface UseComposerResizeInput {
  contentHeight: number;
  autoMaxContentHeight: number;
  windowHeight: number;
  keyboardHeight: number;
  singleLineContentHeight: number;
  composerChromeHeight: number;
  collapsed?: boolean;
  minFrameHeight?: number;
  onSnapToAuto?: () => void;
  /** Only gesture boundaries cross to JS; never publish per-frame heights. */
  onGrabberTouchActiveChange?: (active: boolean) => void;
  /** 聊天记录拖进输入框时由列表侧接手；与按住顶边拖动走同一套调高逻辑。 */
  pullThrough?: ComposerPullThroughBridge;
  /** 展开卡片态、外壳不需要自己滚动时，按在卡片任意处上下拖动也能调高（bodyGesture）；
   *  收起态时往上拖即拉开。 */
  bodyDragEnabled?: boolean;
  /** 收起态往上拖开始 / 结束（true 期间页面保持卡片态，让输入区跟手拉高）。 */
  onDragOpenChange?: (opening: boolean) => void;
  /** 拉开拖动松手且拉够了：页面聚焦输入框（等同点开），由它接着保持卡片态。 */
  onDragOpenCommit?: () => void;
}

/** UI-thread resize. React remembers the settled height, not the pointer stream. */
export function useComposerResize(input: UseComposerResizeInput) {
  const [userContentHeight, setUserContentHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [completedGesture, setCompletedGesture] = useState(0);
  const mounted = useRef(true);
  const latest = useRef(input);
  latest.current = input;
  const bounds = computeComposerResizeBounds(input);
  const model = resolveComposerInputHeight({ ...input, bounds, userContentHeight });
  const geometry = useSharedValue({ bounds, visibleHeight: model.visibleContentHeight, explicit: input.collapsed === true || model.mode === 'manual', minFrameHeight: input.minFrameHeight ?? 0, autoMaxHeight: input.autoMaxContentHeight });
  const active = useSharedValue(false);
  const awaitingCollapse = useSharedValue(false);
  const gestureId = useSharedValue(0);
  const startHeight = useSharedValue(model.visibleContentHeight);
  const dragHeight = useSharedValue(model.visibleContentHeight);
  const dragTranslation = useSharedValue(0);
  const startAbsoluteY = useSharedValue(0);
  const dismissedGestureId = useSharedValue(0);
  const measuredOverflow = input.contentHeight > model.visibleContentHeight + 1;
  const bodyDragGate = useSharedValue({ enabled: input.bodyDragEnabled === true, collapsed: input.collapsed === true, measuredOverflow });
  useLayoutEffect(() => {
    bodyDragGate.value = { enabled: input.bodyDragEnabled === true, collapsed: input.collapsed === true, measuredOverflow };
  }, [bodyDragGate, input.bodyDragEnabled, input.collapsed, measuredOverflow]);
  // 本次拖动是从收起态往上拉开（见 composerOpenDragTranslation）。
  const opening = useSharedValue(false);
  useLayoutEffect(() => {
    const nextGeometry = { collapsed: input.collapsed === true, bounds, visibleHeight: model.visibleContentHeight, explicit: input.collapsed === true || model.mode === 'manual', minFrameHeight: input.minFrameHeight ?? 0, autoMaxHeight: input.autoMaxContentHeight };
    // Check the generation and publish together on UI: another gesture may
    // begin between React's commit and delivery of this geometry update.
    runOnUI((next: typeof nextGeometry, completed: number) => {
      'worklet';
      geometry.value = next;
      if (completed === gestureId.value && (!awaitingCollapse.value || next.collapsed)) {
        active.value = false;
        awaitingCollapse.value = false;
      }
    })(nextGeometry, completedGesture);
  }, [active, awaitingCollapse, bounds.minContentHeight, bounds.maxContentHeight, completedGesture, gestureId, input.autoMaxContentHeight, input.collapsed, input.minFrameHeight, model.mode, model.visibleContentHeight, geometry]);

  const begin = useCallback((id: number, fromCollapsed: boolean) => {
    if (!mounted.current || id !== gestureId.value) return;
    latest.current.onGrabberTouchActiveChange?.(true);
    if (fromCollapsed) latest.current.onDragOpenChange?.(true);
    setDragging(true);
  }, [gestureId]);
  const finish = useCallback((height: number, initialHeight: number, translationY: number, successful: boolean, id: number, fromCollapsed: boolean) => {
    if (!mounted.current || id !== gestureId.value) return;
    const current = latest.current;
    const currentBounds = computeComposerResizeBounds(current);
    if (fromCollapsed) {
      // 拉开：只有拉出了一行以上才记成手动高度，否则沿用点开时的高度（auto 或上次手动值）。
      if (successful && shouldCommitComposerOpenDrag(translationY)) {
        if (height > currentBounds.minContentHeight + COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD) {
          // Keep exactly what was pulled out: the downward snap-to-one-line rule
          // (settleComposerResizeDrag) would hide the lines the user just revealed.
          setUserContentHeight(Math.min(Math.max(Math.round(height), currentBounds.minContentHeight), currentBounds.maxContentHeight));
        }
        current.onDragOpenCommit?.();
      } else {
        current.onDragOpenChange?.(false);
      }
    } else if (successful) {
      if (Math.abs(height - initialHeight) >= COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD) {
        setUserContentHeight(settleComposerResizeDrag({ bounds: currentBounds, contentHeight: current.contentHeight, draggedContentHeight: height }));
      }
      if (shouldDismissComposerOnRelease({ bounds: currentBounds, draggedContentHeight: height, translationY })) {
        awaitingCollapse.value = !!current.onSnapToAuto;
        current.onSnapToAuto?.();
      }
    }
    setDragging(false);
    setCompletedGesture(id);
    current.onGrabberTouchActiveChange?.(false);
  }, [awaitingCollapse, gestureId]);

  // 手柄拖动与「聊天记录拖进输入框」共用的三段 UI 线程逻辑。
  const drag = useMemo(() => {
    const beginAt = (absoluteY: number, fromCollapsed = false) => {
      'worklet';
      opening.value = fromCollapsed;
      startAbsoluteY.value = absoluteY;
      awaitingCollapse.value = false;
      gestureId.value += 1;
      // A second drag can begin before the first JS completion is delivered.
      startHeight.value = active.value ? dragHeight.value : geometry.value.visibleHeight;
      active.value = true;
      dragHeight.value = startHeight.value;
      dragTranslation.value = 0;
      runOnJS(begin)(gestureId.value, fromCollapsed);
    };
    const moveBy = (translationY: number) => {
      'worklet';
      if (dismissedGestureId.value === gestureId.value) return;
      dragTranslation.value = translationY;
      if (opening.value) {
        dragHeight.value = applyComposerResizeDrag({ bounds: geometry.value.bounds, startContentHeight: startHeight.value, translationY: composerOpenDragTranslation(translationY) });
        return;
      }
      dragHeight.value = applyComposerResizeDrag({ bounds: geometry.value.bounds, startContentHeight: startHeight.value, translationY });
      // 拖到一行、折叠完工具栏后再多拉一段即收起，不等松手。
      if (shouldDismissComposerDuringDrag({ bounds: geometry.value.bounds, startContentHeight: startHeight.value, translationY })) {
        dismissedGestureId.value = gestureId.value;
        runOnJS(finish)(dragHeight.value, startHeight.value, translationY, true, gestureId.value, false);
      }
    };
    const finalize = (translationY: number, successful: boolean) => {
      'worklet';
      // 已在拖动途中收起：之后的抬手或取消不再结算。
      if (dismissedGestureId.value === gestureId.value) return;
      if (!successful) {
        // Cancellation must restore the settled frame even while JS is busy,
        // so a new gesture cannot inherit the canceled temporary height.
        dragHeight.value = geometry.value.visibleHeight;
        active.value = false;
      }
      runOnJS(finish)(dragHeight.value, startHeight.value, translationY, successful, gestureId.value, opening.value);
    };
    return { beginAt, moveBy, finalize };
  }, [active, awaitingCollapse, begin, dismissedGestureId, dragHeight, dragTranslation, finish, geometry, gestureId, opening, startAbsoluteY, startHeight]);

  const scrollGesture = useMemo(() => Gesture.Native(), []);
  // 顶边把手正在拖时整张卡片的体拖让位：两者共用同一次调高，体拖若半途接手又被系统
  // 挤掉，它的取消收尾会把把手正在跟手的高度撤回，直到松手才结算。记下把手发起的那次
  // 调高而不是「按着」标记：把手拖到收起时随卡片卸载，收不到抬手，标记会一直卡住。
  const grabberGestureId = useSharedValue(0);
  const gesture = useMemo(() => Gesture.Pan()
    // Dedicated grabber: own the touch before the keyboard's ancestor ScrollView.
    .minDistance(0)
    .blocksExternalGesture(scrollGesture)
    .onBegin((event) => {
      'worklet';
      drag.beginAt(event.absoluteY);
      grabberGestureId.value = gestureId.value;
    })
    .onUpdate((event) => {
      'worklet';
      // The grabber itself moves with the resizing frame. Use screen coordinates
      // so its changing origin cannot feed back into the drag distance.
      drag.moveBy(Number.isFinite(event.absoluteY)
        ? event.absoluteY - startAbsoluteY.value
        : event.translationY);
    })
    .onFinalize((event, successful) => {
      'worklet';
      drag.finalize(Number.isFinite(event.absoluteY)
        ? event.absoluteY - startAbsoluteY.value
        : event.translationY, successful);
    }), [drag, gestureId, grabberGestureId, scrollGesture, startAbsoluteY]);

  // 按在卡片任意处上下拖动调高。Manual 而非 Pan：待定期间不装一个与之竞争的
  // UIPanGestureRecognizer，不拖住 iOS 侧滑返回和视频控件（同 composerPullThrough）；
  // 判定为调高前编辑器照常收到触摸，点按、选字、滚动文字不受影响。
  const textFrameRef = useAnimatedRef<ViewInstance>();
  const textScrollEdge = useSharedValue<ComposerTextScrollEdge | null>(null);
  const setTextScrollEdge = useCallback((edge: ComposerTextScrollEdge | null) => {
    textScrollEdge.value = edge;
  }, [textScrollEdge]);
  const bodyPhase = useSharedValue(BODY_DRAG_IDLE);
  const bodyStartX = useSharedValue(0);
  const bodyStartY = useSharedValue(0);
  const bodyStartTime = useSharedValue(0);
  const bodyInText = useSharedValue(false);
  const bodyGesture = useMemo(() => {
    const cancel = () => {
      'worklet';
      if (bodyPhase.value === BODY_DRAG_ACTIVE) drag.finalize(dragTranslation.value, false);
      bodyPhase.value = BODY_DRAG_IDLE;
    };
    return Gesture.Manual()
      .onTouchesDown((touches, manager) => {
        'worklet';
        // A second finger (or a stale phase) must still settle a drag in progress.
        cancel();
        const touch = touches.allTouches[0];
        if (touches.numberOfTouches !== 1 || touch === undefined || !bodyDragGate.value.enabled) {
          manager.fail();
          return;
        }
        const frame = measure(textFrameRef);
        bodyInText.value = frame !== null
          && touch.absoluteX >= frame.pageX && touch.absoluteX <= frame.pageX + frame.width
          && touch.absoluteY >= frame.pageY && touch.absoluteY <= frame.pageY + frame.height;
        bodyStartX.value = touch.absoluteX;
        bodyStartY.value = touch.absoluteY;
        bodyStartTime.value = Date.now();
        bodyPhase.value = BODY_DRAG_PENDING;
      })
      .onTouchesMove((touches, manager) => {
        'worklet';
        if (bodyPhase.value === BODY_DRAG_IDLE) return;
        const touch = touches.allTouches[0];
        if (touches.numberOfTouches !== 1 || touch === undefined) {
          cancel();
          manager.fail();
          return;
        }
        if (bodyPhase.value === BODY_DRAG_PENDING) {
          if (active.value && grabberGestureId.value === gestureId.value) {
            bodyPhase.value = BODY_DRAG_IDLE;
            manager.fail();
            return;
          }
          const decision = resolveComposerBodyDrag({
            collapsed: bodyDragGate.value.collapsed,
            inText: bodyInText.value,
            edge: textScrollEdge.value,
            measuredOverflow: bodyDragGate.value.measuredOverflow,
            dx: touch.absoluteX - bodyStartX.value,
            dy: touch.absoluteY - bodyStartY.value,
            elapsedMs: Date.now() - bodyStartTime.value,
          });
          if (decision === 'pending') return;
          if (decision === 'reject') {
            bodyPhase.value = BODY_DRAG_IDLE;
            manager.fail();
            return;
          }
          // 从判定点起算位移：越过判定距离的那几点不让输入框跳一下。
          bodyPhase.value = BODY_DRAG_ACTIVE;
          manager.activate();
          drag.beginAt(touch.absoluteY, bodyDragGate.value.collapsed);
          return;
        }
        drag.moveBy(touch.absoluteY - startAbsoluteY.value);
      })
      .onTouchesUp((touches, manager) => {
        'worklet';
        if (bodyPhase.value === BODY_DRAG_ACTIVE) {
          const y = touches.changedTouches[0]?.absoluteY;
          const translationY = y === undefined ? dragTranslation.value : y - startAbsoluteY.value;
          drag.moveBy(translationY);
          drag.finalize(translationY, true);
          bodyPhase.value = BODY_DRAG_IDLE;
          manager.end();
          return;
        }
        bodyPhase.value = BODY_DRAG_IDLE;
        manager.fail();
      })
      .onTouchesCancelled((_touches, manager) => {
        'worklet';
        cancel();
        manager.fail();
      })
      .onFinalize(() => {
        'worklet';
        // 被其它手势（顶边把手、编辑器滚动）挤掉时不会再收到抬手：按取消收尾。
        cancel();
      });
  }, [bodyDragGate, bodyInText, bodyPhase, bodyStartTime, bodyStartX, bodyStartY, drag, active, gestureId, grabberGestureId, dragTranslation, startAbsoluteY, textFrameRef, textScrollEdge]);

  // 列表侧接手：event 每次都带完整位置，同一帧内合并的 begin / move / end 也能按状态补齐。
  const pullThroughEvent = input.pullThrough?.event;
  const pullThroughId = useSharedValue(0);
  const pullThroughOpen = useSharedValue(false);
  useAnimatedReaction(
    () => pullThroughEvent?.value ?? null,
    (event: ComposerPullEvent | null) => {
      if (event === null || event.id <= 0) return;
      if (event.active) {
        if (event.id > pullThroughId.value) {
          pullThroughId.value = event.id;
          pullThroughOpen.value = true;
          drag.beginAt(event.startY);
        }
        if (event.id === pullThroughId.value && pullThroughOpen.value) drag.moveBy(composerPullTranslation(event));
        return;
      }
      // 只收尾已经开始的那次接手；开始与结束挤在同一帧时什么都没发生，无需收尾。
      if (event.id !== pullThroughId.value || !pullThroughOpen.value) return;
      pullThroughOpen.value = false;
      const translationY = composerPullTranslation(event);
      drag.moveBy(translationY);
      drag.finalize(translationY, event.successful);
    },
    [drag, pullThroughEvent],
  );

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current.onGrabberTouchActiveChange?.(false);
    };
  }, []);

  // Expo Go deliberately disables RNGH in the platform adapter. Keep its
  // existing JS fallback; installed apps never attach a PanResponder.
  const panHandlers = useMemo(() => {
    if (!isStoreClient) return {};
    let initial = 0;
    let height = 0;
    let id = 0;
    const responder = PanResponder.create(buildComposerResizeGestureConfig({
      onGrant: () => {
        awaitingCollapse.value = false;
        initial = geometry.value.visibleHeight;
        startHeight.value = initial;
        dragTranslation.value = 0;
        height = initial;
        dragHeight.value = height;
        active.value = true;
        id = ++gestureId.value;
        begin(id, false);
      },
      onMove: (translationY) => {
        dragTranslation.value = translationY;
        height = applyComposerResizeDrag({ bounds: geometry.value.bounds, startContentHeight: initial, translationY });
        dragHeight.value = height;
      },
      onEnd: (translationY) => finish(height, initial, translationY, true, id, false),
    }));
    responder.panHandlers.onResponderTerminate = () => {
      dragHeight.value = geometry.value.visibleHeight;
      active.value = false;
      finish(height, initial, 0, false, id, false);
    };
    return { ...responder.panHandlers, ...buildComposerResizeTouchHandlers((value) => latest.current.onGrabberTouchActiveChange?.(value)) };
  }, [active, awaitingCollapse, begin, dragHeight, dragTranslation, finish, geometry, gestureId, startHeight]);

  const collapseProgress = useDerivedValue(() => !active.value
    ? 0
    : opening.value
      ? composerOpenCollapseProgress(dragTranslation.value)
      : composerCollapseProgress({ bounds: geometry.value.bounds, startContentHeight: startHeight.value, translationY: dragTranslation.value }));

  const contentHeight = useDerivedValue(() => active.value
    ? Math.max(geometry.value.bounds.minContentHeight, Math.min(dragHeight.value, geometry.value.bounds.maxContentHeight))
    : geometry.value.visibleHeight);
  const frameStyle = useAnimatedStyle(() => ({
    // Native animated updates omit undefined props, retaining the previous
    // height/cap. Explicitly restore intrinsic sizing with 'auto' and replace
    // the auto cap with the drag ceiling before begin can reach JS.
    maxHeight: active.value || geometry.value.explicit
      ? Math.max(geometry.value.minFrameHeight, geometry.value.bounds.maxContentHeight + COMPOSER_TEXT_VERTICAL_PADDING * 2)
      : geometry.value.autoMaxHeight,
    height: active.value || geometry.value.explicit
      ? Math.max(geometry.value.minFrameHeight, contentHeight.value + COMPOSER_TEXT_VERTICAL_PADDING * 2)
      : 'auto' as const,
  }));
  const reset = useCallback(() => setUserContentHeight(null), []);
  const adjustByLine = useCallback((direction: 1 | -1) => {
    const current = latest.current;
    const currentBounds = computeComposerResizeBounds(current);
    const height = applyComposerResizeDrag({ bounds: currentBounds, startContentHeight: geometry.value.visibleHeight, translationY: -direction * COMPOSER_TEXT_LINE_HEIGHT });
    setUserContentHeight(settleComposerResizeDrag({ bounds: currentBounds, contentHeight: current.contentHeight, draggedContentHeight: height }));
  }, [geometry]);

  return {
    adjustByLine,
    active,
    bodyGesture,
    contentHeight,
    collapseProgress,
    dragging,
    frameStyle,
    gesture,
    // The inner TextInput/WebView must be ready to fill any UI-driven frame;
    // waiting for React dragging here would clip it during a busy JS thread.
    inputMaxHeight: Math.max(input.autoMaxContentHeight, bounds.maxContentHeight + COMPOSER_TEXT_VERTICAL_PADDING * 2),
    maxFrameHeight: bounds.maxContentHeight + COMPOSER_TEXT_VERTICAL_PADDING * 2,
    mode: model.mode,
    panHandlers,
    reset,
    scrollEnabled: model.scrollEnabled,
    scrollGesture,
    setTextScrollEdge,
    textFrameRef,
    visibleContentHeight: model.visibleContentHeight,
  };
}
