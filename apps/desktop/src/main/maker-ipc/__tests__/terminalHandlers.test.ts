import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { IPty } from 'node-pty';
import type { RemoteTerminalDescription } from '../../../shared/terminal-bridge';
import type { RemoteTerminalRuntime } from '../../terminal/remoteTerminal';

/**
 * Production IPC handlers and an in-memory PTY exercise ticket authorization and account
 * invalidation (Electron security §5). Tickets fence new launches; remote reattachment
 * must match the original task/device/account, and mutations require the current owner.
 * Minimal regression: reuse a remote tab ID from another task or its previous window.
 * Regressions cover a remote create colliding with a local PTY, exited-state reattachment,
 * single-use/expired tickets and A→B→A late metadata/save results. Unit tier: memory only.
 */
const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  spawn: vi.fn(),
  getDefaultShellPref: vi.fn(() => 'bash' as const),
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.ipcHandle } }));
vi.mock('../../terminal/ptyFactory.js', () => ({ defaultPtySpawn: mocks.spawn }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (event: { trusted?: boolean }) => {
    if (!event.trusted) throw new Error('[PERMISSION_DENIED] Untrusted renderer');
  },
}));
vi.mock('../../terminal/shellResolver.js', () => ({
  probeAvailableShells: () => [],
  resolveShellForCreate: (pref: string | null) => ({ id: pref && pref !== 'auto' ? pref : 'bash', command: '/bin/bash', args: [], displayName: 'Bash' }),
}));
vi.mock('../../terminal/terminalPrefsStore.js', () => ({
  getDefaultShellPref: mocks.getDefaultShellPref, setDefaultShellPref: vi.fn(),
}));

import { TERMINAL_INVOKE } from '../channels';
import { registerTerminalHandlers } from '../terminal-handlers';
import { remoteLaunch } from '../../terminal/remoteTerminal';

// Real app-session boundaries with memory-only storage/metadata: protect the SSH
// lifetime through the actual runtime subscription, not a copied auth predicate.
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: ({ defaults }: { defaults: unknown }) => ({ read: () => defaults, writePatch: vi.fn() }),
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionRowSnapshotStrict: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: vi.fn() }));
vi.mock('../../device-link/deviceLinkApi.js', () => ({ deviceLinkApiFetch: vi.fn() }));
vi.mock('../../remote-ssh/index.js', () => ({ getRemoteSshPoolHydrated: vi.fn() }));
import { beginAppSessionBoundary, commitActiveAppSession, getActiveAppSession } from '../../appSessionState';
import { createRemoteTerminalRuntime } from '../../terminal/remoteTerminalRuntime';

function owner(): WebContents {
  return { isDestroyed: () => false, once: vi.fn(), send: vi.fn() } as unknown as WebContents;
}
function event(sender = owner(), trusted = true): IpcMainInvokeEvent {
  return { sender, trusted } as unknown as IpcMainInvokeEvent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function invoke(channel: string, source: IpcMainInvokeEvent, ...args: unknown[]): any {
  const call = mocks.ipcHandle.mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`Missing handler: ${channel}`);
  return call[1](source, ...args);
}
const context = { sessionId: 'task', deviceId: 'device' };
const params = { id: 'remote', cwd: '/renderer-must-not-control-cwd', remote: context };
const description: RemoteTerminalDescription = {
  context, target: { key: '["device",null]', label: 'device', cwd: "/project/a'b $(ignored)" },
  connection: { host: 'my-alias' }, candidates: [],
};
let account: string;
let invalidate: (disposeSessions?: boolean) => void;
let remote: RemoteTerminalRuntime;
let source: IpcMainInvokeEvent;
let manager: ReturnType<typeof registerTerminalHandlers>;
let pty: IPty;
let exit: (info: { exitCode: number }) => void;
let output: (chunk: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  account = 'account:1';
  source = event();
  mocks.spawn.mockImplementation(() => {
    pty = { pid: 123, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: (callback: typeof output) => { output = callback; return { dispose() {} }; },
      onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} }; },
    } as unknown as IPty;
    return pty;
  });
  remote = {
    scope: vi.fn(() => account),
    ownerKey: vi.fn(() => account),
    describe: vi.fn(async () => description),
    prepare: vi.fn(async (connection, cwd, _key, _scope, assertCurrent) => { assertCurrent(); return remoteLaunch(connection, cwd); }),
    save: vi.fn(async (_key, _connection, _scope, assertCurrent) => { assertCurrent(); }),
    onInvalidated: callback => { invalidate = (disposeSessions = true) => callback(disposeSessions); },
  };
  manager = registerTerminalHandlers({ remote });
});
async function prepare(sourceEvent = source, extra: Record<string, unknown> = {}) {
  return invoke(TERMINAL_INVOKE.DESCRIBE_REMOTE, sourceEvent, { id: params.id, ...context, ...extra });
}
function create(sourceEvent = source, ticket?: string, overrides: Record<string, unknown> = {}) {
  return invoke(TERMINAL_INVOKE.CREATE, sourceEvent, { ...params, ...overrides, remote: { ...context, ...(ticket ? { ticket } : {}) } });
}

describe('terminal local compatibility', () => {
  it('uses the persisted shell without an account gate and survives remote invalidation', () => {
    vi.mocked(remote.scope).mockImplementation(() => { throw new Error('signed out'); });
    invoke(TERMINAL_INVOKE.CREATE, event(source.sender, false), { id: 'local', cwd: homedir() });
    expect(manager.__debugListSessions()[0].shellPref).toBe('bash');
    invalidate();
    expect(manager.has('local')).toBe(true);
    expect(pty.kill).not.toHaveBeenCalled();
  });
  it.each(['auto', 'zsh', null] as const)('preserves explicit shellPref (%s)', shellPref => {
    invoke(TERMINAL_INVOKE.CREATE, source, { id: 'local', cwd: homedir(), shellPref });
    expect(mocks.getDefaultShellPref).not.toHaveBeenCalled();
    expect(manager.__debugListSessions()[0].shellPref).toBe(shellPref);
  });
  it('rejects invalid shellPref before spawning', () => {
    expect(() => invoke(TERMINAL_INVOKE.CREATE, source, { id: 'local', cwd: homedir(), shellPref: 'bad' })).toThrow(/invalid shellPref/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('remote ticket IPC', () => {
  it('spawns using authoritative cwd and only reattaches the same task in the current account', async () => {
    const { ticket } = await prepare();
    const result = create(source, ticket);
    expect(result.pid).toBe(123);
    expect(result).not.toBeInstanceOf(Promise);
    const [command, args, opts] = mocks.spawn.mock.calls[0];
    expect(command).toBe(process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    expect(args.at(-1)).toContain('/bin/sh -c ');
    expect(args.at(-1)).not.toContain(params.cwd);
    expect(opts.cwd).toBe(homedir());
    const next = event();
    expect(() => create(event(next.sender, false))).toThrow(/PERMISSION_DENIED/);
    const destroyed = vi.spyOn(next.sender, 'isDestroyed').mockReturnValue(true);
    expect(() => create(next)).toThrow(/PERMISSION_DENIED/);
    destroyed.mockRestore();
    vi.mocked(remote.scope).mockClear();
    for (const otherContext of [{ ...context, sessionId: 'other-task' }, { ...context, deviceId: 'other-device' }]) {
      expect(() => invoke(TERMINAL_INVOKE.CREATE, next, {
        ...params, remote: otherContext,
      })).toThrow(/PERMISSION_DENIED/);
    }
    account = 'account:2';
    expect(() => create(next)).toThrow(/PERMISSION_DENIED/);
    account = 'account:1';
    expect(create(next)).toEqual(result);
    expect(remote.describe).toHaveBeenCalledOnce();
    expect(remote.save).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    output('attached');
    expect(next.sender.send).toHaveBeenCalledWith('terminal:data', { id: params.id, chunk: 'attached' });
    for (const stale of [source, event(next.sender, false)]) {
      expect(() => invoke(TERMINAL_INVOKE.WRITE, stale, params.id, 'old')).toThrow(/PERMISSION_DENIED/);
      expect(() => invoke(TERMINAL_INVOKE.RESIZE, stale, params.id, 100, 40)).toThrow(/PERMISSION_DENIED/);
      expect(() => invoke(TERMINAL_INVOKE.RESTART, stale, params.id)).toThrow(/PERMISSION_DENIED/);
      expect(() => invoke(TERMINAL_INVOKE.DISPOSE, stale, params.id)).toThrow(/PERMISSION_DENIED/);
    }
    await Promise.resolve();
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
    invoke(TERMINAL_INVOKE.WRITE, next, params.id, 'current');
    await Promise.resolve();
    expect(pty.write).toHaveBeenCalledWith('current');
    invoke(TERMINAL_INVOKE.RESIZE, next, params.id, 100, 40);
    expect(pty.resize).toHaveBeenCalledWith(100, 40);
    invoke(TERMINAL_INVOKE.DISPOSE, next, params.id);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(manager.has(params.id)).toBe(false);
  });

  it('closes a popped-out remote tab from its original task window without orphaning the PTY', async () => {
    create(source, (await prepare()).ticket);
    const popup = event();
    create(popup);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(() => invoke(TERMINAL_INVOKE.DISPOSE, source, params.id, { ...context, sessionId: 'other' })).toThrow(/PERMISSION_DENIED/);
    expect(() => invoke(TERMINAL_INVOKE.DISPOSE, event(source.sender, false), params.id, context)).toThrow(/PERMISSION_DENIED/);
    account = 'account:2';
    expect(() => invoke(TERMINAL_INVOKE.DISPOSE, source, params.id, context)).toThrow(/PERMISSION_DENIED/);
    account = 'account:1';
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id, context);
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(manager.has(params.id)).toBe(false);
  });

  // DeepSeek regression: a same-owner repair invalidates pending launches, not
  // an authenticated SSH process. The old blanket invalidation killed it silently.
  it('preserves SSH across same-owner repair while expiring tickets and rejecting boundary operations', async () => {
    create(source, (await prepare()).ticket);
    const pending = (await prepare(source, { id: 'pending' })).ticket;
    invalidate(false);
    expect(manager.has(params.id)).toBe(true);
    expect(pty.kill).not.toHaveBeenCalled();
    vi.mocked(remote.ownerKey).mockImplementationOnce(() => { throw new Error('[PERMISSION_DENIED] Account boundary'); });
    expect(() => invoke(TERMINAL_INVOKE.WRITE, source, params.id, 'blocked')).toThrow(/PERMISSION_DENIED/);
    vi.mocked(remote.scope).mockReturnValue('account:1:repaired-generation');
    expect(() => create(source, pending, { id: 'pending' })).toThrow(/PRECONDITION_FAILED/);
    expect(create()).toEqual({ pid: 123, shellId: 'sh', shellDisplayName: 'SSH · my-alias' });
    invoke(TERMINAL_INVOKE.WRITE, source, params.id, 'resumed');
    await Promise.resolve();
    expect(pty.write).toHaveBeenCalledWith('resumed');
    expect(mocks.spawn).toHaveBeenCalledOnce();
    exit({ exitCode: 0 });
    invoke(TERMINAL_INVOKE.RESTART, source, params.id);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    invalidate(true);
    expect(manager.has(params.id)).toBe(false);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it('preserves the live process through a real projection repair but disposes on a realm move or owner change', async () => {
    commitActiveAppSession('cloud', 'terminal-owner-a');
    const runtime = createRemoteTerminalRuntime();
    let unsubscribe: (() => void) | undefined;
    let release: (() => void) | undefined;
    mocks.ipcHandle.mockClear();
    manager = registerTerminalHandlers({ remote: {
      ...runtime, describe: remote.describe, prepare: remote.prepare, save: remote.save,
      onInvalidated(callback) { unsubscribe = runtime.onInvalidated(callback) as unknown as () => void; },
    } });
    try {
      create(source, (await prepare()).ticket);
      const live = pty;
      const scope = runtime.scope();
      release = beginAppSessionBoundary();
      expect(manager.has(params.id)).toBe(true);
      expect(() => invoke(TERMINAL_INVOKE.WRITE, source, params.id, 'blocked')).toThrow(/PERMISSION_DENIED/);
      commitActiveAppSession('cloud', 'terminal-owner-a', true, 'projection-repair');
      release();
      expect(runtime.scope()).not.toBe(scope);
      expect(live.kill).not.toHaveBeenCalled();
      invoke(TERMINAL_INVOKE.WRITE, source, params.id, 'resumed');
      await Promise.resolve();
      expect(live.write).toHaveBeenCalledWith('resumed');
      output('still connected');
      expect(source.sender.send).toHaveBeenCalledWith('terminal:data', { id: params.id, chunk: 'still connected' });
      // A same-id issuing-realm change must not gain the repair exemption.
      commitActiveAppSession('cloud', 'terminal-owner-a', true);
      expect(source.sender.send).toHaveBeenCalledWith('terminal:exit', { id: params.id, exit: { code: null, signal: null } });
      expect(live.kill).toHaveBeenCalledOnce();
      expect(manager.has(params.id)).toBe(false);
      create(source, (await prepare()).ticket);
      vi.mocked(pty.kill).mockImplementationOnce(() => {
        expect(getActiveAppSession().dataOwnerId).toBe('terminal-owner-a');
      });
      commitActiveAppSession('cloud', 'terminal-owner-b');
      expect(pty.kill).toHaveBeenCalledOnce();
      expect(manager.has(params.id)).toBe(false);
    } finally {
      release?.();
      unsubscribe?.();
      manager.disposeRemote();
    }
  });

  it('allows the current owner to close despite a stale supplied device context', async () => {
    create(source, (await prepare()).ticket);
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id, { ...context, deviceId: null });
    expect(manager.has(params.id)).toBe(false);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it('refuses to attach a local tab to an existing remote PTY', async () => {
    const { ticket } = await prepare();
    create(source, ticket);
    const next = event();
    expect(() => invoke(TERMINAL_INVOKE.CREATE, next, { id: params.id, cwd: homedir() })).toThrow(/PERMISSION_DENIED/);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(pty.kill).not.toHaveBeenCalled();
    output('remote');
    expect(source.sender.send).toHaveBeenCalledWith('terminal:data', { id: params.id, chunk: 'remote' });
    expect(next.sender.send).not.toHaveBeenCalled();
  });

  // Normal window migration/reload must recover an exited PTY without spawning
  // or preparing SSH again. The old create-rejection test missed UI retry recovery.
  // Standalone file wall time: 0.59s on Node 22.22.3 / macOS arm64.
  it('reattaches an exited remote PTY and preserves its launch on explicit restart from another window', async () => {
    const { ticket } = await prepare(source, { connection: { host: 'submitted', user: 'user', port: 2222 } });
    create(source, ticket);
    exit({ exitCode: 255 });
    expect(source.sender.send).toHaveBeenCalledWith('terminal:exit', { id: params.id, exit: { code: 255, signal: null } });
    const next = event();
    expect(create(next)).toEqual({ pid: 123, shellId: 'sh', shellDisplayName: 'SSH · submitted' });
    expect(next.sender.send).toHaveBeenCalledWith('terminal:exit', { id: params.id, exit: { code: 255, signal: null } });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const result = invoke(TERMINAL_INVOKE.RESTART, next, params.id);
    expect(result).toEqual({ pid: 123, shellId: 'sh', shellDisplayName: 'SSH · submitted' });
    expect(mocks.spawn.mock.calls[1]).toEqual(mocks.spawn.mock.calls[0]);
    output('restarted');
    expect(next.sender.send).toHaveBeenCalledWith('terminal:data', { id: params.id, chunk: 'restarted' });
    invalidate();
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(manager.has(params.id)).toBe(false);
  });

  it.each([false, true])('refuses to attach a remote tab to a local PTY (exited: %s)', async exited => {
    invoke(TERMINAL_INVOKE.CREATE, source, { id: params.id, cwd: homedir() });
    const local = pty;
    if (exited) exit({ exitCode: 0 });
    const { ticket } = await prepare();
    const next = event();
    expect(() => create(next)).toThrow(/PERMISSION_DENIED/);
    expect(() => create(source, ticket)).toThrow(/PERMISSION_DENIED/);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(local.kill).not.toHaveBeenCalled();
    if (!exited) {
      output('local');
      expect(source.sender.send).toHaveBeenCalledWith('terminal:data', { id: params.id, chunk: 'local' });
      expect(next.sender.send).not.toHaveBeenCalled();
    }
    invoke(TERMINAL_INVOKE.DISPOSE, next, params.id);
    create(source, ticket);
    expect(manager.isRemote(params.id)).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('saves an explicit submission during prepare and signs only resolvable connections', async () => {
    vi.mocked(remote.describe).mockResolvedValue({ ...description, connection: null });
    expect((await prepare()).ticket).toBeUndefined();
    expect(() => create()).toThrow(/PRECONDITION_FAILED/);
    const { ticket, connection } = await prepare(source, { connection: { host: 'submitted', port: 2222 } });
    expect(connection.host).toBe('submitted');
    expect(remote.save).toHaveBeenCalledWith(description.target.key, expect.objectContaining({ host: 'submitted', port: 2222 }), account, expect.any(Function));
    create(source, ticket);
    expect(mocks.spawn.mock.calls[0][1]).toContain('submitted');
  });

  it('rejects missing, expired and reused tickets without another describe or spawn', async () => {
    vi.useFakeTimers();
    expect(() => create()).toThrow(/PRECONDITION_FAILED/);
    const expired = (await prepare()).ticket;
    vi.advanceTimersByTime(30_000);
    expect(() => create(source, expired)).toThrow(/PRECONDITION_FAILED/);
    const expiredBeforeTimer = (await prepare()).ticket;
    vi.setSystemTime(Date.now() + 30_000);
    expect(() => create(source, expiredBeforeTimer)).toThrow(/expired/);
    const cancelled = (await prepare()).ticket;
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id);
    expect(() => create(source, cancelled)).toThrow(/PRECONDITION_FAILED/);
    const ticket = (await prepare()).ticket;
    create(source, ticket);
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id);
    expect(() => create(source, ticket)).toThrow(/PRECONDITION_FAILED/);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('fences tickets by sender, tab, task and device without consuming on a mismatch', async () => {
    const ticket = (await prepare()).ticket;
    expect(() => create(event(), ticket)).toThrow(/PERMISSION_DENIED/);
    expect(() => create(source, ticket, { id: 'other-tab' })).toThrow(/PERMISSION_DENIED/);
    for (const remoteContext of [{ ...context, sessionId: 'other' }, { ...context, deviceId: 'other' }]) {
      expect(() => invoke(TERMINAL_INVOKE.CREATE, source, { ...params, remote: { ...remoteContext, ticket } })).toThrow(/PERMISSION_DENIED/);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
    create(source, ticket);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it('consumes a ticket even if spawning fails', async () => {
    const ticket = (await prepare()).ticket;
    mocks.spawn.mockImplementation(() => { throw new Error('ENOENT private path'); });
    expect(() => create(source, ticket)).toThrow('[TERMINAL_SHELL_NOT_FOUND] Shell or SSH binary is unavailable');
    expect(() => create(source, ticket)).toThrow(/PRECONDITION_FAILED/);
  });

  it('clears signed tickets and disposes only remote PTYs on account invalidation', async () => {
    invoke(TERMINAL_INVOKE.CREATE, source, { id: 'local', cwd: homedir() });
    const local = pty;
    const ticket = (await prepare()).ticket;
    create(source, ticket);
    const ssh = pty;
    const unused = (await prepare(source, { id: 'pending' })).ticket;
    account = 'account:2';
    expect(() => create(source, unused, { id: 'pending' })).toThrow(/PERMISSION_DENIED/);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    invalidate();
    expect(ssh.kill).toHaveBeenCalledOnce();
    expect(local.kill).not.toHaveBeenCalled();
    expect(manager.has(params.id)).toBe(false);
    expect(manager.has('local')).toBe(true);
    expect(() => invoke(TERMINAL_INVOKE.RESTART, source, params.id)).toThrow(/TERMINAL_NOT_FOUND/);
    account = 'account:1';
    invalidate();
    expect(() => create(source, unused, { id: 'pending' })).toThrow(/PRECONDITION_FAILED/);
    expect(() => create(source, ticket)).toThrow(/PRECONDITION_FAILED/);
  });

  it.each(['destroyed', 'untrusted', 'account', 'aba'] as const)('rejects stale prepare after %s', async reason => {
    const metadata = deferred<RemoteTerminalDescription>();
    vi.mocked(remote.describe).mockReturnValue(metadata.promise);
    const result = prepare();
    if (reason === 'destroyed') vi.spyOn(source.sender, 'isDestroyed').mockReturnValue(true);
    if (reason === 'untrusted') Object.assign(source, { trusted: false });
    if (reason === 'account') account = 'account:2';
    if (reason === 'aba') { account = 'account:2'; invalidate(); account = 'account:1'; invalidate(); }
    metadata.resolve(description);
    await expect(result).rejects.toThrow(/PERMISSION_DENIED/);
    expect(remote.save).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('does not spawn when a tab closes during describe; the caller can discard the late ticket', async () => {
    const metadata = deferred<RemoteTerminalDescription>();
    vi.mocked(remote.describe).mockReturnValue(metadata.promise);
    const result = prepare();
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id);
    metadata.resolve(description);
    expect((await result).ticket).toEqual(expect.any(String));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('keeps an explicit submission when the tab closes during the settings write', async () => {
    const lock = deferred<void>();
    const persisted: string[] = [];
    vi.mocked(remote.save).mockImplementation(async (_key, connection, _scope, assertCurrent) => {
      await lock.promise;
      assertCurrent();
      persisted.push(connection.host);
    });
    const result = prepare(source, { connection: { host: 'submitted' } });
    await Promise.resolve();
    invoke(TERMINAL_INVOKE.DISPOSE, source, params.id);
    lock.resolve();
    expect((await result).ticket).toEqual(expect.any(String));
    expect(persisted).toEqual(['submitted']);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('revalidates account epoch while a submitted binding waits for its atomic update', async () => {
    const lock = deferred<void>();
    const persisted: string[] = [];
    vi.mocked(remote.save).mockImplementation(async (_key, connection, _scope, assertCurrent) => {
      await lock.promise;
      assertCurrent();
      persisted.push(connection.host);
    });
    const result = prepare(source, { connection: { host: 'submitted' } });
    await Promise.resolve();
    account = 'account:2'; invalidate(); account = 'account:1'; invalidate();
    lock.resolve();
    await expect(result).rejects.toThrow(/PERMISSION_DENIED/);
    expect(persisted).toEqual([]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects untrusted senders and invalid prepare inputs', async () => {
    await expect(prepare(event(source.sender, false))).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(prepare(source, { id: '' })).rejects.toThrow(/INVALID_PARAMS/);
    const { ticket } = await prepare();
    expect(() => create(event(source.sender, false), ticket)).toThrow(/PERMISSION_DENIED/);
    const destroyed = vi.spyOn(source.sender, 'isDestroyed').mockReturnValue(true);
    expect(() => create(source, ticket)).toThrow(/PERMISSION_DENIED/);
    destroyed.mockRestore();
    expect(mocks.spawn).not.toHaveBeenCalled();
    create(source, ticket);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
});
