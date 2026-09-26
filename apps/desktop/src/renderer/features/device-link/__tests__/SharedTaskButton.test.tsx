// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer, SHARED_TASK_HOST_CHANNEL, type SharedTaskDetail } from '@cindy/device-link';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SharedTaskButton } from '../SharedTaskButton';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
const state = vi.hoisted(() => ({ invoke: vi.fn(), openLink: vi.fn(), host: vi.fn(), account: vi.fn(), closeLink: vi.fn(), removeDevice: vi.fn(), resetFence: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner', isAuthenticated: true }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ resetRemoteDataOwnerPushFence: state.resetFence, bindSharedTaskPushOwner: vi.fn() }));
vi.mock('../remoteProjectsStore', () => ({ remoteProjectsStore: { getDeviceName: () => undefined, removeDevice: state.removeDevice }, isRemoteDeviceMarkedDisconnected: () => false }));
const ownerSession = { id: 'session-1', title: 'Task A' } as Session;
const detail = {
  sharedTaskId: 'st1', sessionId: 'session-1', ownerAccountId: 'owner', hostDeviceId: 'device-a',
  revision: 1, status: 'active', guests: [], memberLabels: [], title: 'Task A',
} as unknown as SharedTaskDetail;
const memberDetail: SharedTaskDetail = { ...detail,
  guests: [{ memberId: 'guest-1', accountId: 'guest-account', deviceIds: [], version: 1 }],
  memberLabels: [{ memberId: 'guest-1', displayName: 'Guest Name', joinedAt: 1 }],
};
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('owner');
  state.host.mockResolvedValue({ available: true, detail });
  state.openLink.mockResolvedValue(undefined); state.closeLink.mockResolvedValue(undefined);
  state.account.mockImplementation(async ({ action, sharedTaskId }) => {
    if (action === 'owned') return [{ ...detail, local: true }];
    if (action === 'get') return detail;
    if (action === 'close') return { closed: [sharedTaskId], failed: [] };
    return [];
  });
  Object.assign(window, { electronAPI: { deviceLink: { invoke: state.invoke, openLink: state.openLink, closeLink: state.closeLink }, sharedTask: { host: state.host, account: state.account } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function click(key: string) { fireEvent.click(screen.getByRole('button', { name: 'sharedTask.' + key })); }
async function openWindow(session = ownerSession) {
  render(<MemoryRouter><SharedTaskButton session={session} /></MemoryRouter>);
  click('title'); await act(async () => {});
}

it('opens from a task menu and restores focus to its trigger on dismissal', async () => {
  function Harness() {
    const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null);
    return <><DropdownMenu><DropdownMenuTrigger ref={trigger}>More</DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={event => { if (open) event.preventDefault(); }}><DropdownMenuItem onSelect={() => setOpen(true)}>Share</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>{open && <SharedTaskButton session={ownerSession} dialogControl={{ onDismiss: () => setOpen(false), returnFocus: () => trigger.current?.focus() }} />}</>;
  }
  render(<MemoryRouter><Harness /></MemoryRouter>);
  const more = screen.getByRole('button', { name: 'More' }); fireEvent.keyDown(more, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }));
  await screen.findByRole('dialog'); expect(screen.queryByRole('menu')).toBeNull();
  click('dismiss'); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
});
it.each([['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'sharedTask.upgrade'], ['DEVICE_LINK_TIMEOUT', 'sharedTask.requestTimedOut']])('explains %s without offering to enable sharing', async (code, key) => {
  state.host.mockRejectedValue(new Error('[' + code + '] rejected'));
  await openWindow(); await screen.findByText(key); expect(screen.queryByRole('button', { name: 'sharedTask.open' })).toBeNull();
});
it('retries a disconnected host through the existing transport', async () => {
  state.host.mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] disconnected'));
  await openWindow(); await screen.findByText('sharedTask.connectionFailed'); click('retryAction');
  await screen.findByRole('button', { name: 'sharedTask.invite' });
});
it('starts an unshared task and loads its members', async () => {
  let enabled = false;
  state.host.mockImplementation(async command => { if (command.action === 'open') enabled = true; return { available: true, detail: enabled ? detail : null }; });
  await openWindow(); click('open'); await screen.findByRole('button', { name: 'sharedTask.invite' });
  expect(state.host).toHaveBeenCalledWith({ action: 'open', sessionId: ownerSession.id });
});
it('distinguishes a clipboard failure from a request failure and allows retry', async () => {
  const copy = vi.fn().mockRejectedValue(new DOMException('Not focused', 'NotAllowedError'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  state.host.mockImplementation(async c => c.action === 'invite' ? { invitation: 'test-invitation' } : { available: true, detail });
  await openWindow(); click('invite'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sharedTask.invitationCopyFailed'));
  expect(toast.success).not.toHaveBeenCalled(); copy.mockResolvedValue(undefined); click('invite');
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('sharedTask.invitationCopied'));
});
it('does not copy when generating an invitation fails', async () => {
  const copy = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  state.host.mockImplementation(async c => { if (c.action === 'invite') throw new Error('[DEVICE_LINK_TIMEOUT] timeout'); return { available: true, detail }; });
  await openWindow(); click('invite'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sharedTask.requestTimedOut'));
  expect(copy).not.toHaveBeenCalled();
});
it.each([false, true])('removes a captured member and refreshes the member list (remote=%s)', async remote => {
  let current = memberDetail;
  const command = vi.fn(async (c: { action: string }) => { if (c.action === 'remove') current = detail; return { available: true, detail: current }; });
  state.host.mockImplementation(command); state.invoke.mockImplementation((_device, _channel, [c]) => command(c));
  await openWindow(remote ? { ...ownerSession, deviceLinkDeviceId: 'owner-pc' } : ownerSession);
  click('removeShort'); expect(screen.getAllByRole('dialog')).toHaveLength(1); expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'sharedTask.removeKeep' }));
  click('remove'); await waitFor(() => expect(screen.queryByText('Guest Name')).toBeNull());
  expect(command).toHaveBeenCalledWith({ action: 'remove', sharedTaskId: detail.sharedTaskId, memberId: 'guest-1' });
  expect(screen.getByRole('button', { name: 'sharedTask.cancelSharing' })).toBeTruthy();
});
it('cancels a named removal using Escape without leaving member management', async () => {
  state.host.mockResolvedValue({ available: true, detail: memberDetail }); await openWindow(); click('removeShort');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); await screen.findByRole('button', { name: 'sharedTask.removeShort' });
  expect(state.host.mock.calls.every(([c]) => c.action === 'state')).toBe(true);
  expect(screen.getByText('Guest Name')).toBeTruthy();
});
it('does not change a removal target after a newer task state arrives', async () => {
  vi.useFakeTimers(); let current = memberDetail;
  state.host.mockImplementation(async () => ({ available: true, detail: current }));
  await openWindow(); click('removeShort'); current = { ...detail, sharedTaskId: 'replacement' };
  await act(async () => vi.advanceTimersByTimeAsync(5000)); click('remove'); await act(async () => {});
  expect(state.host).toHaveBeenCalledWith({ action: 'remove', sharedTaskId: 'st1', memberId: 'guest-1' });
  expect(state.host).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'remove', sharedTaskId: 'replacement' }));
});
it('closes only the task captured by the confirmation', async () => {
  vi.useFakeTimers(); let current = detail;
  state.host.mockImplementation(async () => ({ available: true, detail: current }));
  await openWindow(); click('cancelSharing'); current = { ...detail, sharedTaskId: 'replacement' };
  await act(async () => vi.advanceTimersByTimeAsync(5000)); click('cancelSharing'); await act(async () => {});
  expect(state.account).toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'st1' });
  expect(state.account).not.toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'replacement' });
});
it('cancels a remote detail through its owning host before reporting success', async () => {
  let finish!: (value: unknown) => void;
  state.invoke.mockImplementation(async (_device, _channel, [command]) => command.action === 'close'
    ? new Promise(resolve => { finish = resolve; })
    : { available: true, detail: { ...detail, hostDeviceId: 'other-pc' } });
  await openWindow({ ...ownerSession, deviceLinkDeviceId: 'other-pc' });
  click('cancelSharing'); click('cancelSharing');
  await waitFor(() => expect(state.invoke).toHaveBeenCalledWith('other-pc', SHARED_TASK_HOST_CHANNEL, [{ action: 'close', sharedTaskId: detail.sharedTaskId }]));
  expect(toast.success).not.toHaveBeenCalled();
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
  await act(async () => finish({ ok: true }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('sharedTask.closedToast'));
});
it.each(['invite', 'remove'])('ignores late %s responses after account change', async operation => {
  let finish!: (value: unknown) => void;
  const copy = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  state.host.mockImplementation(c => c.action === operation ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ available: true, detail: memberDetail }));
  await openWindow(); if (operation === 'remove') click('removeShort'); click(operation);
  await act(async () => { setDataOwnerGeneration('other'); finish({ invitation: 'old-secret' }); });
  expect(copy).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
  expect(state.host.mock.calls.filter(([c]) => c.action === operation)).toHaveLength(1);
});
it('ignores a late unsupported host response after account change', async () => {
  let reject!: (error: unknown) => void;
  state.host.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  await openWindow(); await act(async () => { setDataOwnerGeneration('other'); reject(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported')); });
  expect(screen.queryByText('sharedTask.upgrade')).toBeNull();
});
it.each([false, true])('manages any owned list item using its own session and device (remote=%s)', async remote => {
  const other = { ...detail, sessionId: 'other-session', sharedTaskId: 'other-share', hostDeviceId: 'other-pc', title: 'Other Task', local: !remote };
  state.account.mockImplementation(async c => c.action === 'owned' ? [other] : []);
  state.host.mockImplementation(async c => ({ available: true, detail: c.sessionId === 'other-session' ? other : detail }));
  state.invoke.mockResolvedValue({ available: true, detail: other });
  await openWindow(); click('back'); await screen.findByRole('button', { name: 'sharedTask.manage' }); click('manage');
  await screen.findByRole('button', { name: 'sharedTask.invite' });
  if (remote) {
    expect(state.openLink).toHaveBeenCalledWith('other-pc');
    expect(state.invoke).toHaveBeenCalledWith('other-pc', SHARED_TASK_HOST_CHANNEL, [{ action: 'state', sessionId: 'other-session' }]);
  } else expect(state.host).toHaveBeenCalledWith({ action: 'state', sessionId: 'other-session' });
  expect(screen.getByRole('heading', { name: 'Other Task' })).toBeTruthy();
});
it('refuses to manage a reopened replacement of an expired list item', async () => {
  state.host.mockResolvedValue({ available: true, detail: { ...detail, sharedTaskId: 'replacement' } });
  await openWindow(); click('back'); await screen.findByRole('button', { name: 'sharedTask.manage' }); click('manage');
  await screen.findByText('sharedTask.unavailable'); expect(screen.queryByRole('button', { name: 'sharedTask.invite' })).toBeNull();
});
it('does not invoke another computer after backing out of its pending connection', async () => {
  let finish!: () => void; state.openLink.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  state.account.mockImplementation(async c => c.action === 'owned' ? [{ ...detail, local: false }] : []);
  await openWindow(); click('back'); await screen.findByRole('button', { name: 'sharedTask.manage' }); click('manage'); click('back');
  await act(async () => finish()); expect(state.invoke).not.toHaveBeenCalled();
});
it('lets a slow detail request finish instead of invalidating it on each poll', async () => {
  vi.useFakeTimers(); let finish!: (value: unknown) => void;
  state.host.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openWindow(); await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(state.host).toHaveBeenCalledTimes(1);
  await act(async () => finish({ available: true, detail }));
  expect(screen.getByRole('button', { name: 'sharedTask.invite' })).toBeTruthy();
});
it('shows an ended state without asserting why a guest lost access', async () => {
  state.account.mockImplementation(async c => c.action === 'get' ? { ...detail, status: 'closed' } : []);
  await openWindow({ ...ownerSession, deviceLinkDeviceId: sharedTaskHostPeer('st1', 'desktop') });
  await screen.findByText('sharedTask.accessEndedBody'); expect(screen.queryByRole('button', { name: 'sharedTask.leaveShort' })).toBeNull();
});
it('keeps an existing guest entry focused on leaving, without another enter button', async () => {
  const peer = sharedTaskHostPeer('st1', 'device-a'); await openWindow({ ...ownerSession, deviceLinkDeviceId: peer });
  expect(screen.queryByRole('button', { name: 'sharedTask.enterTask' })).toBeNull(); click('leaveShort'); click('leaveShort');
  await waitFor(() => expect(state.removeDevice).toHaveBeenCalledWith(peer));
  expect(state.resetFence).toHaveBeenCalledWith(peer); expect(state.closeLink).toHaveBeenCalledWith(peer);
});
