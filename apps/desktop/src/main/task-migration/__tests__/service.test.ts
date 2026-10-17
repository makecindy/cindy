vi.mock('../../mcp-integrations/moveSession', () => ({ moveSessionProjectFromHost: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  parseAttachmentOssRef,
  TASK_MIGRATION_ESTIMATE_TIMEOUT_MS,
  TASK_MIGRATION_LOCAL_CHANNEL,
  TASK_MIGRATION_MAX_FILES,
  TASK_MIGRATION_MAX_TRANSCRIPTS,
} from '@cindy/device-link';

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
  uploadedProgress: vi.fn(),
  /** Models a long in-flight upload: it only ends when its signal aborts. */
  stallUpload: undefined as undefined | (() => void),
  loseReply: '' as string,
  importsFail: false,
  siblingRunning: false,
  noSpace: false,
  restoresFail: false,
  exportMedia: { mediaMissing: 0, mediaDropped: 0 },
  sharingLatest: [] as Array<{
    shared_task_id: string;
    session_id: string;
    terminal: number;
    snapshot: null;
  }>,
  workers: [] as string[],
  estimateLimits: [] as number[],
  timeoutAction: '' as string,
  exclusions: [] as string[],
  /** Entries each snapshot reports it left behind. */
  skipped: [] as Array<{ path: string; code: string }>,
  migrationWarn: vi.fn(),
  /** Native transcript the export streams beside the package when the target supports it. */
  transcript: '' as string,
  transcriptCount: 1,
  exportOversize: null as null | {
    totalBytes: number;
    limitBytes: number;
    transcriptBytes: number;
    transcriptFileBytes?: number[];
  },
  /** Target without the `externalTranscripts` capability. */
  oldTarget: false,
  importedTranscripts: [] as Array<{ path: string; content: string }>,
  recentProjects: [] as string[],
  archiveDownloadFails: false,
}));
vi.mock('../../logger', async (original) => {
  const actual = await original<typeof import('../../logger')>();
  return {
    ...actual,
    createLogger: (scope: string) =>
      scope === 'task-migration'
        ? { ...actual.createLogger(scope), warn: state.migrationWarn }
        : actual.createLogger(scope),
  };
});
vi.mock('../../localDb/ipc/sessionCreatedBroadcast', () => ({
  emitSessionCreated: (id: string) => state.created(id),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root }, ipcMain: { handle: vi.fn() } }));
vi.mock('../../dialogue-workspace-settings', () => ({
  readDialogueWorkspaceSettings: () => ({
    directory: path.join(state.root, 'dialogues'),
    isCustomized: false,
  }),
}));
vi.mock('../../localDb/ipc/recentWorkdirs', () => ({
  upsertRecentWorkdir: (dir: string) => state.recentProjects.push(dir),
}));
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
    if (state.timeoutAction === args[0].action) {
      const { DeviceLinkError } = await import('@cindy/device-link');
      throw new DeviceLinkError('INVOKE_TIMEOUT', 'no invoke-result within 180000ms');
    }
    const peer = device();
    const result = await state.context.run({ device: target, peer }, () =>
      requestTaskMigration(args[0]),
    );
    if (state.oldTarget && args[0].action === 'caps') delete result.externalTranscripts;
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
  uploadLocalFile: async (
    file: string,
    opts: { onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ) => {
    if (state.stallUpload) {
      state.stallUpload();
      await new Promise((_, reject) =>
        opts.signal?.addEventListener('abort', () => reject(new Error('UPLOAD_CANCELLED'))),
      );
    }
    const bytes = await fs.readFile(file),
      key = `migration/${state.files.size}`;
    opts.onProgress?.(bytes.length);
    await state.uploadedProgress(bytes.length);
    state.files.set(key, file);
    return { key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  },
}));
vi.mock('../../device-link/remoteAttachment', () => ({
  parseRemoteAttachmentRef: (ref: string) => parseAttachmentOssRef(ref),
  materializeRemoteAttachment: async (ref: { ossKey: string }, destination: string) => {
    if (state.archiveDownloadFails && destination.endsWith('.tar.gz.enc')) {
      state.archiveDownloadFails = false;
      throw new Error('download interrupted');
    }
    await fs.copyFile(state.files.get(ref.ossKey)!, destination);
  },
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
vi.mock('../../worktree/resourceLock', async (original) => ({
  ...(await original<typeof import('../../worktree/resourceLock')>()),
  withWorktreeResourceLock: (_cwd: string, fn: () => unknown) => fn(),
  withWorktreeResourceLocks: (_cwds: string[], fn: () => unknown) => fn(),
}));
vi.mock('../../session-share/sessionShareExport', () => ({
  exportSessionShare: async (opts: {
    targetPath: string;
    externalTranscripts?: { dir: string; minBytes: number };
  }) => {
    state.exported(opts);
    if (state.exportOversize) return { status: 'oversize', mediaBytes: 0, ...state.exportOversize };
    await fs.writeFile(opts.targetPath, 'conversation');
    const external = opts.externalTranscripts;
    const staged =
      external && state.transcript
        ? Array.from({ length: state.transcriptCount }, (_, index) => ({
            path: index
              ? `transcripts/codex/rollout-${index}.jsonl`
              : 'transcripts/codex/rollout.jsonl',
            file: `transcript-${index}-0a1b2c3d.jsonl`,
            bytes: Buffer.byteLength(state.transcript),
            sha256: createHash('sha256').update(state.transcript).digest('hex'),
          }))
        : [];
    for (const transcript of staged)
      await fs.writeFile(path.join(external!.dir, transcript.file), state.transcript);
    return {
      status: 'ok',
      fidelity: 'full',
      ...state.exportMedia,
      ...(external ? { externalTranscripts: staged } : {}),
    };
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
        externalTranscripts?: ReadonlyMap<string, string>;
      };
    },
  ) => {
    state.imports();
    for (const [transcriptPath, file] of scope.migration.externalTranscripts ?? [])
      state.importedTranscripts.push({
        path: transcriptPath,
        content: await fs.readFile(file, 'utf8'),
      });
    const { sessionId, workingDir } = scope.migration;
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
vi.mock('../workspace', async (original) => ({
  isExcludedFromWorkspace: (await original<typeof import('../workspace')>())
    .isExcludedFromWorkspace,
  MigrationPathError: (await original<typeof import('../workspace')>()).MigrationPathError,
  managedWorktreeExclusions: async () => state.exclusions,
  estimateWorkspace: async (_root: string, check: () => void, maxFiles: number) => {
    state.estimateLimits.push(maxFiles);
    check();
    return { fileCount: 1, bytes: 8 };
  },
  snapshotWorkspace: async (source: string, directory: string) => {
    state.snapshot();
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(path.join(source, 'draft'), path.join(directory, 'a.tar.gz.enc'));
    return {
      unpackedBytes: 8,
      archive: { file: 'a.tar.gz.enc', files: {} },
      skipped: state.skipped,
    };
  },
  restoreWorkspace: async (_manifest: unknown, directory: string, target: string) => {
    await fs.copyFile(path.join(directory, 'a.tar.gz.enc'), path.join(target, 'draft'));
    if (state.restoresFail) throw new Error('restore interrupted');
  },
}));
import { requestTaskMigration, registerTaskMigrationIpc } from '../service';
import { moveSessionProjectFromHost } from '../../mcp-integrations/moveSession';
import { migrationScope } from '../journal';

async function settled(sessionId = 'fork') {
  // Match vitest.config.ts's platform budget rather than waitFor's 1-second default.
  await vi.waitFor(
    async () => {
      const status = await requestTaskMigration({ action: 'status', sessionId });
      expect(status.running).not.toBe(true);
    },
    { timeout: process.platform === 'win32' ? 60_000 : 5_000 },
  );
  return requestTaskMigration({ action: 'status', sessionId });
}
describe('resumable cross-computer copy', () => {
  beforeEach(async () => {
    registerTaskMigrationIpc(
      (id, dir, authority) => moveSessionProjectFromHost(() => false, id, dir, authority),
      { isBusy: () => state.boundaryBusy, drain: state.drain },
    );
    state.boundaryBusy = false;
    state.drain.mockReset();
    state.exported.mockClear();
    state.uploadedProgress.mockReset();
    state.stallUpload = undefined;
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
    state.skipped = [];
    state.close.mockClear();
    state.remove.mockReset();
    state.loseReply = '';
    state.importsFail = false;
    state.siblingRunning = false;
    state.noSpace = false;
    state.restoresFail = false;
    state.exportMedia = { mediaMissing: 0, mediaDropped: 0 };
    state.sharingLatest = [];
    state.workers = [];
    state.estimateLimits = [];
    state.timeoutAction = '';
    state.exclusions = [];
    state.transcript = '';
    state.transcriptCount = 1;
    state.exportOversize = null;
    state.oldTarget = false;
    state.importedTranscripts = [];
    state.recentProjects = [];
    state.archiveDownloadFails = false;
    state.migrationWarn.mockClear();
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

  it('flushes journal files using writable handles without truncation', async () => {
    const open = vi.spyOn(syncFs, 'openSync');
    const flush = syncFs.fsyncSync.bind(syncFs);
    const fsync = vi.spyOn(syncFs, 'fsyncSync').mockImplementation((fd) => {
      const index = open.mock.results.findLastIndex(
        (result) => result.type === 'return' && result.value === fd,
      );
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
    vi.mocked(moveSessionProjectFromHost).mockResolvedValueOnce({
      ok: true,
      sessionId: 'fork',
      workingDir: '/another',
      workspaceKind: 'project',
    });
    const result = await state.context.run({ device: 'A', peer: 'B' }, () =>
      requestTaskMigration({ action: 'move-project', sessionId: 'fork', workingDir: '/another' }),
    );
    expect(moveSessionProjectFromHost).toHaveBeenLastCalledWith(
      expect.any(Function),
      'fork',
      '/another',
      expect.any(Function),
    );
    expect(result).toMatchObject({
      deviceId: 'A',
      projectMove: { sessionId: 'fork', workingDir: '/another', workspaceKind: 'project' },
    });
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.imports).not.toHaveBeenCalled();
  });
  it('replaces only preparation staging on retry instead of accumulating archive copies', async () => {
    state.noSpace = true;
    await start();
    const first = await settled();
    expect(first.stage).toBe('preparing');
    const dir = path.join(migrationScope().root, 'outgoing', first.targetSessionId!);
    await fs.writeFile(path.join(dir, 'superseded.tar.gz.enc'), 'old snapshot');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    await settled();
    await expect(fs.stat(path.join(dir, 'superseded.tar.gz.enc'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
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
    await expect(
      state.context.run({ device: 'B' }, () =>
        requestTaskMigration({
          action: 'preflight',
          targetProject: removable,
          resources: {
            transferBytes: 0,
            unpackedBytes: 0,
            contextBytes: 0,
            manifestBytes: 0,
            repositoryBytes: 0,
            entries: 0,
          },
        }),
      ),
    ).rejects.toThrow('MIGRATION_TARGET_UNKNOWN');
    await expect(
      requestTaskMigration({
        action: 'start',
        sessionId: 'fork',
        targetDeviceId: 'B',
        targetProject: file,
      }),
    ).rejects.toThrow('MIGRATION_TARGET_UNKNOWN');
    expect(state.snapshot).not.toHaveBeenCalled();
  });

  it('rejects a worker task opened here by another computer’s collaboration lead', async () => {
    state.rows.get('A')!.get('fork')!.orcaRemoteLead = JSON.stringify({
      leadDeviceId: 'C',
      leadSessionId: 'lead-on-c',
      workerLabel: '转写',
    });
    await expect(start()).rejects.toThrow('MIGRATION_TASK_UNSUPPORTED');
    expect(state.exported).not.toHaveBeenCalled();
  });

  it('rejects an idle runtime whose terminal delivery or accepted queue is still pending', async () => {
    state.boundaryBusy = true;
    await expect(start()).rejects.toThrow('MIGRATION_TASK_RUNNING');
    expect(state.close).not.toHaveBeenCalled();
    expect(state.exported).not.toHaveBeenCalled();
  });
  it('waits for pending message persistence before exporting the conversation', async () => {
    let release!: () => void;
    state.drain.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
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
    expect(interrupted.stage).toBe('transferring');
    const directory = path.join(migrationScope().root, 'outgoing', interrupted.targetSessionId!);
    expect(await fs.readdir(directory)).toContain('workspace.json');
    const imports = state.imports.mock.calls.length;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.imports.mock.calls.length).toBe(imports);
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });

  it('retains every failed receive directory in the existing receipt after a successful retry', async () => {
    state.restoresFail = true;
    await start();
    const first = await settled();
    expect(first.stage).toBe('transferring');
    const receipt = () =>
      state.context.run({ device: 'B' }, () =>
        migrationScope().readIncoming(first.targetSessionId!)!,
      );
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
  it('estimates each physical team workspace once without exporting or uploading', async () => {
    await team();
    const result = await requestTaskMigration({ action: 'estimate', sessionId: 'fork' });
    expect(result.estimate).toEqual({ fileCount: 2, bytes: 16 });
    // The file cap applies to the whole team, not to each directory separately.
    expect(state.estimateLimits).toEqual([TASK_MIGRATION_MAX_FILES, TASK_MIGRATION_MAX_FILES - 1]);
    expect(state.exported).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
  });
  it('stops a local estimate at the same budget the remote wait uses', async () => {
    const start = Date.now();
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(start)
      .mockReturnValue(start + TASK_MIGRATION_ESTIMATE_TIMEOUT_MS + 1);
    try {
      await expect(requestTaskMigration({ action: 'estimate', sessionId: 'fork' })).rejects.toThrow(
        'MIGRATION_TIMEOUT',
      );
    } finally {
      now.mockRestore();
    }
  });
  it('reports a timed-out remote request as MIGRATION_TIMEOUT instead of a generic failure', async () => {
    const { ipcMain } = await import('electron');
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.findLast(([channel]) => channel === TASK_MIGRATION_LOCAL_CHANNEL)![1];
    state.timeoutAction = 'estimate';
    await expect(
      handler({} as never, 'B', { action: 'estimate', sessionId: 'fork' }),
    ).rejects.toThrow('MIGRATION_TIMEOUT');
  });
  it('ignores tasks running in other registered worktrees under the copied root', async () => {
    const rows = state.rows.get('A')!;
    const cwd = rows.get('fork')!.workingDir as string;
    const managed = path.join(cwd, '.cindy-worktrees', 'other');
    await fs.mkdir(managed, { recursive: true });
    // Git's worktree registry is covered by the integration tier; inject its verdict here.
    state.exclusions = [path.join('.cindy-worktrees', 'other')];
    rows.get('sibling')!.workingDir = managed;
    state.siblingRunning = true;
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('still refuses while another task runs in an ordinary subdirectory of the copied root', async () => {
    const rows = state.rows.get('A')!;
    const nested = path.join(rows.get('fork')!.workingDir as string, 'packages');
    await fs.mkdir(nested);
    rows.get('sibling')!.workingDir = nested;
    state.siblingRunning = true;
    await start();
    expect((await settled()).error).toBe('MIGRATION_SHARED_DIRECTORY_BUSY');
  });
  it('acknowledges start and retry with the registered running state', async () => {
    state.noSpace = true;
    expect((await start()).running).toBe(true);
    expect((await settled()).error).toBe('MIGRATION_NO_SPACE');
    const retry = await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect(retry.running).toBe(true);
    await settled();
  });
  it('reports actual upload bytes across files, then drops live telemetry on completion', async () => {
    let sent = 0;
    state.uploadedProgress.mockImplementation(async (size: number) => {
      sent += size;
      const status = await requestTaskMigration({ action: 'status', sessionId: 'fork' });
      expect(status.running).toBe(true);
      expect(status.progress?.phase).toBe('sending');
      expect(status.progress?.sentBytes).toBe(sent);
      expect(status.progress!.totalBytes).toBeGreaterThanOrEqual(sent);
      expect(status.progress!.bytesPerSecond).toBeGreaterThan(0);
    });
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    expect(state.uploadedProgress).toHaveBeenCalled();
    expect(result.progress).toBeUndefined();
  });
  it('cancels a running upload before the target receives it and removes source staging', async () => {
    let cancel: Promise<Awaited<ReturnType<typeof requestTaskMigration>>> | undefined;
    state.uploadedProgress.mockImplementation(async () => {
      cancel ??= requestTaskMigration({ action: 'cancel', sessionId: 'fork' });
    });
    expect((await start()).cancellable).toBe(true);
    const status = await settled();
    expect(await cancel).toMatchObject({ running: true, cancelling: true });
    expect(status.stage).toBe('cancelled');
    expect(status.error).toBeUndefined();
    expect(state.imports).not.toHaveBeenCalled();
    expect(state.remove.mock.calls.map(([key]) => key)).toEqual([...state.files.keys()]);
    await expect(
      fs.stat(path.join(state.root, 'A', 'task-copies', 'outgoing', status.targetSessionId!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
    state.uploadedProgress.mockReset();
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('cancelling stops the file in flight instead of waiting for it to finish', async () => {
    let started!: () => void;
    const uploading = new Promise<void>((resolve) => (started = resolve));
    state.stallUpload = () => started();
    expect((await start()).cancellable).toBe(true);
    await uploading;
    expect(await requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).toMatchObject({
      running: true,
      cancelling: true,
    });
    // Without aborting the stalled upload this never settles.
    const status = await settled();
    expect(status.stage).toBe('cancelled');
    expect(status.error).toBeUndefined();
    expect(state.files.size).toBe(0);
    expect(state.imports).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(state.root, 'A', 'task-copies', 'outgoing', status.targetSessionId!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    state.stallUpload = undefined;
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('closing a failed transfer removes source staging without deleting an already committed target', async () => {
    state.loseReply = 'receive';
    await start();
    const result = await settled();
    expect(result.stage).toBe('transferring');
    const target = state.rows.get('B')!.get(result.targetSessionId!)!;
    const targetFile = path.join(target.workingDir as string, 'draft');
    expect(await fs.readFile(targetFile, 'utf8')).toBe('original');
    const uploadedKeys = [...state.files.keys()];
    expect(uploadedKeys.length).toBeGreaterThan(0);
    state.remove.mockClear();
    expect((await requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).stage).toBe(
      'cancelled',
    );
    expect(state.remove.mock.calls.map(([key]) => key)).toEqual(uploadedKeys);
    await expect(
      fs.stat(path.join(state.root, 'A', 'task-copies', 'outgoing', result.targetSessionId!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(targetFile, 'utf8')).toBe('original');
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('rejects insufficient destination space before uploading and remains cancellable', async () => {
    state.noSpace = true;
    await start();
    const status = await settled();
    expect(status.stage).toBe('preparing');
    expect(status.error).toBe('MIGRATION_NO_SPACE');
    expect(state.migrationWarn).toHaveBeenCalledWith(
      'task copy failed',
      expect.objectContaining({ copyId: status.targetSessionId, code: 'MIGRATION_NO_SPACE' }),
    );
    expect(state.files.size).toBe(0);
    expect(state.imports).not.toHaveBeenCalled();
    // Closing the failure dialog cancels the copy; the code must survive as the only trace.
    const cancelled = await requestTaskMigration({ action: 'cancel', sessionId: 'fork' });
    expect(cancelled).toMatchObject({ stage: 'cancelled', error: 'MIGRATION_NO_SPACE' });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });
  it('keeps cancellation retryable when staging cleanup fails', async () => {
    state.noSpace = true;
    await start();
    const status = await settled();
    const directory = path.join(
      state.root,
      'A',
      'task-copies',
      'outgoing',
      status.targetSessionId!,
    );
    const snapshot = await fs.readFile(path.join(directory, 'session.cshare'));
    const remove = fs.rm.bind(fs);
    const failCleanup = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === directory) throw new Error('cleanup denied');
      return remove(file, options);
    });
    try {
      await expect(requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).rejects.toThrow(
        'cleanup denied',
      );
      expect((await settled()).stage).toBe('preparing');
      await expect(start()).rejects.toThrow('MIGRATION_ALREADY_STARTED');
      expect(await fs.readFile(path.join(directory, 'session.cshare'))).toEqual(snapshot);
    } finally {
      failCleanup.mockRestore();
    }
    expect((await requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).stage).toBe(
      'cancelled',
    );
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
    state.noSpace = false;
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('reclaims interrupted upload parts before resource checks, preserving snapshots and other handoffs', async () => {
    const workerDir = await team();
    state.restoresFail = true;
    await start();
    const interrupted = await settled();
    expect(interrupted.stage).toBe('transferring');
    const directory = path.join(
      state.root,
      'A',
      'task-copies',
      'outgoing',
      interrupted.targetSessionId!,
    );
    const leftovers = [directory, path.join(directory, '1')].map((dir) =>
      path.join(dir, 'parts-Ab12Cd'),
    );
    const unrelated = path.join(
      state.root,
      'A',
      'task-copies',
      'outgoing',
      'another-handoff',
      'parts-Ab12Cd',
    );
    const sourceParts = path.join(workerDir, 'parts-Ab12Cd');
    for (const dir of [...leftovers, unrelated, sourceParts]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'part'), 'retained bytes');
    }
    const snapshot = await fs.readFile(path.join(directory, 'session.cshare'));
    const uploads = state.files.size;
    const remove = fs.rm.bind(fs);
    const failCleanup = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === leftovers[0]) throw new Error('cleanup denied');
      return remove(file, options);
    });
    try {
      await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
      expect((await settled()).stage).toBe('transferring');
      expect(state.files.size).toBe(uploads);
      expect(await fs.readFile(path.join(leftovers[0], 'part'), 'utf8')).toBe('retained bytes');
    } finally {
      failCleanup.mockRestore();
    }
    state.noSpace = true;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).error).toBe('MIGRATION_NO_SPACE');
    for (const dir of leftovers)
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(directory, 'session.cshare'))).toEqual(snapshot);
    expect(state.files.size).toBe(uploads);
    state.noSpace = false;
    state.restoresFail = false;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    for (const dir of [unrelated, sourceParts])
      expect(await fs.readFile(path.join(dir, 'part'), 'utf8')).toBe('retained bytes');
    expect(await fs.readFile(path.join(workerDir, 'draft'), 'utf8')).toBe('worker files');
  });
  it('adopts a committed import after its database reply is lost', async () => {
    state.importsFail = true;
    await start();
    expect((await settled()).stage).toBe('transferring');
    expect(state.recentProjects).toEqual([]);
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
    // The adopted copy still joins the recent projects.
    expect(state.recentProjects).toEqual([path.join(state.root, 'shared 2')]);
  });

  it('copies tasks with automation bindings without modifying the source', async () => {
    const db = state.dbs.get('A')!;
    const original = db.queryOne.getMockImplementation()!;
    db.queryOne.mockImplementation(async (sql, args) =>
      sql.includes('schedules') ? { n: 4 } : original(sql, args),
    );
    const before = structuredClone(state.rows.get('A')!.get('fork'));
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    expect(state.rows.get('A')!.get('fork')).toEqual(before);
    expect(state.close).not.toHaveBeenCalled();
    expect(db.queryOne.mock.calls.some(([sql]) => sql.includes('schedules'))).toBe(false);
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });
  it('copies a project task into a new project at the same home-relative path without overwriting', async () => {
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    const receipt = state.context.run({ device: 'B' }, () =>
      migrationScope().readIncoming(result.targetSessionId!)!,
    );
    // Both test computers share one home, where the source folder already exists.
    expect(receipt.workingDir).toBe(path.join(state.root, 'shared 2'));
    expect(state.recentProjects).toEqual([receipt.workingDir]);
    expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe('original');
  });
  it('reuses its own empty folder on retry instead of leaving a numbered copy behind', async () => {
    state.archiveDownloadFails = true;
    await start();
    expect((await settled()).stage).toBe('transferring');
    expect(await fs.readdir(path.join(state.root, 'shared 2'))).toEqual([]);
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    const result = await settled();
    expect(result.stage).toBe('complete');
    const receipt = state.context.run({ device: 'B' }, () =>
      migrationScope().readIncoming(result.targetSessionId!)!,
    );
    expect(receipt.workingDir).toBe(path.join(state.root, 'shared 2'));
    expect(receipt.retainedWorkingDirs ?? []).toEqual([]);
    await expect(fs.stat(path.join(state.root, 'shared 3'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  async function moveSource(...segments: string[]) {
    const cwd = path.join(state.root, ...segments);
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, 'draft'), 'original');
    state.rows.get('A')!.get('fork')!.workingDir = cwd;
  }
  const copiedDir = async () => {
    const result = await settled();
    expect(result.stage).toBe('complete');
    return state.context.run(
      { device: 'B' },
      () => migrationScope().readIncoming(result.targetSessionId!)!.workingDir,
    );
  };
  it('names a worktree task copy after the project it belongs to', async () => {
    await moveSource('app', '.cindy-worktrees', 'feature');
    await start();
    expect(await copiedDir()).toBe(path.join(state.root, 'app 2'));
  });
  it.each([
    ['parent', ['Code']],
    // E.g. a Windows reserved name such as CON: the parent exists, the folder itself is refused.
    ['folder', ['Code', 'app 2']],
  ])(
    'falls back to the project folder name when the mirrored %s cannot be created',
    async (_kind, blockedPath) => {
      await moveSource('Code', 'app');
      const blocked = path.join(state.root, ...blockedPath);
      const mkdir = fs.mkdir.bind(fs);
      const spy = vi
        .spyOn(fs, 'mkdir')
        .mockImplementation(((dir, options) =>
          dir === blocked
            ? Promise.reject(Object.assign(new Error('refused'), { code: 'EINVAL' }))
            : mkdir(dir, options)) as typeof fs.mkdir);
      try {
        await start();
        const dir = await copiedDir();
        expect(dir).toBe(path.join(state.root, 'app'));
        expect(state.recentProjects).toEqual([dir]);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it('copies a chat task into the dialogue workspace without adding a project', async () => {
    state.rows.get('A')!.get('fork')!.workspaceKind = 'dialogue';
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    const receipt = state.context.run({ device: 'B' }, () =>
      migrationScope().readIncoming(result.targetSessionId!)!,
    );
    const day = path.dirname(receipt.workingDir);
    expect(path.dirname(day)).toBe(path.join(state.root, 'dialogues'));
    expect(path.basename(day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(path.basename(receipt.workingDir)).toBe(result.targetSessionId);
    expect(state.recentProjects).toEqual([]);
  });
  it('copies the complete team and keeps independent target directories', async () => {
    const separate = await team();
    const before = structuredClone([...state.rows.get('A')!]);
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    expect(state.snapshot).toHaveBeenCalledTimes(2);
    expect([...state.rows.get('A')!]).toEqual(before);
    const receipt = state.context.run({ device: 'B' }, () =>
      migrationScope().readIncoming(result.targetSessionId!)!,
    );
    expect(receipt.stage).toBe('active');
    expect(receipt.workers).toHaveLength(2);
    expect(receipt.workers![0].workingDir).toBe(receipt.workingDir);
    expect(receipt.workers![1].workingDir).not.toBe(separate);
    expect(await fs.readFile(path.join(separate, 'draft'), 'utf8')).toBe('worker files');
    expect(state.created).toHaveBeenCalledTimes(3);
  });
  it('recovers a lost receive reply without a second import or source retirement', async () => {
    state.loseReply = 'receive';
    await start();
    const interrupted = await settled();
    expect(interrupted.stage).toBe('transferring');
    const receipt = state.context.run({ device: 'B' }, () =>
      migrationScope().readIncoming(interrupted.targetSessionId!)!,
    );
    expect(receipt.stage).toBe('active');
    expect(state.rows.get('A')!.get('fork')!.status).toBe('active');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
  });
  it('refuses to cancel a resumed transfer before its receipt rules out a target import', async () => {
    state.loseReply = 'receive';
    await start();
    expect((await settled()).stage).toBe('transferring');
    const retry = await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect(retry.running).toBe(true);
    expect(retry.cancellable).toBeUndefined();
    await expect(requestTaskMigration({ action: 'cancel', sessionId: 'fork' })).rejects.toThrow(
      'MIGRATION_CANNOT_CANCEL',
    );
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
  });
  it('finishes despite skipped entries and reports them until the next copy', async () => {
    state.skipped = [{ path: 'Pods/out.h', code: 'MIGRATION_EXTERNAL_LINK' }];
    await start();
    const first = await settled();
    expect(first.stage).toBe('complete');
    expect(first.error).toBeUndefined();
    expect(first.skipped).toEqual({ total: 1, entries: state.skipped });
    state.skipped = [];
    await start();
    const second = await settled();
    expect(second.stage).toBe('complete');
    expect(second.skipped).toBeUndefined();
  });
  it('allows another independent copy after completion', async () => {
    await start();
    const first = await settled();
    await start();
    const second = await settled();
    expect(second.stage).toBe('complete');
    expect(second.targetSessionId).not.toBe(first.targetSessionId);
    expect(state.rows.get('B')!.size).toBe(2);
  });
  it('does not scan unrelated or legacy journals when reading copy progress', async () => {
    const root = migrationScope().root;
    await fs.mkdir(path.join(root, 'records'), { recursive: true });
    await fs.writeFile(path.join(root, 'records', 'unrelated.json'), '{broken');
    expect(migrationScope().read('fork')).toBeNull();
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('adopts the complete team after a lost import acknowledgement without duplicating workers', async () => {
    await team();
    state.importsFail = true;
    await start();
    expect((await settled()).stage).toBe('transferring');
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
    expect(state.rows.get('B')!.size).toBe(3);
  });

  it('rejects the whole team when any worker has queued input and keeps the lead writable', async () => {
    await team();
    state.rows.get('A')!.get('separate-worker')!.payload = JSON.stringify([{ text: 'pending' }]);
    await expect(start()).rejects.toThrow('MIGRATION_TASK_QUEUED');
    expect(state.exported).not.toHaveBeenCalled();
  });

  it.each(['receiving', 'committed', 'imported'])(
    'reclaims interrupted receive staging before retrying a %s receipt',
    async (stage) => {
      state.restoresFail = stage === 'receiving';
      state.importsFail = stage === 'committed';
      const remove = fs.rm.bind(fs);
      let staging = '';
      // Leave actual transfer artifacts behind as a process exit would. A completed
      // import must not confirm completion while cleanup still needs a retry.
      const cleanup = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (
          device() === 'B' &&
          (await fs.stat(path.join(String(target), 'workspace.json')).catch(() => null))
        ) {
          staging = String(target);
          throw new Error('receive cleanup interrupted');
        }
        return remove(target, options);
      });
      try {
        await start();
        const interrupted = await settled();
        expect(interrupted.stage).toBe('transferring');
        expect(staging).not.toBe('');
        const receipt = state.context.run({ device: 'B' }, () =>
          migrationScope().readIncoming(interrupted.targetSessionId!)!,
        );
        expect(receipt.stage).toBe('receiving');
        const otherStaging = path.join(path.dirname(staging), 'other-migration');
        await fs.mkdir(otherStaging);
        await fs.writeFile(path.join(otherStaging, 'keep'), 'other transfer');
        await fs.writeFile(path.join(receipt.workingDir, 'draft'), 'user recovery edit');
        expect(await fs.readdir(staging)).toContain('workspace.json');
        const imports = state.imports.mock.calls.length;
        await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
        expect((await settled()).stage).toBe('transferring');
        expect(state.imports).toHaveBeenCalledTimes(imports);
        cleanup.mockRestore();
        state.restoresFail = false;
        await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
        expect((await settled()).stage).toBe('complete');
        await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(path.join(otherStaging, 'keep'), 'utf8')).toBe('other transfer');
        expect(state.imports).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(path.join(receipt.workingDir, 'draft'), 'utf8')).toBe(
          'user recovery edit',
        );
        expect(await fs.readFile(path.join(state.root, 'shared', 'draft'), 'utf8')).toBe(
          'original',
        );
      } finally {
        cleanup.mockRestore();
      }
    },
  );

  it('copies a Feishu task while leaving its source identity intact', async () => {
    state.rows.get('A')!.get('fork')!.source = 'feishu';
    await start();
    const result = await settled();
    expect(result.stage).toBe('complete');
    expect(state.rows.get('A')!.get('fork')!.source).toBe('feishu');
    expect(state.rows.get('B')!.get(result.targetSessionId!)!.source).toBe('shared');
  });
  it('does not disclose another source device receipt', async () => {
    await start();
    const result = await settled();
    await expect(
      state.context.run({ device: 'B', peer: 'C' }, () =>
        requestTaskMigration({
          action: 'receipt',
          id: result.targetSessionId!,
          sourceSessionId: 'fork',
        }),
      ),
    ).rejects.toThrow('MIGRATION_ID_CONFLICT');
  });

  it('copies a task whose only missing media were already missing on the source', async () => {
    state.exportMedia = { mediaMissing: 3, mediaDropped: 0 };
    await start();
    expect((await settled()).stage).toBe('complete');
  });
  it('stops copying when source media exists but could not be packaged', async () => {
    state.exportMedia = { mediaMissing: 1, mediaDropped: 1 };
    await start();
    expect(await settled()).toMatchObject({
      stage: 'preparing',
      error: 'MIGRATION_INCOMPLETE_CONTEXT',
    });
    expect(state.imports).not.toHaveBeenCalled();
  });
  it('discards a snapshot when a new turn finishes during preparation', async () => {
    state.snapshot.mockImplementationOnce(() => {
      state.rows.get('A')!.get('fork')!.updatedAt = 123;
    });
    await start();
    expect(await settled()).toMatchObject({
      stage: 'preparing',
      error: 'MIGRATION_SOURCE_CHANGED',
    });
    expect(state.imports).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    expect((await settled()).stage).toBe('complete');
  });
  it('reports which project entry blocked packing until a retry succeeds', async () => {
    const { MigrationPathError } = await import('../workspace');
    state.snapshot.mockImplementationOnce(() => {
      throw new MigrationPathError('MIGRATION_NONPORTABLE_PATH', 'apps/desktop/C:');
    });
    await start();
    expect(await settled()).toMatchObject({
      stage: 'preparing',
      error: 'MIGRATION_NONPORTABLE_PATH',
      errorPath: 'apps/desktop/C:',
    });
    expect(state.migrationWarn).toHaveBeenCalledWith(
      'task copy failed',
      expect.objectContaining({
        code: 'MIGRATION_NONPORTABLE_PATH',
        error: expect.stringContaining('apps/desktop/C:'),
      }),
    );
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    const done = await settled();
    expect(done.stage).toBe('complete');
    expect(done.error).toBeUndefined();
    expect(done.errorPath).toBeUndefined();
  });
  it('sends a large native transcript beside the package and restores it', async () => {
    state.transcript = '{"type":"session_meta"}\n'.repeat(4);
    await start();
    expect((await settled()).stage).toBe('complete');
    expect(state.exported.mock.calls[0][0].externalTranscripts).toMatchObject({
      minBytes: 32 * 1024 * 1024,
    });
    expect(state.importedTranscripts).toEqual([
      { path: 'transcripts/codex/rollout.jsonl', content: state.transcript },
    ]);
    // Its upload is tracked with the others, so completing the copy deletes it too.
    const transcriptKey = [...state.files].find(([, file]) => file.includes('transcript-0-'))![0];
    expect(state.remove.mock.calls.map(([key]) => key)).toContain(transcriptKey);
  });
  it('stops before uploading more transcripts than the target accepts', async () => {
    state.transcript = 'native history';
    state.transcriptCount = TASK_MIGRATION_MAX_TRANSCRIPTS + 1;
    await start();
    expect(await settled()).toMatchObject({ stage: 'preparing', error: 'MIGRATION_NO_MEMORY' });
    expect(state.files.size).toBe(0);
  });
  it('keeps transcripts inside the package for a target without the capability', async () => {
    state.transcript = 'native history';
    state.oldTarget = true;
    await start();
    expect((await settled()).stage).toBe('complete');
    expect(state.exported.mock.calls[0][0].externalTranscripts).toBeUndefined();
    expect(state.importedTranscripts).toEqual([]);
  });
  it('explains a package that exceeds the memory budget until a retry succeeds', async () => {
    state.exportOversize = { totalBytes: 900, limitBytes: 100, transcriptBytes: 0 };
    await start();
    expect(await settled()).toMatchObject({
      stage: 'preparing',
      error: 'MIGRATION_NO_MEMORY',
      errorSize: { needed: 900, limit: 100 },
    });
    expect(state.migrationWarn).toHaveBeenCalledWith(
      'task copy package exceeds the memory budget',
      expect.objectContaining({
        totalBytes: 900,
        limitBytes: 100,
        budget: expect.objectContaining({ budget: expect.any(Number) }),
      }),
    );
    state.exportOversize = null;
    await requestTaskMigration({ action: 'retry', sessionId: 'fork' });
    const done = await settled();
    expect(done.stage).toBe('complete');
    expect(done.errorSize).toBeUndefined();
  });
  it('asks to update an older target only when moving large transcripts would fit', async () => {
    const MB = 1024 ** 2;
    state.oldTarget = true;
    state.exportOversize = {
      totalBytes: 900 * MB,
      limitBytes: 100 * MB,
      transcriptBytes: 850 * MB,
      transcriptFileBytes: [850 * MB],
    };
    await start();
    expect(await settled()).toMatchObject({ error: 'MIGRATION_UNSUPPORTED' });
    expect((await settled()).errorSize).toBeUndefined();
  });
  it('reports the size when an updated target would still keep small transcripts inside', async () => {
    const MB = 1024 ** 2;
    state.oldTarget = true;
    // Thirty 28 MB transcripts stay in the package even on an updated target.
    state.exportOversize = {
      totalBytes: 900 * MB,
      limitBytes: 100 * MB,
      transcriptBytes: 840 * MB,
      transcriptFileBytes: Array.from({ length: 30 }, () => 28 * MB),
    };
    await start();
    expect(await settled()).toMatchObject({
      error: 'MIGRATION_NO_MEMORY',
      errorSize: { needed: 900 * MB, limit: 100 * MB },
    });
  });
  it('serializes admission even without process-local route locks', async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await settled()).stage).toBe('complete');
    expect(state.imports).toHaveBeenCalledTimes(1);
  });
});
