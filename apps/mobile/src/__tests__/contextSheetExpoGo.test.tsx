// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextSheetDrag, type UseContextSheetDragInput } from '@/session/useContextSheetDrag';

const runtime = vi.hoisted(() => ({ animationHeight: undefined as number | undefined, reduceMotion: false, durations: [] as number[] }));
vi.mock('expo-constants', () => ({
  default: { executionEnvironment: 'storeClient' }, ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
vi.mock('react-native', () => ({ PanResponder: { create: (handlers: unknown) => ({ panHandlers: handlers }) } }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => runtime.reduceMotion }));
vi.mock('@/theme', () => ({ motionDuration: { fast: 180 }, motionEasing: { move: [0, 0, 1, 1] } }));
vi.mock('@/platform/gestureHandler', () => ({ Gesture: { Pan: () => {
  const gesture = { activeOffsetY: () => gesture, failOffsetX: () => gesture, onBegin: () => gesture, onUpdate: () => gesture, onFinalize: () => gesture };
  return gesture;
} } }));
vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: unknown) => useRef({ value }).current,
  useAnimatedStyle: (calculate: () => unknown) => ({ get current() { return calculate(); } }),
  runOnJS: (fn: unknown) => fn,
  runOnUI: (fn: unknown) => fn,
  cancelAnimation: vi.fn(),
  withTiming: (value: number, config: { duration: number }) => {
    runtime.durations.push(config.duration);
    return runtime.animationHeight ?? value;
  },
  Easing: { bezier: vi.fn() },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
beforeEach(() => {
  runtime.animationHeight = undefined;
  runtime.reduceMotion = false;
  runtime.durations = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mountSheet() {
  const input: UseContextSheetDragInput = {
    heights: { half: 400, full: 700 }, snap: 'half', onSnapChange: vi.fn(), onDismiss: vi.fn(),
  };
  let result: ReturnType<typeof useContextSheetDrag>;
  function Harness() { result = useContextSheetDrag(input); return null; }
  const rerender = () => act(() => root.render(createElement(Harness)));
  rerender();
  const handlers = () => result!.panHandlers as unknown as {
    onPanResponderGrant(): void;
    onPanResponderMove(event: unknown, gesture: { dy: number }): void;
    onPanResponderRelease(): void;
    onPanResponderTerminate(): void;
  };
  return {
    input, rerender,
    get height() { return (result!.animatedStyle as unknown as { current: { height: number } }).current.height; },
    begin: () => handlers().onPanResponderGrant(),
    move: (dy: number) => handlers().onPanResponderMove({}, { dy }),
    release: () => handlers().onPanResponderRelease(),
    cancel: () => handlers().onPanResponderTerminate(),
  };
}

describe('Expo Go sheet release boundary', () => {
  it.each(['tap', 'micro move', 'return to start', 'cancel'])('preserves an external expansion during %s', (event) => {
    const sheet = mountSheet();
    runtime.animationHeight = 450; // External half -> full animation has not reached its destination.
    sheet.input.snap = 'full';
    sheet.rerender();
    runtime.animationHeight = undefined;
    expect(sheet.height).toBe(450);
    sheet.begin();
    if (event === 'micro move') sheet.move(2);
    if (event === 'return to start') { sheet.move(-20); sheet.move(0); }
    if (event === 'cancel') { sheet.move(300); sheet.cancel(); }
    else sheet.release();
    expect(sheet.height).toBe(700);
    expect(sheet.input.onSnapChange).not.toHaveBeenCalled();
    expect(sheet.input.onDismiss).not.toHaveBeenCalled();
  });

  it('retains a release before React commits it, then still supports half and dismiss', () => {
    const sheet = mountSheet();
    sheet.begin(); sheet.move(-250); sheet.release();
    expect(sheet.input.onSnapChange).toHaveBeenCalledExactlyOnceWith('full');
    expect(sheet.input.snap).toBe('half'); // Parent acknowledgement is pending.
    sheet.begin(); sheet.move(300); sheet.cancel();
    expect(sheet.height).toBe(700);
    expect(sheet.input.onSnapChange).toHaveBeenCalledTimes(1);
    sheet.begin(); sheet.move(300); sheet.release();
    expect(sheet.input.onSnapChange).toHaveBeenLastCalledWith('half');
    sheet.begin(); sheet.move(350); sheet.release();
    expect(sheet.input.onDismiss).toHaveBeenCalledOnce();
  });

  it('restores the release target with new geometry and reduced motion', () => {
    runtime.reduceMotion = true;
    const sheet = mountSheet();
    sheet.begin(); sheet.move(-250); sheet.release();
    sheet.begin(); sheet.move(100);
    sheet.input.heights = { half: 300, full: 500 };
    sheet.rerender();
    sheet.cancel();
    expect(sheet.height).toBe(500);
    expect(runtime.durations.every(duration => duration === 0)).toBe(true);
  });
});
