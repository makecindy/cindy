import { sharedTaskHostPeer } from '@cindy/device-link';
// @vitest-environment jsdom
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JoinSharedTaskDialog } from '../JoinSharedTaskDialog';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
const state = vi.hoisted(() => ({ account: vi.fn(), openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn(), setSessions: vi.fn(), removeDevice: vi.fn(), getSessions: vi.fn(), bind: vi.fn(), reset: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { title?: string }) => key + (args?.title ? ':' + args.title : '') }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'guest', isAuthenticated: true }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../remoteProjectsStore', () => ({ remoteProjectsStore: { setDeviceSessions: state.setSessions, removeDevice: state.removeDevice, getMergedRemoteSessions: state.getSessions }, isRemoteDeviceMarkedDisconnected: () => false }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ bindSharedTaskPushOwner: state.bind, resetRemoteDataOwnerPushFence: state.reset }));
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('guest');
  state.account.mockImplementation(async ({ action }) => action === 'owned' || action === 'list' ? [] : action === 'join'
    ? { sharedTaskId: 'share-1', memberId: 'member-1', status: 'joined' }
    : { sharedTaskId: 'share-1', sessionId: 'task-1', ownerAccountId: 'host', hostDeviceId: 'desktop', title: 'Test Task', status: 'active' });
  state.invoke.mockResolvedValue({ id: 'task-1' });
  state.getSessions.mockReturnValue([]);
  state.closeLink.mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { sharedTask: { account: state.account }, deviceLink: { openLink: state.openLink, closeLink: state.closeLink, invoke: state.invoke } } });
});
afterEach(cleanup);
function open(onOpenChange = vi.fn()) {
  render(createElement(MemoryRouter, null, createElement(JoinSharedTaskDialog, { open: true, onOpenChange })));
  return onOpenChange;
}
function fill() {
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('sharedTask.joinNickname'), { target: { value: 'Guest' } });
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.join' }));
}
it.each([['NOT_FOUND', 'sharedTask.invitationUnavailable'], ['PERMISSION_DENIED', 'sharedTask.invitationRenew']])(
  'explains a rejected %s invitation while preserving the form', async (code, key) => {
    state.account.mockImplementation(async ({ action }) => {
      if (action === 'join') throw new Error('[' + code + '] rejected');
      return [];
    });
    open(); fill();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(key));
    expect((screen.getByLabelText('sharedTask.invitation') as HTMLTextAreaElement).value).toBe('A'.repeat(43));
    expect(state.openLink).not.toHaveBeenCalled();
  });
it('uses a multiline invitation form and focuses invalid input without sending', async () => {
  open();
  await act(async () => {});
  expect(screen.getByLabelText('sharedTask.invitation').tagName).toBe('TEXTAREA');
  expect(screen.getByLabelText('sharedTask.joinNickname').getAttribute('maxlength')).toBe('32');
  expect(screen.getByText('sharedTask.joinNotice')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.join' }));
  expect(document.activeElement).toBe(screen.getByLabelText('sharedTask.invitation'));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'join' }));
});

const owned = [
  { sharedTaskId: 'own-1', title: 'First owned task', local: true },
  { sharedTaskId: 'own-2', title: 'Other computer task', local: false },
];
it('keeps the C confirmation in one dialog and preserves the invitation on cancel', async () => {
  state.account.mockResolvedValue(owned); open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'sharedTask.closeAllShort' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('sharedTask.joinNickname'), { target: { value: 'Guest' } });
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllShort' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByText('First owned task')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'sharedTask.closeAllKeep' }));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllKeep' }));
  expect((screen.getByLabelText('sharedTask.invitation') as HTMLTextAreaElement).value).toBe('A'.repeat(43));
  expect((screen.getByLabelText('sharedTask.joinNickname') as HTMLInputElement).value).toBe('Guest');
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});
it('returns to the join form from the confirmation close button and preserves the form', async () => {
  state.account.mockResolvedValue(owned); open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'sharedTask.closeAllShort' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('sharedTask.joinNickname'), { target: { value: 'Guest' } });
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllShort' }));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllCancel' }));
  expect((screen.getByLabelText('sharedTask.invitation') as HTMLTextAreaElement).value).toBe('A'.repeat(43));
  expect((screen.getByLabelText('sharedTask.joinNickname') as HTMLInputElement).value).toBe('Guest');
  expect(screen.getByRole('button', { name: 'sharedTask.closeAllShort' })).toBeTruthy();
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});

it('closes only confirmed owned tasks and retries just the failed task', async () => {
  let secondAttempt = false;
  state.account.mockImplementation(async ({ action, sharedTaskId }) => {
    if (action === 'owned') return owned;
    if (action === 'list') return [];
    if (sharedTaskId === 'own-1' || secondAttempt) return { closed: [sharedTaskId], failed: [] };
    secondAttempt = true; return { closed: [], failed: [{ sharedTaskId }] };
  });
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'sharedTask.closeAllShort' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllShort' }));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllJoinAction' }));
  await waitFor(() => expect(screen.queryByText('First owned task')).toBeNull());
  expect(screen.getByText('Other computer task')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllJoinAction' }));
  await waitFor(() => expect(screen.queryByText('sharedTask.closeAllTitle')).toBeNull());
  const closes = state.account.mock.calls.map(([command]) => command).filter(command => command.action === 'close');
  expect(closes).toEqual([
    { action: 'close', sharedTaskId: 'own-1' }, { action: 'close', sharedTaskId: 'own-2' }, { action: 'close', sharedTaskId: 'own-2' },
  ]);
});

it('stops the batch after an account change and ignores its late result', async () => {
  let finish!: (value: unknown) => void;
  state.account.mockImplementation(({ action }) => action === 'owned' ? Promise.resolve(owned) : new Promise(resolve => { finish = resolve; }));
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'sharedTask.closeAllShort' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllShort' }));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.closeAllJoinAction' }));
  await act(async () => {
    setDataOwnerGeneration('another-account');
    finish({ closed: ['own-1'], failed: [] });
  });
  expect(state.account).not.toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'own-2' });
});
it('shows the joined task before entering through the existing remote link', async () => {
  const close = open(); fill();
  await screen.findByText('sharedTask.joinedTitle:Test Task');
  expect(screen.queryByLabelText('sharedTask.invitation')).toBeNull();
  expect(state.openLink).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.enterTask' }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(state.invoke).toHaveBeenCalledWith(sharedTaskHostPeer('share-1', 'desktop'), 'local-db:sessions:get', ['task-1']);
});
it('lets a newly joined visitor cancel leaving, then leave with confirmation', async () => {
  open(); fill(); await screen.findByText('sharedTask.joinedTitle:Test Task');
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.leave' }));
  let dialog = screen.getByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'sharedTask.leaveKeep' }));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.leave' }));
  dialog = screen.getByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'sharedTask.leave' }));
  await waitFor(() => expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: 'share-1' }));
  await screen.findByLabelText('sharedTask.invitation');
});

const joinedTask = { sharedTaskId: 'joined-1', sessionId: 'remote-task', hostDeviceId: 'host-pc', ownerAccountId: 'host', title: 'Joined project', revision: 1 };
function listJoined(items = [joinedTask]) {
  state.account.mockImplementation(async ({ action, sharedTaskId }) => {
    if (action === 'list') return items;
    if (action === 'get') return { ...joinedTask, sharedTaskId, status: 'active' };
    return [];
  });
}
function joinedTab() { fireEvent.click(screen.getByRole('button', { name: /^sharedTask.joinedTab/ })); }

it('lists joined tasks and preserves the invitation form across tabs', async () => {
  listJoined(); open();
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('sharedTask.joinNickname'), { target: { value: 'Guest' } });
  joinedTab();
  await screen.findByText(joinedTask.title);
  expect(screen.getByRole('dialog', { name: 'sharedTask.joinedSection' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^sharedTask.joinedTab/ }).textContent).toContain('1');
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.joinTab' }));
  expect((screen.getByLabelText('sharedTask.invitation') as HTMLTextAreaElement).value).toBe('A'.repeat(43));
  expect((screen.getByLabelText('sharedTask.joinNickname') as HTMLInputElement).value).toBe('Guest');
});

it('shows a retry instead of an empty list when discovery fails', async () => {
  state.account.mockImplementation(async ({ action }) => {
    if (action === 'list') throw new Error('offline');
    return [];
  });
  open(); joinedTab();
  await screen.findByText('sharedTask.joinedLoadFailed');
  expect(screen.queryByText('sharedTask.joinedEmptyTitle')).toBeNull();
  listJoined([]);
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.retryAction' }));
  await screen.findByText('sharedTask.joinedEmptyTitle');
  expect(screen.queryByText('sharedTask.joinedLoadFailed')).toBeNull();
});

it('opens a discovered task through its host and preserves existing mirrors', async () => {
  listJoined();
  state.invoke.mockResolvedValue({ id: joinedTask.sessionId });
  const close = open(); joinedTab();
  fireEvent.click(await screen.findByRole('button', { name: 'sharedTask.openTask' }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(state.openLink).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId));
  expect(state.invoke).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId), 'local-db:sessions:get', [joinedTask.sessionId]);
});

it('opens an already mirrored task without reconnecting it', async () => {
  listJoined();
  state.getSessions.mockReturnValue([{ id: joinedTask.sessionId, deviceLinkDeviceId: sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId) }]);
  const close = open(); joinedTab();
  fireEvent.click(await screen.findByRole('button', { name: 'sharedTask.openTask' }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(state.openLink).not.toHaveBeenCalled();
  expect(state.setSessions).not.toHaveBeenCalled();
});

it('cancels leaving without changing the list, then removes only the confirmed membership', async () => {
  let items = [joinedTask];
  state.account.mockImplementation(async ({ action }) => {
    if (action === 'list') return items;
    if (action === 'leave') items = [];
    return [];
  });
  open(); joinedTab();
  fireEvent.click(await screen.findByRole('button', { name: 'sharedTask.leaveShort' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'sharedTask.leaveKeep' }));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  expect(screen.getByText(joinedTask.title)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.leaveShort' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'sharedTask.leaveShort' }));
  await screen.findByText('sharedTask.joinedEmptyTitle');
  expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: joinedTask.sharedTaskId });
  expect(state.removeDevice).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});

it('keeps the confirmation and list available after a failed leave', async () => {
  state.account.mockImplementation(async ({ action }) => {
    if (action === 'list') return [joinedTask];
    if (action === 'leave') throw new Error('offline');
    return [];
  });
  open(); joinedTab();
  fireEvent.click(await screen.findByRole('button', { name: 'sharedTask.leaveShort' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'sharedTask.leaveShort' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(state.removeDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'sharedTask.leaveKeep' }));
  expect(screen.getByText(joinedTask.title)).toBeTruthy();
});

it('ignores a discovery response from the previous account', async () => {
  let finish!: (value: unknown) => void;
  state.account.mockImplementation(({ action }) => action === 'list' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]));
  open(); joinedTab();
  await act(async () => { setDataOwnerGeneration('other-account'); finish([joinedTask]); });
  expect(screen.queryByText(joinedTask.title)).toBeNull();
});

it('does not clean up the new account after an old leave response', async () => {
  let finish!: (value: unknown) => void;
  state.account.mockImplementation(({ action }) => action === 'list' ? Promise.resolve([joinedTask]) : action === 'leave'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]));
  open(); joinedTab();
  fireEvent.click(await screen.findByRole('button', { name: 'sharedTask.leaveShort' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'sharedTask.leaveShort' }));
  await act(async () => { setDataOwnerGeneration('other-account'); finish({}); });
  expect(state.removeDevice).not.toHaveBeenCalled();
  expect(state.closeLink).not.toHaveBeenCalled();
});
