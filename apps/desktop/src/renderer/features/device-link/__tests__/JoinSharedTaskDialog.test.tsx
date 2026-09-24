// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { JoinSharedTaskDialog } from '../JoinSharedTaskDialog';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';

const state = vi.hoisted(() => ({ account: vi.fn(), host: vi.fn(), openLink: vi.fn(), closeLink: vi.fn(), invoke: vi.fn(), setSessions: vi.fn(), removeDevice: vi.fn(), getSessions: vi.fn(), bind: vi.fn(), reset: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { title?: string }) => key + (args?.title ? ':' + args.title : '') }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'guest', isAuthenticated: true }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../remoteProjectsStore', () => ({ remoteProjectsStore: { getDeviceName: () => undefined, setDeviceSessions: state.setSessions, removeDevice: state.removeDevice, getMergedRemoteSessions: state.getSessions }, isRemoteDeviceMarkedDisconnected: () => false }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ bindSharedTaskPushOwner: state.bind, resetRemoteDataOwnerPushFence: state.reset }));
const owned = [
  { sharedTaskId: 'own-1', sessionId: 'local-task', ownerAccountId: 'guest', hostDeviceId: 'pc', revision: 1, title: 'First owned task', local: true },
  { sharedTaskId: 'own-2', sessionId: 'other-task', ownerAccountId: 'guest', hostDeviceId: 'other-pc', revision: 1, title: 'Other computer task', local: false },
];
const joinedTask = { sharedTaskId: 'joined-1', sessionId: 'remote-task', hostDeviceId: 'host-pc', ownerAccountId: 'host', title: 'Joined project', revision: 1 };
let ownedItems = [...owned];
let joinedItems = [joinedTask];
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('guest'); ownedItems = [...owned]; joinedItems = [joinedTask];
  state.account.mockImplementation(async ({ action, sharedTaskId }) => {
    if (action === 'owned') return ownedItems;
    if (action === 'list') return joinedItems;
    if (action === 'join') return { sharedTaskId: joinedTask.sharedTaskId, memberId: 'member-1', status: 'joined' };
    if (action === 'get') return { ...joinedTask, status: 'active' };
    if (action === 'leave') { joinedItems = joinedItems.filter(item => item.sharedTaskId !== sharedTaskId); return {}; }
    if (action === 'close') { ownedItems = ownedItems.filter(item => item.sharedTaskId !== sharedTaskId); return { closed: [sharedTaskId], failed: [] }; }
  });
  state.getSessions.mockReturnValue([]);
  state.invoke.mockImplementation(async (_device, channel, [command]) => {
    if (channel === 'maker:shared-task' && command.action === 'close') {
      ownedItems = ownedItems.filter(item => item.sharedTaskId !== command.sharedTaskId);
      return { ok: true };
    }
    return { id: joinedTask.sessionId };
  });
  state.closeLink.mockResolvedValue(undefined); state.openLink.mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { sharedTask: { account: state.account, host: state.host }, deviceLink: { openLink: state.openLink, closeLink: state.closeLink, invoke: state.invoke } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function open(onOpenChange = vi.fn()) {
  render(<MemoryRouter><JoinSharedTaskDialog open onOpenChange={onOpenChange} /></MemoryRouter>);
  return onOpenChange;
}
function tab(kind: 'join' | 'joined' | 'owned') {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp('sharedTask.' + ({ join: 'joinTab', joined: 'joinedTab', owned: 'tabOwned' }[kind])) }));
}
function click(key: string) { fireEvent.click(screen.getByRole('button', { name: 'sharedTask.' + key })); }
function visibleText(text: string) { return screen.queryAllByText(text).filter(el => !el.closest('[hidden]')); }
function fill(submit = true) {
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  fireEvent.change(screen.getByLabelText('sharedTask.joinNickname'), { target: { value: 'Guest' } });
  if (submit) click('join');
}
async function closeAll() { tab('owned'); await screen.findByRole('button', { name: 'sharedTask.closeAll' }); click('closeAll'); }

it('starts with three tabs and a compact join form without host actions', async () => {
  open(); await act(async () => {});
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getByLabelText('sharedTask.invitation').tagName).toBe('INPUT');
  expect(screen.getByLabelText('sharedTask.joinNickname').getAttribute('maxlength')).toBe('32');
  expect(screen.queryByRole('button', { name: 'sharedTask.closeAll' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText('sharedTask.invitation'));
});
it('validates each field and focuses the nickname when the code is valid', () => {
  open(); click('join');
  expect(screen.getByText('sharedTask.invalidInvitation')).toBeTruthy();
  expect(screen.getByText('sharedTask.missingNickname')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('sharedTask.invitation'));
  fireEvent.change(screen.getByLabelText('sharedTask.invitation'), { target: { value: 'A'.repeat(43) } });
  click('join');
  expect(screen.queryByText('sharedTask.invalidInvitation')).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText('sharedTask.joinNickname'));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'join' }));
});
it.each([['NOT_FOUND', 'sharedTask.invitationUnavailable'], ['PERMISSION_DENIED', 'sharedTask.invitationRenew']])('explains rejected %s invitations without losing input', async (code, key) => {
  state.account.mockImplementation(async ({ action }) => { if (action === 'join') throw new Error('[' + code + '] rejected'); return []; });
  open(); fill(); await waitFor(() => expect(toast.error).toHaveBeenCalledWith(key));
  expect((screen.getByLabelText('sharedTask.invitation') as HTMLInputElement).value).toBe('A'.repeat(43));
  expect(state.openLink).not.toHaveBeenCalled();
});
it('preserves the form across all tabs and supports arrow-key tab navigation', async () => {
  open(); fill(false); tab('joined'); await screen.findByRole('button', { name: joinedTask.title });
  expect(screen.getByRole('tab', { name: /sharedTask.joinedTab/ }).textContent).toContain('1');
  fireEvent.keyDown(screen.getByRole('tab', { name: /sharedTask.joinedTab/ }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: /sharedTask.tabOwned/ }).getAttribute('aria-selected')).toBe('true');
  tab('join'); expect((screen.getByLabelText('sharedTask.invitation') as HTMLInputElement).value).toBe('A'.repeat(43));
  expect((screen.getByLabelText('sharedTask.joinNickname') as HTMLInputElement).value).toBe('Guest');
});
it.each(['closeAllKeep', 'cancelOperation'])('cancels in the same window through %s and preserves the form', async key => {
  open(); fill(false); await closeAll();
  expect(screen.getAllByRole('dialog')).toHaveLength(1); expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'sharedTask.closeAllKeep' }));
  click(key); expect(screen.getByRole('button', { name: 'sharedTask.closeAll' })).toBeTruthy();
  tab('join'); expect((screen.getByLabelText('sharedTask.invitation') as HTMLInputElement).value).toBe('A'.repeat(43));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});
it.each(['response', 'rejection'])('retries only failed confirmed tasks after a partial %s', async failure => {
  const original = state.invoke.getMockImplementation()!;
  let secondAttempt = false;
  state.invoke.mockImplementation(async (...args) => {
    const command = args[2][0];
    if (command.action !== 'close' || command.sharedTaskId !== 'own-2' || secondAttempt) return original(...args);
    secondAttempt = true;
    if (failure === 'rejection') throw new Error('offline');
    return { ok: false };
  });
  open(); await closeAll(); click('closeAllAction');
  await waitFor(() => expect(visibleText(owned[0].title)).toHaveLength(0));
  expect(visibleText(owned[1].title)).toHaveLength(1);
  click('closeAllAction'); await screen.findByText('sharedTask.ownedEmptyTitle');
  expect(state.account.mock.calls.map(([c]) => c).filter(c => c.action === 'close')).toEqual([
    { action: 'close', sharedTaskId: 'own-1' },
  ]);
  expect(state.invoke.mock.calls).toEqual([
    ['other-pc', 'maker:shared-task', [{ action: 'close', sharedTaskId: 'own-2' }]],
    ['other-pc', 'maker:shared-task', [{ action: 'close', sharedTaskId: 'own-2' }]],
  ]);
});
it.each(['account', 'unmount'])('stops the batch after %s invalidation', async invalidation => {
  let finish!: (value: unknown) => void;
  const original = state.account.getMockImplementation()!;
  state.account.mockImplementation(command => command.action === 'close' ? new Promise(resolve => { finish = resolve; }) : original(command));
  open(); await closeAll(); click('closeAllAction');
  await act(async () => { if (invalidation === 'account') setDataOwnerGeneration('other'); else cleanup(); finish({ closed: ['own-1'], failed: [] }); });
  expect(state.account).not.toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'own-2' });
  expect(state.openLink).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});
it('keeps the confirmed batch even when an earlier list response arrives late', async () => {
  let finish!: (value: unknown) => void; let reads = 0;
  const original = state.account.getMockImplementation()!;
  state.account.mockImplementation(command => command.action === 'owned' && ++reads === 2 ? new Promise(resolve => { finish = resolve; }) : original(command));
  open(); await act(async () => {}); await closeAll();
  await act(async () => finish([{ ...owned[0], sharedTaskId: 'new-share', title: 'New Task' }]));
  expect(visibleText('New Task')).toHaveLength(0);
  click('closeAllAction'); await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(state.account).not.toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'new-share' });
});
it('shows join success before opening the existing remote task', async () => {
  const close = open(); fill(); await screen.findByText('sharedTask.joinedTitle:' + joinedTask.title);
  expect(state.openLink).not.toHaveBeenCalled(); expect(screen.queryByLabelText('sharedTask.invitation')).toBeNull();
  click('enterTask'); await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(state.invoke).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId), 'local-db:sessions:get', [joinedTask.sessionId]);
});
it('provides joined management from the success screen', async () => {
  open(); fill(); await screen.findByText('sharedTask.joinedTitle:' + joinedTask.title); click('viewJoined');
  await screen.findByRole('button', { name: joinedTask.title }); expect(screen.getByRole('button', { name: 'sharedTask.leaveShort' })).toBeTruthy();
});
it.each(['owned', 'joined'] as const)('shows retry rather than a false empty %s list', async kind => {
  const original = state.account.getMockImplementation()!;
  let fail = true;
  state.account.mockImplementation(command => { if (command.action === (kind === 'owned' ? 'owned' : 'list') && fail) return Promise.reject(new Error('offline')); return original(command); });
  open(); tab(kind); await screen.findByText(kind === 'owned' ? 'sharedTask.ownedLoadFailed' : 'sharedTask.joinedLoadFailed');
  expect(screen.queryByText(kind === 'owned' ? 'sharedTask.ownedEmptyTitle' : 'sharedTask.joinedEmptyTitle')).toBeNull();
  fail = false; click('retryAction'); await waitFor(() => expect(screen.queryByText(kind === 'owned' ? 'sharedTask.ownedLoadFailed' : 'sharedTask.joinedLoadFailed')).toBeNull());
});
it.each([false, true])('opens a joined task by its title, reusing a mirror when available (%s)', async mirrored => {
  if (mirrored) state.getSessions.mockReturnValue([{ id: joinedTask.sessionId, deviceLinkDeviceId: sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId) }]);
  const close = open(); tab('joined'); fireEvent.click(await screen.findByRole('button', { name: joinedTask.title }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  if (mirrored) { expect(state.openLink).not.toHaveBeenCalled(); expect(state.setSessions).not.toHaveBeenCalled(); }
  else expect(state.openLink).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId));
});
it('cancels leaving without changing membership, then cleans up the confirmed peer', async () => {
  open(); tab('joined'); await screen.findByRole('button', { name: 'sharedTask.leaveShort' }); click('leaveShort');
  expect(screen.getAllByRole('dialog')).toHaveLength(1); click('leaveKeep');
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'leave' }));
  click('leaveShort'); click('leaveShort'); await screen.findByText('sharedTask.joinedEmptyTitle');
  expect(state.removeDevice).toHaveBeenCalledWith(sharedTaskHostPeer(joinedTask.sharedTaskId, joinedTask.hostDeviceId));
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
});
it('keeps a failed leave confirmation available for retry', async () => {
  const original = state.account.getMockImplementation()!;
  state.account.mockImplementation(command => command.action === 'leave' ? Promise.reject(new Error('offline')) : original(command));
  open(); tab('joined'); await screen.findByRole('button', { name: 'sharedTask.leaveShort' }); click('leaveShort'); click('leaveShort');
  await waitFor(() => expect(toast.error).toHaveBeenCalled()); expect(screen.getByRole('dialog', { name: 'sharedTask.leaveTitle' })).toBeTruthy();
  expect(state.removeDevice).not.toHaveBeenCalled(); click('leaveKeep'); expect(screen.getByRole('button', { name: joinedTask.title })).toBeTruthy();
});
it('ignores discovery from the previous account', async () => {
  let finish!: (value: unknown) => void;
  const original = state.account.getMockImplementation()!;
  state.account.mockImplementation(command => command.action === 'list' ? new Promise(resolve => { finish = resolve; }) : original(command));
  open(); tab('joined'); await act(async () => { setDataOwnerGeneration('other'); finish([joinedTask]); });
  expect(screen.queryByRole('button', { name: joinedTask.title })).toBeNull();
});
it('does not clean up a new account after a late leave response', async () => {
  let finish!: (value: unknown) => void; const original = state.account.getMockImplementation()!;
  state.account.mockImplementation(command => command.action === 'leave' ? new Promise(resolve => { finish = resolve; }) : original(command));
  open(); tab('joined'); await screen.findByRole('button', { name: 'sharedTask.leaveShort' }); click('leaveShort'); click('leaveShort');
  await act(async () => { setDataOwnerGeneration('other'); finish({}); });
  expect(state.removeDevice).not.toHaveBeenCalled(); expect(state.closeLink).not.toHaveBeenCalled();
});
