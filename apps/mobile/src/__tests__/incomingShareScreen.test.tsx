// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dismissTo: vi.fn(), select: vi.fn(), dispatch: vi.fn(),
  prevent: false, onRemove: undefined as ((event: { data: { action: object }; repeat: () => void }) => void) | undefined,
  acknowledge: vi.fn(), readDevices: vi.fn(), invoke: vi.fn(async () => [] as any[]),
  openLink: vi.fn(async () => undefined), owner: { generation: 1 },
  revoked: new Set<string>(), roster: { items: [] as any[], loading: false, error: null, refresh: vi.fn() },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }, StyleSheet: { create: (x: unknown) => x },
  View: ({ children }: any) => el('div', null, children),
  ScrollView: ({ children }: any) => el('div', null, children),
  KeyboardAvoidingView: ({ children }: any) => el('div', null, children),
  Image: () => null, ActivityIndicator: () => null,
  Pressable: ({ children, onPress, disabled, testID, accessibilityLabel }: any) => el('button', { onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel },
    typeof children === 'function' ? children({ pressed: false }) : children),
  FlatList: ({ data, renderItem }: any) => el('div', null, data.map((item: any) => el('div', { key: item.key }, renderItem({ item })))),
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, Link: () => null, MessageSquare: () => null,
  Plus: () => null, Search: () => null, X: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: any) => el('div', null, children) }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useRouter: () => ({ dismissTo: mock.dismissTo }),
  useNavigation: () => ({ isFocused: () => true, dispatch: mock.dispatch }) }));
vi.mock('expo-router/react-navigation', () => ({ usePreventRemove: (prevent: boolean, callback: typeof mock.onRemove) => {
  mock.prevent = prevent; mock.onRemove = callback;
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (s: string) => s } }));
vi.mock('@/i18n/presentationLocalizer', () => ({ mobilePresentationLocalizer: undefined }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children), TextInput: ({ value, onChangeText, testID }: any) => el('input', { value, onInput: (event: any) => onChangeText(event.currentTarget.value), 'data-testid': testID }) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: ({ onBack }: any) => el('button', { onClick: onBack, 'data-testid': 'back' }, 'Back'), simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => mock.owner, isMobileAuthOwnerCurrent: () => true, subscribeMobileAuthOwner: () => () => undefined }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ readDeviceList: mock.readDevices,
  openLink: mock.openLink, invoke: mock.invoke, status: 'online', presenceVersion: 0 }) }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => mock.revoked }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => mock.roster }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessions: () => [] } }));
vi.mock('@/session/incomingShare', async importOriginal => {
  const original = await importOriginal<typeof import('@/session/incomingShare')>();
  return { ...original, selectIncomingShareDestination: (...args: Parameters<typeof original.selectIncomingShareDestination>) => {
    mock.select(...args); return original.selectIncomingShareDestination(...args);
  } };
});
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: any) => make(tokens.lightColors) };
});
import { __resetIncomingShareForTest, stageIncomingShareBatch, consumeIncomingShareBatch } from '@/session/incomingShare';
import IncomingShareScreen from '../../app/incoming-share';
import { parseNewSessionDeviceOptions, pickNewSessionDefaultDevice } from '@/session/newSession';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mock.dismissTo.mockReset();
  mock.invoke.mockResolvedValue([]);
  mock.roster.items = [];
  __resetIncomingShareForTest();
  Object.assign(mock.owner, { accountKey: 'global:account-a', accountId: 'account-a' });
  mock.acknowledge.mockReset();
  stageIncomingShareBatch([{ value: 'https://example.invalid/shared', shareType: 'url' } as any], mock.acknowledge, 'share-1');
  mock.prevent = false; mock.onRemove = undefined;
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); });
const desktop = (deviceId: string, extra = {}) => ({ deviceId, name: deviceId, busy: false, isSelf: false,
  lastSeenAt: null, online: true, platform: 'darwin', remoteControlEnabled: true, ...extra });

// Integration regression: system share -> picker -> new task used to omit all
// device route params. The real new-task parser then had no selectable computer,
// leaving its selector and send action disabled. Exercise the production click
// and destination parser; native widgets/transport are the only UI boundaries.
it('hands the new-task screen eligible computers instead of an empty route', async () => {
  mock.readDevices.mockResolvedValue({ devices: [desktop('first'), desktop('second'),
    desktop('disabled', { remoteControlEnabled: false }), desktop('phone', { platform: 'ios' })] });
  await act(async () => root.render(el(IncomingShareScreen)));
  await act(() => ([...container.querySelectorAll('button')].find(button => button.textContent?.includes('composer.incomingShare.newTask')) as HTMLButtonElement).click());
  expect(mock.select).toHaveBeenCalledWith('share-1', 'new');
  const route = mock.dismissTo.mock.calls[0]![0];
  expect(route.pathname).toBe('/sessions/new');
  const options = parseNewSessionDeviceOptions(route.params.deviceOptions);
  expect(options.map(option => option.deviceId)).toEqual(['first', 'second']);
  expect(pickNewSessionDefaultDevice({ deviceOptions: options,
    routeDevice: { deviceId: route.params.deviceId, name: route.params.deviceName }, routeDeviceExplicit: false })?.deviceId).toBe('first');
});

it('retains the share without navigating when no eligible computer can create a task', async () => {
  mock.readDevices.mockResolvedValue({ devices: [desktop('disabled', { remoteControlEnabled: false })] });
  await act(async () => root.render(el(IncomingShareScreen)));
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('composer.incomingShare.newTask')) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await act(() => button.click());
  expect(mock.select).not.toHaveBeenCalled();
  expect(mock.dismissTo).not.toHaveBeenCalled();
});

// Search must explain an empty result and recover without leaving the picker.
it('shows one empty search result and clears it without claiming the share', async () => {
  mock.readDevices.mockResolvedValue({ devices: [] });
  await act(async () => root.render(el(IncomingShareScreen)));
  const input = container.querySelector('input')!;
  await act(() => { input.value = 'missing target'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent?.match(/composer.incomingShare.noMatches/g)).toHaveLength(1);
  await act(() => (container.querySelector('[aria-label="composer.incomingShare.clearSearch"]') as HTMLButtonElement).click());
  expect(input.value).toBe('');
  expect(container.textContent).not.toContain('composer.incomingShare.noMatches');
  expect(mock.select).not.toHaveBeenCalled();
});

// #10428: the real chooser + mailbox must finish a blocked removal using the
// router's repeat capability. Previously usePreventRemove was a no-op here.
// The navigation boundary cannot complete direct replay while protected; repeat releases
// it before dispatch, matching Expo Router 58. No transport/native file writes.
function remove(action = { type: 'GO_BACK' }) {
  let completed = false;
  mock.dispatch.mockImplementation(() => {
    completed = !mock.prevent;
  });
  mock.onRemove!({ data: { action }, repeat: () => { mock.prevent = false; mock.dispatch(action); } });
  return completed;
}

it.each(['new', 'task', 'companion'])('hands off a pending share to %s and completes the blocked removal once', async target => {
  mock.readDevices.mockResolvedValue({ devices: [desktop('first')] });
  mock.invoke.mockResolvedValue([{ id: 'task-a', title: 'existing task', status: 'active' }]);
  mock.roster.items = [{ key: 'companion', host: { deviceId: 'first', deviceName: 'first' }, item: {
    ref: { collectionId: 'bots', kind: 'bot', id: 'bot-a' },
    display: { title: 'companion' }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'bot-task' } }],
  } }];
  let removed = false;
  mock.dismissTo.mockImplementation(() => { removed = remove({ type: 'DISMISS_TO' }); });
  await act(async () => root.render(el(IncomingShareScreen)));
  const button = target === 'new' ? container.querySelector('[data-testid="incomingShare.newTask"]')
    : [...container.querySelectorAll('button')].find(button => target === 'task'
      ? button.textContent?.includes('existing task') : button.getAttribute('aria-label') === 'companion, first');
  await act(() => (button as HTMLButtonElement).click());
  expect(removed).toBe(true);
  expect(mock.dispatch).toHaveBeenCalledOnce();
  expect(mock.select).toHaveBeenCalledWith('share-1', target === 'new' ? 'new' : target === 'task'
    ? JSON.stringify(['first', 'task-a']) : JSON.stringify(['first', 'resource', 'bots', 'bot', 'bot-a']));
  expect(mock.acknowledge).not.toHaveBeenCalled();
  await act(() => { expect(consumeIncomingShareBatch('share-1')).toBe(true); });
});

it.each([false, true])('leaves safely after cancellation (native acknowledgement fails: %s)', async failed => {
  mock.readDevices.mockResolvedValue({ devices: [] });
  if (failed) mock.acknowledge.mockImplementationOnce(() => { throw new Error('INCOMING_SHARE_ACK_FAILED'); });
  await act(async () => root.render(el(IncomingShareScreen)));
  await act(() => { expect(remove()).toBe(true); });
  expect(mock.dispatch).toHaveBeenCalledOnce();
  expect(mock.acknowledge).toHaveBeenCalledOnce();
  // Failure retains the same batch for retry; success cannot replay it.
  await act(() => { expect(consumeIncomingShareBatch('share-1')).toBe(failed); });
});
