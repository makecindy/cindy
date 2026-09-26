vi.mock('../../mcp-integrations/moveSession', () => ({ moveSessionProjectFromHost: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseAttachmentOssRef } from '@cindy/device-link';

const state = vi.hoisted(() => ({
  root: '',
  context: null as unknown as AsyncLocalStorage<{ device: string; peer?: string }>,
  dbs: new Map<string, { query: ReturnType<typeof vi.fn>; queryOne: ReturnType<typeof vi.fn> }>(),
  rows: new Map<string, Map<string, Record<string, unknown>>>(),
  files: new Map<string, string>(),
  imports: vi.fn(),
  created: vi.fn(),
  snapshot: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  boundaryBusy: false,
  drain: vi.fn(),
  exported: vi.fn(),
  loseReply: '' as string,
  importsFail: false,
  siblingRunning: false,
  noSpace: false,
  restoresFail: false,
  sharingLatest: [] as Array<{
    shared_task_id: string;
    session_id: string;
    terminal: number;
    snapshot: null;
  }>,
  workers: [] as string[],
}));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast', () => ({ emitSessionCreated: (id: string) => state.created(id) }));
vi.mock('electron', () => ({ app: { getPath: () => state.root }, ipcMain: { handle: vi.fn() } }));
vi.mock('../resources', async (original) => {
  const actual = await original<typeof import('../resources')>();
  return {
    ...actual,
    assertDiskCapacity: async (allocations: Parameters<typeof actual.assertDiskCapacity>[0]) => {
      if (state.noSpace && device() === 'B') throw new Error('MIGRATION_NO_SPACE');
      return actual.assertDiskCapacity(allocations);
    },
  };
});
function device() {
  return state.context.getStore()?.device ?? 'A';
}
vi.mock('../../appSessionState', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(state.root, device(), ...parts),
  activeOwnerScopeKey: () => `${device()}:owner`,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => state.dbs.get(device()),
  tryGetDbClient: () => state.dbs.get(device()),
}));
vi.mock('../../localDb/sessionRouteLock', () => ({
  withSessionRouteLock: (_id: string, fn: () => unknown) => fn(),
  withSessionRouteLocks: (_ids: string[], fn: () => unknown) => fn(),
}));
vi.mock('../../localDb/orcaTeamStore', () => ({
  getActiveTeamByLead: async () => ({ id: 'team' }),
}));
vi.mock('../../device-link/invoke-context', () => ({
  getDeviceLinkInvokeContext: () => {
    const peer = state.context.getStore()?.peer;
    return peer ? { controllerDeviceId: peer } : null;
  },
}));
vi.mock('../../device-link/settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }),
}));
vi.mock('../../device-link', () => ({
  getSelfDeviceId: device,
  remoteInvoke: async (
    target: string,
    _channel: string,
    args: Array<{ action: string }>,
    opts?: { preSend(): void },
  ) => {
    opts?.preSend();
    const peer = device();
    const result = await state.context.run({ device: target, peer }, () =>
      requestTaskMigration(args[0]),
    );
    if (state.loseReply === args[0].action) {
      state.loseReply = '';
      throw new Error('connection lost after commit');
    }
    return { ok: true, result };
  },
}));
vi.mock('../../device-link/filePeer', () => ({ tryUploadPeerAttachment: async () => null }));
vi.mock('../../device-link/mediaTransfer', () => ({
  MAX_MEDIA_BYTES: 2 * 1024 ** 3,
  removeRemote: (key: string) => state.remove(key),
  uploadLocalFile: async (file: string) => {
    const bytes = await fs.readFile(file),
      key = `migration/${state.files.size}`;
    state.files.set(key, file);
    return { key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  },
}));
vi.mock('../../device-link/remoteAttachment', () => ({
  parseRemoteAttachmentRef: (ref: string) => parseAttachmentOssRef(ref),
  materializeRemoteAttachment: (ref: { ossKey: string }, destination: string) =>
    fs.copyFile(state.files.get(ref.ossKey)!, destination),
}));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent() {} }));
vi.mock('../../cindy-media/refCompensationJournal', () => ({
  captureMediaRefCompensationScope: () => ({}),
}));
vi.mock('../../im/binding', () => ({ bindingStore: { findByTarget: () => null } }));
vi.mock('../../maker-host', () => ({
  getMakerIfReady: () => ({
    getSession: () => null,
    closeSession: state.close,
    getCapabilities: () => ({ availableModels: [] }),
    listActiveSessions: () =>
      state.siblingRunning ? [{ id: 'sibling', isTurnRunning: () => true }] : [],
  }),
}));
vi.mock('../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => [] }),
}));
vi.mock('../../maker-host/model-route-guard', () => ({
  pickEnabledFallbackModel: () => ({ model: 'target-model', providerId: 'target-provider' }),
}));
vi.mock('../../worktree/resourceLock', async original => ({
  ...await original<typeof import('../../worktree/resourceLock')>(),
  withWorktreeResourceLock: (_cwd: string, fn: () => unknown) => fn(),
  withWorktreeResourceLocks: (_cwds: string[], fn: () => unknown) => fn(),
}));
vi.mock('../../session-share/sessionShareExport', () => ({
  exportSessionShare: async ({ targetPath }: { targetPath: string }) => {
    state.exported();
    await fs.writeFile(targetPath, 'conversation');
    return { status: 'ok', fidelity: 'full', mediaMissing: false };
  },
}));
vi.mock('../../session-share/sessionShareImport', () => ({
  inspectShareFile: async () => ({
    draftId: 'draft',
    encrypted: false,
    preview: { fidelity: 'full', orcaWorkerCount: state.workers.length, agentKind: 'cc' },
  }),
  cancelShareDraft() {},
  commitShareImport: async (
    _opts: unknown,
    scope: {
      migration: {
        sessionId: string;
        workingDir: string;
        workers?: Array<{ sessionId: string; sourceSessionId: string; workingDir: string }>;
      };
    },
  ) => {
    state.imports();
    const { sessionId, workingDir } = scope.migration;
    // Imports remain fenced until source has durably retired.
    expect(() => assertTaskMigrationWritable(sessionId)).toThrow('MIGRATION_TASK_BUSY');
    state.rows.get(device())!.set(sessionId, {
      id: sessionId,
      workingDir,
      remoteHostId: null,
      status: 'active',
      source: 'shared',
      agentKind: 'cc',
      orcaRole: null,
    });
    for (const worker of scope.migration.workers ?? []) {
      expect(() => assertTaskMigrationWritable(worker.sessionId)).toThrow('MIGRATION_TASK_BUSY');
      state.rows.get(device())!.set(worker.sessionId, {
        id: worker.sessionId,
        workingDir: worker.workingDir,
        remoteHostId: null,
        status: 'active',
        source: 'shared',
        agentKind: 'cc',
        orcaRole: 'worker',
      });
    }
    if (state.importsFail) {
      state.importsFail = false;
      throw new Error('DB committed but acknowledgement lost');
    }
    return { fidelity: 'full' };
  },
}));
vi.mock('../workspace', () => ({
  snapshotWorkspace: async (source: string, directory: string) => {
    state.snapshot();
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(path.join(source, 'draft'), path.join(directory, 'a.tar.gz.enc'));
    return { unpackedBytes: 8, archive: { file: 'a.tar.gz.enc', files: {} } };
  },
  restoreWorkspace: async (_manifest: unknown, directory: string, target: string) => {
    await fs.copyFile(path.join(directory, 'a.tar.gz.enc'), path.join(target, 'draft'));
    if (state.restoresFail) throw new Error('restore interrupted');
  },
}));
import { requestTaskMigration, registerTaskMigrationIpc } from '../service';
import { moveSessionProjectFromHost } from '../../mcp-integrations/moveSession';
import { assertTaskMigrationWritable, migrationScope } from '../journal';
import { assertTaskMigrationInputAllowed } from '../inputGuard';

async function settled(sessionId = 'fork') {
  // Match vitest.config.ts's platform budget rather than waitFor's 1-second default.
  await vi.waitFor(async () => {
    const status = await requestTaskMigration({ action: 'status', sessionId });
    expect(status.running).not.toBe(true);
  }, { timeout: process.platform === 'win32' ? 60_000 : 5_000 });
  return requestTaskMigration({ action: 'status', sessionId });
}
describe('durable cross-machine handoff', () => {
  beforeEach(async () => {
    registerTaskMigrationIpc((id, dir, authority) => moveSessionProjectFromHost(() => false, id, dir, authority),
      { isBusy: () => state.boundaryBusy, drain: state.drain });
    state.boundaryBusy = false;
    state.drain.mockReset();
    state.exported.mockClear();
    state.root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-migration-service-')),
    );
    state.context = new AsyncLocalStorage();
    state.rows.clear();
    state.dbs.clear();
    state.files.clear();
    state.imports.mockClear();
    state.created.mockReset();
    state.snapshot.mockClear();
    state.close.mockClear();
    state.remove.mockReset();
    state.loseReply = '';
    state.importsFail = false;
    state.siblingRunning = false;
    state.noSpace = false;
    state.restoresFail = false;
    state.sharingLatest = [];
    state.workers = [];
    const cwd = path.join(state.root, 'shared');
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'draft'), 'original');
    for (const d of ['A', 'B', 'C']) {
      const rows = new Map<string, Record<string, unknown>>();
      state.rows.set(d, rows);
      state.dbs.set(d, {
        query: vi.fn(async (sql: string) =>
          sql.includes('shared_task_events')
            ? state.sharingLatest
            : sql.includes('FROM orca_workers')
              ? state.workers.map((sessionId) => ({ sessionId }))
              : [],
        ),
        queryOne: vi.fn(async (sql: string, args: string[]) =>
          sql.includes(' AS n') ? { n: 0 } : (rows.get(args[0]) ?? null),
        ),
      });
    }
    for (const id of ['fork', 'sibling'])
      state.rows.get('A')!.set(id, {
        id,
        workingDir: cwd,
        remoteHostId: null,
        status: 'active',
        source: 'desktop',
        agentKind: 'cc',
        orcaRole: null,
      });
  });
  afterEach(async () => {
    // A failed assertion must not tear down directories while a background transfer writes.
    for (const [device, rows] of state.rows) {
      await state.context.run({ device }, async () => {
        for (const id of rows.keys()) await settled(id);
      });
    }
    await fs.rm(state.root, { recursive: true, force: true });
  });
  it('flushes journal files using writable handles without truncation', async () => {
    const open = vi.spyOn(syncFs, 'openSync');
    const flush = syncFs.fsyncSync.bind(syncFs);
    const fsync = vi.spyOn(syncFs, 'fsyncSync').mockImplementation(fd => {
      const index = open.mock.results.findLastIndex(result => result.type === 'return' && result.value === fd);
      if (syncFs.fstatSync(fd).isFile()) {
        // Emulate Windows: FlushFileBuffers rejects a read-only file handle.
        expect(open.mock.calls[index]?.[1]).toBe('r+');
      }
      flush(fd);
    });
    try {
      await start();
      const result = await settled();
      expect(result.stage).toBe('complete');
      expect(migrationScope().read('fork')?.stage).toBe('complete');
      expect(fsync).toHaveBeenCalled();
    } finally {
      fsync.mockRestore();
      open.mockRestore();
    }
  });
  it('routes a remote project move through the source host helper without starting a transfer', async () => {
    vi.mocked(moveSessionProjectFromHost).mockResolvedValueOnce({ ok: true, sessionId: 'fork', workingDir: '/another', workspaceKind: 'project' });
    const result = await state.context.run({ device: 'A', peer: 'B' }, () => requestTaskMigration({ action: 'move-project', sessionId: 'fork', workingDir: '/another' }));
    expect(moveSessionProjectFromHost).toHaveBeenLastCalledWith(expect.any(Function), 'fork', '/another', expect.any(Function));
    expect(result).toMatchObject({ deviceId: 'A', projectMove: { sessionId: 'fork', workingDir: '/another', workspaceKind: 'project' } });
    expect(state.snapshot).not.toHaveBeenCalled(); expect(state.imports).not.toHaveBeenCalled();
  });
  const start = () =>
    requestTaskMigration({ action: 'start', sessionId: 'fork', targetDeviceId: 'B' });

  async function team() {
    const rows = state.rows.get('A')!;
    rows.get('fork')!.orcaRole = 'lead';
    const separate = path.join(state.root, 'worker-project');
    await fs.mkdir(separate);
    await fs.writeFile(path.join(separate, 'draft'), 'worker files');
    state.workers = ['shared-worker', 'separate-worker'];
    for (const id of state.workers)
      rows.set(id, {
        ...rows.get('fork'),
        id,
        orcaRole: 'worker',
        workingDir: id === 'shared-worker' ? rows.get('fork')!.workingDir : separate,
      });
    return separate;
  }

  it('replaces only preparation staging on retry instead of accumulating archive copies', async () => {
    state.noSpace = true;
    await start();
    const first = await settled();
    expect(first.stage).toBe('preparing');
    const dir = path.join(migrationScope().root, 'outgoing', first.targetSessionId!);
    await fs.writeFile(path.join(dir, 'superseded.tar.gz.enc'), 'old snapshot');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    await settled();
    await expect(fs.stat(path.join(dir, 'superseded.tar.gz.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });
  it('journals every team directory before allocation can fail', async () => {
    await team();
    const mkdir = fs.mkdir.bind(fs);
    let allocations = 0;
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation((async (target: string, options?: unknown) => {
      if (path.basename(String(target)).startsWith('cindy-')) {
        allocations++;
        const receipt = state.context.run({ device: 'B' }, () => migrationScope().list(true)[0]);
        expect(receipt).toBeDefined();
        expect([receipt!.workingDir, ...('retainedWorkingDirs' in receipt! ? receipt!.retainedWorkingDirs ?? [] : [])]).toContain(target);
        if (allocations === 2) throw new Error('allocation failed');
      }
      return mkdir(target, options as never);
    }) as typeof fs.mkdir);
    try {
      await start();
      expect((await settled()).stage).toBe('transferring');
      expect(allocations).toBe(2);
    } finally { spy.mockRestore(); }
  });
  it('notifies all members only after durable activation and repeats notifications on replay', async () => {
    await team();
    state.loseReply = 'receive';
    const started = await start();
    await settled();
    expect(state.created).not.toHaveBeenCalled();
    state.created.mockImplementation((id: string) => {
      expect(device()).toBe('B');
      expect(migrationScope().readIncoming(started.targetSessionId!)?.stage).toBe('active');
      expect(state.rows.get('B')!.has(id)).toBe(true);
    });
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.created).toHaveBeenCalledTimes(3);
    const ids = state.created.mock.calls.map(([id]) => id);
    await state.context.run({ device: 'B', peer: 'A' }, () => requestTaskMigration({
      action: 'activate', id: started.targetSessionId!, sourceSessionId: 'fork',
    }));
    expect(state.created.mock.calls.slice(3).map(([id]) => id)).toEqual(ids);
  });
  it('moves the entire team, copies shared directories once and keeps every source file', async () => {
    const separate = await team();
    const started = await start();
    expect((await settled()).stage).toBe('complete');
    expect(state.snapshot).toHaveBeenCalledTimes(2);
    for (const id of ['fork', ...state.workers])
      expect(() => assertTaskMigrationWritable(id)).toThrow('MIGRATION_TASK_MOVED');
    expect(() => assertTaskMigrationWritable('sibling')).not.toThrow();
    expect(await fs.readFile(path.join(separate, 'draft'), 'utf8')).toBe('worker files');
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
    await state.context.run({ device: 'B' }, async () => {
      const receipt = migrationScope().readIncoming(started.targetSessionId!)!;
      expect(receipt.workers).toHaveLength(2);
      expect(receipt.workers![0].workingDir).toBe(receipt.workingDir);
      expect(receipt.workers![1].workingDir).not.toBe(receipt.workingDir);
      expect(await fs.readFile(path.join(receipt.workers![1].workingDir, 'draft'), 'utf8')).toBe(
        'worker files',
      );
      for (const member of receipt.workers!)
        expect(() => assertTaskMigrationWritable(member.sessionId)).not.toThrow();
    });
  });

  it('adopts the complete team after a lost import acknowledgement without duplicating workers', async () => {
    await team();
    state.importsFail = true;
    await start();
    expect((await settled()).stage).toBe('transferring');
    for (const id of state.workers)
      expect(() => assertTaskMigrationWritable(id)).toThrow('MIGRATION_TASK_BUSY');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
    expect(state.rows.get('B')!.size).toBe(3);
  });

  it('rejects the whole team when any worker has queued input and keeps the lead writable', async () => {
    await team();
    state.rows.get('A')!.get('separate-worker')!.payload = JSON.stringify([{ text: 'pending' }]);
    await expect(start()).rejects.toThrow('MIGRATION_TASK_QUEUED');
    expect(() => assertTaskMigrationWritable('fork')).not.toThrow();
    expect(state.exported).not.toHaveBeenCalled();
  });

  it('fences every member directory during preparation and releases the whole group on cancellation', async () => {
    const separate = await team();
    state.noSpace = true;
    await start();
    expect((await settled()).stage).toBe('preparing');
    await expect(assertTaskMigrationInputAllowed(undefined, separate)).rejects.toThrow(
      'MIGRATION_SHARED_DIRECTORY_BUSY',
    );
    for (const id of state.workers)
      expect(() => assertTaskMigrationWritable(id)).toThrow('MIGRATION_TASK_BUSY');
    await requestTaskMigration({ action: 'cancel', sessionId: 'fork' });
    for (const id of ['fork', ...state.workers])
      expect(() => assertTaskMigrationWritable(id)).not.toThrow();
    await expect(assertTaskMigrationInputAllowed(undefined, separate)).resolves.toBeUndefined();
  });

  it('filters stale project history and rechecks a directory removed after listing', async () => {
    const existing = path.join(state.root, 'shared');
    const missing = path.join(state.root, 'missing');
    const file = path.join(existing, 'draft');
    const removable = path.join(state.root, 'removable');
    await fs.mkdir(removable);
    state.dbs
      .get('B')!
      .query.mockResolvedValue([existing, missing, file, removable].map((path) => ({ path })));
    const caps = await state.context.run({ device: 'B' }, () =>
      requestTaskMigration({ action: 'caps' }),
    );
    expect(caps.projects).toEqual([existing, removable]);
    await fs.rmdir(removable);
    await expect(state.context.run({ device: 'B' }, () => requestTaskMigration({
      action: 'preflight', targetProject: removable,
      resources: { transferBytes: 0, unpackedBytes: 0, contextBytes: 0, manifestBytes: 0, repositoryBytes: 0, entries: 0 },
    }))).rejects.toThrow('MIGRATION_TARGET_UNKNOWN');
    await expect(requestTaskMigration({ action: 'start', sessionId: 'fork', targetDeviceId: 'B', targetProject: file }))
      .rejects.toThrow('MIGRATION_TARGET_UNKNOWN');
    expect(state.snapshot).not.toHaveBeenCalled();
  });

  it('rejects an idle runtime whose terminal delivery or accepted queue is still pending', async () => {
    state.boundaryBusy = true;
    await expect(start()).rejects.toThrow('MIGRATION_TASK_RUNNING');
    expect(state.close).not.toHaveBeenCalled();
    expect(state.exported).not.toHaveBeenCalled();
  });
  it('waits for pending message persistence before exporting the conversation', async () => {
    let release!: () => void;
    state.drain.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await start();
    await vi.waitFor(() => expect(state.drain).toHaveBeenCalledOnce());
    expect(state.exported).not.toHaveBeenCalled();
    release();
    expect((await settled()).stage).toBe('complete');
    expect(state.exported).toHaveBeenCalledOnce();
  });

  it('keeps cleanup failures replayable without importing again or touching source files', async () => {
    state.remove.mockRejectedValueOnce(new Error('cleanup interrupted'));
    await start();
    const interrupted = await settled();
    expect(interrupted.stage).toBe('moved');
    const directory = path.join(migrationScope().root, 'outgoing', interrupted.targetSessionId!);
    expect(await fs.readdir(directory)).toContain('workspace.json');
    const imports = state.imports.mock.calls.length;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.imports.mock.calls.length).toBe(imports);
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });

  it('blocks current sharing but permits migration after all sharing identities are closed', async () => {
    state.sharingLatest = [
      { shared_task_id: 'closed', session_id: 'fork', terminal: 1, snapshot: null },
      { shared_task_id: 'active', session_id: 'fork', terminal: 0, snapshot: null },
    ];
    await expect(start()).rejects.toThrow('MIGRATION_TASK_BOUND');
    state.sharingLatest[1].terminal = 1;
    state.sharingLatest.push({ shared_task_id: 'unrelated', session_id: 'sibling', terminal: 0, snapshot: null });
    await start();
    expect((await settled()).stage).toBe('complete');
    expect(state.dbs.get('A')!.query).toHaveBeenCalledWith(expect.stringContaining('SELECT MAX(id)'));
  });
  it('keeps the source fenced and refuses activation by a different controller before retirement', async () => {
    state.loseReply = 'receive';
    await start();
    const source = await settled();
    expect(source.stage).toBe('transferring');
    expect(() => assertTaskMigrationWritable('fork')).toThrow('MIGRATION_TASK_BUSY');
    await state.context.run({ device: 'B', peer: 'C' }, async () => {
      expect(migrationScope().readIncoming(source.targetSessionId!)?.stage).toBe('ready');
      await expect(requestTaskMigration({ action: 'activate', id: source.targetSessionId!, sourceSessionId: 'fork' })).rejects.toThrow('MIGRATION_TARGET_NOT_READY');
      expect(migrationScope().readIncoming(source.targetSessionId!)?.stage).toBe('ready');
      expect(() => assertTaskMigrationWritable(source.targetSessionId!)).toThrow('MIGRATION_TASK_BUSY');
    });
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
  });
  it('retains every failed receive directory in the existing receipt after a successful retry', async () => {
    state.restoresFail = true;
    await start();
    const first = await settled();
    expect(first.stage).toBe('transferring');
    const receipt = () => state.context.run({ device: 'B' }, () => migrationScope().readIncoming(first.targetSessionId!)!);
    const firstDir = receipt().workingDir;
    await fs.writeFile(path.join(firstDir, 'draft'), 'user recovery edit');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    await settled();
    const secondDir = receipt().workingDir;
    expect(receipt().retainedWorkingDirs).toEqual([firstDir]);
    state.restoresFail = false;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(receipt().retainedWorkingDirs).toEqual([firstDir, secondDir]);
    expect(await fs.readFile(path.join(firstDir, 'draft'), 'utf8')).toBe('user recovery edit');
    expect(await fs.readFile(path.join(secondDir, 'draft'), 'utf8')).toBe('original');
    expect(receipt().workingDir).not.toBe(firstDir);
    expect(receipt().workingDir).not.toBe(secondDir);
  });
  it('allows missing unrelated workspaces while preserving overlap guards for missing leaves', async () => {
    state.noSpace = true;
    await start();
    expect((await settled()).stage).toBe('preparing');
    await expect(assertTaskMigrationInputAllowed(undefined, path.join(state.root, 'missing', 'project'))).resolves.toBeUndefined();
    await expect(assertTaskMigrationInputAllowed(undefined, path.join(state.root, 'shared', 'missing'))).rejects.toThrow('MIGRATION_SHARED_DIRECTORY_BUSY');
    await fs.rename(path.join(state.root, 'shared'), path.join(state.root, 'temporarily-detached'));
    await expect(assertTaskMigrationInputAllowed(undefined, path.join(state.root, 'unrelated'))).resolves.toBeUndefined();
    await expect(assertTaskMigrationInputAllowed(undefined, path.join(state.root, 'shared', 'missing'))).rejects.toThrow('MIGRATION_SHARED_DIRECTORY_BUSY');
  });
  it('moves a fork into an independent directory and leaves the sibling and source files usable', async () => {
    // First use must work with the real file lock and no migration state directory.
    await expect(fs.stat(path.join(state.root, 'A', 'task-migrations'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(state.root, 'B', 'task-migrations'))).rejects.toMatchObject({ code: 'ENOENT' });
    await start();
    const status = await settled();
    expect(status.stage).toBe('complete');
    expect(() => assertTaskMigrationWritable('fork')).toThrow('MIGRATION_TASK_MOVED');
    expect(() => assertTaskMigrationWritable('sibling')).not.toThrow();
    const row = state.rows.get('B')!.get(status.targetSessionId!)!;
    expect(row.workingDir).not.toBe(path.join(state.root, 'shared'));
    await fs.writeFile(path.join(row.workingDir as string, 'draft'), 'destination edit');
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
    state.context.run({ device: 'B' }, () =>
      expect(() => assertTaskMigrationWritable(status.targetSessionId!)).not.toThrow(),
    );
  });
  it('rejects insufficient destination space before uploading and remains cancellable', async () => {
    state.noSpace = true;
    await start();
    const status = await settled();
    expect(status.stage).toBe('preparing');
    expect(status.error).toBe('MIGRATION_NO_SPACE');
    expect(state.files.size).toBe(0);
    expect(state.imports).not.toHaveBeenCalled();
    await requestTaskMigration({ action: 'cancel', sessionId: 'fork' });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });
  it.each(['receive', 'activate'])(
    'resumes a lost %s reply without importing twice or permitting source input',
    async (action) => {
      state.loseReply = action;
      await start();
      const interrupted = await settled();
      expect(interrupted.stage).toBe(action === 'receive' ? 'transferring' : 'moved');
      expect(() => assertTaskMigrationWritable('fork')).toThrow();
      await expect(requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).rejects.toThrow(
        'MIGRATION_CANNOT_CANCEL',
      );
      await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
      expect((await settled()).stage).toBe('complete');
      expect(state.imports).toHaveBeenCalledTimes(1);
    },
  );
  it('adopts a committed import after its database reply is lost', async () => {
    state.importsFail = true;
    await start();
    expect((await settled()).stage).toBe('transferring');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
  });
  it('can move an imported task onward while retaining its earlier receipt', async () => {
    await start();
    const first = await settled();
    await state.context.run({ device: 'B' }, async () => {
      await requestTaskMigration({
        action: 'start',
        sessionId: first.targetSessionId!,
        targetDeviceId: 'C',
      });
      expect((await settled(first.targetSessionId!)).stage).toBe('complete');
      expect(migrationScope().readIncoming(first.targetSessionId!)?.stage).toBe('active');
      expect(() => assertTaskMigrationWritable(first.targetSessionId!)).toThrow(
        'MIGRATION_TASK_MOVED',
      );
    });
  });
  it('stops before snapshotting a running sibling and allows safe cancellation', async () => {
    state.siblingRunning = true;
    await start();
    const status = await settled();
    expect(status.error).toBe('MIGRATION_SHARED_DIRECTORY_BUSY');
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.imports).not.toHaveBeenCalled();
    await expect(assertTaskMigrationInputAllowed('sibling')).rejects.toThrow(
      'MIGRATION_SHARED_DIRECTORY_BUSY',
    );
    await requestTaskMigration({ action: 'cancel', sessionId: 'fork' });
    await expect(assertTaskMigrationInputAllowed('sibling')).resolves.toBeUndefined();
    expect(() => assertTaskMigrationWritable('fork')).not.toThrow();
  });
});
