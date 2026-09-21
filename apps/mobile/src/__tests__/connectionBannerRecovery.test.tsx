// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import { useShowConnectionBanner } from '@/components/ConnectionBanner';
import type { DeviceLinkStatus } from '@cindy/device-link';

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('react-native', () => ({ ActivityIndicator: () => null, View: () => null, StyleSheet: { create: (s: unknown) => s } }));
vi.mock('lucide-react-native', () => ({ LoaderCircle: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null, StatusDot: () => null }));
vi.mock('@/theme', () => ({ fontWeight: {}, useTheme: () => ({}), useThemedStyles: () => ({}) }));

let root: Root;
let visible = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  root = createRoot(document.createElement('div'));
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
