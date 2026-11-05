import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalRemoteTerminalConnection } from '../remoteTerminal';

/**
 * Test value: production description/launch/runtime entry points protect account and task
 * isolation, OpenSSH alias resolution and settings writes after lock waits (Electron §5,
 * credentials/local-storage account boundary). No prior tests cover the remote adapter.
 * Minimal failures: same nested host on two devices; Match alias with a default pool user;
 * cancellation/account change during a pending atomic update. Tier: unit, memory only.
 * P2 regression: synthetic manual-host / legacy-binding identity paths must stay in main,
 * while prepare retains -i and rejects redirected or stale credential references.
 * Standalone Vitest wall time: 1.41s (25 cases, macOS); initial P2 red: 0.88s.
 */
const mocks = vi.hoisted(() => ({
  scope: 'account:1',
  bindings: {} as Record<string, InternalRemoteTerminalConnection>,
  row: { id: 'task', workingDir: '/project', remoteHostId: 'nested', status: 'active' } as Record<string, unknown> | null,
  hosts: [] as Array<{ id: string; hostname: string; user: string; port: number; identityFile?: string; source?: string }>,
  update: vi.fn(),
  remoteInvoke: vi.fn(),
  deviceList: vi.fn(),
  onInvalidated: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.scope,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: mocks.scope.split(':')[0] }),
  isAppSessionBoundaryPending: () => false,
  onAppSessionInvalidated: mocks.onInvalidated,
  ownerScopedUserDataPath: () => 'unused-memory-settings',
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionRowSnapshotStrict: async () => mocks.row }));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: mocks.remoteInvoke }));
vi.mock('../../device-link/deviceLinkApi.js', () => ({ deviceLinkApiFetch: mocks.deviceList }));
vi.mock('../../remote-ssh/index.js', () => ({ getRemoteSshPoolHydrated: async () => ({ list: () => mocks.hosts.map(config => ({ config })) }) }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    read: () => ({ bindings: mocks.bindings }), invalidateIfChanged: vi.fn(), updateAtomic: mocks.update,
  }),
}));

import { describeRemoteTerminal, parseRemoteConnection, remoteLaunch, remoteShellScript } from '../remoteTerminal';
import { createRemoteTerminalRuntime } from '../remoteTerminalRuntime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = 'account:1';
  mocks.bindings = {};
  mocks.row = { id: 'task', workingDir: '/project', remoteHostId: 'nested', status: 'active' };
  mocks.hosts = [];
  mocks.deviceList.mockResolvedValue({ devices: [{ deviceId: 'device' }, { deviceId: 'other-device' }] });
  mocks.remoteInvoke.mockImplementation(async () => ({ ok: true, result: mocks.row }));
  mocks.update.mockImplementation(async updater => { mocks.bindings = updater({ value: { bindings: mocks.bindings } }).bindings; });
});

describe('remote connection and launch validation', () => {
  it.each([
    { host: '-oProxyCommand=bad' }, { host: 'host;command' }, { host: 'host', user: '-option' },
    { host: 'host', port: 0 }, { host: 'host', port: 65536 }, { host: 'host', identityFile: '-option' },
    { host: 'host\nother' },
  ])('rejects connection values that can be interpreted as options or shell syntax: %j', value => {
    expect(() => parseRemoteConnection(value)).toThrow(/INVALID_PARAMS/);
  });

  it('uses the Windows SSH executable directly and keeps remote POSIX paths out of local cwd', () => {
    const result = remoteLaunch({ host: 'alias', user: 'user', port: 2222 }, '/remote/work', 'win32');
    expect(result.launch?.command).toBe('ssh.exe');
    expect(result.launch?.args).toContain('-l');
    expect(result.launch?.args).toContain('2222');
    expect(result.cwd).not.toBe('/remote/work');
    expect(result.launch?.args.slice(-3, -1)).toEqual(['--', 'alias']);
    expect(() => remoteLaunch({ host: 'alias' }, 'C:\\work', 'win32')).toThrow(/Windows targets are unsupported/);
  });

  it('wraps a short POSIX command, leaving the remote user login shell to load its configuration', () => {
    expect(remoteShellScript('/remote/work')).toBe('cd -- \'/remote/work\' && exec "${SHELL:-/bin/sh}" -l');
    const command = remoteLaunch({ host: 'alias' }, "/remote/a'b `tick` $value \\ tail").launch!.args.at(-1)!;
    // Protocol regression: fish must not receive backslash-backtick in a double-quoted segment.
    expect(command).toContain("'`'");
    expect(command).not.toContain('\\`');
    expect(command).toContain('\\$');
  });

  // PR8881 r4475914874 / unit: existing alias coverage missed leading dots.
  // Minimal input .work must describe the task and reach OpenSSH unchanged.
  it.each(['nested', '.work'])('leaves Match/Include alias %s user, port and identity to system OpenSSH', async host => {
    mocks.row = { ...mocks.row, remoteHostId: host };
    mocks.hosts = [{ id: host, hostname: 'resolved-host', user: 'pool-default', port: 22, identityFile: '/pool/key', source: 'ssh-config' }];
    const runtime = createRemoteTerminalRuntime();
    const description = await runtime.describe({ sessionId: 'task' });
    expect(description.connection).toEqual({ host });
    expect(description.candidates).toEqual([{ host }]);
    const args = (await runtime.prepare(description.connection!, description.target.cwd, description.target.key, mocks.scope, () => {})).launch!.args;
    expect(args.slice(-3, -1)).toEqual(['--', host]);
    expect(args).not.toContain('-l');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-i');
    // Cindy supplies the task-directory command; an alias RemoteCommand must not conflict.
    expect(args).toContain('RemoteCommand=none');
  });
});

describe('remote runtime ownership and bindings', () => {
  it('preserves sessions only during boundaries and explicit projection repair commits', () => {
    const notify = vi.fn();
    createRemoteTerminalRuntime().onInvalidated(notify);
    const callback = mocks.onInvalidated.mock.calls[0][0];
    callback({ kind: 'boundary', ownerChanged: false });
    callback({ kind: 'commit', ownerChanged: false, generationReason: 'projection-repair' });
    callback({ kind: 'commit', ownerChanged: false });
    callback({ kind: 'commit', ownerChanged: true, generationReason: 'projection-repair' });
    expect(notify.mock.calls).toEqual([[false], [false], [true], [true]]);
  });

  it('rejects credential preparation completing after account invalidation', async () => {
    const runtime = createRemoteTerminalRuntime();
    mocks.hosts = [{ id: 'nested', hostname: 'build.example.test', user: 'builder', port: 22, identityFile: '/synthetic/private/key_ed25519', source: 'manual' }];
    const result = await runtime.describe({ sessionId: 'task' });
    const preparing = runtime.prepare(result.connection!, '/project', result.target.key, mocks.scope, () => {});
    mocks.scope = 'account:2';
    await expect(preparing).rejects.toThrow(/PERMISSION_DENIED/);
  });

  // P2 validation-path-snippet: describe must not serialize manual-host credential paths (unit).
  it('keeps managed private-key paths out of renderer descriptions', async () => {
    mocks.hosts = [{ id: 'nested', hostname: 'build.example.test', user: 'builder', port: 22, identityFile: '/synthetic/private/key_ed25519', source: 'manual' }];
    const runtime = createRemoteTerminalRuntime();
    const result = await runtime.describe({ sessionId: 'task' });
    expect(JSON.stringify(result)).not.toContain('/synthetic/private/key_ed25519');
    expect(result.connection?.hostRef).toBeTruthy();
    expect(result.candidates[0]).toEqual(result.connection);
    const prepared = await runtime.prepare(result.connection!, result.target.cwd, result.target.key, mocks.scope, () => {});
    expect(prepared.launch?.args).toContain('/synthetic/private/key_ed25519');
    await runtime.save(result.target.key, result.connection!, mocks.scope, () => {});
    expect(mocks.bindings[result.target.key].identityFile).toBe('/synthetic/private/key_ed25519');
    const restored = await runtime.describe({ sessionId: 'task' });
    expect(JSON.stringify(restored)).not.toContain('/synthetic/private/key_ed25519');
    expect((await runtime.prepare(restored.connection!, '/project', restored.target.key, mocks.scope, () => {})).launch?.args).toContain('/synthetic/private/key_ed25519');
  });
  it('rejects forged paths, foreign references, changed destinations and stale generations', async () => {
    const runtime = createRemoteTerminalRuntime();
    mocks.hosts = [{ id: 'nested', hostname: 'build.example.test', user: 'builder', port: 22, identityFile: '/synthetic/private/key_ed25519', source: 'manual' }];
    const result = await runtime.describe({ sessionId: 'task' });
    const prepare = (connection: unknown) => runtime.prepare(connection as NonNullable<typeof result.connection>, '/project', result.target.key, mocks.scope, () => {});
    await expect(prepare({ host: 'chosen', identityFile: '/synthetic/forged' })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(prepare({ ...result.connection, hostRef: 'forged' })).rejects.toThrow(/PRECONDITION_FAILED/);
    await expect(prepare({ ...result.connection, host: 'attacker.example.test' })).rejects.toThrow(/PRECONDITION_FAILED/);
    await expect(prepare({ ...result.connection, user: 'other' })).rejects.toThrow(/PRECONDITION_FAILED/);
    const owner = runtime.ownerKey();
    mocks.scope = 'account:2';
    expect(runtime.ownerKey()).toBe(owner);
    await expect(prepare(result.connection)).rejects.toThrow(/PRECONDITION_FAILED/);
    mocks.scope = 'other-account:1';
    expect(runtime.ownerKey()).not.toBe(owner);
    await expect(prepare(result.connection)).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('restores a legacy binding without exposing its path or accepting it for another target', async () => {
    const runtime = createRemoteTerminalRuntime();
    const key = JSON.stringify(['device', 'nested']);
    mocks.bindings[key] = { host: 'legacy', identityFile: '/synthetic/private/legacy' };
    const result = await runtime.describe({ sessionId: 'task', deviceId: 'device' });
    expect(JSON.stringify(result)).not.toContain('/synthetic/private/legacy');
    const launch = await runtime.prepare(result.connection!, '/project', key, mocks.scope, () => {});
    expect(launch.launch?.args).toContain('/synthetic/private/legacy');
    await expect(runtime.prepare(result.connection!, '/project', 'another-target', mocks.scope, () => {})).rejects.toThrow(/PRECONDITION_FAILED/);
    mocks.bindings = {};
    await expect(runtime.prepare(result.connection!, '/project', key, mocks.scope, () => {})).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('reuses explicitly submitted bindings across tasks, isolated by device and nested host', async () => {
    const runtime = createRemoteTerminalRuntime();
    const first = await runtime.describe({ sessionId: 'task', deviceId: 'device' });
    expect(first.connection).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    await runtime.save(first.target.key, { host: 'chosen' }, mocks.scope, () => {});
    mocks.row = { ...mocks.row, id: 'task-2' };
    expect((await runtime.describe({ sessionId: 'task-2', deviceId: 'device' })).connection).toEqual({ host: 'chosen' });
    expect((await runtime.describe({ sessionId: 'task-2', deviceId: 'other-device' })).connection).toBeNull();
    mocks.row = { ...mocks.row, remoteHostId: 'different-nested-host' };
    expect((await runtime.describe({ sessionId: 'task-2', deviceId: 'device' })).connection).toBeNull();
  });

  it.each(['account', 'cancel'] as const)('rejects %s invalidation inside the atomic update callback', async reason => {
    const lock = deferred();
    mocks.update.mockImplementation(async updater => {
      await lock.promise;
      mocks.bindings = updater({ value: { bindings: mocks.bindings } }).bindings;
    });
    let cancelled = false;
    const saving = createRemoteTerminalRuntime().save('target', { host: 'chosen' }, mocks.scope, () => {
      if (cancelled) throw new Error('request cancelled');
    });
    if (reason === 'account') mocks.scope = 'account:2';
    else cancelled = true;
    lock.resolve();
    await expect(saving).rejects.toThrow(reason === 'account' ? /PERMISSION_DENIED/ : /Unable to save/);
    expect(mocks.bindings).toEqual({});
  });

  it('rejects a non-owned device before reading any task metadata', async () => {
    await expect(createRemoteTerminalRuntime().describe({ sessionId: 'task', deviceId: 'foreign' })).rejects.toThrow(/PERMISSION_DENIED/);
    expect(mocks.remoteInvoke).not.toHaveBeenCalled();
  });

  it('fences metadata returned after an account-generation change', async () => {
    const reply = deferred();
    mocks.remoteInvoke.mockImplementation(async () => { await reply.promise; return { ok: true, result: mocks.row }; });
    const request = createRemoteTerminalRuntime().describe({ sessionId: 'task', deviceId: 'device' });
    await Promise.resolve();
    mocks.scope = 'account:2';
    reply.resolve();
    await expect(request).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it.each([
    null,
    { workingDir: '/project', remoteHostId: 'nested', status: 'deleted' },
    { workingDir: '/project' },
    { workingDir: 'C:\\project', remoteHostId: null },
    { workingDir: '/local', remoteHostId: null },
  ])('refuses missing/deleted/incomplete/Windows/local task metadata: %j', async row => {
    await expect(describeRemoteTerminal({ sessionId: 'task' }, {
      task: async () => row, hosts: async () => [], binding: () => undefined, project: connection => connection,
    })).rejects.toThrow();
  });
});
