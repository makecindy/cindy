import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { bindPluginViewDirectoryGuest, registerPluginViewDirectoryContextIpc } from '../pluginViewDirectoryContext.js';
import { PLUGIN_VIEW_DIRECTORY_CONTEXT } from '../../../shared/pluginViewDirectoryContext.js';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  readTask: vi.fn(),
  trusted: vi.fn(),
  recover: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../localDb/sessionDispatchSnapshot.js', () => ({ getSessionRowSnapshot: mocks.readTask }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ isTrustedAppRendererEvent: mocks.trusted }));
vi.mock('../../maker-ipc/workingDirectoryRecovery.desktop.js', () => ({ workingDirectoryRecovery: { resolve: mocks.recover } }));
vi.mock('../../workdir-probe-host/index.js', () => ({ statWorkingDirectory: mocks.stat }));

const url = 'cindy-ghost://directory-inspector/main.html';
const projectDir = process.platform === 'win32' ? 'C:\\fixture\\project' : '/fixture/project';
const workingDir = projectDir + '/.git-worktrees/topic';

function setup() {
  const frame = { url, send: vi.fn() };
  const host = {} as WebContents;
  const guest = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, mainFrame: frame });
  const current = vi.fn(() => true);
  const disabled = vi.fn((_directory: string) => false);
  bindPluginViewDirectoryGuest(host, guest as unknown as WebContents, url, current, disabled);
  guest.emit('did-navigate', {}, url);
  const invoke = mocks.handle.mock.lastCall?.[1] as (
    event: { sender: WebContents }, guestId: number, source: object,
  ) => Promise<void>;
  return { frame, host, guest, current, disabled, invoke };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.trusted.mockReturnValue(true);
  mocks.recover.mockImplementation((_id, directory) => directory);
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  registerPluginViewDirectoryContextIpc();
});

// Unit: use the registered production IPC and bound guest. An actual Git
// worktree can differ from projectDir, while a draft provides only projectDir.
it('delivers the current local task and draft directory facts to the bound guest', async () => {
  const { frame, host, invoke } = setup();
  mocks.readTask.mockResolvedValueOnce({ workingDir, projectDir });
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'task-a' });
  expect(mocks.readTask).toHaveBeenCalledExactlyOnceWith('task-a');
  expect(frame.send).toHaveBeenCalledExactlyOnceWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, { projectDir, workingDir });
  await invoke({ sender: host }, 42, { kind: 'project', projectDir });
  expect(mocks.readTask).toHaveBeenCalledTimes(1);
  expect(frame.send).toHaveBeenLastCalledWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, { projectDir, workingDir: null });
});

// Unit: denied inputs never disclose remote paths or a directory in which
// this plugin instance is disabled. Unbound guests never get a database read.
it('returns null for SSH and denied folders and ignores an unrelated host', async () => {
  const { frame, host, disabled, invoke } = setup();
  await invoke({ sender: {} as WebContents }, 42, { kind: 'task', sessionId: 'task-a' });
  expect(mocks.readTask).not.toHaveBeenCalled();
  mocks.readTask.mockResolvedValueOnce({ workingDir, projectDir, remoteHostId: 'ssh' });
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'ssh' });
  expect(frame.send).toHaveBeenCalledExactlyOnceWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, null);
  disabled.mockImplementation(dir => dir === projectDir);
  mocks.readTask.mockResolvedValueOnce({ workingDir, projectDir });
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'task-a' });
  expect(frame.send).toHaveBeenLastCalledWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, null);
});

// Unit: reuse an in-flight local lookup to exercise revocation and navigation
// during the read. The response may only go to its original document.
it.each(['revoke', 'navigate'] as const)('discards the result if the guest lease changes: %s', async reason => {
  const { frame, host, guest, current, invoke } = setup();
  let complete!: (row: unknown) => void;
  mocks.readTask.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const old = invoke({ sender: host }, 42, { kind: 'task', sessionId: 'task-a' });
  if (reason === 'revoke') current.mockReturnValue(false);
  else guest.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });
  complete({ workingDir, projectDir });
  await old;
  expect(frame.send).not.toHaveBeenCalled();
});

// Unit: resolve the known fallback through the real delivery IPC. Project
// membership survives recovery and the initial binding's disable still applies.
it('uses the recovered runtime folder and suppresses an unavailable or disallowed directory', async () => {
  const { frame, host, disabled, invoke } = setup();
  const fallback = projectDir + '-temporary-chat';
  mocks.readTask.mockResolvedValue({ workingDir, projectDir });
  mocks.recover.mockReturnValue(fallback);
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'worktree-task' });
  expect(frame.send).toHaveBeenLastCalledWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, { workingDir: fallback, projectDir });
  expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(fallback);
  disabled.mockImplementation(dir => dir === workingDir);
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'worktree-task' });
  expect(frame.send).toHaveBeenLastCalledWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, null);
  expect(mocks.stat).toHaveBeenCalledTimes(1);
  disabled.mockReturnValue(false);
  mocks.stat.mockRejectedValueOnce(new Error('missing'));
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'worktree-task' });
  expect(frame.send).toHaveBeenLastCalledWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, null);
});


// P2 #13556: the IPC must survive in-page routing before and during the probe.
// The existing navigation test covered only a replacement document (unit).
it('retains the entry document across same-document URL changes', async () => {
  const { frame, host, guest, invoke } = setup();
  const route = (next: string) => {
    guest.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true });
    frame.url = next;
  };
  route(url + '#/home');
  mocks.readTask.mockResolvedValueOnce({ workingDir, projectDir });
  mocks.stat.mockImplementationOnce(async () => {
    route('cindy-ghost://directory-inspector/preferences?tab=current');
    return { isDirectory: () => true };
  });
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'task-a' });
  expect(frame.send).toHaveBeenCalledExactlyOnceWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, { projectDir, workingDir });

  frame.send.mockClear();
  guest.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });
  guest.emit('did-navigate', {}, frame.url);
  route(url);
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'task-a' });
  expect(mocks.readTask).toHaveBeenCalledTimes(1);
  expect(frame.send).not.toHaveBeenCalled();
});

// P2 #13556: a saved row with a remote Lead can have local files. The
// existing SSH IPC test covers the separate case of remotely owned files (unit).
it('delivers the local directory of a Worker assigned by a remote Lead', async () => {
  const { frame, host, invoke } = setup();
  mocks.readTask.mockResolvedValueOnce({ workingDir, projectDir, orcaRemoteLead: '{"deviceId":"lead-computer"}' });
  await invoke({ sender: host }, 42, { kind: 'task', sessionId: 'worker-a' });
  expect(frame.send).toHaveBeenCalledExactlyOnceWith(PLUGIN_VIEW_DIRECTORY_CONTEXT, { projectDir, workingDir });
});
