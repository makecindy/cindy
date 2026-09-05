// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerResize, type UseComposerResizeInput } from '@/session/useComposerResize';
import { useContextSheetDrag, type UseContextSheetDragInput } from '@/session/useContextSheetDrag';

const runtime = vi.hoisted(() => ({
  js: [] as Array<() => void>,
  ui: [] as Array<() => void>,
  deferUI: false,
  reduceMotion: false,
  durations: [] as number[],
  deferAnimations: false,
  animationHeight: undefined as number | undefined,
}));
vi.mock('react-native', () => ({ PanResponder: { create: vi.fn(() => ({ panHandlers: {} })) } }));
vi.mock('expo-constants', () => ({
  default: { executionEnvironment: 'bare' }, ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => runtime.reduceMotion }));
vi.mock('@/theme', () => ({ motionDuration: { fast: 180 }, motionEasing: { move: [0, 0, 1, 1] } }));
type Callback = (event: { translationY: number }, successful?: boolean) => void;
interface TestGesture {
  begin: Callback; update: Callback; finalize: Callback;
}
vi.mock('@/platform/gestureHandler', () => {
  const make = () => {
    const callbacks = {} as TestGesture;
    return Object.assign(callbacks, {
      minDistance() { return this; },
      blocksExternalGesture() { return this; },
      activeOffsetY() { return this; },
      failOffsetX() { return this; },
      onBegin(fn: Callback) { callbacks.begin = fn; return this; },
      onUpdate(fn: Callback) { callbacks.update = fn; return this; },
      onFinalize(fn: Callback) { callbacks.finalize = fn; return this; },
    });
  };
  return { Gesture: { Pan: make, Native: make } };
});
// Run real hooks/React and geometry models. Model UI worklets as synchronous
// callbacks, but hold runOnJS deliveries to exercise a busy JS thread explicitly.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useDerivedValue: (calculate: () => unknown) => ({ get value() { return calculate(); } }),
    useAnimatedStyle: (calculate: () => unknown) => ({ get current() { return calculate(); } }),
    runOnJS: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => {
      runtime.js.push(() => fn(...args));
    },
    runOnUI: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => {
      if (runtime.deferUI) runtime.ui.push(() => fn(...args));
      else fn(...args);
    },
    withTiming: (value: number, config: { duration: number }, done?: (finished: boolean) => void) => {
      runtime.durations.push(config.duration);
      if (!runtime.deferAnimations) done?.(true);
      return runtime.animationHeight ?? value;
    },
    cancelAnimation: vi.fn(),
    Easing: { bezier: vi.fn() },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const flushJS = () => act(() => { for (const job of runtime.js.splice(0)) job(); });
const gestureOf = (value: unknown) => value as TestGesture;
const styleOf = (value: unknown) => (value as { current: { height: number; maxHeight?: number } }).current;

beforeEach(() => {
  runtime.js = [];
  runtime.ui = [];
  runtime.deferUI = false;
  runtime.durations = [];
  runtime.reduceMotion = false;
  runtime.deferAnimations = false;
  runtime.animationHeight = undefined;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

const composerInput = (): UseComposerResizeInput => ({
  contentHeight: 60, autoMaxContentHeight: 120, windowHeight: 900,
  keyboardHeight: 250, singleLineContentHeight: 20, composerChromeHeight: 80,
  onSnapToAuto: vi.fn(), onGrabberTouchActiveChange: vi.fn(),
});
function mountComposer(input: UseComposerResizeInput) {
  let result: ReturnType<typeof useComposerResize>;
  let renders = 0;
  function Harness() { renders++; result = useComposerResize(input); return null; }
  const rerender = () => act(() => root.render(createElement(Harness)));
  rerender();
  return { get result() { return result!; }, get renders() { return renders; }, rerender };
}

describe('composer resize interaction boundary', () => {
  it('tracks 100 pointer moves with no JS deliveries or React renders, then commits once', () => {
    const input = composerInput();
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    const innerLimit = harness.result.inputMaxHeight;
    expect(innerLimit).toBeGreaterThan(input.autoMaxContentHeight);
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(input.autoMaxContentHeight);
    gesture.begin({ translationY: 0 });
    // Even touch-down can wait for JS while the native frame follows the finger.
    const before = harness.renders;
    for (let index = 1; index <= 100; index++) gesture.update({ translationY: -index });
    expect(harness.result.contentHeight.value).toBe(160);
    expect(styleOf(harness.result.frameStyle).height).toBeGreaterThan(160);
    expect(styleOf(harness.result.frameStyle).maxHeight).toBeUndefined();
    expect(innerLimit).toBeGreaterThanOrEqual(styleOf(harness.result.frameStyle).height);
    expect(harness.result.inputMaxHeight).toBe(innerLimit);
    expect(harness.renders).toBe(before);
    expect(runtime.js).toHaveLength(1); // only begin, never pointer moves
    gesture.finalize({ translationY: -100 }, true);
    flushJS();
    expect(harness.result.visibleContentHeight).toBe(160);
    expect(harness.result.mode).toBe('manual');
    expect(harness.result.active.value).toBe(false);
    expect(input.onGrabberTouchActiveChange).toHaveBeenNthCalledWith(1, true);
    expect(input.onGrabberTouchActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('cancellation restores the settled height without dismissing the keyboard', () => {
    const input = composerInput();
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 100 });
    gesture.finalize({ translationY: 100 }, false);
    expect(harness.result.active.value).toBe(false);
    expect(harness.result.contentHeight.value).toBe(60);
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(input.autoMaxContentHeight);
    flushJS();
    expect(harness.result.contentHeight.value).toBe(60);
    expect(harness.result.mode).toBe('auto');
    expect(input.onSnapToAuto).not.toHaveBeenCalled();
  });

  it('keeps long drafts at the auto cap and restores that cap after cancel and reset', () => {
    const input = { ...composerInput(), contentHeight: 500 };
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    expect(harness.result.visibleContentHeight).toBe(120);
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(120);
    expect(harness.result.scrollEnabled).toBe(true);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -100 });
    expect(harness.result.contentHeight.value).toBe(220);
    expect(harness.result.inputMaxHeight).toBeGreaterThanOrEqual(220);
    gesture.finalize({ translationY: -100 }, false);
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(120);
    expect(harness.result.contentHeight.value).toBe(120);
    flushJS();
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -100 });
    gesture.finalize({ translationY: -100 }, true);
    flushJS();
    expect(styleOf(harness.result.frameStyle).maxHeight).toBeUndefined();
    act(() => harness.result.reset());
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(120);
    expect(harness.result.visibleContentHeight).toBe(120);
    input.autoMaxContentHeight = 100;
    harness.rerender();
    expect(styleOf(harness.result.frameStyle).maxHeight).toBe(100);
    expect(harness.result.visibleContentHeight).toBe(100);
  });

  it('starts a new drag from the settled manual height before canceled JS callbacks arrive', () => {
    const input = composerInput();
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -100 });
    gesture.finalize({ translationY: -100 }, true);
    flushJS();
    expect(harness.result.visibleContentHeight).toBe(160);

    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 100 });
    gesture.finalize({ translationY: 100 }, false);
    expect(harness.result.active.value).toBe(false);
    expect(harness.result.contentHeight.value).toBe(160);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -20 });
    expect(harness.result.contentHeight.value).toBe(180);
    flushJS();
    expect(harness.result.active.value).toBe(true);
    expect(harness.result.contentHeight.value).toBe(180);
    gesture.finalize({ translationY: -20 }, true);
    flushJS();
    expect(harness.result.visibleContentHeight).toBe(180);
    expect(input.onSnapToAuto).not.toHaveBeenCalled();
  });

  it('ignores an old release while a second drag is active and clamps to new keyboard bounds', () => {
    const input = composerInput();
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 100 });
    gesture.finalize({ translationY: 100 }, true); // would dismiss if delivered
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -300 });
    flushJS();
    expect(input.onSnapToAuto).not.toHaveBeenCalled();
    expect(harness.result.active.value).toBe(true);
    input.keyboardHeight = 450;
    harness.rerender();
    expect(harness.result.contentHeight.value).toBe(150);
    gesture.finalize({ translationY: -300 }, true);
    flushJS();
    expect(harness.result.visibleContentHeight).toBe(150);
    expect(harness.result.contentHeight.value).toBe(150);
  });

  it('delayed release after unmount cannot dismiss a different task', () => {
    const input = composerInput();
    const harness = mountComposer(input);
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 100 });
    gesture.finalize({ translationY: 100 }, true);
    act(() => root.render(null));
    flushJS();
    expect(input.onSnapToAuto).not.toHaveBeenCalled();
  });

  it('a React height commit delivered after the next gesture cannot drop its UI override', () => {
    const harness = mountComposer(composerInput());
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -100 });
    gesture.finalize({ translationY: -100 }, true);
    runtime.deferUI = true;
    flushJS();
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -50 });
    for (const job of runtime.ui.splice(0)) job();
    expect(harness.result.active.value).toBe(true);
    expect(harness.result.contentHeight.value).toBe(210);
  });
});

function mountSheet() {
  const input: UseContextSheetDragInput = {
    heights: { half: 400, full: 700 }, snap: 'half',
    onSnapChange: vi.fn(), onDismiss: vi.fn(),
  };
  let result: ReturnType<typeof useContextSheetDrag>;
  let renders = 0;
  function Harness() { renders++; result = useContextSheetDrag(input); return null; }
  const rerender = () => act(() => root.render(createElement(Harness)));
  rerender();
  return { input, get result() { return result!; }, get renders() { return renders; }, rerender };
}

describe('sheet UI gesture lifecycle', () => {
  it.each([0, 2])('retains the external snap when a drag returns to %ipx displacement', (distance) => {
    const harness = mountSheet();
    runtime.animationHeight = 450;
    harness.input.snap = 'full';
    harness.rerender();
    runtime.animationHeight = undefined;
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -20 });
    gesture.update({ translationY: distance });
    gesture.finalize({ translationY: distance }, true);
    flushJS();
    expect(styleOf(harness.result.animatedStyle).height).toBe(700);
    expect(harness.input.onSnapChange).toHaveBeenCalledExactlyOnceWith('full');
    expect(harness.input.onDismiss).not.toHaveBeenCalled();
  });

  it('moves without JS/React work and reports the full snap after release', () => {
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    for (let index = 1; index <= 250; index++) gesture.update({ translationY: -index });
    expect(styleOf(harness.result.animatedStyle).height).toBe(650);
    expect(harness.renders).toBe(1);
    expect(runtime.js).toHaveLength(0);
    gesture.finalize({ translationY: -250 }, true);
    flushJS();
    expect(harness.input.onSnapChange).toHaveBeenCalledExactlyOnceWith('full');
  });

  it('cancellation returns to the current snap, including reduced motion', () => {
    runtime.reduceMotion = true;
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 350 });
    gesture.finalize({ translationY: 350 }, false);
    flushJS();
    expect(styleOf(harness.result.animatedStyle).height).toBe(400);
    expect(harness.input.onDismiss).not.toHaveBeenCalled();
    expect(runtime.durations.every((duration) => duration === 0)).toBe(true);
  });

  it('rejects late dismissal from an earlier gesture or an unmounted sheet', () => {
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 350 });
    gesture.finalize({ translationY: 350 }, true);
    gesture.begin({ translationY: 0 });
    flushJS();
    expect(harness.input.onDismiss).not.toHaveBeenCalled();
    gesture.finalize({ translationY: 0 }, true);
    act(() => root.render(null));
    flushJS();
    expect(harness.input.onDismiss).not.toHaveBeenCalled();
  });

  it('a header tap during snap animation preserves the last release destination', () => {
    runtime.deferAnimations = true;
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -250 });
    gesture.finalize({ translationY: -250 }, true);
    expect(harness.input.onSnapChange).not.toHaveBeenCalled();
    gesture.begin({ translationY: 0 });
    gesture.finalize({ translationY: 0 }, false);
    expect(styleOf(harness.result.animatedStyle).height).toBe(700);
    expect(harness.input.onDismiss).not.toHaveBeenCalled();
  });

  it.each(['rotation', 'reduced motion'])('preserves and reports a release interrupted by %s', (change) => {
    runtime.deferAnimations = true;
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -250 });
    gesture.finalize({ translationY: -250 }, true);
    if (change === 'rotation') harness.input.heights = { half: 300, full: 500 };
    else runtime.reduceMotion = true;
    harness.rerender();
    expect(styleOf(harness.result.animatedStyle).height).toBe(harness.input.heights.full);
    flushJS();
    expect(harness.input.onSnapChange).toHaveBeenCalledExactlyOnceWith('full');
  });

  it('geometry queued on JS does not overwrite a newly started UI drag', () => {
    const harness = mountSheet();
    runtime.deferUI = true;
    harness.input.heights = { half: 300, full: 500 };
    harness.rerender();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -50 });
    for (const job of runtime.ui.splice(0)) job();
    expect(styleOf(harness.result.animatedStyle).height).toBe(450);
  });

  it.each(['UI delivery', 'React commit'])('ignores an old snap acknowledgement delayed until %s', (delay) => {
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -250 });
    gesture.finalize({ translationY: -250 }, true);
    flushJS();
    runtime.deferUI = true;
    if (delay === 'UI delivery') {
      harness.input.snap = 'full';
      harness.rerender();
    }
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 300 });
    gesture.finalize({ translationY: 300 }, true);
    if (delay === 'React commit') {
      harness.input.snap = 'full';
      harness.rerender();
    }
    for (const job of runtime.ui.splice(0)) job();
    expect(styleOf(harness.result.animatedStyle).height).toBe(400);
    flushJS();
    expect(harness.input.onSnapChange).toHaveBeenLastCalledWith('half');
  });

  it('reports a return to half even while the earlier full notification has not committed', () => {
    const harness = mountSheet();
    const gesture = gestureOf(harness.result.gesture);
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: -250 });
    gesture.finalize({ translationY: -250 }, true);
    flushJS();
    gesture.begin({ translationY: 0 });
    gesture.update({ translationY: 300 });
    gesture.finalize({ translationY: 300 }, true);
    flushJS();
    expect(harness.input.onSnapChange).toHaveBeenNthCalledWith(1, 'full');
    expect(harness.input.onSnapChange).toHaveBeenNthCalledWith(2, 'half');
  });
});
