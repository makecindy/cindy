// @vitest-environment jsdom
// Regression #7086: a changed route must own its scroll window. Existing tail
// controller tests never mount this harness or cancel its delayed/rAF sweep.
// Real ListPerfHarness + runScrollSweep; only native/router ports are replaced.
// Minimal failures: leave during the 400ms settle delay or during an active sweep.
// Tier: unit, virtual timers; native scrolling remains simulator acceptance.
import { act, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ListPerfHarness from '../../app/listperf';

const state = vi.hoisted(() => ({
  params: { turns: '40', media: '0', auto: '1', run: 'one' } as Record<string, string>,
  lists: [] as { offsets: number[]; recycle: boolean; focus?: string }[],
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => state.params }));
vi.mock('react-native', () => ({ View: 'div', Text: 'span', StyleSheet: { create: (v: unknown) => v } }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'section' }));
vi.mock('@/debug/listPerfFixture', () => ({ buildListPerfRenderItems: () => [{ key: 'first' }] }));
vi.mock('@/session/mobileMarkdownRenderMetrics', () => ({ resetMobileMarkdownRenderMetrics: vi.fn() }));
vi.mock('@/session/MessageRenderer', () => ({
  MessageRenderer: ({ devExposeList, devRecycleItems, focusedItemKey }: {
    devExposeList: (api: unknown) => void; devRecycleItems: boolean; focusedItemKey?: string;
  }) => {
    const list = useMemo(() => {
      const next = { offsets: [] as number[], recycle: devRecycleItems, focus: focusedItemKey };
      state.lists.push(next);
      return next;
    }, []);
    useEffect(() => {
      devExposeList({
        scrollTo: (y: number) => list.offsets.push(y),
        getMetrics: () => ({ contentHeight: 20000, viewportHeight: 800, offsetY: list.offsets.at(-1) ?? 0 }),
        getWebViewMetrics: () => null,
        getMarkdownMetrics: () => null,
      });
    }, [devExposeList, list]);
    return <div>native list</div>;
  },
}));
let root: Root;
let container: HTMLDivElement;
const render = () => act(() => root.render(<ListPerfHarness />));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  state.params = { turns: '40', media: '0', auto: '1', run: 'one' };
  state.lists = [];
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([100, 600])('cancels the old run when switching to manual after %ims', elapsed => {
  render();
  advance(elapsed);
  const old = state.lists[0];
  const count = old.offsets.length;
  state.params = { ...state.params, run: 'manual', auto: '0', turns: '41' };
  render();
  const next = state.lists.at(-1)!;
  advance(4000);
  expect(old.offsets).toHaveLength(count);
  expect(next.offsets).toEqual([]);
  expect(container.textContent).toContain('manual');
  expect(vi.getTimerCount()).toBe(0);
});

it('releases a pending sweep on unmount', () => {
  render();
  advance(100);
  act(() => root.render(null));
  const count = state.lists[0].offsets.length;
  advance(4000);
  expect(state.lists[0].offsets).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('finishes each keyed run separately and keeps recycling opt-in', () => {
  render();
  advance(4000);
  const first = state.lists[0];
  expect(first.recycle).toBe(false);
  expect(first.focus).toBe('first');
  expect(first.offsets.slice(0, 4)).toEqual([0, 0, 45, 90]);
  expect(container.textContent).toContain('done');
  const count = first.offsets.length;
  state.params = { ...state.params, run: 'two', recycle: '1' };
  render();
  advance(4000);
  const second = state.lists.at(-1)!;
  expect(second).not.toBe(first);
  expect(second.recycle).toBe(true);
  expect(second.offsets).toEqual(first.offsets);
  expect(first.offsets).toHaveLength(count);
  expect(container.textContent).toContain('done');
  expect(vi.getTimerCount()).toBe(0);
});
