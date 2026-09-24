// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SessionTaskMenu } from '../SessionTaskMenu';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';

const state = vi.hoisted(() => ({
  host: vi.fn(),
  rowClick: vi.fn(),
  rename: vi.fn(),
  account: vi.fn(),
  closeLink: vi.fn(),
  invoke: vi.fn(),
  removeDevice: vi.fn(),
  writeClipboard: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { removeDevice: state.removeDevice, getDeviceName: () => undefined },
  isRemoteDeviceMarkedDisconnected: () => false,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner', isAuthenticated: true }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/features/device-link/JoinSharedTaskDialog', () => ({
  JoinSharedTaskDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <div role="dialog" aria-label="join">
      <button onClick={() => onOpenChange(false)}>Cancel join</button>
    </div>
  ),
}));

const session = { id: 'task', title: 'Task', status: 'active' } as Session;
function Harness({ target = session, blocked = false }: { target?: Session; blocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const slot = (text: string) => <DropdownMenuItem>{text}</DropdownMenuItem>;
  return (
    <MemoryRouter><div onClick={state.rowClick}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger ref={trigger}>More</DropdownMenuTrigger>
        <SessionTaskMenu
          session={target}
          open={open}
          writeBlocked={blocked}
          returnFocus={() => trigger.current?.focus()}
          onRename={state.rename}
          onPin={vi.fn()}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
          onDelete={vi.fn()}
          onOpenInNewWindow={vi.fn()}
          move={target.status === 'active' ? slot('move') : null}
          tags={slot('tags')}
          copy={slot('copy')}
          exportShare={slot('export')}
        />
      </DropdownMenu>
    </div></MemoryRouter>
  );
}
function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' });
}
function labels() {
  return screen.getAllByRole('menuitem').map((item) => item.textContent);
}
async function openSharingSubmenu() {
  const trigger = await screen.findByRole('menuitem', { name: 'manageSharing' });
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
  await screen.findByRole('menuitem', { name: 'manageMembers' });
}
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  state.host.mockResolvedValue({ available: false, detail: null });
  state.account.mockImplementation(async ({ action, sharedTaskId }) => action === 'close' ? { closed: [sharedTaskId], failed: [] } : []);
  state.closeLink.mockResolvedValue(undefined);
  state.writeClipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: state.writeClipboard } });
  Object.assign(window, {
    electronAPI: { sharedTask: { host: state.host, account: state.account }, deviceLink: { closeLink: state.closeLink, invoke: state.invoke } },
  });
});
afterEach(cleanup);

it('loads only on open and groups task organization, sharing, viewing and removal in order', () => {
  render(<Harness />);
  expect(state.host).not.toHaveBeenCalled();
  openMenu();
  expect(labels()).toEqual([
    'pin',
    'rename',
    'move',
    'tags',
    'copy',
    'title',
    'export',
    'openInNewWindow',
    'archived',
    'delete',
  ]);
  expect(screen.getAllByRole('separator')).toHaveLength(3);
  expect(state.host).toHaveBeenCalledWith({ action: 'state', sessionId: 'task' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'rename' }));
  expect(state.rename).toHaveBeenCalledTimes(1);
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('shows unpin without a branch entry even for a forked Pi task', () => {
  render(
    <Harness
      target={{ ...session, pinnedAt: '2026-09-23', agentKind: 'pi', parentSessionId: 'parent' }}
    />,
  );
  openMenu();
  expect(labels()).toEqual([
    'unpin',
    'rename',
    'move',
    'tags',
    'copy',
    'title',
    'export',
    'openInNewWindow',
    'archived',
    'delete',
  ]);
});

it('keeps restore and delete last for archived tasks and does not expose sharing', () => {
  render(<Harness target={{ ...session, status: 'archived' }} />);
  openMenu();
  expect(labels()).toEqual(['rename', 'tags', 'copy', 'export', 'unarchive', 'delete']);
});

it('shows only leave sharing for guests without disabled actions or separators', () => {
  render(
    <Harness target={{ ...session, deviceLinkDeviceId: sharedTaskHostPeer('share', 'device') }} />,
  );
  openMenu();
  expect(labels()).toEqual(['leaveShort']);
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'leaveShort' }).getAttribute('aria-disabled')).not.toBe('true');
});

it('opens only a leave confirmation for guests and preserves the task on cancel', async () => {
  render(
    <Harness target={{ ...session, deviceLinkDeviceId: sharedTaskHostPeer('share', 'device') }} />,
  );
  const more = screen.getByRole('button', { name: 'More' });
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'leaveShort' }));
  expect(screen.getByRole('alertdialog', { name: 'leaveTitle' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'leaveKeep' }));
  fireEvent.click(screen.getByRole('button', { name: 'leaveKeep' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(state.account).not.toHaveBeenCalled();
  expect(state.removeDevice).not.toHaveBeenCalled();
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('disables mutations while retaining read-only actions for an unavailable remote task', () => {
  render(<Harness blocked />);
  openMenu();
  for (const name of ['pin', 'rename', 'openInNewWindow', 'archived', 'delete']) {
    expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
  }
  expect(screen.getByRole('menuitem', { name: 'copy' }).getAttribute('aria-disabled')).not.toBe(
    'true',
  );
});

it('keeps the shared dialog after closing the menu and isolates its clicks from the row', async () => {
  render(<Harness />);
  const more = screen.getByRole('button', { name: 'More' });
  openMenu();
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'title' }).getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'title' }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'dismiss' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('shows stop sharing for an active host and closes only after confirmation', async () => {
  state.host.mockResolvedValue({ available: true, detail: { sharedTaskId: 'share', status: 'active' } });
  render(<Harness />); openMenu();
  await screen.findByRole('menuitem', { name: 'manageSharing' });
  expect(labels()).toEqual(['pin', 'rename', 'move', 'tags', 'copy', 'manageSharing', 'export', 'openInNewWindow', 'archived', 'delete']);
  expect(screen.queryByRole('menuitem', { name: 'cancelSharing' })).toBeNull();
  await openSharingSubmenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'cancelSharing' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(state.account).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'closeAllKeep' }));
  fireEvent.click(screen.getByRole('button', { name: 'cancelSharing' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(state.account).toHaveBeenCalledWith({ action: 'close', sharedTaskId: 'share' });
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('routes the state lookup through the owning remote computer', async () => {
  state.invoke.mockResolvedValue({ available: true, detail: { sharedTaskId: 'remote-share', status: 'active' } });
  render(<Harness target={{ ...session, deviceLinkDeviceId: 'own-computer' }} />); openMenu();
  await screen.findByRole('menuitem', { name: 'manageSharing' });
  expect(state.invoke).toHaveBeenCalledWith('own-computer', 'maker:shared-task', [{ action: 'state', sessionId: 'task' }]);
  expect(state.host).not.toHaveBeenCalled();
});

it('opens the existing member management panel from the sharing submenu', async () => {
  state.host.mockResolvedValue({ available: true, detail: { sharedTaskId: 'share', sessionId: 'task', status: 'active', title: 'Task', guests: [], memberLabels: [], hostDeviceId: 'device' } });
  render(<Harness />); openMenu(); await openSharingSubmenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'manageMembers' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('button', { name: 'invite' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(state.account).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
  expect(state.rowClick).not.toHaveBeenCalled();
});

it.each([false, true])('copies an invitation for the correct host (remote: %s)', async remote => {
  const api = remote ? state.invoke : state.host;
  api.mockImplementation(async (...args) => (remote ? args[2][0] : args[0]).action === 'invite'
    ? { invitation: 'test-invitation' }
    : { available: true, detail: { sharedTaskId: 'share', status: 'active' } });
  render(<Harness target={{ ...session, deviceLinkDeviceId: remote ? 'own-computer' : undefined }} />);
  openMenu(); await openSharingSubmenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'invite' }));
  await waitFor(() => expect(state.writeClipboard).toHaveBeenCalledWith('test-invitation'));
  expect(toast.success).toHaveBeenCalledWith('invitationCopied');
  if (remote) expect(state.invoke).toHaveBeenCalledWith('own-computer', 'maker:shared-task', [{ action: 'invite', sharedTaskId: 'share' }]);
  else expect(state.host).toHaveBeenCalledWith({ action: 'invite', sharedTaskId: 'share' });
  expect(state.rowClick).not.toHaveBeenCalled();
});

it('does not copy a late invitation after the account changes', async () => {
  let finish!: (value: { invitation: string }) => void;
  state.host.mockImplementation(async command => command.action === 'invite'
    ? new Promise(resolve => { finish = resolve; })
    : { available: true, detail: { sharedTaskId: 'share', status: 'active' } });
  render(<Harness />); openMenu(); await openSharingSubmenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'invite' }));
  setDataOwnerGeneration('other-account');
  await act(async () => finish({ invitation: 'old-account-invitation' }));
  expect(state.writeClipboard).not.toHaveBeenCalled();
});

it('reports clipboard failure separately and allows retrying', async () => {
  state.host.mockImplementation(async command => command.action === 'invite'
    ? { invitation: 'test-invitation' }
    : { available: true, detail: { sharedTaskId: 'share', status: 'active' } });
  state.writeClipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));
  render(<Harness />); openMenu(); await openSharingSubmenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'invite' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('invitationCopyFailed'));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'invite' }).getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'invite' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('invitationCopied'));
});

it('leaves the confirmed shared peer without calling host management', async () => {
  const peer = sharedTaskHostPeer('share', 'device');
  render(<Harness target={{ ...session, deviceLinkDeviceId: peer }} />); openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'leaveShort' }));
  fireEvent.click(screen.getByRole('button', { name: 'leaveShort' }));
  await waitFor(() => expect(state.removeDevice).toHaveBeenCalledWith(peer));
  expect(state.account).toHaveBeenCalledWith({ action: 'leave', sharedTaskId: 'share' });
  expect(state.closeLink).toHaveBeenCalledWith(peer);
  expect(state.host).not.toHaveBeenCalled();
});

it('does not submit a confirmation from an old account', async () => {
  render(<Harness target={{ ...session, deviceLinkDeviceId: sharedTaskHostPeer('share', 'device') }} />); openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'leaveShort' }));
  setDataOwnerGeneration('other-account');
  fireEvent.click(screen.getByRole('button', { name: 'leaveShort' }));
  expect(state.account).not.toHaveBeenCalled();
});
