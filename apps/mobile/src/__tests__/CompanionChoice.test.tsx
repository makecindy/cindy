// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: true, menu: null as any }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (v: unknown) => v },
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityRole }: any) => <button aria-label={accessibilityLabel} role={accessibilityRole} disabled={disabled} onClick={onPress}>{children}</button>,
}));
vi.mock('lucide-react-native', () => ({ Check: () => <i data-check /> , ChevronDown: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  usesNativePullDownMenu: () => h.native,
  NativePullDownMenu: (props: any) => { h.menu = props; return props.children; },
}));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
import { CompanionChoice } from '@/session/CompanionChoice';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root; let container: HTMLDivElement;
const change = vi.fn();
const options = [{ value: '', label: 'None' }, { value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B', disabled: true }];
async function render(disabled = false) {
  await act(async () => root.render(createElement(CompanionChoice, { label: 'Route', value: 'a', options, onChange: change, disabled })));
}
beforeEach(() => { vi.clearAllMocks(); h.native = true; h.menu = null; container = document.createElement('div'); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); });

it('opens the system menu (Android PopupMenu / iOS UIMenu) with the checked value and disabled options', async () => {
  await render();
  expect(h.menu.actions).toEqual([
    { id: '0', title: 'None', state: 'off', disabled: false },
    { id: '1', title: 'Model A', state: 'on', disabled: false },
    { id: '2', title: 'Model B', state: 'off', disabled: true },
  ]);
  expect(container.textContent).toContain('Model A');
  // An empty value is still selectable: menu IDs are positions, not values.
  await act(async () => h.menu.onAction('0')); expect(change).toHaveBeenLastCalledWith('');
  await act(async () => h.menu.onAction('2')); expect(change).toHaveBeenCalledTimes(1);
  // No inline list or search field alongside the system menu.
  await act(async () => { container.querySelector('button')!.click(); });
  expect(container.querySelectorAll('button')).toHaveLength(1); expect(container.querySelector('input')).toBeNull();
});

it('does not attach a menu to a disabled control', async () => {
  await render(true);
  expect(h.menu).toBeNull(); expect(container.querySelector('button')!.disabled).toBe(true);
});

it('falls back to an inline option list when the build has no MenuView', async () => {
  h.native = false; await render();
  await act(async () => { container.querySelector('button')!.click(); });
  const radios = [...container.querySelectorAll('button[role="radio"]')] as HTMLButtonElement[];
  expect(radios.map(node => node.textContent)).toEqual(['None', 'Model A', 'Model B']);
  expect(radios[2]!.disabled).toBe(true); expect(radios[1]!.querySelector('[data-check]')).not.toBeNull();
  await act(async () => { radios[0]!.click(); });
  expect(change).toHaveBeenCalledWith(''); expect(container.querySelectorAll('button[role="radio"]')).toHaveLength(0);
});

it('shows the control as disabled without a menu when nothing can be chosen', async () => {
  const lists: Array<Array<{ value: string; label: string; disabled?: boolean }>> = [[], [{ value: 'b', label: 'Model B', disabled: true }]];
  for (const list of lists) {
    h.menu = null;
    await act(async () => root.render(createElement(CompanionChoice, { label: 'Route', value: 'b', options: list, onChange: change, disabled: false })));
    expect(h.menu).toBeNull(); expect(container.querySelector('button')!.disabled).toBe(true);
  }
});
