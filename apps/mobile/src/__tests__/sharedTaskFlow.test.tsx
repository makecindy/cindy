// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { ApiError } from '@/api/client';
import { Platform } from 'react-native';
import SharedSessionScreen from '../../app/shared-session';

const h = vi.hoisted(() => ({
  params: {} as { sessionId?: string; deviceId?: string; sharedTaskId?: string }, generation: 1,
  router: { replace: vi.fn() }, alert: vi.fn(), revoked: vi.fn(),
  link: { sharedTaskAvailable: true, invoke: vi.fn(), openLink: vi.fn(), closeLink: vi.fn(), readDeviceList: vi.fn() },
  api: { list: vi.fn(), get: vi.fn(), join: vi.fn(), leave: vi.fn(), close: vi.fn() },
  store: { getSessions: () => [], removeDevice: vi.fn(), setDeviceSessions: vi.fn(), upsertDeviceSession: vi.fn() },
  t: (key: string, options?: { title?: string }) => options?.title ? key + ':' + options.title : key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('lucide-react-native', () => ({ Check: () => null, Laptop: () => null, Link: () => null, Users: () => null, Clock: () => null, FileText: () => null, Square: () => null, X: () => null }));
vi.mock('@/device-link/accessRevoked', () => ({ markDeviceAccessRevoked: h.revoked }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Stack: { Screen: () => null }, useLocalSearchParams: () => h.params, useRouter: () => h.router, useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, accountGeneration: h.generation }) }));
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
  MainWindowActionButton: ({ action }: { action: { label: string; disabled?: boolean; busy?: boolean; onPress(): void } }) => createElement('button', { disabled: action.disabled || action.busy, onClick: action.onPress }, action.label),
  MainWindowRowButton: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress(): void; accessibilityLabel?: string }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  MainWindowOptionButton: ({ label, onPress }: { label: string; onPress(): void }) => createElement('button', { onClick: onPress }, label),
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: ({ title, onBack }: { title: string; onBack(): void }) => createElement('header', null, title, createElement('button', { onClick: onBack }, 'back')), simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
let element: HTMLDivElement;
let root: Root;
const detail = { sharedTaskId: 'shared', sessionId: 'task', hostDeviceId: 'desktop', status: 'active', title: 'Design review', memberLabels: [{ memberId: 'member', displayName: 'Guest' }] };
const owned = (id: string) => ({ sharedTaskId: id, sessionId: 'task', title: id, ownerAccountId: 'owner', hostDeviceId: 'host' });
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
  vi.useFakeTimers(); vi.resetAllMocks(); h.params = {}; h.generation = 1;
  Platform.OS = 'android';
  setMobileAuthOwner('owner'); h.link.sharedTaskAvailable = true;
  h.api.list.mockResolvedValue([]); h.api.get.mockResolvedValue(detail);
  h.api.join.mockResolvedValue({ sharedTaskId: 'shared' });
  h.link.invoke.mockResolvedValue({ available: true, detail: null });
  h.link.readDeviceList.mockResolvedValue({ devices: [{ deviceId: 'host', name: 'Test computer' }] });
  element = document.createElement('div'); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
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
    await fill('sharedTask.invitation', 'a'.repeat(43)); await fill('sharedTask.joinNickname', 'Guest');
    await click('sharedTask.join');
    expect(element.textContent).toContain(key);
    expect(element.querySelector('textarea')?.value).toBe('a'.repeat(43));
    expect(h.link.openLink).not.toHaveBeenCalled();
  });
it('uses a multiline invitation and stops at the joined screen before opening the task', async () => {
  await render();
  expect(element.querySelector('textarea')).not.toBeNull();
  expect(element.querySelector('input')?.maxLength).toBe(32);
  await fill('sharedTask.invitation', 'a'.repeat(43)); await fill('sharedTask.joinNickname', ' Guest ');
  await click('sharedTask.join');
  expect(h.api.join).toHaveBeenCalledWith('a'.repeat(43), 'Guest');
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
  await click('sharedTask.rejoin');
  expect(h.router.replace).toHaveBeenCalledWith('/shared-session');
  h.params = {}; await render();
  expect(element.querySelector('textarea')).not.toBeNull();
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
