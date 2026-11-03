// @vitest-environment jsdom
import { act, createElement as el, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dark: false, frameWidth: 390, naturalWidth: null as number | null, mirroredBars: [] as number[] }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  Pressable: ({ children }: any) => el('div', null, typeof children === 'function' ? children({ pressed: false }) : children),
  View: ({ children, onLayout, style }: any) => {
    // The hidden measuring row reports the title's natural width, as on device.
    useEffect(() => { if (onLayout && h.naturalWidth != null) onLayout({ nativeEvent: { layout: { width: h.naturalWidth } } }); }, [onLayout]);
    const width = [style].flat(Infinity).reduce((found: unknown, s: any) => s?.width ?? found, undefined);
    return el('div', { 'data-width': typeof width === 'number' ? width : undefined }, children);
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaFrame: () => ({ width: h.frameWidth, height: 844, x: 0, y: 0 }),
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
  centeredHomeTitleWidth: (barWidth: number) => { h.mirroredBars.push(barWidth); return 200; },
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
  h.frameWidth = 390;
  h.naturalWidth = null;
  h.mirroredBars = [];
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

async function renderTitleWidth(props: { statusRowReserve?: number; remoteDesktop: boolean }) {
  await act(async () => root.render(el(HomeNativeStackHeader, {
    displayA11y: 'Display settings', displayActions: [], displayBadge: false, menuA11y: 'Open menu',
    onDisplayAction: vi.fn(), onOpenDeviceMenu: vi.fn(), onOpenMenu: vi.fn(), remoteDesktopA11y: 'Remote desktop',
    onOpenRemoteDesktop: props.remoteDesktop ? vi.fn() : undefined, statusRowReserve: props.statusRowReserve,
    onSelectScope: vi.fn(), scopeActions: [], showRemoteGuide: false, title: 'Dash MacBook Pro', titleA11y: 'Select scope',
  })));
  // The outermost sized view is the title frame handed to the native bar.
  return Number(node.querySelector('[data-width]')!.getAttribute('data-width'));
}

// Regression: Duo portrait home (2026-11-03). The bar shares the status row there, so UIKit puts
// the trailing items left of the status area; a title sized for the full 662pt bar ran under them.
it.each([
  // [reserve, remote desktop, natural title width, expected title view width]
  [238, true, 150, 200], // short name: centered between margins mirrored past the status area
  [238, true, 300, 224], // long name: the gap up to the shifted trailing pill, not 360
  [238, false, 300, 268], // one trailing item is still asymmetric beside the status area
  [0, false, 300, 360], // ordinary wide bar keeps its centered cap
] as const)('Duo reserve=%s remote=%s natural=%s sizes the title view to %s', async (reserve, remoteDesktop, natural, width) => {
  h.frameWidth = 662;
  h.naturalWidth = natural;
  expect(await renderTitleWidth({ statusRowReserve: reserve, remoteDesktop })).toBe(width);
  expect(h.mirroredBars.at(-1)).toBe(662 - reserve * 2);
});
