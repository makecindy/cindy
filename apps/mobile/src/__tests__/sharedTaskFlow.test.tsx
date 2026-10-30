// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseSharedTaskInvitation, sharedTaskHostPeer } from '@cindy/device-link';
import { writeClipboardText } from '@/session/messageActions';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { ApiError } from '@/api/client';
import { setMobileDebugSink } from '@/debug/mobileDebugLog';
import { Platform } from 'react-native';
import { clearSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';
import SharedSessionScreen from '../../app/shared-session';

const h = vi.hoisted(() => ({
  params: {} as { sessionId?: string; deviceId?: string; sharedTaskId?: string; expectedOwnedSharedTaskId?: string; mode?: string }, generation: 1,
  router: { replace: vi.fn(), push: vi.fn() }, alert: vi.fn(), revoked: vi.fn(),
  link: { sharedTaskAvailable: true, invoke: vi.fn(), openLink: vi.fn(), closeLink: vi.fn(), readDeviceList: vi.fn() },
  api: { list: vi.fn(), get: vi.fn(), join: vi.fn(), leave: vi.fn(), close: vi.fn() },
  store: { getSessions: vi.fn(), removeDevice: vi.fn(), setDeviceSessions: vi.fn(), upsertDeviceSession: vi.fn() },
  t: (key: string, options?: { title?: string; link?: string }) => key === 'sharedTask.invitationMessage' ? `Join “${options?.title}”\n${options?.link}\nOpen the link, or paste it into Join Shared Task in Cindy.` : options?.title ? key + ':' + options.title : key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) } }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://relay.example.test', APP_SCHEME: 'cindy' }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('lucide-react-native', () => ({ Check: () => null, Laptop: () => null, Link: () => null, Users: () => null, Clock: () => null, FileText: () => null, Square: () => null, X: () => null }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: h.revoked }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Stack: { Screen: () => null }, useLocalSearchParams: () => h.params, useRouter: () => h.router, useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, accountGeneration: h.generation, user: { name: 'Account Guest' } }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/useSharedTaskApi', () => ({ useSharedTaskApi: () => h.api }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: h.store }));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: vi.fn() }));
// Workflow/authorization tests; platform dialog rendering has separate coverage.
vi.mock('@/session/useSharedTaskConfirmation', async () => {
  const { showConfirm } = await import('@/platform/chrome/showActionMenu');
  return { useSharedTaskConfirmation: () => ({ confirm: showConfirm, dialog: null }) };
});
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('xdt-ios-action-sheet', () => ({ iosBottomActionSheetAvailable: false, showIosBottomActionSheet: vi.fn() }));
vi.mock('react-native', () => ({
  ActionSheetIOS: {},
  Alert: { alert: h.alert }, AppState: { currentState: 'active' }, Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'android' },
  Modal: ({ children }: { children?: ReactNode }) => createElement('div', { role: 'dialog' }, children),
  AccessibilityInfo: { setAccessibilityFocus: vi.fn() }, findNodeHandle: () => null,
  View: ({ children, testID, accessibilityElementsHidden }: { children?: ReactNode; testID?: string; accessibilityElementsHidden?: boolean }) => createElement('div', { 'data-testid': testID, hidden: accessibilityElementsHidden }, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress(): void; accessibilityLabel?: string }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => children }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  TextInput: ({ accessibilityLabel, multiline, maxLength, value, onChangeText }: { accessibilityLabel: string; multiline?: boolean; maxLength?: number; value: string; onChangeText(value: string): void }) => createElement(multiline ? 'textarea' : 'input', { 'aria-label': accessibilityLabel, maxLength, value, onInput: (e: { currentTarget: HTMLInputElement }) => onChangeText(e.currentTarget.value), onChange: () => {} }),
}));
vi.mock('@/components/MobilePrimitives', () => ({
  ScreenBackButton: ({ onPress }: { onPress(): void }) => createElement('button', { onClick: onPress }, 'back'),
  MainWindowActionButton: ({ action }: { action: { label: string; disabled?: boolean; busy?: boolean; onPress(): void } }) => createElement('button', { disabled: action.disabled || action.busy, onClick: action.onPress }, action.label),
  MainWindowRowButton: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress(): void; accessibilityLabel?: string }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  MainWindowOptionButton: ({ label, onPress }: { label: string; onPress(): void }) => createElement('button', { onClick: onPress }, label),
  MainWindowEmptyState: ({ title, copy, children }: { title: string; copy: string; children?: ReactNode }) => createElement('section', null, title, copy, children),
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: ({ title, onBack }: { title: string; onBack(): void }) => createElement('header', null, title, createElement('button', { onClick: onBack }, 'back')), simpleScreenSafeAreaEdges: () => [], simpleScrollInsetProps: {}, simpleScrollScreenSafeAreaEdges: () => [] }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
let element: HTMLDivElement;
let root: Root;
const detail = { sharedTaskId: 'shared', sessionId: 'task', hostDeviceId: 'desktop', status: 'active', title: 'Design review', memberLabels: [{ memberId: 'member', displayName: 'Guest' }] };
const owned = (id: string) => ({ sharedTaskId: id.replaceAll(' ', '-'), sessionId: 'task', title: id, ownerAccountId: 'owner', hostDeviceId: 'host' });
async function render() { await act(async () => root.render(createElement(SharedSessionScreen))); }
async function click(label: string) {
  // The account page has a Join tab and a Join submit action; use the latter.
  const buttons = [...element.querySelectorAll('button')];
  const button = (label === 'sharedTask.join' ? buttons.reverse() : buttons).find((button) => button.textContent === label || button.getAttribute('aria-label') === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const input = element.querySelector('[aria-label="' + label + '"]') as HTMLInputElement;
  await act(async () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const confirmation = () => h.alert.mock.lastCall![2] as { style: string; onPress(): void }[];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.resetAllMocks(); clearSharedTaskInvitationIntent(); h.params = {}; h.generation = 1;
  Platform.OS = 'android';
  setMobileAuthOwner('owner'); h.link.sharedTaskAvailable = true;
  h.api.list.mockResolvedValue([]); h.api.get.mockResolvedValue(detail);
  h.store.getSessions.mockReturnValue(['host', 'desktop', sharedTaskHostPeer('shared', 'desktop'), sharedTaskHostPeer('guest-task', 'host'), sharedTaskHostPeer('Already-joined', 'host')]
    .map(deviceLinkDeviceId => ({ id: 'task', source: 'desktop', deviceLinkDeviceId })));
  h.api.join.mockResolvedValue({ sharedTaskId: 'shared' });
  h.link.invoke.mockResolvedValue({ available: true, detail: null });
  h.link.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'host', name: 'Test computer' }] });
  element = document.createElement('div'); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); clearSharedTaskInvitationIntent(); setMobileDebugSink(undefined); vi.useRealTimers(); });
it.each(['cindy-make', 'cindy-make-merge'])('hides cold %s shares from both account management lists', async source => {
  h.params = { mode: 'manage' };
  let shares = [owned('Legacy owned'), { ...owned('Legacy joined'), ownerAccountId: 'other' }];
  h.api.list.mockImplementation(async () => shares);
  h.api.leave.mockImplementation(async sharedTaskId => { shares = shares.filter(task => task.sharedTaskId !== sharedTaskId); });
  h.store.getSessions.mockReturnValue([]);
  h.link.invoke.mockImplementation(async (_peer, _channel, [sessionId]) => ({ id: sessionId, source }));
  await render();
  expect(element.textContent).not.toContain('Legacy owned');
  expect(element.textContent).not.toContain('Legacy joined');
  expect(element.textContent).toContain('sharedTask.ownedEmptyTitle');
  await click('sharedTask.joinedTab');
  expect(element.textContent).toContain('sharedTask.joinedEmptyTitle');
  expect(h.link.invoke).toHaveBeenCalledWith('host', 'local-db:sessions:get', ['task']);
  expect(h.link.invoke).toHaveBeenCalledWith(sharedTaskHostPeer('Legacy-joined', 'host'), 'local-db:sessions:get', ['task']);
  expect(h.api.leave).toHaveBeenCalledExactlyOnceWith('Legacy-joined');
  expect(h.api.close).not.toHaveBeenCalled();
});
it.each(['cindy-make', 'cindy-make-merge'])('publishes ordinary management rows when %s cleanup fails and retries on the next poll', async source => {
  h.params = { mode: 'manage' };
  const ordinaryOwned = owned('Ordinary owned');
  const ordinaryJoined = { ...owned('Ordinary joined'), ownerAccountId: 'other' };
  const hidden = { ...owned('Hidden Make share'), ownerAccountId: 'other' };
  let shares = [ordinaryOwned, ordinaryJoined, hidden];
  h.api.list.mockImplementation(async () => shares);
  const peer = sharedTaskHostPeer(hidden.sharedTaskId, hidden.hostDeviceId);
  h.store.getSessions.mockReturnValue([]);
  h.link.invoke.mockImplementation(async (deviceId, _channel, [sessionId]) => ({ id: sessionId, source: deviceId === peer ? source : 'desktop' }));
  let failing = true;
  h.api.leave.mockImplementation(async sharedTaskId => {
    if (failing) throw new Error('offline');
    shares = shares.filter(item => item.sharedTaskId !== sharedTaskId);
  });
  const diagnostics = vi.fn();
  setMobileDebugSink(diagnostics);
  await render();
  expect(element.textContent).toContain(ordinaryOwned.title);
  await click('sharedTask.joinedTab');
  expect(element.textContent).toContain(ordinaryJoined.title);
  expect(element.textContent).not.toContain(hidden.title);
  expect(element.textContent).not.toContain('sharedTask.retry');
  expect(h.store.removeDevice).not.toHaveBeenCalled();
  expect(diagnostics).toHaveBeenCalledWith('warn', 'device-link', ['Hidden shared task membership cleanup failed; will retry on refresh']);
  const attempts = h.api.leave.mock.calls.length;
  failing = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(h.api.leave).toHaveBeenCalledTimes(attempts + 1);
  expect(h.api.leave.mock.calls.every(([sharedTaskId]) => sharedTaskId === hidden.sharedTaskId)).toBe(true);
  expect(h.link.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(h.store.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(h.api.close).not.toHaveBeenCalled();
  expect(element.textContent).toContain(ordinaryJoined.title);
  expect(element.textContent).not.toContain(hidden.title);
});

it('does not show unknown offline shares and restores a confirmed ordinary share on the next poll', async () => {
  h.params = { mode: 'manage' }; h.api.list.mockResolvedValue([owned('Recovered normal task')]);
  h.store.getSessions.mockReturnValue([]); h.link.invoke.mockRejectedValue(new Error('offline'));
  await render();
  expect(element.textContent).not.toContain('Recovered normal task');
  h.link.invoke.mockResolvedValue({ id: 'task', source: 'desktop' });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(element.textContent).toContain('Recovered normal task');
  expect(h.link.openLink).not.toHaveBeenCalled();
});
const invitationLink = 'https://relay.example.test/shared-task/join#' + 'A'.repeat(43);
const invitationIntent = 'cindy://shared-session?invitation=' + 'A'.repeat(43) + '&server=https%3A%2F%2Frelay.example.test';
it.each([
  ['cindy-make', false], ['cindy-make-merge', false],
  ['cindy-make', true], ['cindy-make-merge', true],
] as const)('undoes a legacy %s invitation before publishing success or navigating (link=%s)', async (source, automatic) => {
  h.store.getSessions.mockReturnValue([]);
  h.link.invoke.mockResolvedValue({ id: 'task', source });
  if (automatic) receiveSharedTaskInvitationIntent(invitationIntent);
  await render();
  if (!automatic) { await fill('sharedTask.invitation', invitationLink); await click('sharedTask.join'); }
  const peer = sharedTaskHostPeer('shared', 'desktop');
  expect(h.api.leave).toHaveBeenCalledExactlyOnceWith('shared');
  expect(h.revoked).toHaveBeenCalledExactlyOnceWith(peer);
  expect(h.link.closeLink).toHaveBeenCalledExactlyOnceWith(peer);
  expect(h.store.removeDevice).toHaveBeenCalledExactlyOnceWith(peer);
  expect(h.api.close).not.toHaveBeenCalled();
  expect(h.store.setDeviceSessions).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(element.textContent).toContain('sharedTask.invitationUnavailable');
  expect(element.textContent).not.toContain('Design review');
  expect(element.querySelector('[aria-label="sharedTask.invitation"]')).not.toBeNull();
});
it('does not revoke membership after an account change while confirming an invitation', async () => {
  h.store.getSessions.mockReturnValue([]);
  let finish!: (session: unknown) => void;
  h.link.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await fill('sharedTask.invitation', invitationLink); await click('sharedTask.join');
  expect(finish).toBeTypeOf('function');
  setMobileAuthOwner('other'); h.generation++;
  await render(); await act(async () => finish({ id: 'task', source: 'cindy-make' }));
  expect(h.api.leave).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
});
it('retries failed Make membership rollback without exposing the task', async () => {
  h.store.getSessions.mockReturnValue([]); h.link.invoke.mockResolvedValue({ id: 'task', source: 'cindy-make' });
  h.api.leave.mockRejectedValueOnce(new Error('offline'));
  await render(); await fill('sharedTask.invitation', invitationLink); await click('sharedTask.join');
  expect(element.textContent).toContain('sharedTask.invitationUnavailable');
  expect(element.textContent).not.toContain('Design review');
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(h.store.removeDevice).not.toHaveBeenCalled();
  await click('sharedTask.join');
  expect(h.api.leave).toHaveBeenCalledTimes(2);
  expect(element.textContent).toContain('sharedTask.invitationUnavailable');
});
it('copies a shareable invitation message with a link accepted by automatic and manual admission', async () => {
  h.params = { sessionId: 'task', deviceId: 'desktop' };
  h.link.invoke.mockImplementation(async (_device, _channel, [command]) => command.action === 'invite' ? { invitation: 'A'.repeat(43) } : { available: true, detail });
  await render(); await click('sharedTask.invite');
  const content = vi.mocked(writeClipboardText).mock.lastCall![0];
  expect(content).toContain('Design review');
  expect(content).toContain(invitationLink);
  expect(content).toContain('paste it into Join Shared Task in Cindy');
  expect(parseSharedTaskInvitation(content, 'https://relay.example.test')).toEqual({ ok: true, invitation: 'A'.repeat(43) });
});
it('rejects an invitation from another service without joining', async () => {
  await render(); await fill('sharedTask.invitation', invitationLink.replace('relay.example.test', 'other.example.test'));
  await click('sharedTask.join');
  expect(h.api.join).not.toHaveBeenCalled();
  expect(element.textContent).toContain('sharedTask.invitationDifferentServer');
});
it('claims a received invitation while capability loads, then joins and enters only once', async () => {
  h.link.sharedTaskAvailable = false;
  receiveSharedTaskInvitationIntent(invitationIntent);
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await render();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  expect(h.api.join).not.toHaveBeenCalled();
  h.link.sharedTaskAvailable = true;
  await render(); await render();
  expect(h.api.join).toHaveBeenCalledExactlyOnceWith('A'.repeat(43), 'Account Guest');
  expect(h.router.replace).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: {
    sessionId: 'task', deviceId: sharedTaskHostPeer('shared', 'desktop'), deviceName: 'Design review',
  } });
});
it('retains the original expiry when a link is claimed while relay capability loads', async () => {
  h.link.sharedTaskAvailable = false;
  receiveSharedTaskInvitationIntent(invitationIntent);
  await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60_000); });
  await render();
  expect(getPendingSharedTaskInvitationIntent()).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  h.link.sharedTaskAvailable = true;
  await render();
  expect(h.api.join).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(element.textContent).toContain('sharedTask.invitationUnavailable');
  expect((element.querySelector('[aria-label="sharedTask.invitation"]') as HTMLTextAreaElement).value).toBe('');
});
it('rejects an expired claimed link even when its timeout has not run in the background', async () => {
  h.link.sharedTaskAvailable = false;
  receiveSharedTaskInvitationIntent(invitationIntent);
  await render();
  vi.setSystemTime(Date.now() + 15 * 60_000);
  h.link.sharedTaskAvailable = true;
  await render();
  expect(h.api.join).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(element.textContent).toContain('sharedTask.invitationUnavailable');
});
it('does not let the previous claimed link expiry discard a newer invitation', async () => {
  h.link.sharedTaskAvailable = false;
  receiveSharedTaskInvitationIntent(invitationIntent);
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60_000); });
  await act(async () => { receiveSharedTaskInvitationIntent(invitationIntent.replace('A'.repeat(43), 'B'.repeat(43))); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  h.link.sharedTaskAvailable = true;
  await render();
  expect(h.api.join).toHaveBeenCalledExactlyOnceWith('B'.repeat(43), 'Account Guest');
});
it('does not carry a claimed invitation across an account change', async () => {
  h.link.sharedTaskAvailable = false;
  receiveSharedTaskInvitationIntent(invitationIntent);
  await render();
  setMobileAuthOwner('other'); h.generation++;
  h.link.sharedTaskAvailable = true;
  await render();
  expect(h.api.join).not.toHaveBeenCalled();
});
it('can receive another link while the previous joined task is still shown', async () => {
  await render(); await fill('sharedTask.invitation', invitationLink); await click('sharedTask.join');
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await act(async () => { receiveSharedTaskInvitationIntent(invitationIntent); });
  expect(h.api.join).toHaveBeenCalledTimes(2);
  expect(h.router.replace).toHaveBeenCalledOnce();
});
it('keeps joined tasks out of the invitation form while retaining the owner tab', async () => {
  h.api.list.mockResolvedValue([{ ...owned('Already joined'), ownerAccountId: 'someone' }, owned('My share')]);
  await render();
  expect(element.querySelector('textarea')).not.toBeNull();
  expect(element.textContent).not.toContain('Already joined');
  expect(element.textContent).not.toContain('My share');
  expect(h.api.leave).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled();
  await click('sharedTask.tabOwned');
  expect(element.textContent).toContain('My share');
  expect(element.textContent).not.toContain('Already joined');
});
it('removes closed owner shares without closing the same-account device connection', async () => {
  h.api.list.mockResolvedValue([owned('shared')]);
  await render(); await click('sharedTask.tabOwned');
  h.api.list.mockResolvedValue([]);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(element.textContent).toContain('sharedTask.ownedEmptyTitle');
  expect(element.textContent).not.toContain('sharedTask.enterTask');
  expect(h.link.closeLink).not.toHaveBeenCalled();
  expect(h.store.removeDevice).not.toHaveBeenCalled();
});
it('lists owned tasks from the account menu and enters through the physical owner device', async () => {
  h.api.list.mockResolvedValue([owned('shared')]);
  h.api.get.mockResolvedValue({ ...detail, ownerAccountId: 'owner', hostDeviceId: 'host' });
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await render(); await click('sharedTask.tabOwned');
  expect(element.textContent).toContain('shared');
  await click('sharedTask.enterTask');
  expect(h.link.openLink).toHaveBeenCalledExactlyOnceWith('host');
  expect(h.link.invoke).toHaveBeenCalledExactlyOnceWith('host', 'local-db:sessions:get', ['task']);
  expect(h.store.upsertDeviceSession).toHaveBeenCalledWith('host', 'Test computer', { id: 'task' });
  expect(h.store.setDeviceSessions).not.toHaveBeenCalled();
  expect(h.api.join).not.toHaveBeenCalled();
  expect(h.router.replace).toHaveBeenCalledWith({ pathname: '/sessions/[sessionId]', params: { sessionId: 'task', deviceId: 'host', deviceName: 'Test computer' } });
});
it('opens an owner shortcut without showing guest membership or exit actions', async () => {
  h.params = { sharedTaskId: 'shared' };
  h.api.get.mockResolvedValue({ ...detail, ownerAccountId: 'owner', hostDeviceId: 'host' });
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await render();
  expect(element.textContent).toContain('Design review');
  expect(element.textContent).not.toContain('sharedTask.joinedBody');
  expect(element.textContent).not.toContain('sharedTask.leave');
  await click('sharedTask.enterTask');
  expect(h.link.openLink).toHaveBeenCalledWith('host');
});
it('keeps owner shares visible while remote control is disabled and lets the user retry after enabling it', async () => {
  h.api.list.mockResolvedValue([owned('shared')]);
  h.api.get.mockResolvedValue({ ...detail, ownerAccountId: 'owner', hostDeviceId: 'host' });
  h.link.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'host', name: 'Test computer', remoteControlEnabled: false }] });
  await render(); await click('sharedTask.tabOwned'); await click('sharedTask.enterTask');
  expect(element.textContent).toContain('deviceLink.connectStep3');
  expect(element.textContent).toContain('shared');
  expect(h.link.openLink).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
  h.link.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'host', name: 'Test computer', remoteControlEnabled: true }] });
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await click('sharedTask.enterTask');
  expect(h.router.replace).toHaveBeenCalledTimes(1);
});
it('does not enter or write owner session data after an account change during opening', async () => {
  h.params = { sharedTaskId: 'shared' };
  h.api.get.mockResolvedValue({ ...detail, ownerAccountId: 'owner', hostDeviceId: 'host' });
  let finish!: () => void;
  h.link.openLink.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click('sharedTask.enterTask');
  setMobileAuthOwner('other'); h.generation++; await render();
  await act(async () => finish());
  expect(h.store.upsertDeviceSession).not.toHaveBeenCalled();
  expect(h.router.replace).not.toHaveBeenCalled();
});
it.each([['NOT_FOUND', 'sharedTask.invitationUnavailable'], ['PERMISSION_DENIED', 'sharedTask.invitationRenew']])(
  'keeps the invitation form and explains joining failure %s', async (code, key) => {
    h.api.join.mockRejectedValue({ code });
    await render();
    await fill('sharedTask.invitation', 'a'.repeat(43));
    await click('sharedTask.join');
    expect(element.textContent).toContain(key);
    expect(element.querySelector('textarea')?.value).toBe('a'.repeat(43));
    expect(h.link.openLink).not.toHaveBeenCalled();
  });
it('uses a multiline invitation and stops at the joined screen before opening the task', async () => {
  await render();
  expect(element.querySelector('textarea')).not.toBeNull();
  expect(element.querySelector('input')).toBeNull();
  await fill('sharedTask.invitation', 'a'.repeat(43));
  await click('sharedTask.join');
  expect(h.api.join).toHaveBeenCalledWith('a'.repeat(43), 'Account Guest');
  expect(element.textContent).toContain('sharedTask.joinedTitle:Design review');
  expect(element.querySelector('textarea')).toBeNull();
  expect(h.link.openLink).not.toHaveBeenCalled();
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await click('sharedTask.enterTask');
  expect(h.link.invoke).toHaveBeenCalledWith(sharedTaskHostPeer('shared', 'desktop'), 'local-db:sessions:get', ['task']);
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
});
it.each(['ios', 'android'] as const)('%s preserves the page on cancel and rejects an old account confirmation', async (platform) => {
  Platform.OS = platform;
  h.params = { sessionId: 'task', deviceId: sharedTaskHostPeer('shared', 'desktop') }; await render();
  const originalPage = element.innerHTML;
  await click('sharedTask.leave');
  expect(h.alert).toHaveBeenCalledTimes(1);
  expect(element.innerHTML).toBe(originalPage);
  await click('sharedTask.leave');
  expect(h.alert).toHaveBeenCalledTimes(1);
  await act(async () => confirmation()[0].onPress());
  expect(element.innerHTML).toBe(originalPage);
  expect(h.api.leave).not.toHaveBeenCalled();
  await click('sharedTask.leave');
  expect(confirmation()[0].style).toBe('cancel');
  expect(h.api.leave).not.toHaveBeenCalled();
  const old = confirmation()[1]; setMobileAuthOwner('other');
  await act(async () => old.onPress!()); expect(h.api.leave).not.toHaveBeenCalled();
  setMobileAuthOwner('owner'); await click('sharedTask.leave');
  await act(async () => confirmation()[1].onPress!());
  expect(h.api.leave).toHaveBeenCalledWith('shared');
  expect(h.router.replace).toHaveBeenCalledWith('/devices');
});
it('replaces stale guest state only for confirmed membership loss and can join again', async () => {
  h.params = { sessionId: 'task', deviceId: sharedTaskHostPeer('shared', 'desktop') };
  await render();
  expect(element.textContent).toContain('sharedTask.joinedTitle');
  await click('sharedTask.leave');
  const oldConfirm = confirmation()[1];
  h.api.get.mockRejectedValue(new ApiError('NETWORK_ERROR', 0, 'offline'));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(element.textContent).not.toContain('sharedTask.ended'); expect(h.link.closeLink).not.toHaveBeenCalled();
  h.api.get.mockRejectedValue(new ApiError('NOT_FOUND', 404, 'gone'));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(element.textContent).toContain('sharedTask.ended');
  expect(element.textContent).not.toContain('sharedTask.leave');
  expect(h.revoked).toHaveBeenCalledWith(sharedTaskHostPeer('shared', 'desktop'));
  await act(async () => oldConfirm.onPress());
  expect(h.api.leave).not.toHaveBeenCalled();
  await click('sharedTask.returnToTasks');
  expect(h.router.replace).toHaveBeenCalledWith('/devices');
});
it('closes only the confirmed owned tasks and retains failures for retry', async () => {
  h.params = { sessionId: 'task', deviceId: 'host' };
  h.api.list.mockResolvedValue([owned('one'), owned('two'), { ...owned('foreign'), ownerAccountId: 'other' }]);
  await render(); await click('sharedTask.tabOwned'); await click('sharedTask.closeAll');
  expect(h.alert.mock.lastCall![3].cancelable).toBe(true);
  await act(async () => h.alert.mock.lastCall![3].onDismiss());
  expect(h.api.close).not.toHaveBeenCalled();
  expect(element.querySelector('header')?.textContent).toContain('sharedTask.ownedTitle');
  await click('sharedTask.closeAll');
  expect(h.api.close).not.toHaveBeenCalled();
  expect(h.alert.mock.lastCall![1]).toContain('Test computer');
  h.api.close.mockImplementation((id: string) => id === 'two' ? Promise.reject(new Error('offline')) : Promise.resolve());
  h.api.list.mockResolvedValue([owned('two')]);
  await act(async () => confirmation()[1].onPress!());
  expect(h.api.close.mock.calls.map(([id]) => id)).toEqual(['one', 'two']);
  expect(element.textContent).toContain('sharedTask.closeFailedToast');
  expect(element.textContent).toContain('two'); expect(element.textContent).not.toContain('one');
});
it('does not start the next batch close after the page account generation changes', async () => {
  h.params = { sessionId: 'task', deviceId: 'host' };
  h.api.list.mockResolvedValue([owned('one'), owned('two')]);
  let finishFirst!: () => void;
  h.api.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
  await render(); await click('sharedTask.tabOwned'); await click('sharedTask.closeAll');
  await act(async () => confirmation()[1].onPress!());
  expect(h.api.close.mock.calls.map(([id]) => id)).toEqual(['one']);
  setMobileAuthOwner('other'); h.generation++; await render();
  await act(async () => finishFirst());
  expect(h.api.close.mock.calls.map(([id]) => id)).toEqual(['one']);
});
it('guards current-task close and member removal behind separate confirmations', async () => {
  h.params = { sessionId: 'task', deviceId: 'host' }; h.link.invoke.mockResolvedValue({ available: true, detail });
  await render(); await click('sharedTask.removeShort');
  expect(h.link.invoke).not.toHaveBeenCalledWith('host', 'maker:shared-task', [expect.objectContaining({ action: 'remove' })]);
  await act(async () => confirmation()[1].onPress!());
  expect(h.link.invoke).toHaveBeenCalledWith('host', 'maker:shared-task', [{ action: 'remove', sharedTaskId: 'shared', memberId: 'member' }]);
  await click('sharedTask.closeCurrent');
  await act(async () => confirmation()[1].onPress!());
  expect(h.link.invoke).toHaveBeenCalledWith('host', 'maker:shared-task', [{ action: 'close', sharedTaskId: 'shared' }]);
});
it.each(['ios', 'android'] as const)('%s refreshes members after the host reconciles an already-left removal', async (platform) => {
  Platform.OS = platform;
  h.params = { sessionId: 'task', deviceId: 'host' };
  let currentDetail = { ...detail, memberLabels: [
    { memberId: 'member', displayName: 'Departing Guest' },
    { memberId: 'staying', displayName: 'Remaining Guest' },
  ] };
  h.link.invoke.mockImplementation(async (_peer, _channel, [command]) => {
    if (command.action === 'remove') {
      // SharedTaskHost verified the guest is absent while sharing stays active.
      currentDetail = { ...currentDetail, memberLabels: currentDetail.memberLabels.slice(1) };
      return { ok: true };
    }
    return { available: true, detail: currentDetail };
  });
  await render();
  await click('sharedTask.removeShort');
  await act(async () => confirmation()[1].onPress!());
  expect(h.link.invoke).toHaveBeenCalledWith('host', 'maker:shared-task', [{ action: 'remove', sharedTaskId: 'shared', memberId: 'member' }]);
  expect(element.textContent).not.toContain('Departing Guest');
  expect(element.textContent).toContain('Remaining Guest');
  expect(element.textContent).toContain('sharedTask.closeCurrent');
  expect(element.textContent).not.toContain('sharedTask.unavailable');
  expect(element.textContent).not.toContain('sharedTask.ended');
  expect(h.revoked).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled();
});
it('ignores an old poll after switching away from and back to the current task', async () => {
  h.params = { sessionId: 'task', deviceId: 'host' };
  let finishOld!: (value: unknown) => void;
  h.link.invoke.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await render();
  await click('sharedTask.tabOwned');
  h.link.invoke.mockResolvedValue({ available: true, detail });
  await click('sharedTask.tabCurrent');
  expect(element.textContent).toContain('Design review');
  await act(async () => finishOld({ available: true, detail: null }));
  expect(element.textContent).toContain('Design review');
  expect(element.textContent).toContain('sharedTask.closeCurrent');
});

it('keeps manual admission available on empty management and accepts a legacy code with the account nickname', async () => {
  h.params = { mode: 'manage' };
  h.link.invoke.mockResolvedValue({ id: 'task' });
  await render();
  expect(element.querySelector('textarea')).toBeNull();
  expect(element.textContent).toContain('sharedTask.ownedEmptyTitle');
  await click('sharedTask.join');
  await fill('sharedTask.invitation', 'A'.repeat(43));
  await click('sharedTask.join');
  expect(h.api.join).toHaveBeenCalledExactlyOnceWith('A'.repeat(43), 'Account Guest');
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
});

it('preserves the joined management tab on canceled admission and canceled leave', async () => {
  h.params = { mode: 'manage' };
  h.api.list.mockResolvedValue([{ ...owned('guest-task'), ownerAccountId: 'someone' }, owned('My task')]);
  await render(); await click('sharedTask.joinedTab');
  await click('sharedTask.join'); await click('sharedTask.cancelOperation');
  expect(element.textContent).toContain('guest-task');
  expect(element.textContent).not.toContain('My task');
  await click('sharedTask.leaveShort');
  await act(async () => confirmation()[0].onPress());
  expect(h.api.leave).not.toHaveBeenCalled();
  expect(element.textContent).toContain('guest-task');
  await click('sharedTask.leaveShort');
  h.api.list.mockResolvedValue([owned('My task')]);
  await act(async () => confirmation()[1].onPress());
  expect(h.api.leave).toHaveBeenCalledWith('guest-task');
  expect(element.textContent).toContain('sharedTask.joinedEmptyTitle');
  expect(h.router.replace).not.toHaveBeenCalled();
});

it('shows a retry on failed discovery instead of an empty management list', async () => {
  h.params = { mode: 'manage' }; h.api.list.mockRejectedValue(new Error('offline'));
  await render();
  expect(element.textContent).not.toContain('sharedTask.ownedEmptyTitle');
  h.api.list.mockResolvedValue([owned('My task')]);
  await click('sharedTask.retryAction');
  expect(element.textContent).toContain('My task');
});

it('opens owner management through the physical host and preserves the settings page beneath it', async () => {
  h.params = { mode: 'manage' }; h.api.list.mockResolvedValue([owned('My task')]);
  await render(); await click('sharedTask.manage');
  expect(h.link.openLink).toHaveBeenCalledWith('host');
  expect(h.router.push).toHaveBeenCalledWith({ pathname: '/shared-session', params: { sessionId: 'task', deviceId: 'host', expectedOwnedSharedTaskId: 'My-task', mode: 'detail' } });
  expect(h.router.replace).not.toHaveBeenCalled();
});

it.each([
  { ...detail, sharedTaskId: 'replacement', title: 'Replacement sharing' },
  { ...detail, sessionId: 'another-task' },
  { ...detail, status: 'closed' },
  null,
])('rejects an expired owner management target instead of managing its replacement: %j', async replacement => {
  vi.useFakeTimers();
  h.params = { sessionId: 'task', deviceId: 'host', mode: 'detail', expectedOwnedSharedTaskId: 'shared' };
  h.link.invoke.mockResolvedValue({ available: true, detail });
  await render();
  expect(element.textContent).toContain('sharedTask.closeCurrent');
  h.link.invoke.mockResolvedValue({ available: true, detail: replacement });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(element.textContent).toContain('sharedTask.unavailable');
  expect(element.textContent).not.toContain('Replacement sharing');
  for (const action of ['closeCurrent', 'removeShort', 'copyInvitation', 'open']) {
    expect(element.textContent).not.toContain('sharedTask.' + action);
  }
  expect(h.revoked).not.toHaveBeenCalled();
  expect(h.link.closeLink).not.toHaveBeenCalled();
});
