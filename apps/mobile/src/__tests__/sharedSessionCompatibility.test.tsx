// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedSessionScreen from '../../app/shared-session';

const state = vi.hoisted(() => ({
  params: { sessionId: 'session', deviceId: 'host' },
  link: { sharedTaskAvailable: true as boolean | undefined, invoke: vi.fn() },
  api: { list: vi.fn(async () => []), get: vi.fn() },
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('lucide-react-native', () => ({ Check: () => null, Laptop: () => null, Link: () => null, Users: () => null, Clock: () => null, FileText: () => null, Square: () => null, X: () => null }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: vi.fn() }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Stack: { Screen: () => null }, useLocalSearchParams: () => state.params, useRouter: () => ({}), useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => state.link }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => state.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessions: () => [] } }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: vi.fn() }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('xdt-ios-action-sheet', () => ({ iosBottomActionSheetAvailable: false, showIosBottomActionSheet: vi.fn() }));
vi.mock('react-native', () => ({
  ActionSheetIOS: {},
  Alert: { alert: vi.fn() }, AppState: { currentState: 'active' }, Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'android' }, BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
  MainWindowOptionButton: ({ label }: { label: string }) => createElement('button', null, label),
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
let host: HTMLDivElement;
let root: Root;
async function render() { await act(async () => root.render(createElement(SharedSessionScreen))); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.clearAllMocks(); state.link.sharedTaskAvailable = true;
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it('shows upgrade for an old host and recovers when the host gains the channel', async () => {
  state.link.invoke.mockRejectedValue({ code: 'CHANNEL_NOT_ALLOWED' });
  await render();
  expect(host.textContent).toContain('sharedTask.upgrade');
  expect(host.textContent).not.toContain('sharedTask.open');
  state.link.invoke.mockResolvedValue({ available: true, detail: null });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(host.textContent).not.toContain('sharedTask.upgrade');
  expect(host.textContent).toContain('sharedTask.open');
});
it('does not query an old relay and does not mislabel disconnected as old', async () => {
  state.link.sharedTaskAvailable = false;
  await render();
  expect(host.textContent).toContain('sharedTask.upgrade');
  expect(state.link.invoke).not.toHaveBeenCalled();
  state.link.sharedTaskAvailable = undefined; await render();
  expect(host.textContent).not.toContain('sharedTask.upgrade');
  expect(host.textContent).toContain('sharedTask.retry');
  expect(state.link.invoke).not.toHaveBeenCalled();
});
it('does not convert a timeout into an upgrade requirement', async () => {
  state.link.invoke.mockRejectedValue({ code: 'INVOKE_TIMEOUT' }); await render();
  expect(host.textContent).toContain('sharedTask.requestTimedOut');
  expect(host.textContent).not.toContain('sharedTask.upgrade');
});
