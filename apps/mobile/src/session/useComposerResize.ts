import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanResponder } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { runOnJS, runOnUI, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { Gesture } from '@/platform/gestureHandler';
import { COMPOSER_TEXT_LINE_HEIGHT, COMPOSER_TEXT_VERTICAL_PADDING } from '@/session/composerTextMetrics';
import {
  COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD,
  applyComposerResizeDrag,
  buildComposerResizeGestureConfig,
  buildComposerResizeTouchHandlers,
  computeComposerResizeBounds,
  resolveComposerInputHeight,
  settleComposerResizeDrag,
  shouldDismissComposerOnRelease,
} from '@/session/composerResize';

const isStoreClient = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

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
  const gestureId = useSharedValue(0);
  const startHeight = useSharedValue(model.visibleContentHeight);
  const dragHeight = useSharedValue(model.visibleContentHeight);
  useLayoutEffect(() => {
    const nextGeometry = { bounds, visibleHeight: model.visibleContentHeight, explicit: input.collapsed === true || model.mode === 'manual', minFrameHeight: input.minFrameHeight ?? 0, autoMaxHeight: input.autoMaxContentHeight };
    // Check the generation and publish together on UI: another gesture may
    // begin between React's commit and delivery of this geometry update.
    runOnUI((next: typeof nextGeometry, completed: number) => {
      'worklet';
      geometry.value = next;
      if (completed === gestureId.value) active.value = false;
    })(nextGeometry, completedGesture);
  }, [active, bounds.minContentHeight, bounds.maxContentHeight, completedGesture, gestureId, input.autoMaxContentHeight, input.collapsed, input.minFrameHeight, model.mode, model.visibleContentHeight, geometry]);

  const begin = useCallback((id: number) => {
    if (!mounted.current || id !== gestureId.value) return;
    latest.current.onGrabberTouchActiveChange?.(true);
    setDragging(true);
  }, [gestureId]);
  const finish = useCallback((height: number, initialHeight: number, translationY: number, successful: boolean, id: number) => {
    if (!mounted.current || id !== gestureId.value) return;
    const current = latest.current;
    const currentBounds = computeComposerResizeBounds(current);
    if (successful) {
      if (Math.abs(height - initialHeight) >= COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD) {
        setUserContentHeight(settleComposerResizeDrag({ bounds: currentBounds, contentHeight: current.contentHeight, draggedContentHeight: height }));
      }
      if (shouldDismissComposerOnRelease({ bounds: currentBounds, draggedContentHeight: height, translationY })) {
        current.onSnapToAuto?.();
      }
    }
    setDragging(false);
    setCompletedGesture(id);
    current.onGrabberTouchActiveChange?.(false);
  }, [gestureId]);

  const scrollGesture = useMemo(() => Gesture.Native(), []);
  const gesture = useMemo(() => Gesture.Pan()
    // Dedicated grabber: own the touch before the keyboard's ancestor ScrollView.
    .minDistance(0)
    .blocksExternalGesture(scrollGesture)
    .onBegin(() => {
      'worklet';
      gestureId.value += 1;
      // A second drag can begin before the first JS completion is delivered.
      startHeight.value = active.value ? dragHeight.value : geometry.value.visibleHeight;
      active.value = true;
      dragHeight.value = startHeight.value;
      runOnJS(begin)(gestureId.value);
    })
    .onUpdate((event) => {
      'worklet';
      dragHeight.value = applyComposerResizeDrag({ bounds: geometry.value.bounds, startContentHeight: startHeight.value, translationY: event.translationY });
    })
    .onFinalize((event, successful) => {
      'worklet';
      if (!successful) {
        // Cancellation must restore the settled frame even while JS is busy,
        // so a new gesture cannot inherit the canceled temporary height.
        dragHeight.value = geometry.value.visibleHeight;
        active.value = false;
      }
      runOnJS(finish)(dragHeight.value, startHeight.value, event.translationY, successful, gestureId.value);
    }), [active, begin, dragHeight, finish, geometry, gestureId, scrollGesture, startHeight]);

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
        initial = geometry.value.visibleHeight;
        height = initial;
        dragHeight.value = height;
        active.value = true;
        id = ++gestureId.value;
        begin(id);
      },
      onMove: (translationY) => {
        height = applyComposerResizeDrag({ bounds: geometry.value.bounds, startContentHeight: initial, translationY });
        dragHeight.value = height;
      },
      onEnd: (translationY) => finish(height, initial, translationY, true, id),
    }));
    responder.panHandlers.onResponderTerminate = () => {
      dragHeight.value = geometry.value.visibleHeight;
      active.value = false;
      finish(height, initial, 0, false, id);
    };
    return { ...responder.panHandlers, ...buildComposerResizeTouchHandlers((value) => latest.current.onGrabberTouchActiveChange?.(value)) };
  }, [active, begin, dragHeight, finish, geometry, gestureId]);

  const contentHeight = useDerivedValue(() => active.value
    ? Math.max(geometry.value.bounds.minContentHeight, Math.min(dragHeight.value, geometry.value.bounds.maxContentHeight))
    : geometry.value.visibleHeight);
  const frameStyle = useAnimatedStyle(() => ({
    // Auto growth stays capped, but the grabber removes that cap on UI before
    // begin can reach JS. Explicit heights are already bounded by the model.
    maxHeight: active.value || geometry.value.explicit ? undefined : geometry.value.autoMaxHeight,
    height: active.value || geometry.value.explicit
      ? Math.max(geometry.value.minFrameHeight, contentHeight.value + COMPOSER_TEXT_VERTICAL_PADDING * 2)
      : undefined,
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
    contentHeight,
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
    visibleContentHeight: model.visibleContentHeight,
  };
}
