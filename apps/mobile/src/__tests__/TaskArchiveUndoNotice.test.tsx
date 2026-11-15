// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>,
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('@/theme', () => ({ useThemedStyles: (make: (colors: object) => unknown) => make({}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { title: string }) => args?.title ?? key }) }));

import { showTaskArchiveUndo, TaskArchiveUndoHost, TaskArchiveUndoSlot } from '@/session/TaskArchiveUndoNotice';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => vi.runAllTimers());
  act(() => root.unmount());
  vi.useRealTimers();
});

// Unit: real notice host/slot lifecycle. The reported bug is a global toast covering
// the next task's composer. useTaskAutoArchive mocks this module and cannot cover it.
// Minimal input: one notice, focused/unfocused slots, then route change during its timeout.
it('shows only at the focused composer, falls back without one, and preserves expiry across navigation', () => {
  vi.useFakeTimers();
  root = createRoot(container);
  const page = (active: boolean) => <><TaskArchiveUndoHost /><section data-slot><TaskArchiveUndoSlot active={active} /></section><TaskArchiveUndoSlot active={false} /></>;
  act(() => root.render(page(true)));
  act(() => showTaskArchiveUndo('Archived task', vi.fn()));
  expect(container.querySelectorAll('[data-testid="taskArchiveUndo"]')).toHaveLength(1);
  expect(container.querySelector('[data-slot]')?.textContent).toContain('Archived task');
  act(() => vi.advanceTimersByTime(4000));
  act(() => root.render(page(false)));
  expect(container.querySelector('[data-slot]')?.textContent).toBe('');
  expect(container.querySelectorAll('[data-testid="taskArchiveUndo"]')).toHaveLength(1);
  act(() => root.render(page(true)));
  act(() => vi.advanceTimersByTime(4000));
  expect(container.textContent).toBe('');
});

it('replaces an older notice and undo dismisses only the latest task', () => {
  vi.useFakeTimers();
  root = createRoot(container);
  act(() => root.render(<><TaskArchiveUndoHost /><TaskArchiveUndoSlot active /></>));
  const oldUndo = vi.fn();
  const undo = vi.fn();
  act(() => showTaskArchiveUndo('Old task', oldUndo));
  act(() => vi.advanceTimersByTime(7000));
  act(() => showTaskArchiveUndo('New task', undo));
  act(() => vi.advanceTimersByTime(1000));
  expect(container.textContent).toContain('New task');
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toBe('');
  expect(undo).toHaveBeenCalledOnce();
  expect(oldUndo).not.toHaveBeenCalled();
});
