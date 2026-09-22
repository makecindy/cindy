// @vitest-environment jsdom
import { createElement } from 'react';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer, type SharedTaskCloseResult, type SharedTaskDetail, type SharedTaskOwnedItem } from '@cindy/device-link';
import { SharedTaskButton } from '../SharedTaskButton';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { toast } from '@/lib/toast';
const state = vi.hoisted(() => ({ invoke: vi.fn(), host: vi.fn(), account: vi.fn(), closeLink: vi.fn(), removeDevice: vi.fn(), resetFence: vi.fn(), t: vi.fn((key: string, _options?: unknown) => key) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner' }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ resetRemoteDataOwnerPushFence: state.resetFence }));
vi.mock('../remoteProjectsStore', () => ({ remoteProjectsStore: { removeDevice: state.removeDevice } }));
let container: HTMLDivElement;
let root: Root;
const ownerSession = { id: 'session-1' } as Session;
const detail = {
  sharedTaskId: 'st1', sessionId: 'session-1', ownerAccountId: 'owner', hostDeviceId: 'device-a',
  revision: 1, status: 'active', guests: [], memberLabels: [], title: 'Task A',
} as unknown as SharedTaskDetail;
async function openWindow(session: Session) {
  await act(async () => root.render(createElement(SharedTaskButton, { session })));
  const trigger = [...container.querySelectorAll('button')][0];
  await act(async () => { fireEvent.click(trigger); });
  return document.body;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); setDataOwnerGeneration('owner');
  Object.assign(window, { electronAPI: {
    deviceLink: { invoke: state.invoke, closeLink: state.closeLink },
    sharedTask: { host: state.host, account: state.account },
  } });
  state.host.mockResolvedValue({ available: true, detail });
  state.account.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});
it('renders an upgrade instruction when an old host rejects the new channel', async () => {
  state.host.mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported'));
  const body = await openWindow(ownerSession);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.upgrade'));
  expect(body.textContent).not.toContain('sharedTask.open');
});
it('does not mislabel a timeout as an old host', async () => {
  state.host.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] timeout'));
  const body = await openWindow(ownerSession);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.requestTimedOut'));
  expect(within(body).getByRole('button', { name: 'sharedTask.retryAction' })).toBeDefined();
  expect(body.textContent).not.toContain('sharedTask.upgrade');
});
it('retries a disconnected host after showing a recoverable error', async () => {
  let calls = 0;
  state.host.mockImplementation(() => ++calls <= 2
    ? Promise.reject(new Error('[DEVICE_LINK_NOT_CONNECTED] disconnected'))
    : Promise.resolve({ available: true, detail }));
  const body = await openWindow(ownerSession);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.connectionFailed'));
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.retryAction' }));
  await waitFor(() => expect(body.textContent).toContain('sharedTask.inviteBoxTitle'));
  expect(state.host).toHaveBeenCalledTimes(3);
});
it('distinguishes a local clipboard failure from a shared-task request failure', async () => {
  const copy = vi.fn().mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  state.host.mockImplementation((command: { action: string }) => command.action === 'invite'
    ? Promise.resolve({ invitation: 'test-invitation' }) : Promise.resolve({ available: true, detail }));
  const body = await openWindow(ownerSession);
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.invite' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sharedTask.invitationCopyFailed'));
  expect(toast.error).not.toHaveBeenCalledWith('sharedTask.retry');
  expect(toast.success).not.toHaveBeenCalled();
  copy.mockResolvedValue(undefined);
  await waitFor(() => expect(within(body).getByRole('button', { name: 'sharedTask.invite' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.invite' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('sharedTask.invitationCopied'));
});

it('keeps invitation request failures distinct and does not attempt to copy', async () => {
  const copy = vi.fn();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  state.host.mockImplementation((command: { action: string }) => command.action === 'invite'
    ? Promise.reject(new Error('[DEVICE_LINK_TIMEOUT] timed out')) : Promise.resolve({ available: true, detail }));
  const body = await openWindow(ownerSession);
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.invite' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sharedTask.requestTimedOut'));
  expect(copy).not.toHaveBeenCalled();
});
it.each([false, true])('refreshes members after an already-left removal completes (remote=%s)', async (remote) => {
  let currentDetail: SharedTaskDetail = { ...detail, guests: [
    { memberId: 'left', accountId: 'guest-left', deviceIds: ['phone-a'], version: 1 },
    { memberId: 'staying', accountId: 'guest-staying', deviceIds: ['phone-b'], version: 1 },
  ], memberLabels: [
    { memberId: 'left', displayName: 'Departing Guest', joinedAt: 1 },
    { memberId: 'staying', displayName: 'Remaining Guest', joinedAt: 1 },
  ] };
  const command = vi.fn(async (input: { action: string }) => {
    if (input.action === 'remove') {
      // The host reconciled NOT_FOUND against the active task's fresh members.
      currentDetail = { ...currentDetail, revision: 2, guests: currentDetail.guests.slice(1), memberLabels: currentDetail.memberLabels.slice(1) };
      return { ok: true };
    }
    return { available: true, detail: currentDetail };
  });
  state.host.mockImplementation(command);
  state.invoke.mockImplementation((_peer, _channel, [input]) => command(input));
  const body = await openWindow(remote ? { ...ownerSession, deviceLinkDeviceId: 'owner-computer' } : ownerSession);
  await act(async () => fireEvent.click(within(body).getAllByRole('button', { name: 'sharedTask.removeShort' })[0]));
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.remove' })));
  await waitFor(() => expect(body.textContent).not.toContain('Departing Guest'));
  expect(body.textContent).toContain('Remaining Guest');
  expect(within(body).queryByRole('button', { name: 'sharedTask.remove' })).toBeNull();
  const closeCurrent = within(body).getByRole('button', { name: 'sharedTask.closeCurrent' });
  expect(closeCurrent).toBeDefined();
  expect(closeCurrent.className).toContain('w-full');
  expect(closeCurrent.parentElement?.className).toContain('justify-center');
  expect(command).toHaveBeenCalledWith({ action: 'remove', sharedTaskId: 'st1', memberId: 'left' });
  expect(toast.error).not.toHaveBeenCalled();
});
it('ignores a late unsupported response after the data owner changes', async () => {
  let reject!: (error: unknown) => void;
  state.host.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  const body = await openWindow(ownerSession);
  setDataOwnerGeneration('other');
  await act(async () => reject(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] unsupported')));
  expect(body.textContent).not.toContain('sharedTask.upgrade');
});
it('keeps the confirmed snapshot when an owned-list refresh completes before closing', async () => {
  let refresh!: (items: SharedTaskOwnedItem[]) => void;
  let reads = 0;
  state.account.mockImplementation((command: { action: string; sharedTaskId?: string }) => {
    if (command.action === 'owned') {
      if (++reads === 2) return new Promise<SharedTaskOwnedItem[]>((resolve) => { refresh = resolve; });
      return Promise.resolve([
        { sharedTaskId: 'st1', sessionId: 'session-1', ownerAccountId: 'owner', hostDeviceId: 'device-a', title: 'Task A', revision: 1, local: true },
        { sharedTaskId: 'st9', sessionId: 'session-9', ownerAccountId: 'owner', hostDeviceId: 'device-b', title: 'Task B', revision: 1, local: false },
      ]);
    }
    if (command.action === 'close') return Promise.resolve({ closed: [command.sharedTaskId], failed: [] });
    return Promise.resolve(detail);
  });
  const body = await openWindow(ownerSession);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.tabOwned'));
  await act(async () => { fireEvent.click([...body.querySelectorAll('button')].find((b) => b.textContent?.startsWith('sharedTask.tabOwned'))!); });
  await waitFor(() => expect(body.textContent).toContain('sharedTask.ownedIntro'));
  expect(body.textContent).toContain('Task A');
  expect(body.textContent).toContain('sharedTask.thisDevice');
  expect(body.textContent).toContain('Task B');
  await act(async () => { fireEvent.click([...body.querySelectorAll('button')].find((b) => b.textContent?.startsWith('sharedTask.closeAll'))!); });
  await waitFor(() => expect(body.textContent).toContain('sharedTask.closeAllTitle'));
  const confirmation = within(body).getByRole('alertdialog');
  expect(confirmation.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).toBe('sharedTask.closeAllKeep');
  expect(within(confirmation).getByText('sharedTask.closeAllBody').className).toContain('text-13');
  const closeAll = [...body.querySelectorAll('button')].find((button) => button.textContent?.startsWith('sharedTask.closeAll'))!;
  expect(closeAll.className).toContain('w-full');
  expect(closeAll.parentElement?.className).toContain('justify-center');
  expect(within(confirmation).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'sharedTask.closeAllKeep', 'sharedTask.closeAllAction',
  ]);
  expect(body.textContent).toContain('Task B');
  await act(async () => refresh([{ ...detail, sharedTaskId: 'new-share', title: 'New Task', local: false }]));
  expect(body.textContent).toContain('New Task');
  expect(confirmation.textContent).not.toContain('New Task');
  expect(confirmation.textContent).toContain('Task A');
  expect(confirmation.textContent).toContain('Task B');
  expect(state.t.mock.calls.filter(([key]) => key === 'sharedTask.closeAllAction').at(-1)).toEqual(['sharedTask.closeAllAction', { count: 2 }]);
  await act(async () => { fireEvent.click([...body.querySelectorAll('button')].find((b) => b.textContent?.startsWith('sharedTask.closeAllAction'))!); });
  expect(state.account.mock.calls.filter(([command]) => command.action === 'close')).toEqual([
    [{ action: 'close', sharedTaskId: 'st1' }],
    [{ action: 'close', sharedTaskId: 'st9' }],
  ]);
  expect(within(body).queryByRole('alertdialog')).toBeNull();
});
it.each(['response', 'rejection'])('retries only failed snapshot items after a close %s', async (failure) => {
  let retry = false;
  const items = [
    { ...detail, local: true },
    { ...detail, sharedTaskId: 'st9', title: 'Task B', local: false },
  ];
  state.account.mockImplementation(async (command: { action: string; sharedTaskId?: string }) => {
    if (command.action === 'owned') return retry ? [{ ...detail, sharedTaskId: 'new-share', title: 'New Task', local: true }] : items;
    if (command.sharedTaskId === 'st1' && !retry) {
      if (failure === 'rejection') throw new Error('offline');
      return { closed: [], failed: [{ sharedTaskId: 'st1' }] };
    }
    return { closed: [command.sharedTaskId], failed: [] };
  });
  const body = await openWindow(ownerSession);
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: /sharedTask.tabOwned/ })));
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.closeAll' })));
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.closeAllAction' })));
  const confirmation = within(body).getByRole('alertdialog');
  expect(confirmation.textContent).toContain('Task A');
  expect(confirmation.textContent).not.toContain('Task B');
  expect(state.t.mock.calls.filter(([key]) => key === 'sharedTask.closeAllAction').at(-1)).toEqual(['sharedTask.closeAllAction', { count: 1 }]);
  expect(toast.error).toHaveBeenCalledWith('sharedTask.closeFailedToast');
  retry = true;
  await act(async () => fireEvent.click(within(confirmation).getByRole('button', { name: 'sharedTask.closeAllAction' })));
  expect(state.account.mock.calls.filter(([command]) => command.action === 'close')).toEqual([
    [{ action: 'close', sharedTaskId: 'st1' }],
    [{ action: 'close', sharedTaskId: 'st9' }],
    [{ action: 'close', sharedTaskId: 'st1' }],
  ]);
  expect(within(body).queryByRole('alertdialog')).toBeNull();
});
it('closes the shared task captured when the current-task confirmation opened', async () => {
  vi.useFakeTimers();
  try {
    let currentDetail: SharedTaskDetail = detail;
    state.host.mockImplementation(async (command: { action: string }) => {
      if (command.action === 'close') return { ok: true };
      return { available: true, detail: currentDetail };
    });
    const body = await openWindow(ownerSession);
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.closeCurrent' })));
    currentDetail = { ...detail, sharedTaskId: 'st2', title: 'Task B' };
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.close' })));
    expect(state.host.mock.calls.filter(([command]) => command.action === 'close')).toEqual([
      [{ action: 'close', sharedTaskId: 'st1' }],
    ]);
  } finally {
    vi.useRealTimers();
  }
});
it('removes a member from the shared task captured when the confirmation opened', async () => {
  vi.useFakeTimers();
  try {
    let currentDetail: SharedTaskDetail | null = { ...detail, guests: [
      { memberId: 'guest-1', accountId: 'guest-account', deviceIds: [], version: 1 },
    ] };
    const command = vi.fn(async (input: { action: string; sharedTaskId?: string; memberId?: string }) => {
      if (input.action === 'remove') return { ok: true };
      return { available: true, detail: currentDetail };
    });
    state.host.mockImplementation(command);
    const body = await openWindow(ownerSession);
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.removeShort' })));
    currentDetail = { ...detail, sharedTaskId: 'st2', title: 'Task B', guests: [] };
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.remove' })));
    expect(command.mock.calls.filter(([input]) => input.action === 'remove')).toEqual([
      [{ action: 'remove', sharedTaskId: 'st1', memberId: 'guest-1' }],
    ]);
  } finally {
    vi.useRealTimers();
  }
});
it.each(['account change', 'unmount'])('stops the confirmed batch after %s', async (invalidation) => {
  let finish!: (result: SharedTaskCloseResult) => void;
  state.account.mockImplementation((command: { action: string }) => command.action === 'owned'
    ? Promise.resolve([{ ...detail, local: true }, { ...detail, sharedTaskId: 'st9', title: 'Task B', local: false }])
    : new Promise<SharedTaskCloseResult>((resolve) => { finish = resolve; }));
  const body = await openWindow(ownerSession);
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: /sharedTask.tabOwned/ })));
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.closeAll' })));
  await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.closeAllAction' })));
  if (invalidation === 'account change') setDataOwnerGeneration('other');
  else await act(async () => root.render(null));
  await act(async () => finish({ closed: ['st1'], failed: [] }));
  expect(state.account.mock.calls.filter(([command]) => command.action === 'close')).toEqual([
    [{ action: 'close', sharedTaskId: 'st1' }],
  ]);
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});
it('keeps the member screen behind a named removal confirmation and cancels without removing', async () => {
  state.host.mockResolvedValue({ available: true, detail: { ...detail,
    guests: [{ memberId: 'guest-1', accountId: 'guest-account' }],
    memberLabels: [{ memberId: 'guest-1', displayName: 'Guest Name' }],
  } });
  const body = await openWindow(ownerSession);
  expect(body.textContent).toContain('Guest Name');
  expect(body.textContent).toContain('sharedTask.roleGuest');
  expect(body.textContent).toContain('sharedTask.inviteBoxTitle');
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.removeShort' }));
  const dialog = within(body).getByRole('alertdialog');
  expect(dialog.textContent).toContain('sharedTask.removeNamedTitle');
  fireEvent.click(within(dialog).getByRole('button', { name: 'sharedTask.removeKeep' }));
  await waitFor(() => expect(within(body).queryByRole('alertdialog')).toBeNull());
  expect(state.host.mock.calls.every(([command]) => command.action === 'state')).toBe(true);
});
it('does not route another local task management button to the current task', async () => {
  state.account.mockResolvedValue([{ ...detail, sessionId: 'other-session', sharedTaskId: 'other-share', title: 'Other Task', local: true }]);
  const body = await openWindow(ownerSession);
  fireEvent.click(within(body).getByRole('button', { name: /sharedTask.tabOwned/ }));
  await waitFor(() => expect(body.textContent).toContain('Other Task'));
  expect(within(body).queryByRole('button', { name: 'sharedTask.manage' })).toBeNull();
});
it('shows the host-offline ending for a guest whose share closed', async () => {
  state.account.mockImplementation((command: { action: string }) => command.action === 'get'
    ? Promise.resolve({ ...detail, status: 'closed' })
    : Promise.resolve([]));
  const body = await openWindow({ id: 'session-1', deviceLinkDeviceId: sharedTaskHostPeer('st1', 'desktop') } as Session);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.hostOfflineTitle'));
  expect(body.textContent).toContain('sharedTask.hostOfflineBody');
  expect(body.textContent).not.toContain('sharedTask.leave');
});
it('does not offer to enter a guest task that is already open', async () => {
  state.account.mockImplementation((command: { action: string }) => command.action === 'get'
    ? Promise.resolve(detail)
    : Promise.resolve([]));
  const body = await openWindow({ id: 'session-1', deviceLinkDeviceId: sharedTaskHostPeer('st1', 'desktop') } as Session);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.joinedTitle'));
  expect(within(body).queryByRole('button', { name: 'sharedTask.enterTask' })).toBeNull();
  expect(within(body).getByRole('button', { name: 'sharedTask.leave' })).toBeDefined();
});
it('cleans up the guest peer immediately after leaving', async () => {
  state.account.mockImplementation((command: { action: string }) => command.action === 'get'
    ? Promise.resolve(detail)
    : Promise.resolve([]));
  const peer = sharedTaskHostPeer('st1', 'desktop');
  const body = await openWindow({ id: 'session-1', deviceLinkDeviceId: peer } as Session);
  await waitFor(() => expect(body.textContent).toContain('sharedTask.joinedTitle'));
  fireEvent.click(within(body).getByRole('button', { name: 'sharedTask.leave' }));
  fireEvent.click(within(body).getByRole('alertdialog').querySelector('button:last-child')!);
  await waitFor(() => expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: 'st1' }));
  expect(state.removeDevice).toHaveBeenCalledWith(peer);
  expect(state.resetFence).toHaveBeenCalledWith(peer);
  expect(state.closeLink).toHaveBeenCalledWith(peer);
});
