// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useModalFadeLifecycle } from '@/session/useModalFadeLifecycle';

const runtime = vi.hoisted(() => ({ reduce: null as boolean | null, animations: [] as Array<{ toValue: number; callback?: (r: { finished: boolean }) => void }> }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => runtime.reduce }));
vi.mock('react-native', () => ({
  Animated: {
    Value: class {
      constructor(public value: number) {}
      setValue(value: number) { this.value = value; }
      stopAnimation() {}
    },
    timing: (_value: unknown, options: { toValue: number }) => ({
      start: (callback?: (r: { finished: boolean }) => void) => runtime.animations.push({ toValue: options.toValue, callback }),
    }),
  },
  Easing: { in: (v: unknown) => v, out: (v: unknown) => v, quad: {} },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
beforeEach(() => { runtime.reduce = null; runtime.animations = []; root = createRoot(document.createElement('div')); });
afterEach(() => act(() => root.unmount()));

function harness() {
  let visible = false;
  let result: ReturnType<typeof useModalFadeLifecycle>;
  const closed = vi.fn();
  function Harness() { result = useModalFadeLifecycle(visible, { inMs: 150, outMs: 120, onClosed: closed }); return null; }
  const render = (next: boolean) => { visible = next; act(() => root.render(createElement(Harness))); };
  render(false);
  return { render, closed, show: () => act(() => result.onShowStartIn()), get mounted() { return result.mounted; }, get progress() { return (result.progress as unknown as { value: number }).value; } };
}

it.each([true, null])('settles without animation when system preference is %s', (reduce) => {
  runtime.reduce = reduce;
  const h = harness();h.render(true);h.show();
  expect(h.mounted).toBe(true);expect(h.progress).toBe(1);
  h.render(false);
  expect(h.mounted).toBe(false);expect(h.progress).toBe(0);
  expect(h.closed).toHaveBeenCalledOnce();expect(runtime.animations).toHaveLength(0);
});

it('retains onShow timing, ignores stale exit completion on reopen, and settles when motion is reduced', () => {
  runtime.reduce = false;
  const h = harness();h.render(true);
  expect(runtime.animations).toHaveLength(0);
  h.show();expect(runtime.animations.at(-1)?.toValue).toBe(1);
  h.render(false);const exit = runtime.animations.at(-1)!;
  expect(exit.toValue).toBe(0);expect(h.mounted).toBe(true);
  h.render(true);act(() => exit.callback?.({ finished: true }));
  expect(h.mounted).toBe(true);expect(h.closed).not.toHaveBeenCalled();
  runtime.reduce = true;h.render(true);expect(h.progress).toBe(1);
  h.render(false);expect(h.mounted).toBe(false);expect(h.closed).toHaveBeenCalledOnce();
});
