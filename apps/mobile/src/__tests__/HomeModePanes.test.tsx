// @vitest-environment jsdom
import { act, createElement, useState, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ reduced: false as boolean | null, width: 400, header: 106, blur: [] as number[], progress: null as any,
  styles: [] as (() => any)[], spring: vi.fn((target: number, _config: unknown) => target), cancel: vi.fn() }));
vi.mock('react-native', () => ({
  View: ({ children, testID, pointerEvents, accessibilityElementsHidden }: any) =>
    createElement('div', { 'data-testid': testID, 'data-pointer': pointerEvents, 'data-hidden': accessibilityElementsHidden }, children),
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduced }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ width: h.width }) }));
vi.mock('@/session/useOptionalHeaderHeight', () => ({ useOptionalHeaderHeight: () => h.header }));
vi.mock('@/session/SessionHeaderNativeControls', () => ({ SessionHeaderNativeBlur: ({ height }: any) => {
  h.blur.push(height); return createElement('div', { 'data-testid': 'fixed-blur' });
} }));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react'); const { View } = await import('react-native');
  return { default: { View }, useSharedValue: (value: number) => { const ref = useRef({ value }); h.progress = ref.current; return ref.current; },
    useAnimatedStyle: (factory: () => any) => { h.styles.push(factory); return factory(); },
    cancelAnimation: h.cancel, withSpring: h.spring,
  };
});
import { HomeModePanes } from '@/session/HomeModePanes';
import { HOME_MODE_SLIDE_SPRING, HomeModeProgressContext, useHomeModeProgress } from '@/session/HomeModeTransition';
import type { HomeMode } from '@/session/homeViewPreferenceStore';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { h.reduced = false; h.styles = []; h.blur = []; h.spring.mockClear(); h.cancel.mockClear(); h.width = 400; });

/** Production wiring: ResidentHomeListProvider owns the clock, the panes only read it. */
function Home({ mode, animate = true, ready = true, tasks = 'tasks', teammates = 'teammates' }: {
  mode: HomeMode; animate?: boolean; ready?: boolean; tasks?: ReactNode; teammates?: ReactNode;
}) {
  const progress = useHomeModeProgress(mode, animate, ready);
  return createElement(HomeModeProgressContext.Provider, { value: progress }, createElement(HomeModePanes, { mode, tasks, teammates }));
}
describe('home mode continuity', () => {
  it('keeps task search, expansion and scroll state mounted through repeated mode switches', () => {
    const mount = vi.fn(); const unmount = vi.fn();
    function Tasks() {
      const [query, setQuery] = useState('');
      const [expanded, setExpanded] = useState(false);
      useEffect(() => { mount(); return unmount; }, []);
      return createElement('div', { 'data-tasks': true },
        createElement('button', { onClick: () => { setQuery('release'); setExpanded(true); } }, 'edit'),
        createElement('span', {}, `${query}:${expanded}`));
    }
    const container = document.createElement('div'); const root = createRoot(container);
    const render = (mode: 'tasks' | 'teammates') => act(() => root.render(createElement(Home, { mode, tasks: createElement(Tasks), teammates: createElement('span', {}, 'roster') })));
    try {
      render('tasks'); act(() => container.querySelector('button')!.click());
      const taskElement = container.querySelector('[data-tasks]')!; taskElement.scrollTop = 120;
      for (let i = 0; i < 3; i++) { render('teammates'); render('tasks'); }
      expect(container.querySelector('[data-tasks]')).toBe(taskElement);
      expect(taskElement.textContent).toContain('release:true'); expect(taskElement.scrollTop).toBe(120);
      expect(mount).toHaveBeenCalledTimes(1); expect(unmount).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });
});

it('slides toward the right-hand teammate tab and retargets a reversal without cancelling the running spring', () => {
  const node = document.createElement('div'); const root = createRoot(node);
  const render = (mode: HomeMode) => act(() => root.render(createElement(Home, { mode })));
  try {
    render('tasks'); expect(h.spring).not.toHaveBeenCalled();
    render('teammates'); expect(h.spring).toHaveBeenLastCalledWith(1, HOME_MODE_SLIDE_SPRING);
    // Sample the same shared progress partway through the UI-thread animation.
    h.progress.value = 0.4;
    const [tasks, teammates] = h.styles.slice(-2);
    expect(tasks().transform[0].translateX).toBe(-160);
    expect(teammates().transform[0].translateX).toBe(240);
    expect(node.querySelector('[data-testid="home.pane.tasks"]')?.getAttribute('data-pointer')).toBe('none');
    expect(node.querySelector('[data-testid="home.pane.tasks"]')?.getAttribute('data-hidden')).toBe('true');
    render('tasks'); expect(h.spring).toHaveBeenLastCalledWith(0, HOME_MODE_SLIDE_SPRING);
    expect(h.cancel).not.toHaveBeenCalled();
    h.width = 600; render('tasks'); h.progress.value = 0.5;
    expect(h.styles.slice(-2).map(factory => factory().transform[0].translateX)).toEqual([-300, 300]);
  } finally { act(() => root.unmount()); }
  expect(h.cancel).toHaveBeenCalledOnce();
});
it('draws one bar blur outside the sliding panes', () => {
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    act(() => root.render(createElement(Home, { mode: 'teammates' })));
    expect(node.querySelectorAll('[data-testid="fixed-blur"]')).toHaveLength(1);
    expect(node.querySelector('[data-testid^="home.pane."] [data-testid="fixed-blur"]')).toBeNull();
    expect(h.blur.at(-1)).toBe(106);
  } finally { act(() => root.unmount()); }
});
it.each([
  ['reduced motion', { reduced: true }], ['unknown motion preference', { reduced: null }],
  ['a non-home route', { animate: false }], ['preference restoration', { ready: false }],
] as const)('snaps for %s', (_name, options) => {
  h.reduced = 'reduced' in options ? options.reduced : false;
  const props = { animate: 'animate' in options ? options.animate : true, ready: 'ready' in options ? options.ready : true };
  const root = createRoot(document.createElement('div'));
  const render = (mode: HomeMode) => act(() => root.render(createElement(Home, { mode, ...props })));
  try { render('tasks'); render('teammates'); expect(h.progress.value).toBe(1); expect(h.spring).not.toHaveBeenCalled(); }
  finally { act(() => root.unmount()); }
});
it('snaps the first change after restoring the preference, then animates', () => {
  const root = createRoot(document.createElement('div'));
  const render = (mode: HomeMode, ready: boolean) => act(() => root.render(createElement(Home, { mode, ready })));
  try {
    render('tasks', false); render('teammates', true); expect(h.spring).not.toHaveBeenCalled();
    render('tasks', true); expect(h.spring).toHaveBeenLastCalledWith(0, HOME_MODE_SLIDE_SPRING);
  } finally { act(() => root.unmount()); }
});
