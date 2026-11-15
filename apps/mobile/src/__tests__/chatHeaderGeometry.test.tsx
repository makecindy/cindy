// @vitest-environment jsdom
import { act, createContext, memo, useContext, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GeometryContext } from '@/platform/AdaptiveWindowContext';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { ChatIdentityHeader } from '@/session/ChatIdentityHeader';
import type { WindowGeometry } from '@/platform/windowGeometry';
const h = vi.hoisted(() => ({ size: { width: 669, height: 951, scale: 2, fontScale: 1 },
  listeners: new Set<() => void>(), commits: 0 }));
vi.mock('react-native', () => ({
  Dimensions: { get: () => h.size, addEventListener: (_: string, fn: () => void) => { h.listeners.add(fn); return { remove: () => h.listeners.delete(fn) }; } },
  useWindowDimensions: () => useSyncExternalStore(fn => { h.listeners.add(fn); return () => h.listeners.delete(fn); }, () => h.size),
  View: ({ children, style }: any) => <div style={typeof style?.width === 'number' ? { width: style.width } : undefined}>{children}</div>, Pressable: ({ children }: any) => <div>{children}</div>,
  StyleSheet: { create: (s: any) => s }, Keyboard: { dismiss() {} },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaInsetsContext: createContext(null),
  useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => { h.commits++; return null; },
  Toolbar: Object.assign(({ children }: any) => <div>{children}</div>, { View: ({ children }: any) => children }) } }));
vi.mock('@/platform/chrome/SystemNavigationBack', () => ({ useSystemNavigationBack: () => false }));
vi.mock('@/platform/chrome/NativeChromeBackButton', () => ({ NativeChromeBackButton: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: () => null }));
vi.mock('lucide-react-native', () => ({ Settings2: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/theme', async () => { const tokens = await import('@/theme/tokens'); return { ...tokens,
  useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (fn: any) => fn(tokens.lightColors) }; });
const Header = memo(() => <ChatIdentityHeader nativeHeader mark={null} title="Companion" subtitle="PC"
  identityLabel="Companion" onBack={() => {}} testIDPrefix="companion" />);
const initial: WindowGeometry = { width: 669, height: 951, insets: { top: 88, bottom: 34, left: 0, right: 0 },
  barEdge: 'none', regularWidth: true, regularHeight: true, regions: [], reservedRegionsSupported: true };
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const render = (geometry: WindowGeometry | null, insets = initial.insets) => act(() => root.render(
  <SafeAreaInsetsContext.Provider value={insets}><GeometryContext.Provider value={geometry}><Header /></GeometryContext.Provider></SafeAreaInsetsContext.Provider>));
const resize = () => act(() => { h.size = { ...h.size, width: 951, height: 669 }; h.listeners.forEach(fn => fn()); });
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; h.commits = 0; h.size = { width: 669, height: 951, scale: 2, fontScale: 1 }; container = document.createElement('div'); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); expect(h.listeners.size).toBe(0); });
it('does not re-render the native identity header for redundant window and safe-area broadcasts', () => {
  render(initial); resize(); render(initial, { ...initial.insets, top: 0 });
  expect(h.commits).toBe(1);
  render({ ...initial, width: 951, height: 669 }); expect(h.commits).toBe(2);
});
it('standalone headers without native geometry retain the dimension and safe-area fallback', () => {
  render(null); resize(); render(null, { ...initial.insets, top: 0 });
  expect(h.commits).toBe(3);
});

// #10349: the native toolbar used to spend UIKit's inter-item space on the identity,
// hiding both custom actions in an empty overflow menu. Existing cases only covered
// geometry subscriptions. Unit regression: render the production header at 402pt
// with two actions, and check its actual width budget (also narrow/group variants).
it.each([402, 393, 375])('reserves native bar space at %spt without shrinking action targets', (width) => {
  for (const actionCount of [1, 2]) {
    act(() => root.render(<GeometryContext.Provider value={{ ...initial, width }}>
      <ChatIdentityHeader nativeHeader mark={null} title="A long companion or group name" subtitle="PC"
        identityLabel="Companion" onBack={() => {}} onOpenSettings={() => {}}
        accessory={actionCount === 2 ? <span>Glance</span> : undefined} testIDPrefix="companion" />
    </GeometryContext.Provider>));
    const identityWidth = Number.parseFloat(container.querySelector<HTMLElement>('div[style]')!.style.width);
    // Back + identity gap + trailing targets/gap leave 64pt for native margins/gaps.
    const customControlsWidth = 44 + 12 + actionCount * 44 + (actionCount - 1) * 12;
    expect(identityWidth).toBeGreaterThan(0);
    expect(width - identityWidth - customControlsWidth).toBeGreaterThanOrEqual(64);
  }
});
