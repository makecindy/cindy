// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reduceMotion: false as boolean | null,
  fades: [] as Array<{ toValue: number; duration: number; finish(finished?: boolean): void }>,
  opacity: [] as number[],
}));
vi.mock('react-native', () => {
  class Value {
    value: number;
    constructor(value: number) { this.value = value; }
    setValue(value: number) { this.value = value; h.opacity.push(value); }
    stopAnimation() {
      // Native stop reports an unfinished animation to its completion callback.
      for (const fade of h.fades.splice(0)) fade.finish(false);
    }
  }
  return {
    Animated: {
      Value,
      View: ({ children }: { children: unknown }) => createElement('div', { 'data-testid': 'fade' }, children as never),
      timing: (value: Value, config: { toValue: number; duration: number }) => ({
        start(callback?: (result: { finished: boolean }) => void) {
          const fade = { toValue: config.toValue, duration: config.duration, finish(finished = true) {
            if (finished) value.setValue(config.toValue);
            callback?.({ finished });
          } };
          h.fades.push(fade);
        },
      }),
    },
    Easing: { bezier: () => (t: number) => t },
  };
});
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: unknown }) => createElement('span', null, children as never) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduceMotion }));
vi.mock('@/theme', () => ({ motionDuration: { fast: 150 }, motionEasing: { move: [0.4, 0, 0.2, 1] } }));
import { WorkingStatusText, WORKING_STATUS_MIN_INTERVAL_MS } from '../session/WorkingStatusText';

let root: Root; let node: HTMLDivElement;
const render = (text: string) => act(async () => root.render(createElement(WorkingStatusText, { text })));
const finishFade = () => act(async () => { h.fades.shift()!.finish(); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  h.reduceMotion = false; h.fades.length = 0; h.opacity.length = 0;
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

it('holds each caption for at least one second, then fades out and back in with the latest copy', async () => {
  expect(WORKING_STATUS_MIN_INTERVAL_MS).toBe(1000);
  await render('Thinking…');
  await render('Reading memory…');
  await render('Reading files…');
  await act(async () => { vi.advanceTimersByTime(999); });
  expect(node.textContent).toBe('Thinking…');
  expect(h.fades).toHaveLength(0);
  await act(async () => { vi.advanceTimersByTime(1); });
  // Fade out uses the shared fast motion token; the copy only swaps once invisible.
  expect(h.fades[0]).toMatchObject({ toValue: 0, duration: 150 });
  expect(node.textContent).toBe('Thinking…');
  await finishFade();
  expect(node.textContent).toBe('Reading files…');
  expect(h.fades[0]).toMatchObject({ toValue: 1, duration: 150 });
  await finishFade();
  expect(h.opacity).toEqual([0, 1]);
  // The next change waits a full interval from this commit.
  await render('Checking code…');
  await act(async () => { vi.advanceTimersByTime(999); });
  expect(node.textContent).toBe('Reading files…');
  await act(async () => { vi.advanceTimersByTime(1); });
  await finishFade();
  expect(node.textContent).toBe('Checking code…');
});

it('drops a pending change that returns to the shown copy', async () => {
  await render('Thinking…');
  await render('Replying…');
  await render('Thinking…');
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(h.fades).toHaveLength(0);
  expect(node.textContent).toBe('Thinking…');
});

it('commits directly without a fade when reduced motion is on or still unknown', async () => {
  for (const preference of [true, null]) {
    h.reduceMotion = preference; h.fades.length = 0;
    await render('Thinking…');
    await render('Saving memory…');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(h.fades).toHaveLength(0);
    expect(node.textContent).toBe('Saving memory…');
    await act(async () => root.unmount());
    root = createRoot(node);
  }
});

it('cancels pending copy on unmount', async () => {
  await render('Thinking…');
  await render('Reading files…');
  await act(async () => root.unmount());
  root = createRoot(node);
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(h.fades).toHaveLength(0);
});
