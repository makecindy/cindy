// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import { ConnectionBanner, useShowConnectionBanner } from '@/components/ConnectionBanner';
import { localNetworkStore } from '@/device-link/localNetworkStatus';
import { i18n } from '@/i18n';
import type { DeviceLinkStatus } from '@cindy/device-link';

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('react-native', () => ({
  ActivityIndicator: () => null,
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (s: unknown) => s },
}));
vi.mock('@/components/ConnectionNoticeOverlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/ConnectionNoticeOverlay')>(),
  ConnectionNoticeOverlay: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('lucide-react-native', () => ({ LoaderCircle: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: { children: ReactNode; testID: string }) => createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { onPress(): void; testID: string } }) =>
    createElement('button', { onClick: action.onPress, 'data-testid': action.testID }),
  StatusDot: () => null,
}));
vi.mock('@/theme', () => ({ fontWeight: {}, useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
let visible = false;
beforeEach(async () => {
  localNetworkStore.update();
  await i18n.changeLanguage('zh-CN');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
function Probe({ status, error, unresponsive }: {
  status: DeviceLinkStatus; recovery?: 'syncing' | 'recovered'; error?: string; unresponsive?: boolean;
}) {
  const active = useShowConnectionBanner(status, error ?? null, null, unresponsive);
  visible = useDelayedConnectionNotice(active);
  return null;
}
function render(status: DeviceLinkStatus, recovery?: 'syncing' | 'recovered', error?: string, unresponsive?: boolean) {
  act(() => root.render(createElement(Probe, { status, recovery, error, unresponsive })));
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

// Unit regression: render the real banner, replacing only native views/placement.
// Existing tests covered delay but missed phone outages overriding stale host errors.
function banner(status: DeviceLinkStatus, cachedOnly = false, deviceUnresponsive = false) {
  act(() => root.render(createElement(ConnectionBanner, {
    status, cachedOnly, deviceUnresponsive, loading: false, error: null,
    lastSyncedAt: null, onSync: () => {},
  })));
  advance(3_000);
  return container.querySelector('[data-testid="connection.title"]')?.textContent;
}
it('shows phone network loss even while relay still looks online, and clears on recovery', () => {
  act(() => localNetworkStore.update({ type: 'NONE', isConnected: false }));
  expect(banner('online', false, true)).toBe('手机网络不可用');
  expect(banner('online', true)).toBe('手机网络不可用');
  banner('online');
  act(() => localNetworkStore.update({ type: 'WIFI', isConnected: true }));
  expect(container.textContent).toBe('');
});
it('distinguishes service loss, confirmed offline computer and unattributed timeout', () => {
  expect(banner('stopped', true)).toBe('暂时连不上服务');
  expect(banner('online', true)).toBe('电脑未连接');
  expect(banner('online', false, true)).toBe('连接暂无响应');
});

// Unit regression: a retained history error must not override recovered presence
// or remove its real retry action; existing cases only covered null request errors.
it('restores history retry after the computer reconnects despite a retained offline error', () => {
  const onSync = vi.fn();
  const props = {
    status: 'online' as const, loading: false, error: '[DEVICE_OFFLINE] unavailable',
    requestErrorAutoRecovering: false, lastSyncedAt: null, onSync,
  };
  act(() => root.render(createElement(ConnectionBanner, { ...props, cachedOnly: true })));
  advance(3_000);
  expect(container.querySelector('[data-testid="connection.title"]')?.textContent).toBe('电脑未连接');
  expect(container.querySelector('button')).toBeNull();
  act(() => root.render(createElement(ConnectionBanner, { ...props, cachedOnly: false })));
  expect(container.querySelector('[data-testid="connection.title"]')?.textContent).toBe(i18n.t('deviceLink.syncFailed'));
  const button = container.querySelector<HTMLButtonElement>('[data-testid="connection.syncButton"]');
  expect(button).not.toBeNull();
  act(() => button!.click());
  expect(onSync).toHaveBeenCalledOnce();
});

it('keeps repeated online task loads quiet, even when content takes several seconds', () => {
  for (let visit = 0; visit < 3; visit++) {
    render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
    render('online', 'recovered'); advance(500); expect(visible).toBe(false);
  }
});
it('clears a real outage when online without showing a content repair or completion banner', () => {
  render('stopped', 'syncing'); advance(2_999); expect(visible).toBe(false);
  advance(1); expect(visible).toBe(true);
  render('online', 'syncing'); expect(visible).toBe(false);
  advance(5_000); expect(visible).toBe(false);
  render('online', 'recovered'); expect(visible).toBe(false);
  render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
});
it('does not promote a brief connection blip into a long content recovery banner', () => {
  render('connecting', 'syncing'); advance(300);
  render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
});
it('shows real errors after the shared delay and clears immediately on recovery', () => {
  render('online', 'syncing', 'INVOKE_TIMEOUT'); expect(visible).toBe(false);
  advance(2_999); expect(visible).toBe(false);
  advance(1); expect(visible).toBe(true);
  render('online', 'syncing', undefined, true); expect(visible).toBe(true);
  render('online', 'recovered'); expect(visible).toBe(false);
  advance(2_000); expect(visible).toBe(false);
});
