import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type {
  HostConfig,
  ManagedConfigWriteToken,
  ReadSshConfigResult,
} from '@cindy/maker-remote-ssh';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown> | unknown>(),
  readSshConfigDetailed: vi.fn(),
  addManagedHostWithInclude: vi.fn(),
  rollbackAdd: vi.fn(),
  updateManagedHostFields: vi.fn(),
  removeManagedHost: vi.fn(),
  patchPref: vi.fn(),
  removePref: vi.fn(),
  clearAgentProxy: vi.fn(),
  removeMcpPref: vi.fn(),
  invalidateMcpEndpoint: vi.fn(),
  dbLimit: vi.fn(),
  getDbClient: vi.fn(),
  logWarn: vi.fn(),
  send: vi.fn(),
  /** This file's own profile directory (mkdtemp, removed afterwards), where Cindy's host-key store is written. */
  userData: '',
}));

vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  return {
    ...actual,
    createLogger: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.logWarn,
      error: vi.fn(),
    }),
  };
});

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-remote-ssh-runtime-'));
  return {
    ...actual,
    // Not the electron stub's shared userData: pins written here must not leak into other runs or worktrees.
    app: Object.assign(Object.create(actual.app), {
      getPath: (name: string) => (name === 'userData' ? mocks.userData : actual.app.getPath(name as never)),
    }),
    ipcMain: {
      ...actual.ipcMain,
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        mocks.handlers.set(channel, handler);
      }),
    },
    BrowserWindow: class {
      static getAllWindows() { return [{ isDestroyed: () => false, webContents: { send: mocks.send } }]; }
    },
  };
});

vi.mock('@cindy/maker-remote-ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-remote-ssh')>();
  return {
    ...actual,
    defaultSshConfigPath: () => '/virtual/.ssh/config',
    defaultManagedSshConfigPath: () => '/virtual/.ssh/cindy.conf',
    readSshConfigDetailed: mocks.readSshConfigDetailed,
    addManagedHostWithInclude: mocks.addManagedHostWithInclude,
    updateManagedHostFields: mocks.updateManagedHostFields,
    removeManagedHost: mocks.removeManagedHost,
  };
});

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: mocks.getDbClient,
}));

vi.mock('../ssh-host-prefs-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ssh-host-prefs-store.js')>();
  return {
    ...actual,
    getSshHostAgentProxy: () => null,
    getSshHostAutoConnect: () => false,
    getSshHostDisplayName: (hostId: string) => hostId,
    hasAnyAutoConnectHost: () => false,
    readSshHostPrefs: () => ({}),
    patchSshHostPref: mocks.patchPref,
    removeSshHostPref: mocks.removePref,
    setSshHostAutoConnect: vi.fn(),
  };
});

vi.mock('../agent-proxy.js', () => ({
  applyAgentProxyForHost: vi.fn(async () => undefined),
  clearAgentProxyTunnelState: mocks.clearAgentProxy,
  clearAgentProxyTunnelStateAndWait: vi.fn(async () => undefined),
  disposeAllTunnels: vi.fn(async () => undefined),
  getAgentProxyTunnelState: () => null,
  getRemoteAgentProxyEnvUppercase: () => ({}),
  handleAgentProxyMainHostDown: vi.fn(),
  initAgentProxy: vi.fn(),
  killRemoteCodexDaemon: vi.fn(async () => undefined),
  reconcileCodexAgentProxyEnv: vi.fn(async () => undefined),
  teardownAgentProxyOnUserDisconnect: vi.fn(async () => undefined),
}));

vi.mock('../cc-manager-install.js', () => ({
  clearCcManagerInstallCache: vi.fn(),
  runCcMgrUpgrade: vi.fn(),
  listPendingCcMgrUpgrades: vi.fn(() => []),
  dismissPendingCcMgrUpgrade: vi.fn(),
  ensureCcManagerInstalledOrInstall: vi.fn(),
}));

vi.mock('../codex-remote-mcp.js', () => ({
  invalidateRemoteCodexMcpEndpointState: mocks.invalidateMcpEndpoint,
  removeRemoteMcpForwardPref: mocks.removeMcpPref,
}));

vi.mock('../../maker-host/index.js', () => ({
  getMakerIfReady: () => null,
  softCloseCcSessionsForHost: vi.fn(async () => undefined),
}));

import {
  getRemoteSshHostKeyStore,
  getRemoteSshPool,
  onRemoteSshHostRemoved,
  setRemoteSshDeviceHostResolver,
  updateRemoteSshHost,
  upsertPinnedDeviceHost,
  removeRemoteSshHost,
  REMOTE_SSH_PUSH,
  probeRemoteWorkingDirectory,
  registerRemoteSshIpc,
  REMOTE_SSH_INVOKE,
  type PinnedDeviceHostSpec,
} from '../index.js';
import { listSetupSshHosts } from '../setupMigrationSsh.js';

function host(id: string, overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id,
    hostname: `192.0.2.${id.length}`,
    port: 22,
    user: 'developer',
    authMethod: 'agent',
    source: 'ssh-config',
    managedByCindy: true,
    ...overrides,
  };
}

function successfulRead(hosts: HostConfig[]): ReadSshConfigResult {
  return {
    hosts,
    diagnostic: null,
    warnings: [],
    managedConfigWriteToken: 'a'.repeat(64) as ManagedConfigWriteToken,
  };
}

function failedRead(): ReadSshConfigResult {
  return {
    hosts: [],
    diagnostic: {
      path: '/virtual/.ssh/config',
      kind: 'syntax',
      message: 'fixture parse failure',
      recoveryHint: 'fix fixture',
    },
    warnings: [],
  };
}

function handler(channel: string): (...args: any[]) => Promise<any> {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`handler not registered: ${channel}`);
  return async (...args: any[]) => registered(...args);
}

let initialListResult: {
  hosts: unknown[];
  warningCount: number;
  diagnostic: { kind: string } | null;
};

beforeAll(async () => {
  mocks.readSshConfigDetailed.mockResolvedValue(failedRead());
  registerRemoteSshIpc();
  initialListResult = await handler(REMOTE_SSH_INVOKE.LIST)({});
  mocks.readSshConfigDetailed.mockResolvedValue(successfulRead([]));
  await handler(REMOTE_SSH_INVOKE.RELOAD_CONFIG)({});
});

afterAll(() => {
  if (mocks.userData) rmSync(mocks.userData, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.readSshConfigDetailed.mockReset();
  mocks.rollbackAdd.mockReset().mockResolvedValue(true);
  mocks.addManagedHostWithInclude.mockResolvedValue({ rollback: mocks.rollbackAdd });
  mocks.updateManagedHostFields.mockReset().mockResolvedValue(undefined);
  mocks.removeManagedHost.mockReset().mockResolvedValue(undefined);
  mocks.invalidateMcpEndpoint.mockReset();
  mocks.dbLimit.mockReset().mockResolvedValue([]);
  mocks.getDbClient.mockReturnValue({
    drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.dbLimit }) }) }) },
  });
  mocks.logWarn.mockReset();
  await getRemoteSshPool().hydrate([]);
  mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead(
    getRemoteSshPool().list().map((snapshot) => snapshot.config),
  ));
});

describe('remote SSH mutation runtime semantics', () => {
  // #13489: run the actual reference query against SQLite. A stubbed result cannot
  // distinguish a deleted reference from a recoverable session after it.
  describe.each(['UPDATE', 'REMOVE'] as const)('%s session references', (operation) => {
    it.each(['deleted', 'active', 'archived'])('checks the target’s %s session', async (status) => {
      const target = host('reference-target');
      const updated = { ...target, hostname: '192.0.2.99' };
      await getRemoteSshPool().hydrate([target]);
      let diskHosts = [target];
      mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead(diskHosts));
      mocks.updateManagedHostFields.mockImplementationOnce(async () => { diskHosts = [updated]; });
      mocks.removeManagedHost.mockImplementationOnce(async () => { diskHosts = []; });
      const db = new Database(':memory:');
      try {
        db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, remote_host_id TEXT, status TEXT NOT NULL)');
        const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
        insert.run('earlier', target.id, 'deleted');
        insert.run('unrelated', 'another-host', 'active');
        insert.run('last', target.id, status);
        mocks.getDbClient.mockReturnValue({ drizzle: drizzle(db) });
        const result = operation === 'UPDATE'
          ? handler(REMOTE_SSH_INVOKE.UPDATE)({}, { ...updated, displayName: target.id })
          : handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: target.id });
        const write = operation === 'UPDATE' ? mocks.updateManagedHostFields : mocks.removeManagedHost;
        if (status === 'deleted') {
          await result;
          expect(write).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED', message: expect.stringContaining('仍被远端会话引用'),
          });
          expect(write).not.toHaveBeenCalled();
        }
      } finally {
        db.close();
      }
    });
  });

  // Unit: AI rename previously had no native path. A key-backed external host
  // with existing sessions must remain usable without exposing/replacing the key.
  it('renames through the Agent patch path without rewriting a key-backed connection', async () => {
    const original = host('agent-name', { managedByCindy: false, authMethod: 'key', identityFile: '/private/id_ed25519', port: 2222 });
    await getRemoteSshPool().hydrate([original]);
    mocks.dbLimit.mockResolvedValue([{ id: 'existing-session' }]);
    await updateRemoteSshHost({ id: original.id, displayName: '家里的服务器' }, { patch: true });
    expect(mocks.patchPref).toHaveBeenCalledWith(original.id, expect.objectContaining({ displayName: '家里的服务器' }));
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(original.id)?.config).toEqual(original);
  });

  // Unit: deleting through AI has no Settings component to remove its row.
  // The shared mutation must broadcast the sanitized remaining list itself.
  it('broadcasts the remaining SSH list after a native removal', async () => {
    const target = host('delete-from-agent');
    const other = host('keep-from-agent', { authMethod: 'key', identityFile: '/private/keep-key' });
    await getRemoteSshPool().hydrate([target, other]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([target, other]))
      .mockResolvedValueOnce(successfulRead([other]));
    await removeRemoteSshHost({ id: target.id });
    const receipt = mocks.send.mock.calls.find(([channel]) => channel === REMOTE_SSH_PUSH.HOSTS_CHANGED);
    expect(receipt?.[1].hosts.map((entry: { config: { id: string } }) => entry.config.id)).toEqual([other.id]);
    expect(JSON.stringify(receipt)).not.toContain('/private/keep-key');
  });

  it.each(['\n', '\r', '\r\n'])('rejects injected protocol lines before remote execution (%j)', async (separator) => {
    await getRemoteSshPool().hydrate([host('worker-dir')]);
    const remote = getRemoteSshPool().get('worker-dir')!;
    const status = vi.spyOn(remote, 'getStatus').mockReturnValue('ready');
    const exec = vi.spyOn(remote, 'exec');
    try {
      await expect(probeRemoteWorkingDirectory('worker-dir', `/missing${separator}dir /other`))
        .rejects.toThrow('unsupported control characters');
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
      status.mockRestore();
    }
  });

  // symlink-platform-skip: Windows cannot represent CR/LF in directory names used as link targets.
  it.skipIf(process.platform === 'win32')('validates physical paths before emitting the line protocol', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-stat-framing-'));
    await getRemoteSshPool().hydrate([host('worker-dir')]);
    const remote = getRemoteSshPool().get('worker-dir')!;
    const status = vi.spyOn(remote, 'getStatus').mockReturnValue('ready');
    const exec = vi.spyOn(remote, 'exec').mockImplementation(async (command) => {
      try {
        return { exitCode: 0, signal: null, stdout: `banner\n${execSync(command, { encoding: 'utf8' })}`, stderr: '' };
      } catch {
        return { exitCode: 64, signal: null, stdout: '', stderr: 'unsupported physical path' };
      }
    });
    try {
      const normal = join(root, 'project ');
      mkdirSync(normal);
      await expect(probeRemoteWorkingDirectory('worker-dir', normal)).resolves.toBe(realpathSync(normal));
      for (const [i, suffix] of ['\n', '\r', '\ndir other'].entries()) {
        const target = join(root, `target${suffix}`);
        const alias = join(root, `alias-${i}`);
        mkdirSync(target);
        symlinkSync(target, alias);
        await expect(probeRemoteWorkingDirectory('worker-dir', alias)).rejects.toThrow('bash exit=64');
        await expect(probeRemoteWorkingDirectory('worker-dir', join(alias, 'missing'))).rejects.toThrow('bash exit=64');
      }
    } finally {
      exec.mockRestore();
      status.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['dir /remote/project \n', 'Welcome\nnotice\ndir /remote/project \n', 'Welcome\r\ndir /remote/project \r\n'])('preserves trailing whitespace after shell startup output: %j', async (stdout) => {
    await getRemoteSshPool().hydrate([host('worker-dir')]);
    const remote = getRemoteSshPool().get('worker-dir')!;
    const status = vi.spyOn(remote, 'getStatus').mockReturnValue('ready');
    const exec = vi.spyOn(remote, 'exec').mockResolvedValue({
      exitCode: 0, signal: null, stdout, stderr: '',
    });
    try {
      await expect(probeRemoteWorkingDirectory('worker-dir', '/remote/project '))
        .resolves.toBe('/remote/project ');
      await expect(handler(REMOTE_SSH_INVOKE.STAT_REMOTE_PATH)({}, { id: 'worker-dir', path: '/remote/project ' }))
        .resolves.toEqual({ kind: 'dir', resolvedPath: '/remote/project ' });
      expect(exec).toHaveBeenCalledWith(expect.stringContaining("'/remote/project '"),
        expect.objectContaining({ timeoutMs: 10_000 }));
    } finally {
      exec.mockRestore();
      status.mockRestore();
    }
  });

  it.each([true, false])('reconnects only the selected Worker host before probing (success=%s)', async (succeeds) => {
    const pool = getRemoteSshPool();
    await pool.hydrate([host('worker-dir'), host('unrelated')]);
    const remote = pool.get('worker-dir')!;
    let ready = false;
    const status = vi.spyOn(remote, 'getStatus').mockImplementation(() => ready ? 'ready' : 'disconnected');
    const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => {
      if (!succeeds) throw new Error('fixture connection failed');
      ready = true;
    });
    const exec = vi.spyOn(remote, 'exec').mockResolvedValue({
      exitCode: 0, signal: null, stdout: 'banner\ndir /remote/project \n', stderr: '',
    });
    try {
      const result = probeRemoteWorkingDirectory('worker-dir', '/remote/project ');
      if (succeeds) {
        await expect(result).resolves.toBe('/remote/project ');
        expect(connect.mock.invocationCallOrder[0]).toBeLessThan(exec.mock.invocationCallOrder[0]!);
      } else {
        await expect(result).rejects.toThrow('fixture connection failed');
        expect(exec).not.toHaveBeenCalled();
      }
      expect(connect).toHaveBeenCalledExactlyOnceWith('worker-dir');
    } finally {
      exec.mockRestore();
      connect.mockRestore();
      status.mockRestore();
    }
  });

  it('returns a cold-start diagnostic instead of making the host list look valid and empty', () => {
    expect(initialListResult).toMatchObject({
      hosts: [],
      warningCount: 0,
      diagnostic: { kind: 'syntax' },
    });
  });

  it('does not expose main-only SSH authentication metadata or warning paths over LIST IPC', async () => {
    const visible = host('visible', {
      identityFile: '/Users/example/.ssh/private.key',
      sshAuthentication: {
        identitiesOnly: true,
        identityAgent: '/private/tmp/agent.sock',
        configuredIdentityFiles: ['/Users/example/.ssh/private.key'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
        allowedAgentFingerprints: ['SHA256:secret-fingerprint'],
      },
    });
    mocks.readSshConfigDetailed.mockResolvedValueOnce({
      hosts: [visible],
      diagnostic: null,
      warnings: ['/Users/example/.ssh/config:12: unsupported conditional Include'],
    });

    const result = await handler(REMOTE_SSH_INVOKE.RELOAD_CONFIG)({});
    expect(result.warningCount).toBe(1);
    expect(result).not.toHaveProperty('warnings');
    expect(result).not.toHaveProperty('managedConfigWriteToken');
    expect(result.hosts[0].config).not.toHaveProperty('sshAuthentication');
    expect(result.hosts[0].config).not.toHaveProperty('identityFile');
    expect(result.hosts[0].config).toMatchObject({
      identityFileConfigured: true,
      identityFileName: 'private.key',
    });
    expect(JSON.stringify(result)).not.toContain('secret-fingerprint');
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/private.key');
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/config');
  });

  it('preserves an existing main-only identity path when Renderer edits other fields', async () => {
    const current = host('preserve-key', {
      authMethod: 'key',
      identityFile: '/Users/example/.ssh/preserve.key',
    });
    await getRemoteSshPool().hydrate([current]);
    const onDisk = { ...getRemoteSshPool().get(current.id)!.config };
    const updated = { ...onDisk, hostname: '192.0.2.210' };
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([onDisk]))
      .mockResolvedValueOnce(successfulRead([onDisk]))
      .mockResolvedValueOnce(successfulRead([updated]));

    const result = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      id: current.id,
      displayName: current.id,
      hostname: updated.hostname,
      port: current.port,
      user: current.user,
      authMethod: current.authMethod,
      identityFileUnchanged: true,
    });

    expect(mocks.updateManagedHostFields).toHaveBeenCalledWith(
      expect.objectContaining({ identityFile: current.identityFile }),
      expect.any(String),
      'a'.repeat(64),
    );
    expect(result.host.config).toMatchObject({
      identityFileConfigured: true,
      identityFileName: 'preserve.key',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/example/.ssh/preserve.key');
  });

  it('keeps a live endpoint connected when UPDATE cannot write', async () => {
    const current = host('managed');
    await getRemoteSshPool().hydrate([current]);
    const live = getRemoteSshPool().get(current.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    mocks.updateManagedHostFields.mockRejectedValueOnce(
      new Error('EACCES: cannot write /Users/example/.ssh/cindy.conf'),
    );

    const error = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.99',
      displayName: current.id,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'SSH_CONFIG_IO_FAILED' });
    expect(error.message).not.toContain('/Users/example/.ssh/cindy.conf');

    expect(disconnect).not.toHaveBeenCalled();
    expect(live.config.hostname).toBe(current.hostname);
  });

  it.each([
    ['UPDATE', mocks.updateManagedHostFields],
    ['REMOVE', mocks.removeManagedHost],
  ] as const)('maps a concurrent managed-file change during %s without mutating runtime state', async (operation, writer) => {
    const current = host(`concurrent-${operation.toLowerCase()}`);
    await getRemoteSshPool().hydrate([current]);
    const live = getRemoteSshPool().get(current.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    const conflict = new Error('config changed') as Error & { code?: string };
    conflict.code = 'SSH_CONFIG_CONCURRENT_MODIFICATION';
    writer.mockRejectedValueOnce(conflict);

    const request = operation === 'UPDATE'
      ? handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
          ...current,
          hostname: '192.0.2.199',
          displayName: current.id,
        })
      : handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: current.id });
    await expect(request).rejects.toMatchObject({
      code: 'SSH_CONFIG_CONCURRENT_MODIFICATION',
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(mocks.patchPref).not.toHaveBeenCalled();
    expect(mocks.removePref).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(current.id)).toBe(live);
  });

  it('rejects a missing managed write token as an internal contract error', async () => {
    const current = host('missing-write-token');
    await getRemoteSshPool().hydrate([current]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce({
      hosts: [current],
      diagnostic: null,
      warnings: [],
    });

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.188',
      displayName: current.id,
    })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('a'.repeat(64));
  });

  it('keeps database details out of IPC and the remote-ssh log scope', async () => {
    const current = host('db-failure');
    await getRemoteSshPool().hydrate([current]);
    const sensitive = 'SQL SELECT secret FROM sessions at /Users/alice/cindy.db value=private';
    mocks.dbLimit.mockRejectedValueOnce(Object.assign(new Error(sensitive), {
      code: 'SQLITE_BUSY',
    }));

    const error = await handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: current.id })
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL' });
    expect(error.message).not.toContain(sensitive);
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(mocks.logWarn.mock.calls)).toContain('SQLITE_BUSY');
    expect(mocks.removeManagedHost).not.toHaveBeenCalled();
  });

  it.each([
    ['a thrown filesystem error', () => {
      mocks.readSshConfigDetailed.mockRejectedValueOnce(
        new Error('EACCES: cannot read /Users/example/.ssh/config'),
      );
    }],
    ['a returned diagnostic', () => {
      mocks.readSshConfigDetailed.mockResolvedValueOnce({
        hosts: [],
        diagnostic: {
          path: '/Users/example/.ssh/included.conf',
          kind: 'io',
          message: 'EACCES: cannot read /Users/example/.ssh/included.conf',
          recoveryHint: 'fix permissions',
        },
        warnings: [],
      });
    }],
  ])('does not expose local paths when config preflight returns %s', async (_label, failRead) => {
    const current = host('private-path');
    await getRemoteSshPool().hydrate([current]);
    failRead();

    const error = await handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...current,
      hostname: '192.0.2.199',
      displayName: current.id,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'SSH_CONFIG_IO_FAILED' });
    expect(error.message).not.toContain('/Users/example');
    expect(error.message).not.toContain('EACCES');
  });

  it('keeps existing aliases connected when ADD writes but refresh fails', async () => {
    const existing = host('existing');
    await getRemoteSshPool().hydrate([existing]);
    const live = getRemoteSshPool().get(existing.id)!;
    const disconnect = vi.spyOn(live, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([existing]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: 'new-host',
      hostname: '192.0.2.77',
      user: 'developer',
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(disconnect).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(existing.id)).toBe(live);
    expect(getRemoteSshPool().get('new-host')).toBeUndefined();
    expect(mocks.patchPref).toHaveBeenCalledWith('new-host', {
      displayName: 'new-host',
    });
  });

  it('rejects an ADD when the newly introduced alias is no longer Cindy-owned', async () => {
    const conflicting = host('new-host', { managedByCindy: false });
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([]))
      .mockResolvedValueOnce(successfulRead([conflicting]));

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: conflicting.id,
      hostname: conflicting.hostname,
      user: conflicting.user,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mocks.rollbackAdd).toHaveBeenCalledOnce();
    expect(mocks.patchPref).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(conflicting.id)).toBeUndefined();
  });

  it('does not report ADD success when the managed-file rollback cannot be confirmed', async () => {
    const conflicting = host('rollback-unknown', { managedByCindy: false });
    mocks.rollbackAdd.mockResolvedValueOnce(false);
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([]))
      .mockResolvedValueOnce(successfulRead([conflicting]));

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: conflicting.id,
      hostname: conflicting.hostname,
      user: conflicting.user,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mocks.rollbackAdd).toHaveBeenCalledOnce();
    expect(mocks.patchPref).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(conflicting.id)).toBeUndefined();
  });

  it('reports a stable partial-success code when ADD commits but local prefs cannot be written', async () => {
    const added = host('prefs-failed');
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([]))
      .mockResolvedValueOnce(successfulRead([added]));
    mocks.patchPref.mockImplementationOnce(() => {
      throw new Error('userData is read-only');
    });

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: added.id,
      hostname: added.hostname,
      user: added.user,
      displayName: 'Friendly name',
    })).rejects.toMatchObject({ code: 'SSH_HOST_PREFS_WRITE_FAILED' });

    expect(mocks.addManagedHostWithInclude).toHaveBeenCalledOnce();
    expect(getRemoteSshPool().get(added.id)?.config.id).toBe(added.id);
  });

  it('reports an ownership error when the existing managed SSH file is unclaimed', async () => {
    const ownershipError = new Error('existing managed SSH config is not owned by Cindy') as Error & { code?: string };
    ownershipError.code = 'SSH_CONFIG_OWNERSHIP_REQUIRED';
    mocks.addManagedHostWithInclude.mockRejectedValueOnce(ownershipError);

    await expect(handler(REMOTE_SSH_INVOKE.ADD)({}, {
      id: 'unclaimed-file',
      hostname: '192.0.2.73',
      user: 'developer',
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_OWNERSHIP_REQUIRED' });
    expect(mocks.patchPref).not.toHaveBeenCalled();
  });

  it('reports a stable local-prefs error instead of a raw filesystem failure on UPDATE', async () => {
    const external = host('prefs-only', { managedByCindy: false });
    await getRemoteSshPool().hydrate([external]);
    mocks.patchPref.mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      displayName: 'Unsaved name',
    })).rejects.toMatchObject({ code: 'SSH_HOST_PREFS_WRITE_FAILED' });

    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(external.id)).toBeTruthy();
  });

  it('disconnects only the target when UPDATE writes but refresh fails', async () => {
    const target = host('target');
    const other = host('other');
    await getRemoteSshPool().hydrate([target, other]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const otherLive = getRemoteSshPool().get(other.id)!;
    const targetDisconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    const otherDisconnect = vi.spyOn(otherLive, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([target, other]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...target,
      hostname: '192.0.2.88',
      displayName: target.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(targetDisconnect).toHaveBeenCalledTimes(1);
    expect(otherDisconnect).not.toHaveBeenCalled();
    expect(targetLive.config.hostname).toBe(target.hostname);
    expect(mocks.patchPref).toHaveBeenCalledWith(target.id, {
      displayName: target.id,
    });
  });

  it('disconnects only the target when REMOVE writes but refresh fails', async () => {
    const target = host('remove-me');
    const other = host('keep-me');
    await getRemoteSshPool().hydrate([target, other]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const otherLive = getRemoteSshPool().get(other.id)!;
    const targetDisconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    const otherDisconnect = vi.spyOn(otherLive, 'disconnect').mockResolvedValue();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([target, other]))
      .mockResolvedValueOnce(failedRead());

    await expect(handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: target.id }))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(targetDisconnect).toHaveBeenCalledTimes(1);
    expect(otherDisconnect).not.toHaveBeenCalled();
    expect(getRemoteSshPool().get(target.id)).toBe(targetLive);
    expect(mocks.removePref).toHaveBeenCalledWith(target.id);
    expect(mocks.clearAgentProxy).toHaveBeenCalledWith(target.id);
    expect(mocks.removeMcpPref).toHaveBeenCalledWith(target.id);
  });

  // Async MCP persistence must be awaited before REMOVE reports success.
  // Unit: previous synchronous cleanup coverage cannot expose a late rejection.
  it('waits for asynchronous MCP cleanup and preserves removal on persistence failure', async () => {
    const target = host('remove-async-cleanup');
    await getRemoteSshPool().hydrate([target]);
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([target]))
      .mockResolvedValue(successfulRead([]));
    let rejectCleanup!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new Promise<void>((_, reject) => { rejectCleanup = reject; });
    mocks.removeMcpPref.mockImplementationOnce(() => { entered(); return cleanup; });
    let settled = false;
    const removal = handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: target.id });
    void removal.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([started, removal]);
    expect(settled).toBe(false);
    rejectCleanup(new Error('synthetic prefs write failure'));
    await expect(removal).resolves.toEqual({ ok: true });
    expect(mocks.removeManagedHost.mock.calls[0]?.[0]).toBe(target.id);
    expect(mocks.clearAgentProxy).toHaveBeenCalledWith(target.id);
  });

  // A slow prefs write must not postpone RemoteHost.disconnect's epoch fence:
  // cindy_ssh/list_machines can use the old pool host outside the mutation queue.
  // Unit: spy wraps the real disconnect; no SSH/socket or private epoch access.
  it('fences the old endpoint before slow asynchronous MCP persistence finishes', async () => {
    const target = host('slow-endpoint-prefs');
    const other = host('unaffected-endpoint');
    const updated = { ...target, hostname: '192.0.2.99' };
    await getRemoteSshPool().hydrate([target, other]);
    const oldHost = getRemoteSshPool().get(target.id)!;
    const disconnect = vi.spyOn(oldHost, 'disconnect');
    const otherDisconnect = vi.spyOn(getRemoteSshPool().get(other.id)!, 'disconnect');
    let committed = false;
    mocks.updateManagedHostFields.mockImplementationOnce(async () => { committed = true; });
    mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead(
      committed ? [updated, other] : [target, other],
    ));
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mocks.invalidateMcpEndpoint.mockImplementationOnce(() => { entered(); return pending; });
    const update = handler(REMOTE_SSH_INVOKE.UPDATE)({}, { ...updated, displayName: target.id });
    try {
      await Promise.race([started, update]);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(otherDisconnect).not.toHaveBeenCalled();
    } finally {
      release();
      await update;
    }
    expect(getRemoteSshPool().get(target.id)?.config.hostname).toBe(updated.hostname);
  });

  it('still disconnects the target when endpoint cleanup fails after UPDATE writes', async () => {
    const target = host('cleanup-failure');
    await getRemoteSshPool().hydrate([target]);
    const targetLive = getRemoteSshPool().get(target.id)!;
    const disconnect = vi.spyOn(targetLive, 'disconnect').mockResolvedValue();
    mocks.invalidateMcpEndpoint.mockRejectedValueOnce(new Error('prefs disk unavailable'));

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...target,
      hostname: '192.0.2.89',
      displayName: target.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_RELOAD_REQUIRED' });

    expect(mocks.updateManagedHostFields).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getRemoteSshPool().get(target.id)).toBe(targetLive);
    expect(targetLive.config.hostname).toBe(target.hostname);
  });

  it('rejects external connection edits but allows local preference edits', async () => {
    const external = host('external', { managedByCindy: false });
    await getRemoteSshPool().hydrate([external]);

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      hostname: '192.0.2.111',
      displayName: 'Renamed',
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_OWNERSHIP_REQUIRED' });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...external,
      displayName: 'Renamed',
      agentProxy: null,
    })).resolves.toMatchObject({
      host: { config: { id: external.id } },
    });
    expect(mocks.patchPref).toHaveBeenCalledWith(external.id, {
      displayName: 'Renamed',
      agentProxy: null,
    });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
  });

  it('refuses UPDATE when the latest disk graph no longer uniquely owns the alias', async () => {
    const managed = host('duplicate-update');
    await getRemoteSshPool().hydrate([managed]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([
      { ...managed, managedByCindy: false },
    ]));

    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      ...managed,
      hostname: '192.0.2.200',
      displayName: managed.id,
    })).rejects.toMatchObject({ code: 'SSH_CONFIG_OWNERSHIP_REQUIRED' });

    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
  });

  it('refuses REMOVE when the latest disk graph no longer uniquely owns the alias', async () => {
    const managed = host('duplicate-remove');
    await getRemoteSshPool().hydrate([managed]);
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([
      { ...managed, managedByCindy: false },
    ]));

    await expect(handler(REMOTE_SSH_INVOKE.REMOVE)({}, { id: managed.id }))
      .rejects.toMatchObject({ code: 'SSH_CONFIG_OWNERSHIP_REQUIRED' });

    expect(mocks.removeManagedHost).not.toHaveBeenCalled();
    expect(mocks.removePref).not.toHaveBeenCalled();
  });
});

/*
 * SSH access to the person's own devices (decisions 6 and 8, 2026-11-26). Entry points: the main-only
 * upsertPinnedDeviceHost, the Settings UPDATE/REMOVE/LIST handlers and new-computer setup's host list, with the
 * managed writers mocked as above and the real host-key store (in this file's own profile directory). Observable: the pinned key in known-hosts.json under
 * the HostKeyAlias, the block written with strict checking, a deleted host reported missing instead of re-added, an
 * alias that is someone else's left alone, connection fields of a device host refused in Settings, the
 * 「来自我的设备」 label on LIST, 「主机指纹已核对」 (hostKeyPinned) only for a key that really is pinned, and the removal
 * reaching the controller. Unit tier.
 */
describe('hosts for the person\'s own devices', () => {
  const spec = (overrides: Partial<PinnedDeviceHostSpec> = {}): PinnedDeviceHostSpec => ({
    alias: 'cindy-studio',
    displayName: 'Studio',
    previousDisplayName: null,
    hostname: '203.0.113.7',
    port: 22,
    user: 'ubuntu',
    identityFile: '/profile/owners/abc/ssh-access/id_ed25519',
    hostKeyAlias: 'cindy-device-abc123',
    userKnownHostsFile: '~/.ssh/cindy_known_hosts',
    hostKeyFingerprint: 'SHA256:pinned-first',
    ...overrides,
  });
  const onDisk = (value: PinnedDeviceHostSpec) => host(value.alias, {
    hostname: value.hostname, port: value.port, user: value.user, authMethod: 'key', identityFile: value.identityFile,
    hostKeyAlias: value.hostKeyAlias, strictHostKeyChecking: true,
  });

  it('pins the key under its alias, adds and updates the block, and never writes a deleted or foreign alias', async () => {
    const first = spec();
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([]))
      .mockResolvedValueOnce(successfulRead([onDisk(first)]));
    await expect(upsertPinnedDeviceHost(first, { expectPresent: false })).resolves.toBe('created');
    expect(mocks.addManagedHostWithInclude).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cindy-studio', authMethod: 'key', identityFile: first.identityFile, hostKeyAlias: 'cindy-device-abc123',
      userKnownHostsFile: '~/.ssh/cindy_known_hosts', strictHostKeyChecking: true, managedByCindy: true,
    }), expect.any(String), expect.any(String));
    expect(await getRemoteSshHostKeyStore().get('cindy-device-abc123')).toBe('SHA256:pinned-first');
    expect(mocks.patchPref).toHaveBeenCalledWith('cindy-studio', { displayName: 'Studio' });

    // The device moved and re-keyed: the pin and the block follow it.
    const moved = spec({ hostname: '203.0.113.9', hostKeyFingerprint: 'SHA256:pinned-second' });
    mocks.readSshConfigDetailed
      .mockResolvedValueOnce(successfulRead([onDisk(first)]))
      .mockResolvedValueOnce(successfulRead([onDisk(moved)]));
    await expect(upsertPinnedDeviceHost(moved, { expectPresent: true })).resolves.toBe('updated');
    expect(mocks.updateManagedHostFields).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '203.0.113.9', hostKeyAlias: 'cindy-device-abc123', strictHostKeyChecking: true }),
      expect.any(String), 'a'.repeat(64),
    );
    expect(await getRemoteSshHostKeyStore().get('cindy-device-abc123')).toBe('SHA256:pinned-second');

    mocks.addManagedHostWithInclude.mockClear();
    mocks.updateManagedHostFields.mockClear();
    // Deleted by the person: reported, not written back. Someone else's alias: left alone, nothing pinned.
    mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([]));
    await expect(upsertPinnedDeviceHost(spec({ hostKeyFingerprint: 'SHA256:after-delete' }), { expectPresent: true })).resolves.toBe('missing');
    for (const foreign of [host('cindy-studio', { managedByCindy: false }), host('cindy-studio')]) {
      mocks.readSshConfigDetailed.mockResolvedValueOnce(successfulRead([foreign]));
      await expect(upsertPinnedDeviceHost(spec({ hostKeyFingerprint: 'SHA256:foreign' }), { expectPresent: false })).resolves.toBe('alias-taken');
    }
    expect(mocks.addManagedHostWithInclude).not.toHaveBeenCalled();
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    expect(await getRemoteSshHostKeyStore().get('cindy-device-abc123')).toBe('SHA256:pinned-second');
  });

  // 「主机指纹已核对」 follows the pin itself, not the device-host flag: a device host whose key is missing from the store,
  // or whose block no longer requires a known key, is not reported pinned.
  it('reports a device host\'s key pinned only when its block requires a known key and Cindy\'s store holds one', async () => {
    const store = getRemoteSshHostKeyStore();
    const pinned = onDisk(spec({ alias: 'cindy-cloud', hostKeyAlias: 'cindy-device-cloud01' }));
    const unpinned = onDisk(spec({ alias: 'cindy-mini', hostKeyAlias: 'cindy-device-mini01' }));
    const { strictHostKeyChecking: _strict, ...lax } = onDisk(spec({ alias: 'cindy-lax', hostKeyAlias: 'cindy-device-lax01' }));
    await store.pin('cindy-device-cloud01', 'SHA256:cloud');
    await store.pin('cindy-device-lax01', 'SHA256:lax');
    const hosts = [pinned, unpinned, lax, host('dev-server')];
    await getRemoteSshPool().hydrate(hosts);
    mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead(hosts));
    const listed = await handler(REMOTE_SSH_INVOKE.LIST)({});
    expect(listed.hosts.filter((entry: { hostKeyPinned?: true }) => entry.hostKeyPinned).map((entry: { config: { id: string } }) => entry.config.id))
      .toEqual(['cindy-cloud']);

    // Pinned here by the controller: the status push that follows says so without another read of the store.
    mocks.send.mockClear();
    await expect(upsertPinnedDeviceHost(spec({ alias: 'cindy-mini', hostKeyAlias: 'cindy-device-mini01', hostKeyFingerprint: 'SHA256:mini' }), { expectPresent: true }))
      .resolves.toBe('unchanged');
    expect(mocks.send).toHaveBeenCalledWith(REMOTE_SSH_PUSH.STATUS_CHANGED, expect.objectContaining({
      config: expect.objectContaining({ id: 'cindy-mini' }), hostKeyPinned: true,
    }));
  });

  it('refuses Settings edits of a device host\'s connection, labels it on LIST, tells the controller of its removal and keeps it out of setup', async () => {
    const device = onDisk(spec());
    const ordinary = host('dev-server');
    await getRemoteSshPool().hydrate([device, ordinary]);
    mocks.readSshConfigDetailed.mockImplementation(async () => successfulRead([device, ordinary]));
    await expect(handler(REMOTE_SSH_INVOKE.UPDATE)({}, {
      id: device.id, displayName: 'Studio', hostname: '198.51.100.1', port: 22, user: 'ubuntu', authMethod: 'key', identityFileUnchanged: true,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.updateManagedHostFields).not.toHaveBeenCalled();
    await updateRemoteSshHost({ id: device.id, displayName: '我的云主机' }, { patch: true });
    expect(mocks.patchPref).toHaveBeenCalledWith(device.id, expect.objectContaining({ displayName: '我的云主机' }));

    setRemoteSshDeviceHostResolver((hostId) => (hostId === device.id ? { deviceId: 'abc123', available: false } : null));
    try {
      const listed = await handler(REMOTE_SSH_INVOKE.LIST)({});
      const byId = new Map(listed.hosts.map((entry: { config: { id: string } }) => [entry.config.id, entry]));
      expect(byId.get(device.id)).toMatchObject({ device: { deviceId: 'abc123', available: false } });
      expect(byId.get(ordinary.id)).not.toHaveProperty('device');
      expect((await listSetupSshHosts()).map((entry) => entry.id)).toEqual([ordinary.id]);
    } finally {
      setRemoteSshDeviceHostResolver(null);
    }

    const removed = vi.fn();
    const stop = onRemoteSshHostRemoved(removed);
    try {
      mocks.readSshConfigDetailed
        .mockResolvedValueOnce(successfulRead([device, ordinary]))
        .mockResolvedValueOnce(successfulRead([ordinary]));
      await removeRemoteSshHost({ id: device.id });
      expect(removed).toHaveBeenCalledExactlyOnceWith(device.id);
    } finally {
      stop();
    }
  });
});
