// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ options: {} as any, dark: false }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value }, Image: ({ source, style }: any) => el('i', { 'data-artwork': source, style }),
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
}));
vi.mock('expo-router', () => ({ Stack: {
  Screen: ({ options }: any) => { h.options = options; return options.headerTitle(); },
  Header: () => null,
  Toolbar: Object.assign(({ children }: any) => children, {
    View: ({ children }: any) => el('div', { 'data-testid': 'custom-toolbar-item' }, children),
    Button: ({ children, icon, onPress, accessibilityLabel }: any) => el('button', {
      'data-icon': icon, 'aria-label': accessibilityLabel, onClick: onPress,
    }, children),
  }),
} }));
vi.mock('@/platform/chrome/homeMenuIcon', () => ({ homeMenuIcon: 'narrow-home-menu', homeMenuArtworkSize: 26 }));
vi.mock('@/theme', async () => {
  const { lightColors, darkColors } = await import('@/theme/tokens');
  return { useTheme: () => ({ colors: h.dark ? darkColors : lightColors }) };
});
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: ({ onPress, testID, accessibilityLabel, children }: any) =>
  el('button', { onClick: onPress, 'data-testid': testID, 'aria-label': accessibilityLabel }, children) }));
import { HomeStackHeader } from '@/platform/chrome/HomeStackHeader';
import { lightColors, darkColors } from '@/theme/tokens';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.dark = false;
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

it.each([false, true])('keeps the native menu and title content across themes (dark=%s)', async dark => {
  h.dark = dark;
  const open = vi.fn();
  await act(async () => root.render(el(HomeStackHeader, {
    title: el('span', null, 'All tasks'), menuA11y: 'Open menu', menuTestID: 'home.chromeMenu', onOpenMenu: open,
  })));
  expect(node.textContent).toContain('All tasks');
  expect(h.options.headerTransparent).toBe(true);
  expect(h.options.headerTintColor).toBe((dark ? darkColors : lightColors).textPrimary);
  expect(node.querySelector('button')?.getAttribute('data-icon')).toBe('narrow-home-menu');
  expect(node.querySelector('[data-testid="custom-toolbar-item"]')).toBeNull();
  expect(node.querySelector('button')?.getAttribute('aria-label')).toBe('Open menu');
  await act(async () => node.querySelector('button')!.click());
  expect(open).toHaveBeenCalledOnce();
});

it('keeps the Duo custom menu within the native toolbar and preserves its action', async () => {
  const open = vi.fn();
  await act(async () => root.render(el(HomeStackHeader, {
    title: el('span', null, 'All tasks'), menuA11y: 'Open menu', menuTestID: 'home.chromeMenu', onOpenMenu: open,
    keepMenuTopLeft: true,
  })));
  const toolbar = node.querySelector('[data-testid="custom-toolbar-item"]')!;
  expect(toolbar.querySelector('[data-artwork]')?.getAttribute('data-artwork')).toBe('narrow-home-menu');
  await act(async () => toolbar.querySelector('button')!.click());
  expect(open).toHaveBeenCalledOnce();
});
