// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnimatedContentHeight } from '@/session/AnimatedContentHeight';

const runtime = vi.hoisted(() => ({
  outerStyle: [] as Array<{ height?: number; overflow?: string }>,
  measure: null as ((event: { nativeEvent: { layout: { height: number } } }) => void) | null,
  timing: vi.fn((height: number, _options: object, _complete?: unknown) => height),
  cancel: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    StyleSheet: { create: (styles: object) => styles },
    View: ({ onLayout, children }: { onLayout?: typeof runtime.measure; children?: ReactNode }) => {
      if (onLayout) runtime.measure = onLayout;
      return createElement('div', null, children);
    },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { createElement, useRef } = await import('react');
  return {
    default: { View: ({ children, style }: { children?: ReactNode; style: typeof runtime.outerStyle }) => {
      runtime.outerStyle = style;
      return createElement('div', null, children);
    } },
    useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    Easing: { bezier: () => 'move' },
    withSpring: runtime.timing,
    cancelAnimation: runtime.cancel,
  };
});
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: () => void) => fn() }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => false }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
const root = createRoot(container);
afterEach(() => { act(() => root.unmount()); container.remove(); });

// Unit regression: a second identical native layout sample used to cancel and
// restart an in-flight height animation. Existing collapse tests do not exercise
// the production measurement component's repeated native samples.
it('keeps the current height trajectory for repeated measurements, but retargets changed content', () => {
  act(() => root.render(<AnimatedContentHeight>Streaming reply</AnimatedContentHeight>));
  const measure = (height: number) => act(() => runtime.measure!({ nativeEvent: { layout: { height } } }));
  measure(100);
  // Before the next native onLayout arrives, changing the child must not expose
  // its final height and then jump back to the previous animation position.
  act(() => root.render(<AnimatedContentHeight>Streaming reply with another line</AnimatedContentHeight>));
  expect(Object.assign({}, ...runtime.outerStyle).height).toBe(100);
  expect(Object.assign({}, ...runtime.outerStyle).overflow).toBe('hidden');
  measure(160);
  const timings = runtime.timing.mock.calls.length;
  const cancellations = runtime.cancel.mock.calls.length;
  measure(160);
  expect(runtime.timing).toHaveBeenCalledTimes(timings);
  expect(runtime.cancel).toHaveBeenCalledTimes(cancellations);
  measure(180);
  expect(runtime.timing).toHaveBeenCalledTimes(timings + 1);
  expect(runtime.timing.mock.calls.at(-1)?.[0]).toBe(180);

  // Android reconnect reproduced a 22pt first-frame jump when a previously
  // collapsed note reopened: its spring ran before the remounted content was
  // measured. Keep the shell closed until that native measurement arrives.
  act(() => root.render(<AnimatedContentHeight open={false}>Streaming reply</AnimatedContentHeight>));
  const complete = runtime.timing.mock.calls.at(-1)?.[2] as (finished: boolean) => void;
  act(() => complete(true));
  const beforeReopen = runtime.timing.mock.calls.length;
  act(() => root.render(<AnimatedContentHeight>Reconnected</AnimatedContentHeight>));
  expect(runtime.timing).toHaveBeenCalledTimes(beforeReopen);
  measure(180);
  expect(runtime.timing).toHaveBeenCalledTimes(beforeReopen + 1);

  // A live cell begins with zero occupied height. Its absolute child must stay
  // clipped before the first measurement; otherwise several new rows flash
  // on top of one another despite their zero-height animation shells.
  act(() => root.render(<AnimatedContentHeight key="new-live-cell" animateInitial>New live reply</AnimatedContentHeight>));
  const firstFrame = Object.assign({}, ...runtime.outerStyle);
  expect(firstFrame.height).toBe(0);
  expect(firstFrame.overflow).toBe('hidden');
});
