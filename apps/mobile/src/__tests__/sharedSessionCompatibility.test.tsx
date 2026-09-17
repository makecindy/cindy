// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedSessionScreen from '../../app/shared-session';

const state = vi.hoisted(() => ({
  params: { sessionId: 'session', deviceId: 'host' },
  link: { sessionMeetingAvailable: true as boolean | undefined, invoke: vi.fn() },
  api: { list: vi.fn(async () => []), get: vi.fn() },
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => state.params, useRouter: () => ({}) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSessionMeetingApi', () => ({ useSessionMeetingApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {} }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: vi.fn() }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => children }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children), TextInput: () => null,
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string } }) => createElement('button', null, action.label),
  MainWindowRowButton: () => null,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
let host: HTMLDivElement;
let root: Root;
async function render() { await act(async () => root.render(createElement(SharedSessionScreen))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks(); state.link.sessionMeetingAvailable = true;
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('shows upgrade for an old host and recovers when the host gains the channel', async () => {
  state.link.invoke.mockRejectedValue({ code: 'CHANNEL_NOT_ALLOWED' });
  await render();
  expect(host.textContent).toContain('sessionMeeting.upgrade');
  expect(host.querySelector('button')).toBeNull();
  state.link.invoke.mockResolvedValue({ available: true, detail: null });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(host.textContent).not.toContain('sessionMeeting.upgrade');
  expect(host.querySelector('button')?.textContent).toBe('sessionMeeting.open');
});
it('does not query an old relay and does not mislabel disconnected as old', async () => {
  state.link.sessionMeetingAvailable = false;
  await render();
  expect(host.textContent).toContain('sessionMeeting.upgrade');
  expect(state.link.invoke).not.toHaveBeenCalled();
  state.link.sessionMeetingAvailable = undefined; await render();
  expect(host.textContent).not.toContain('sessionMeeting.upgrade');
  expect(host.textContent).toContain('sessionMeeting.retry');
  expect(state.link.invoke).not.toHaveBeenCalled();
});
it('does not convert a timeout into an upgrade requirement', async () => {
  state.link.invoke.mockRejectedValue({ code: 'INVOKE_TIMEOUT' }); await render();
  expect(host.textContent).toContain('sessionMeeting.retry');
  expect(host.textContent).not.toContain('sessionMeeting.upgrade');
});
