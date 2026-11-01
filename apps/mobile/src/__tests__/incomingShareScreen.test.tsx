// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  dismissTo: vi.fn(), select: vi.fn(() => true), readDevices: vi.fn(), invoke: vi.fn(async () => []),
  openLink: vi.fn(async () => undefined), owner: { generation: 1 },
  revoked: new Set<string>(), roster: { items: [], loading: false, error: null, refresh: vi.fn() },
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
  useNavigation: () => ({ isFocused: () => true }) }));
vi.mock('expo-router/react-navigation', () => ({ usePreventRemove: () => undefined }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (s: string) => s } }));
vi.mock('@/i18n/presentationLocalizer', () => ({ mobilePresentationLocalizer: undefined }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children), TextInput: ({ value, onChangeText, testID }: any) => el('input', { value, onInput: (event: any) => onChangeText(event.currentTarget.value), 'data-testid': testID }) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => mock.owner, isMobileAuthOwnerCurrent: () => true }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ readDeviceList: mock.readDevices,
  openLink: mock.openLink, invoke: mock.invoke, status: 'online', presenceVersion: 0 }) }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => mock.revoked }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => mock.roster }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessions: () => [] } }));
vi.mock('@/session/incomingShare', () => ({
  useIncomingShareBatch: () => ({ id: 'share-1', payloads: [] }), incomingShareText: () => 'shared page',
  selectIncomingShareDestination: mock.select, leaveIncomingShareChooser: vi.fn(), incomingShareDestination: vi.fn(),
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: any) => make(tokens.lightColors) };
});
import IncomingShareScreen from '../../app/incoming-share';
import { parseNewSessionDeviceOptions, pickNewSessionDefaultDevice } from '@/session/newSession';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
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
