// @vitest-environment jsdom
import { act, createElement as el, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
// Unit: a completed turn must not hide records the reader opened, including after
// virtualized remount. Exercise the production shell and its shared disclosure memory.
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => el('div', null, children),
  Pressable: ({ children, onPress, accessibilityState, accessibilityLabel }: any) => el('button', {
    onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState.expanded,
  }, children),
  ActivityIndicator: () => null,
  StyleSheet: { create: (v: unknown) => v },
  Animated: { View: ({ children }: any) => el('span', null, children),
    Value: class { interpolate() { return '0deg'; } }, timing: () => ({ start(done?: (result: { finished: boolean }) => void) { done?.({ finished: true }); }, stop() {} }) },
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Layers: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
import { TeammateProcess } from '@/session/TeammateProcess';
import { __test_internals as memory } from '@/session/expandedBlockMemory';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, node: HTMLDivElement;
beforeEach(() => { memory.reset(); node = document.createElement('div'); root = createRoot(node); });
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
