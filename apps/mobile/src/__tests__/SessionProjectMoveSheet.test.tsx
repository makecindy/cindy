// @vitest-environment jsdom
// Unit: the missing mobile move entry must dismiss its parent before choosing a host project.
// Existing menu tests cover rename/archive, not a project transaction or account-switch fencing.
// Minimal regression: active task on a relinked computer -> select /project -> host confirmation.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { sessionAllowsProjectMove, useSessionProjectMoveSheet } from '@/session/SessionProjectMoveSheet';
import type { NewTaskSelectionSheetProps } from '@/session/NewTaskSelectionSheet';
import type { RemoteSession } from '@/session/types';

const h = vi.hoisted(() => ({
  invoke: vi.fn(), patch: vi.fn(), reseed: vi.fn(), running: false,
  picker: null as NewTaskSelectionSheetProps | null,
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('@/session/remoteSessionStore', () => ({
  resolveSessionWriteDevices: (_id: string, session: RemoteSession, preferred?: string) => ({
    rpcDeviceId: preferred || session.canonicalDeviceId || session.deviceLinkDeviceId,
    shardId: session.deviceLinkDeviceId,
  }),
  remoteSessionStore: {
    applySessionPatch: h.patch, requestReseed: h.reseed,
    getSessionRunStatus: () => ({ isRunning: h.running }),
  },
}));
vi.mock('@/session/NewTaskSelectionSheet', () => ({
  NewTaskSelectionSheet: (props: NewTaskSelectionSheetProps) => { h.picker = props; return null; },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: translate }),
}));
function translate(key: string) { return key; }

const session = {
  id: 'task-a', status: 'active', workingDir: '/old', workspaceKind: 'dialogue',
  deviceLinkDeviceId: 'old-shard', canonicalDeviceId: 'live-computer',
} as RemoteSession;
let root: Root;
let container: HTMLDivElement;
let move: ReturnType<typeof useSessionProjectMoveSheet>;
function Harness() { move = useSessionProjectMoveSheet(); return move.sheet; }
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); h.invoke.mockReset(); h.picker = null; h.running = false;
  setMobileAuthOwner('owner-a');
  h.invoke.mockResolvedValue({ supported: true, projects: ['/project'] });
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(createElement(Harness)));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function open(target = session) {
  const closeMenu = vi.fn();
  act(() => move.open(target, closeMenu));
  expect(closeMenu).toHaveBeenCalledOnce();
  expect(h.picker).toBeNull();
  await act(async () => move.parentClosed());
  expect(h.picker?.workspaces.map(({ title, workingDir }) => ({ title, workingDir }))).toEqual([{ title: 'project', workingDir: '/project' }]);
}

it('opens only after dismissal, sends to the current computer, and updates the physical shard only after success', async () => {
  await open();
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => { h.picker!.onProject('/project'); h.picker!.onProject('/project'); });
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.invoke).toHaveBeenCalledTimes(2); // caps + one write, despite a double tap
  expect(h.invoke).toHaveBeenLastCalledWith('live-computer', 'maker:task-copy',
    [{ action: 'move-project', sessionId: 'task-a', workingDir: '/project' }], expect.any(Object));
  await act(async () => finish({ projectMove: {
    sessionId: 'task-a', workingDir: '/project', workspaceKind: 'project',
  } }));
  expect(h.patch).toHaveBeenCalledWith('old-shard', 'task-a', {
    workingDir: '/project', workspaceKind: 'project', projectDir: null,
  });
  expect(h.reseed).toHaveBeenCalledWith('old-shard');
  expect(h.picker?.page).toBeNull();
});

it('retains the picker and original membership after a host rejection; never retries a move', async () => {
  await open();
  h.invoke.mockRejectedValueOnce(new Error('WORKTREE_MOVE_BLOCKED'));
  await act(async () => h.picker!.onProject('/project'));
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.picker?.actionError).toBe('session.menu.moveWorktree');
  expect(h.picker?.page).toBe('workspace');
  expect(h.invoke).toHaveBeenCalledTimes(2);
});

it('blocks a running task and does not send its workspace change', async () => {
  await open(); h.running = true;
  await act(async () => h.picker!.onProject('/project'));
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.picker?.actionError).toBe('session.menu.moveRunning');
});

it('does not apply a late result after switching accounts, and cancels queued writes before send', async () => {
  await open();
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => h.picker!.onProject('/project'));
  const options = h.invoke.mock.calls.at(-1)![3];
  setMobileAuthOwner('owner-b');
  expect(() => options.preSend()).toThrow('PROJECT_MOVE_CLOSED');
  await act(async () => finish({ projectMove: {
    sessionId: 'task-a', workingDir: '/project', workspaceKind: 'project',
  } }));
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.reseed).not.toHaveBeenCalled();
});

it('offers ordinary remote-controlled tasks, excluding host-managed, archived, SSH and guest tasks', () => {
  expect(sessionAllowsProjectMove(session)).toBe(true);
  for (const patch of [
    { source: 'bot' }, { source: 'review' }, { status: 'archived' },
    { remoteHostId: 'ssh' }, { orcaRole: 'worker' },
    { deviceLinkDeviceId: sharedTaskHostPeer('11111111-1111-4111-8111-111111111111', 'host') },
  ]) expect(sessionAllowsProjectMove({ ...session, ...patch } as RemoteSession)).toBe(false);
});

it('fences the original task owner even when accounts change while the menu dismisses', async () => {
  act(() => move.open(session, vi.fn()));
  setMobileAuthOwner('owner-b');
  await act(async () => move.parentClosed());
  const options = h.invoke.mock.calls[0]![3];
  expect(() => options.preSend()).toThrow('PROJECT_MOVE_CLOSED');
  await act(async () => h.picker!.onProject('/project'));
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.patch).not.toHaveBeenCalled();
});

it('uses the host resolved folder path and can move a task back to a dialogue', async () => {
  await open();
  h.invoke.mockResolvedValueOnce({ resolvedPath: '/actual', parent: '/', entries: [
    { name: 'child', path: '/actual/child', kind: 'directory' },
    { name: 'file', path: '/actual/file', kind: 'file' },
  ] });
  await act(async () => h.picker!.onBrowse());
  expect(h.picker?.path).toBe('/actual');
  expect(h.picker?.entries.map(entry => entry.name)).toEqual(['child']);
  h.invoke.mockResolvedValueOnce({ projectMove: { sessionId: 'task-a', workingDir: '/actual', workspaceKind: 'project' } });
  await act(async () => h.picker!.onChoose(h.picker!.path));
  expect(h.invoke).toHaveBeenLastCalledWith('live-computer', 'maker:task-copy',
    [{ action: 'move-project', sessionId: 'task-a', workingDir: '/actual' }], expect.any(Object));
  await act(async () => h.picker!.onClosed?.());
  h.picker = null;
  h.invoke.mockResolvedValue({ supported: true, projects: ['/project'] });
  await open();
  h.invoke.mockResolvedValueOnce({ projectMove: { sessionId: 'task-a', workingDir: '/old', workspaceKind: 'dialogue' } });
  await act(async () => h.picker!.onDialogue());
  expect(h.invoke).toHaveBeenLastCalledWith('live-computer', 'maker:task-copy',
    [{ action: 'move-project', sessionId: 'task-a', workingDir: null }], expect.any(Object));
});

// PR #9826: a move rejection must not invalidate a folder that was already read.
it('keeps a loaded folder selectable after running/host failures and permits an explicit retry', async () => {
  await open();
  h.invoke.mockResolvedValueOnce({ resolvedPath: '/actual', parent: '/', entries: [] });
  await act(async () => h.picker!.onBrowse());
  h.running = true;
  await act(async () => h.picker!.onChoose('/actual'));
  expect(h.picker?.error).toBeNull();
  expect(h.picker?.actionError).toBe('session.menu.moveRunning');
  h.running = false;
  h.invoke.mockRejectedValueOnce(new Error('HOST_UNAVAILABLE'));
  await act(async () => h.picker!.onChoose('/actual'));
  expect(h.picker?.path).toBe('/actual');
  expect(h.picker?.error).toBeNull();
  expect(h.picker?.actionError).toBe('session.menu.moveFailed');
  h.invoke.mockResolvedValueOnce({ projectMove: { sessionId: 'task-a', workingDir: '/actual', workspaceKind: 'project' } });
  await act(async () => h.picker!.onChoose('/actual'));
  expect(h.patch).toHaveBeenCalledOnce();
  expect(h.picker?.page).toBeNull();
});

// PR #9826: delayed Windows drive enumeration must populate the same directory page.
it('loads late Windows drives without blocking the folder and bounds pending enumeration', async () => {
  await open();
  const folder = { resolvedPath: 'C:/work', parent: 'C:/', entries: [], drivesPending: true };
  let finish!: (value: unknown) => void;
  h.invoke.mockResolvedValueOnce(folder).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => h.picker!.onBrowse());
  await act(async () => {});
  expect(h.picker?.path).toBe('C:/work');
  expect(h.picker?.loading).toBe(false);
  await act(async () => finish({ ...folder, drivesPending: false, drives: [
    { name: 'C:', path: 'C:/', current: true }, { name: 'D:', path: 'D:/', current: false },
  ] }));
  expect(h.picker?.drives.map(drive => drive.path)).toEqual(['C:/', 'D:/']);
  h.invoke.mockResolvedValue(folder);
  await act(async () => h.picker!.onEnter('C:/work'));
  expect(h.invoke.mock.calls.filter(call => call[1] === 'fs:list-dir')).toHaveLength(6); // 2 + initial/3 bounded rereads
});

it.each(['back', 'account'])('ignores late drive enumeration after %s and fences queued rereads', async change => {
  await open();
  let finish!: (value: unknown) => void;
  h.invoke.mockResolvedValueOnce({ resolvedPath: 'C:/', parent: null, entries: [], drivesPending: true })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => h.picker!.onBrowse());
  await act(async () => {});
  const preSend = h.invoke.mock.calls.at(-1)![3].preSend;
  if (change === 'back') act(() => h.picker!.onBack());
  else setMobileAuthOwner('owner-b');
  expect(() => preSend()).toThrow('PROJECT_MOVE_CLOSED');
  await act(async () => finish({ resolvedPath: 'C:/', parent: null, entries: [], drivesPending: true,
    drives: [{ name: 'C:', path: 'C:/', current: true }, { name: 'D:', path: 'D:/', current: false }] }));
  expect(h.picker?.drives).toEqual([]);
  expect(h.invoke).toHaveBeenCalledTimes(3);
});

// PR #9826: explicit membership can differ from cwd; picking it must not reset cwd.
it.each([
  { projectDir: '/project', workingDir: '/project/subdir', same: '/project/' },
  { projectDir: null, workingDir: '/project', same: '/project/' },
  { projectDir: 'D:/project', workingDir: 'D:/project/subdir', same: 'd:\\PROJECT\\' },
])('marks and guards current project membership without rewriting cwd: %j', async ({ same, ...membership }) => {
  await open({ ...session, ...membership, workspaceKind: 'project' });
  expect(h.picker?.workingDir).toBe(membership.projectDir ?? membership.workingDir);
  if (membership.workingDir.startsWith('/')) expect(h.picker?.workspaces[0].disabled).toBe(true);
  await act(async () => { h.picker!.onProject(same); h.picker!.onChoose(same); });
  expect(h.invoke).toHaveBeenCalledTimes(1); // caps only, never a same-project write
  expect(h.patch).not.toHaveBeenCalled();
  expect(h.picker?.page).toBe('workspace');
  h.invoke.mockResolvedValueOnce({ projectMove: { sessionId: 'task-a', workingDir: '/other', workspaceKind: 'project' } });
  await act(async () => h.picker!.onProject('/other'));
  expect(h.patch).toHaveBeenCalledOnce();
});

it('can assign a dialogue to a project even when the execution directory is already there', async () => {
  await open({ ...session, workingDir: '/project' });
  expect(h.picker?.workspaces[0].disabled).not.toBe(true);
  h.invoke.mockResolvedValueOnce({ projectMove: { sessionId: 'task-a', workingDir: '/project', workspaceKind: 'project' } });
  await act(async () => h.picker!.onProject('/project'));
  expect(h.patch).toHaveBeenCalledOnce();
});
