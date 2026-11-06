// @vitest-environment jsdom
import { act, createElement as el, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dark: false, frameWidth: 390, naturalWidth: null as number | null,
  detachedHeader: false, options: {} as any, loops: new Set<object>(), appListeners: new Set<() => void>(),
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: (_event: string, listener: () => void) => {
    h.appListeners.add(listener);
    return { remove: () => h.appListeners.delete(listener) };
  } },
  Animated: {
    Value: class { setValue() {} interpolate() { return this; } },
    View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
    timing: () => ({}),
    loop: () => {
      const loop = { start: () => h.loops.add(loop), stop: () => h.loops.delete(loop) };
      return loop;
    },
  },
  Easing: { linear: (value: number) => value },
  StyleSheet: { create: (value: unknown) => value },
  Image: () => null,
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
  Screen: ({ options }: any) => { h.options = options; return h.detachedHeader ? null : options.headerTitle(); },
  Header: () => null,
  Toolbar: Object.assign(({ children }: any) => children, {
    View: ({ children }: any) => children,
    Button: () => null,
    Menu: ({ icon, iconRenderingMode, accessibilityLabel }: any) => el('div', {
      'data-testid': 'display-menu', 'data-icon': icon, 'data-rendering': iconRenderingMode, 'aria-label': accessibilityLabel,
    }),
    MenuAction: () => null,
  }),
} }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, LoaderCircle: () => el('i') }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => false }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children) }));
vi.mock('@/components/ConnectionNoticeOverlay', () => ({ useDelayedConnectionNotice: (active: boolean) => active }));
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({
  NativePullDownMenu: ({ children }: any) => children,
  usesNativePullDownMenu: () => true,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ usesNativeStackHeader: () => true }));
vi.mock('@/platform/chrome/homeMenuIcon', () => ({ homeMenuIcon: 'home-menu', homeMenuArtworkSize: 26 }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: () => null }));
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
import { AnimationVisibilityProvider } from '@/hooks/useLoopingAnimation';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.dark = false;
  h.frameWidth = 390;
  h.naturalWidth = null;
  h.detachedHeader = false;
  h.options = {};
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(h.loops.size).toBe(0);
  expect(h.appListeners.size).toBe(0);
});

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
// Widths come from the real centeredHomeTitleWidth. A 238pt reserve (status area with a Live
// Activity, as in the report) moves the trailing items left of the bar's center, so no name can be
// centered on the bar: every name takes the gap before the shifted items instead of 360pt.
it.each([
  // [reserve, remote desktop, natural title width, expected title view width]
  [238, true, 150, 224], // even a short name: the gap up to the shifted trailing pill
  [238, true, 300, 224],
  [238, false, 150, 268], // one trailing item is still asymmetric beside the status area
  [60, false, 150, 360], // a narrow status area still leaves room to center on the bar
  [0, false, 300, 360], // ordinary wide bar keeps its centered cap
] as const)('Duo reserve=%s remote=%s natural=%s sizes the title view to %s', async (reserve, remoteDesktop, natural, width) => {
  h.frameWidth = 662;
  h.naturalWidth = natural;
  expect(await renderTitleWidth({ statusRowReserve: reserve, remoteDesktop })).toBe(width);
});

// Unit regression from the hidden-animation review: native-stack renders the
// real HomeNativeStackHeader → HomeStackHeader headerTitle callback outside the
// route's providers. Earlier tests replaced the bar and sync glyph, hiding this
// gap. Minimal failure: pending sync, then hide home while the app stays active.
// Assert the real QuietSyncIndicator stops its native loop without losing the
// title/glyph, resumes on return, and disappears when the hidden sync completes.
it('carries visibility into a native title rendered outside the home route', async () => {
  h.detachedHeader = true;
  const headerNode = document.createElement('div');
  const headerRoot = createRoot(headerNode);
  const props = {
    displayA11y: 'Display settings', displayActions: [], displayBadge: false, menuA11y: 'Open menu',
    onDisplayAction: vi.fn(), onOpenDeviceMenu: vi.fn(), onOpenMenu: vi.fn(), remoteDesktopA11y: 'Remote desktop',
    onSelectScope: vi.fn(), scopeActions: [], showRemoteGuide: false, title: 'All tasks', titleA11y: 'Select scope',
  };
  // Stable element: visibility must cross memo boundaries without new props.
  const syncingHeader = el(HomeNativeStackHeader, { ...props, syncing: true });
  const render = async (visible: boolean, syncing = true) => {
    await act(async () => root.render(el(AnimationVisibilityProvider, { visible,
      children: syncing ? syncingHeader : el(HomeNativeStackHeader, { ...props, syncing: false }),
    })));
    await act(async () => headerRoot.render(h.options.headerTitle()));
  };
  try {
    await render(true);
    expect(h.loops.size).toBe(1);
    const glyph = headerNode.querySelector('[data-testid="connection.quietSync"]');
    expect(glyph).not.toBeNull();
    await render(false);
    expect(h.loops.size).toBe(0);
    expect(headerNode.querySelector('[data-testid="connection.quietSync"]')).toBe(glyph);
    expect(headerNode.textContent).toContain('All tasks');
    await render(true);
    expect(h.loops.size).toBe(1);
    await render(false, false);
    expect(h.loops.size).toBe(0);
    expect(headerNode.querySelector('[data-testid="connection.quietSync"]')).toBeNull();
    await render(true, false);
    expect(h.loops.size).toBe(0);
  } finally {
    await act(async () => headerRoot.unmount());
  }
});
