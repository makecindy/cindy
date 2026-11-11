// @vitest-environment jsdom
import { act, createElement as el, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// Unit: a completed turn must not hide records the reader opened, including after
// virtualized remount. Exercise the production shell and its shared disclosure memory.
const h = vi.hoisted(() => ({ reduceMotion: true, heightMotions: [] as number[] }));
vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children: ReactNode; onLayout?: (event: any) => void }) => {
    useLayoutEffect(() => { onLayout?.({ nativeEvent: { layout: { height: 300 } } }); }, []);
    return el('div', null, children);
  },
  Pressable: ({ children, onPress, accessibilityState, accessibilityLabel }: any) => el('button', {
    onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState.expanded,
  }, children),
  ActivityIndicator: () => null,
  StyleSheet: { create: (v: unknown) => v },
  Animated: { View: ({ children, onLayout, style }: any) => {
    useLayoutEffect(() => { onLayout?.({ nativeEvent: { layout: { height: 300 } } }); }, []);
    return el('span', { 'data-body-height': onLayout ? style.height?.current ?? 'auto' : undefined }, children);
  },
    Value: class { constructor(public current: number) {} setValue(value: number) { this.current = value; } interpolate() { return '0deg'; } },
    timing: (value: any, options: any) => ({ start(done?: (result: { finished: boolean }) => void) {
      if (!options.useNativeDriver && options.duration > 0) h.heightMotions.push(options.toValue);
      value.setValue(options.toValue); done?.({ finished: true });
    }, stop() {} }) },
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Layers: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduceMotion }));
import { TeammateProcess } from '@/session/TeammateProcess';
import { ProcessDisclosureViewport, useProcessDisclosureViewport } from '@/session/useProcessDisclosureViewport';
import { __test_internals as memory } from '@/session/expandedBlockMemory';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, node: HTMLDivElement;
beforeEach(() => { memory.reset(); h.reduceMotion = true; h.heightMotions = []; node = document.createElement('div'); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); });
const header = () => node.querySelector('button')!;
async function show(running: boolean) {
  await act(async () => root.render(el(TeammateProcess, { id: 'turn', title: running ? 'Reading feedback' : 'Progress', running,
    children: [el('p', { key: 'note' }, 'Found the cause'), el(TeammateProcess, { key: 'records', id: 'records', secondary: true, title: 'Activity log', children: 'First tool details' })],
  })));
}
it('shows live notes, collapses uninspected work on completion, and can restore every note', async () => {
  await show(true); expect(node.textContent).toContain('Found the cause');
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(node.textContent).not.toContain('Found the cause');
  await act(async () => header().click()); expect(node.textContent).toContain('Found the cause');
});
it('keeps a turn open when its inner activity log was inspected, including remount', async () => {
  await show(true);
  await act(async () => node.querySelectorAll('button')[1]!.click());
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('First tool details');
  await act(async () => root.render(null)); await show(false);
  expect(header().getAttribute('aria-expanded')).toBe('true'); expect(node.textContent).toContain('First tool details');
});
it('respects a manual collapse while live status and completion change', async () => {
  await show(true); await act(async () => header().click());
  await show(false); expect(header().getAttribute('aria-expanded')).toBe('false');
  await show(true); expect(header().getAttribute('aria-expanded')).toBe('false');
});

// Unit regression: switching tasks replayed a 0→30pt disclosure, moving all earlier
// messages. Existing cases only checked which text survived, with motion disabled.
// Mount a live turn, then remount remembered expansion through the production shell.
it('lays out initially and remembered expanded work immediately while preserving disclosure motion', async () => {
  h.reduceMotion = false;
  await show(true);
  expect(node.querySelector('[data-body-height]')?.getAttribute('data-body-height')).toBe('auto');
  expect(h.heightMotions).toEqual([]);
  await act(async () => header().click());
  expect(h.heightMotions).toContain(0);
  await act(async () => header().click());
  expect(h.heightMotions).toContain(300);
  await act(async () => root.render(null));
  h.heightMotions = [];
  await show(false);
  expect(node.textContent).toContain('Found the cause');
  expect(node.querySelector('[data-body-height]')?.getAttribute('data-body-height')).toBe('auto');
  expect(h.heightMotions).toEqual([]);
});

// Unit regression: the native iOS group header moved 336pt on manual disclosure (2026-11-07).
// Existing tests only cover remembered expansion, not viewport ownership. Minimal input: a
// 300pt body at the end of a 1400pt list in a 600pt viewport. Exercise the real shell/provider;
// the reserved footer must exist before shrinking, and layout scrolls cannot resume following.
it('reserves the shrinking scroll range before collapse and releases it only on user navigation', async () => {
  const metrics = { offsetY: 800, contentHeight: 1400, viewportHeight: 600 };
  let following = true;
  let viewport!: ReturnType<typeof useProcessDisclosureViewport>;
  function Screen() {
    viewport = useProcessDisclosureViewport(() => metrics, () => { following = false; });
    return el(ProcessDisclosureViewport.Provider, { value: viewport.inspect },
      el(TeammateProcess, { id: 'scroll-turn', title: 'Working', running: true, children: 'Notes' }),
      el('footer', { style: { height: viewport.footerHeight } }));
  }
  await act(async () => root.render(el(Screen)));
  await act(async () => header().click());
  expect(following).toBe(false);
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(node.querySelector('footer')!.style.height).toBe('300px');
  await act(async () => viewport.scroll(800, 799, false, true));
  expect(viewport.inspecting.current).toBe(true);
  await act(async () => viewport.scroll(700, 800, true, false));
  expect(node.querySelector('footer')!.style.height).toBe('200px');
  await act(async () => viewport.scroll(800, 700, true, true));
  expect(viewport.inspecting.current).toBe(false);
  expect(node.querySelector('footer')!.style.height).toBe('0px');
  await act(async () => { viewport.inspect(300); viewport.resume(); });
  expect(viewport.inspecting.current).toBe(false);
  expect(node.querySelector('footer')!.style.height).toBe('0px');
});
