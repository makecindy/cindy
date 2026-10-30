// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  Pressable: ({ children }: any) => el('div', null, typeof children === 'function' ? children({ pressed: false }) : children),
  View: ({ children }: any) => el('div', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaFrame: () => ({ width: 390, height: 844, x: 0, y: 0 }),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ Stack: {
  Toolbar: Object.assign(({ children }: any) => children, {
    Button: () => null,
    Menu: ({ icon, iconRenderingMode, accessibilityLabel }: any) => el('div', {
      'data-testid': 'display-menu', 'data-icon': icon, 'data-rendering': iconRenderingMode, 'aria-label': accessibilityLabel,
    }),
    MenuAction: () => null,
  }),
} }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/components/QuietSyncIndicator', () => ({ QuietSyncIndicator: () => null }));
vi.mock('@/components/ConnectionNoticeOverlay', () => ({ useDelayedConnectionNotice: () => false }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  NativePullDownMenu: ({ children }: any) => children,
  usesNativePullDownMenu: () => true,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ usesNativeStackHeader: () => true }));
vi.mock('@/platform/chrome/HomeStackHeader', () => ({
  centeredHomeTitleWidth: () => 200,
  HomeStackHeader: ({ title, children }: any) => el('div', null, title, children),
}));
vi.mock('@/platform/chrome/homeDisplayIcon', () => ({
  homeDisplayIcon: 'plain-ellipsis',
  homeDisplayAttentionIcon: { light: 'ellipsis-dot-light', dark: 'ellipsis-dot-dark' },
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return {
    useTheme: () => ({ colors: h.dark ? tokens.darkColors : tokens.lightColors, mode: h.dark ? 'dark' : 'light' }),
    useThemedStyles: (make: (colors: unknown) => unknown) => make(tokens.lightColors),
    fontWeight: tokens.fontWeight,
    iconSize: tokens.iconSize,
    iconStroke: tokens.iconStroke,
    typeScale: tokens.typeScale,
  };
});
import { HomeNativeStackHeader } from '@/platform/chrome/HomeNativeStackHeader';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.dark = false;
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

async function renderMenu(displayBadge: boolean) {
  await act(async () => root.render(el(HomeNativeStackHeader, {
    displayA11y: 'Display settings', displayActions: [], displayBadge, menuA11y: 'Open menu',
    onDisplayAction: vi.fn(), onOpenDeviceMenu: vi.fn(), onOpenMenu: vi.fn(), remoteDesktopA11y: 'Remote desktop',
    onSelectScope: vi.fn(), scopeActions: [], showRemoteGuide: false, title: 'All tasks', titleA11y: 'Select scope',
  })));
  return node.querySelector('[data-testid="display-menu"]')!;
}

// 在看「已归档」任务时首页「⋯」带 6pt 提醒点。点是 statusAccent 色的原色图,不随模板着色,
// 所以按深浅色各一张;无提醒时保持模板着色的同一 glyph。空 Stack.Toolbar.Badge 会被画成大圆,不可替代。
it.each([
  [false, false, 'plain-ellipsis', 'template'],
  [true, false, 'ellipsis-dot-light', 'original'],
  [true, true, 'ellipsis-dot-dark', 'original'],
] as const)('badge=%s dark=%s gives the display menu icon %s (%s)', async (badge, dark, icon, rendering) => {
  h.dark = dark;
  const menu = await renderMenu(badge);
  expect(menu.getAttribute('data-icon')).toBe(icon);
  expect(menu.getAttribute('data-rendering')).toBe(rendering);
  expect(menu.getAttribute('aria-label')).toBe('Display settings');
});
