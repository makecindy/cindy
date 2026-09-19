import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CindyMakeHistoryRecord, MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';
const h = vi.hoisted(() => ({
  current: true,
  running: false,
  busy: false,
  exists: true,
  rows: [] as any[],
  cards: [] as any[],
  records: new Map<string, CindyMakeHistoryRecord>(),
  state: {} as any,
  verify: vi.fn(async () => {}),
  merge: vi.fn(),
  end: vi.fn(),
  saved: vi.fn(),
  artifactPath: vi.fn(),
  showItem: vi.fn(),
  build: vi.fn(),
  testBuild: undefined as
    | { buildId: string; status: string; stopping?: boolean }
    | undefined,
  cancelTestBuild: vi.fn(),
}));
const store = {
  readBuild: vi.fn(),
  saveBuild: vi.fn(),
  directory: path.join(os.tmpdir(), 'history-runtime-unit-no-io'),
  read: (id: string) => h.records.get(id),
  list: () => [...h.records.values()].map((record) => structuredClone(record)),
  seed: (record: any) => {
    h.saved();
    const old = h.records.get(record.runId);
    h.records.set(record.runId, {
      schema: 1,
      completions: [],
      receipts: [],
      versions: [],
      ...record,
      ...old,
    });
  },
  completion: (id: string, completion: any) => {
    const record = h.records.get(id)!;
    record.completions = [
      ...record.completions.filter((entry) => entry.id !== completion.id),
      completion,
    ];
  },
  receipt: (id: string, receipt: MakeFeatureReceipt) => h.records.get(id)!.receipts.push(receipt),
  version: vi.fn(),
};
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'history-runtime-profile') },
  shell: { showItemInFolder: h.showItem },
}));
vi.mock('node:fs', () => ({ existsSync: () => h.exists }));
vi.mock('../../utils/atomicWriteFile.js', () => ({
  readAtomicFileSync: () => null,
  atomicWriteFileSync: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../historyOwner.js', () => ({ captureMakeHistoryStore: () => store }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'owner' }),
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => client }));
vi.mock('../../localDb/sessionRouteLock.js', () => ({
  withSessionRouteLock: async (_id: string, run: () => unknown) => run(),
}));
vi.mock('../upstreamMergeRuntime.js', () => ({
  integrateMakeHistory: h.merge,
  actUpstreamMerge: vi.fn(),
}));
vi.mock('../taskManagement.js', () => ({ manageCindyMakeTask: h.end }));
vi.mock('../testRuntime.js', () => ({
  actCindyMakeTest: vi.fn(),
  cindyMakeTestController: {
    hasActiveJobs: () => !!h.testBuild,
    isBuilding: () => !!h.testBuild,
    activeBuild: () => h.testBuild,
    cancelBuild: h.cancelTestBuild,
  },
}));
vi.mock('../testRunner.js', () => ({ verifyMakeTestWorkspace: h.verify }));
vi.mock('../personalBuild.js', () => ({
  buildCindyPersonal: h.build,
  personalBuildEnvironment: vi.fn(),
  personalArtifactPath: h.artifactPath,
}));
vi.mock('../versionStartup.js', () => ({
  rememberOriginalVersion: vi.fn(),
  currentVersionProfile: vi.fn(),
}));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: async () => ({
    probe: async () => ({ path: process.execPath, status: 'ok' }),
  }),
  resolveMakeToolEnvironment: async () => ({}),
}));
vi.mock('../sourceGit.js', () => ({
  runSourceGit: async (_env: unknown, args: string[]) =>
    args[0] === 'branch' ? 'cindy-personal' : '',
}));
import { cindyMakeManager } from '../manager';
const realHasActiveWork = cindyMakeManager.hasActiveWork.bind(cindyMakeManager);
import { sessions } from '../../localDb/schema';
import {
  configureMakeHistory,
  getCindyMakeHistory,
  actCindyMakeHistory,
  cancelHistoryPersonalVersion,
  openHistoryPersonalBuild,
  generateHistoryPersonalVersion,
} from '../historyRuntime';
const client = {
  drizzle: {
    select: () => {
      let table: unknown;
      const query = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        where: () => query,
        limit: async () => h.rows,
        then: (resolve: (value: any[]) => unknown) =>
          Promise.resolve(table === sessions ? h.rows : h.cards).then(resolve),
      };
      return query;
    },
  },
};
const receipt: MakeFeatureReceipt = {
  id: 'operation',
  action: 'integrate',
  at: 4,
  baselineCommit: 'a'.repeat(40),
  commit: 'b'.repeat(40),
  beforeTree: 'c'.repeat(40),
  tree: 'd'.repeat(40),
  taskTree: 'e'.repeat(40),
};
beforeEach(() => {
  vi.clearAllMocks();
  store.readBuild.mockReset();
  store.saveBuild.mockReset();
  h.artifactPath.mockResolvedValue(path.join(os.tmpdir(), 'history-installer.exe'));
  h.current = true;
  h.running = false;
  h.busy = false;
  h.testBuild = undefined;
  h.cancelTestBuild.mockReset();
  vi.spyOn(cindyMakeManager, 'getState').mockImplementation(() => h.state);
  h.exists = true;
  h.records.clear();
  h.state = {};
  h.verify.mockResolvedValue(undefined);
  vi.spyOn(cindyMakeManager, 'hasActiveWork').mockImplementation(
    () => h.busy || realHasActiveWork(),
  );
  configureMakeHistory(() => h.running);
  h.rows = [
    {
      id: 'session',
      source: 'cindy-make',
      status: 'active',
      remoteHostId: null,
      title: 'Feature',
      createdAt: 1,
      updatedAt: 2,
      workingDir: path.join(
        os.tmpdir(),
        'history-runtime-profile',
        'cindy-make',
        'worktrees',
        'aaaa',
      ),
    },
  ];
  h.cards = [
    {
      id: 1,
      sessionId: 'session',
      role: 'assistant',
      clientId: 'complete',
      content: '',
      createdAt: 3,
      agentMeta: JSON.stringify({
        cindyMakeCompletion: { reportedAt: 3, commit: 'f'.repeat(40), tree: 'e'.repeat(40) },
      }),
    },
  ];
});
describe('history Main admission and owner boundary', () => {
  it('releases history integration and builds after real manager preparation and failed cleanup settle', async () => {
    const runId = 'prepared-history';
    const report = {
      runId,
      platform: 'win32',
      arch: 'x64',
      checks: [],
      status: 'running' as const,
      task: { sessionId: 'prepared-session', phase: 'waiting' as const },
    };
    let release!: () => void;
    await cindyMakeManager.startTask(
      { runId, request: 'fix', title: 'fix' },
      {
        create: async () => report,
        persist: async () => {},
        start: async () => {},
        prepare: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        isCurrent: () => true,
        onError: () => {},
      },
    );
    expect((await getCindyMakeHistory('aaaa')).busy).toBe(true);
    release();
    await cindyMakeManager.waitForTask(runId);
    expect(cindyMakeManager.taskReport(runId)?.status).toBe('completed');
    await expect(
      cindyMakeManager.runTaskAction(
        'failed-cleanup',
        'delete',
        () => true,
        async () => {
          throw new Error('locked');
        },
      ),
    ).rejects.toThrow('locked');
    const state = await getCindyMakeHistory('aaaa');
    expect(state).toMatchObject({ busy: false, canBuild: true });
    expect(state.items[0].actions).toContain('integrate');
    cindyMakeManager.forgetTask(runId);
  });
  it('shows and stops a completion-card build by the same identity without marking it interrupted', async () => {
    h.testBuild = { buildId: 'card-build', status: 'packaging' };
    store.readBuild.mockImplementation(() => h.testBuild);
    expect(await getCindyMakeHistory()).toMatchObject({ busy: true, build: h.testBuild });
    expect(store.saveBuild).not.toHaveBeenCalled();
    await cancelHistoryPersonalVersion('old-build');
    expect(h.cancelTestBuild).not.toHaveBeenCalled();
    h.cancelTestBuild.mockImplementation(async () => {
      h.testBuild!.stopping = true;
    });
    expect(await cancelHistoryPersonalVersion('card-build')).toMatchObject({
      build: { stopping: true },
    });
    expect(h.cancelTestBuild).toHaveBeenCalledWith('card-build');
  });
  it('settles a failed background build with its known cause and releases controls for retry', async () => {
    let buildState: any;
    store.readBuild.mockImplementation(() => buildState);
    store.saveBuild.mockImplementation((value) => {
      buildState = value;
    });
    let fail!: (error: Error) => void;
    h.build.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    expect(await generateHistoryPersonalVersion()).toMatchObject({ busy: true, canBuild: false });
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    fail(Object.assign(new Error('private test output'), { code: 'checksFailed' }));
    await vi.waitFor(async () => {
      expect(await getCindyMakeHistory()).toMatchObject({
        busy: false,
        canBuild: true,
        build: { status: 'failed', error: 'checksFailed' },
      });
    });
    expect(JSON.stringify(buildState)).not.toContain('private test output');
  });
  it('marks a running build as stopping and aborts only the matching build identity', async () => {
    let buildState: any;
    store.readBuild.mockImplementation(() => buildState);
    store.saveBuild.mockImplementation((value) => {
      buildState = value;
    });
    let signal!: AbortSignal;
    h.build.mockImplementationOnce(
      (...args: any[]) =>
        new Promise((_resolve, reject) => {
          signal = args[4];
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })),
            { once: true },
          );
        }),
    );
    await expect(generateHistoryPersonalVersion()).resolves.toMatchObject({ busy: true });
    await vi.waitFor(() => expect(buildState?.buildId).toBeTypeOf('string'));
    const buildId = buildState.buildId;
    await expect(cancelHistoryPersonalVersion('other-build')).resolves.toMatchObject({
      busy: true,
    });
    expect(signal.aborted).toBe(false);
    const state = await cancelHistoryPersonalVersion(buildId);
    expect(signal.aborted).toBe(true);
    expect(state.build).toMatchObject({ buildId, stopping: true });
    await vi.waitFor(() =>
      expect(buildState).toMatchObject({ status: 'failed', error: 'cancelled' }),
    );
  });
  it('keeps an old generated record unverified when its integration delta cannot be reconstructed', async () => {
    const meta = JSON.parse(h.cards[0].agentMeta);
    meta.cindyMakeCompletion.personal = {
      status: 'ready',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    };
    h.cards[0].agentMeta = JSON.stringify(meta);
    expect((await getCindyMakeHistory('aaaa')).items[0]).toMatchObject({
      integration: 'unknown',
      actions: ['open', 'end'],
    });
    await expect(actCindyMakeHistory('aaaa', 'revert')).rejects.toThrow('unavailable');
    expect(h.merge).not.toHaveBeenCalled();
  });
  it('opens only the saved verified installer and rejects an owner transition before file access', async () => {
    await expect(openHistoryPersonalBuild()).rejects.toThrow('unavailable');
    expect(h.artifactPath).not.toHaveBeenCalled();
    const build = {
      status: 'ready',
      buildId: 'saved-build',
      artifactDirectory: 'saved-build-output',
      artifactName: 'Cindy.exe',
      commit: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
    };
    store.readBuild.mockReturnValue(build);
    await openHistoryPersonalBuild();
    expect(h.artifactPath).toHaveBeenCalledWith(
      path.join(os.tmpdir(), 'history-runtime-profile'),
      'saved-build',
      build,
    );
    expect(h.showItem).toHaveBeenCalledWith(path.join(os.tmpdir(), 'history-installer.exe'));
    h.current = false;
    await expect(openHistoryPersonalBuild()).rejects.toThrow('unavailable');
    expect(h.artifactPath).toHaveBeenCalledOnce();
    expect(h.showItem).toHaveBeenCalledOnce();
  });
  it('shows writes only after selecting and verifying the record, and rejects stale completion files', async () => {
    expect((await getCindyMakeHistory()).items[0].actions).toEqual(['open']);
    expect((await getCindyMakeHistory('aaaa')).items[0].actions).toContain('integrate');
    h.verify.mockRejectedValue(Object.assign(new Error('changed'), { code: 'changed' }));
    await expect(actCindyMakeHistory('aaaa', 'integrate')).rejects.toThrow('unavailable');
    expect(h.merge).not.toHaveBeenCalled();
  });
  it('retains ended history and undo but does not pretend a missing source can still be changed', async () => {
    await getCindyMakeHistory();
    const record = h.records.get('aaaa')!;
    record.receipts.push(receipt);
    record.endedAt = 5;
    h.rows[0].status = 'archived';
    expect((await getCindyMakeHistory('aaaa')).items[0]).toMatchObject({
      lifecycle: 'ended',
      integration: 'unknown',
      actions: ['open', 'build'],
    });
    h.exists = false;
    expect((await getCindyMakeHistory('aaaa')).items[0]).toMatchObject({
      integration: 'unknown',
      actions: ['open'],
    });
  });
  it('explains an empty action area when the ended task is no longer available', async () => {
    h.rows[0].status = 'deleted';
    h.exists = false;
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.actions).toEqual([]);
    expect(item.actionReason).toBe('sessionUnavailable');
  });
  it('keeps a failed personal build actionable after the task itself ended', async () => {
    h.cards[0].agentMeta = JSON.stringify({
      cindyMakeCompletion: {
        reportedAt: 3,
        commit: 'f'.repeat(40),
        tree: 'e'.repeat(40),
        personal: { status: 'failed', error: 'checksFailed' },
      },
    });
    await getCindyMakeHistory();
    const record = h.records.get('aaaa')!;
    record.endedAt = 5;
    h.rows[0].status = 'deleted';
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.actions).toContain('build');
    expect(item.actions).not.toEqual([]);
  });
  it('does not offer mutation controls while the task is running or after a new user message', async () => {
    h.running = true;
    expect((await getCindyMakeHistory('aaaa')).items[0].actions).toEqual(['open']);
    h.running = false;
    h.cards.push({
      id: 2,
      sessionId: 'session',
      role: 'user',
      clientId: 'next',
      content: '',
      agentMeta: null,
      createdAt: 4,
    });
    expect((await getCindyMakeHistory('aaaa')).items[0].actions).not.toContain('integrate');
    await expect(actCindyMakeHistory('aaaa', 'integrate')).rejects.toThrow();
  });
  it('never writes captured task data into an owner that changed while the read was pending', async () => {
    h.current = false;
    await expect(getCindyMakeHistory()).rejects.toThrow('unavailable');
    expect(h.saved).not.toHaveBeenCalled();
  });
  it('uses the selected record’s verified snapshot, not caller-supplied Git inputs', async () => {
    await actCindyMakeHistory('aaaa', 'integrate');
    expect(h.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'aaaa',
        taskSessionId: 'session',
        taskTree: 'e'.repeat(40),
        mergeCommit: 'f'.repeat(40),
      }),
      expect.any(Object),
    );
    await expect(actCindyMakeHistory('../source', 'revert')).rejects.toThrow('Invalid');
  });
});
