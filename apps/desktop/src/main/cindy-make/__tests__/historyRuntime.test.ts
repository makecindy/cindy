import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CindyMakeHistoryRecord, MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';
import type { MakeTestContext } from '../testController';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';
const h = vi.hoisted(() => ({
  current: true,
  running: false,
  busy: false,
  exists: true,
  rows: [] as any[],
  cards: [] as any[],
  records: new Map<string, CindyMakeHistoryRecord>(),
  state: {} as any,
  routeLocks: new Set<string>(),
  verify: vi.fn(async (_workspace: { runId: string }) => {}),
  merge: vi.fn(),
  waitForMerge: vi.fn(),
  finishCleanup: vi.fn(),
  syncBuild: vi.fn(),
  syncBeforeBuild: false,
  git: vi.fn(),
  end: vi.fn(),
  saved: vi.fn(),
  artifactPath: vi.fn(),
  showItem: vi.fn(),
  build: vi.fn(),
  testBuild: undefined as
    { buildId: string; status: string; stopping?: boolean; sessionId?: string } | undefined,
  cancelTestBuild: vi.fn(),
  testStatus: vi.fn(),
  testUsing: false,
  testAction: vi.fn(),
  stopTest: vi.fn(),
  retryMerge: vi.fn(),
  historyChanged: vi.fn(),
}));
const store = {
  readBuildRollback: () => [],
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
  hide: vi.fn((id: string) => {
    h.records.get(id)!.hiddenAt = 6;
  }),
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
  withSessionRouteLock: async (id: string, run: () => unknown) => {
    if (h.routeLocks.has(id)) throw new Error('Nested route lock');
    h.routeLocks.add(id);
    try {
      return await run();
    } finally {
      h.routeLocks.delete(id);
    }
  },
}));
vi.mock('../upstreamMergeRuntime.js', () => ({
  integrateMakeHistory: h.merge,
  actUpstreamMerge: h.retryMerge,
  waitForMakeHistoryMerge: h.waitForMerge,
  finishMakeHistoryCleanup: h.finishCleanup,
  syncSourceBeforeCindyMakeBuild: h.syncBuild,
}));
vi.mock('../settingsStore.js', () => ({
  readCindyMakeSettings: () => ({ syncLatestBeforeBuild: h.syncBeforeBuild }),
}));
vi.mock('../taskManagement.js', () => ({ manageCindyMakeTask: h.end }));
vi.mock('../testRuntime.js', () => ({
  actCindyMakeTest: h.testAction,
  cindyMakeTestController: {
    hasActiveJobs: () => !!h.testBuild || h.testUsing,
    isUsingWorkspace: () => h.testUsing,
    act: h.testStatus,
    isBuilding: (sessionId: string) =>
      !!h.testBuild && (h.testBuild.sessionId ?? 'session') === sessionId,
    activeBuild: () => h.testBuild,
    cancelBuild: h.cancelTestBuild,
    stopTestForBuild: h.stopTest,
  },
}));
vi.mock('../testRunner.js', () => ({ verifyMakeTestWorkspace: h.verify }));
vi.mock('../personalBuild.js', () => ({
  buildCindyPersonal: h.build,
  personalBuildEnvironment: vi.fn(),
  personalBuildError: (code: string) => Object.assign(new Error(code), { code }),
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
  runSourceGit: h.git,
}));
import { cindyMakeManager } from '../manager';
const realHasActiveWork = cindyMakeManager.hasActiveWork.bind(cindyMakeManager);
const realGetState = cindyMakeManager.getState.bind(cindyMakeManager);
import { sessions } from '../../localDb/schema';
import {
  configureMakeHistory,
  getCindyMakeHistory,
  actCindyMakeHistory,
  cancelHistoryPersonalVersion,
  openHistoryPersonalBuild,
  generateHistoryPersonalVersion,
  integrateCompletionForBuild,
  readCindyMakeBuildState,
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
  h.testUsing = false;
  h.testStatus.mockReset();
  h.merge.mockReset();
  h.waitForMerge.mockReset().mockResolvedValue(undefined);
  h.finishCleanup.mockReset().mockResolvedValue(undefined);
  h.syncBuild.mockReset().mockImplementation(async (_signal, publish) => {
    await publish({ status: 'syncing', syncLatestSource: true });
  });
  h.syncBeforeBuild = false;
  h.git
    .mockReset()
    .mockImplementation(async (_env: unknown, args: string[]) =>
      args[0] === 'branch' ? 'cindy-personal' : '',
    );
  h.build.mockReset();
  h.stopTest.mockReset();
  h.cancelTestBuild.mockReset();
  vi.spyOn(cindyMakeManager, 'getState').mockImplementation(() => h.state);
  h.exists = true;
  h.records.clear();
  h.state = {};
  h.routeLocks.clear();
  h.verify.mockResolvedValue(undefined);
  vi.spyOn(cindyMakeManager, 'hasActiveWork').mockImplementation(
    () => h.busy || realHasActiveWork(),
  );
  configureMakeHistory(() => h.running, h.historyChanged);
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
    {
      id: 0,
      sessionId: 'session',
      role: 'user',
      clientId: 'first-request',
      content: JSON.stringify('First round prompt'),
      agentMeta: null,
      createdAt: 2,
    },
  ];
});
describe('history Main admission and owner boundary', () => {
  it.each(['conflicts', 'cleanup'] as const)(
    'retains the %s build record after restart without starting over',
    (mergeStep) => {
      let build: CindyMakePersonalBuildState = {
        status: 'merging',
        mergeStep,
        mergeSessionId: 'resolver',
        buildId: 'original-build',
        startedAt: 10,
        logs: [
          { step: 'merging', at: 11 },
          { step: mergeStep === 'conflicts' ? 'resolving-conflicts' : 'cleaning-merge', at: 12 },
        ],
      };
      const logs = build.logs!;
      store.readBuild.mockImplementation(() => build);
      store.saveBuild.mockImplementation((next) => {
        build = next;
      });
      expect(readCindyMakeBuildState()).toMatchObject({
        status: 'failed',
        error: 'interrupted',
        buildId: 'original-build',
        startedAt: 10,
        mergeSessionId: 'resolver',
      });
      expect(build.logs?.slice(0, 2)).toEqual(logs);
      expect(build.logs?.at(-1)?.step).toBe('failed');
      expect(readCindyMakeBuildState()).toEqual(build);
      expect(store.saveBuild).toHaveBeenCalledOnce();
      expect(h.merge).not.toHaveBeenCalled();
      expect(h.build).not.toHaveBeenCalled();
      expect(h.finishCleanup).not.toHaveBeenCalled();
    },
  );
  it.each(['ready', 'changed', 'unreserved', 'stale-completion'])(
    'validates the card snapshot before merging and releases its route lock before waiting: %s',
    async (condition) => {
      await getCindyMakeHistory('aaaa');
      const task: MakeTestContext = {
        userData: path.join(os.tmpdir(), 'history-runtime-profile'),
        workingDir: h.rows[0].workingDir,
        runId: 'aaaa',
        sessionId: 'session',
        completionId: 'complete',
        commit: 'f'.repeat(40),
        tree: 'e'.repeat(40),
        meta: { reportedAt: 3 },
        isCurrent: () => h.current,
      };
      if (condition !== 'unreserved') h.testBuild = { buildId: 'build', status: 'merging' };
      if (condition === 'changed')
        h.verify.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'changed' }));
      if (condition === 'stale-completion') task.completionId = 'older-round';
      const operation = { id: 'merge-operation', status: 'resolving' };
      h.merge.mockImplementationOnce(async () => {
        expect(h.routeLocks.has('session')).toBe(true);
        return operation;
      });
      h.waitForMerge.mockImplementationOnce(async () => {
        expect(h.routeLocks.size).toBe(0);
      });
      const signal = new AbortController().signal;
      const publish = vi.fn(async () => {
        // Real card persistence re-enters this same route lock.
        expect(h.routeLocks.has(task.sessionId)).toBe(false);
      });
      const result = integrateCompletionForBuild(task, signal, publish);
      if (condition !== 'ready') {
        await expect(result).rejects.toBeInstanceOf(Error);
        expect(h.merge).not.toHaveBeenCalled();
        expect(h.waitForMerge).not.toHaveBeenCalled();
      } else {
        await result;
        expect(h.merge).toHaveBeenCalledWith(
          expect.objectContaining({
            taskSessionId: 'session',
            mergeCommit: task.commit,
            taskTree: task.tree,
          }),
          expect.any(Object),
          signal,
        );
        expect(h.waitForMerge).toHaveBeenCalledWith(operation, signal, publish);
      }
    },
  );
  it('associates each completion with the preceding user prompt', async () => {
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.completions.at(-1)?.prompt).toBe('First round prompt');
    expect(h.records.get('aaaa')?.completions.at(-1)?.prompt).toBe('First round prompt');
  });
  it('skips synthetic UI triggers when associating a completion with its user prompt', async () => {
    h.cards.push({
      id: 2,
      sessionId: 'session',
      role: 'user',
      clientId: 'synthetic-trigger',
      content: JSON.stringify('[UI_ACTION_TRIGGER] continue the task'),
      agentMeta: null,
      createdAt: 2.5,
    });
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.completions.at(-1)?.prompt).toBe('First round prompt');
  });
  it('continues into generation after retrying a failed integration', async () => {
    h.state.upstreamMerge = {
      id: 'failed-merge',
      status: 'failed',
      error: 'checksFailed',
      hasWorkspace: true,
      feature: { runId: 'aaaa', action: 'integrate' },
    };
    h.retryMerge.mockImplementationOnce(async () => {
      h.state.upstreamMerge = undefined;
    });
    await actCindyMakeHistory('aaaa', 'retry');
    expect(h.retryMerge).toHaveBeenCalledWith({ action: 'resolve' });
    expect(h.testAction).toHaveBeenCalledWith('session', 'complete', 'build');
  });
  it('generates a completed task through the same integration and build controller as its completion card', async () => {
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.actions).toContain('build');
    await actCindyMakeHistory('aaaa', 'build');
    expect(h.testAction).toHaveBeenCalledWith('session', 'complete', 'build');
    expect(h.build).not.toHaveBeenCalled();
  });
  it.each(['starting', 'ready', 'failed', 'stopped'] as const)(
    'projects the completion card test receipt: %s',
    async (status) => {
      const meta = JSON.parse(h.cards[0].agentMeta).cindyMakeCompletion;
      const test = {
        status,
        step: 'launching',
        ...(status === 'failed' ? { error: 'launchFailed' } : {}),
      };
      h.cards[0].agentMeta = JSON.stringify({
        cindyMakeCompletion: { ...meta, lastAction: 'test', test },
      });
      h.testUsing = ['starting', 'ready'].includes(status);
      h.testStatus.mockResolvedValue({ ...meta, lastAction: 'test', test });
      const item = (await getCindyMakeHistory('aaaa')).items[0];
      expect(item.test).toEqual(test);
      expect(item.completions.at(-1)?.test).toEqual(test);
      if (status === 'starting') expect(item.actions).toEqual(['open']);
      else if (status === 'ready')
        expect(item.actions).toEqual(['open', 'continue', 'test', 'build']);
      else expect(item.actions).toContain('test');
      expect(item.canHide).toBe(!h.testUsing);
    },
  );
  it('uses the card controller to reconcile an interrupted test after restart', async () => {
    const meta = JSON.parse(h.cards[0].agentMeta).cindyMakeCompletion;
    h.cards[0].agentMeta = JSON.stringify({
      cindyMakeCompletion: { ...meta, test: { status: 'starting' } },
    });
    const recovered = { ...meta, test: { status: 'stopped', error: 'interrupted' } };
    h.testStatus.mockResolvedValue(recovered);
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(h.testStatus).toHaveBeenCalledWith('session', 'complete', 'status');
    expect(item.test).toEqual(recovered.test);
    expect(item.completions.at(-1)?.test).toEqual(recovered.test);
    expect(item.actions).toContain('test');
  });
  it('does not present a previous round test failure during continued editing', async () => {
    const meta = JSON.parse(h.cards[0].agentMeta).cindyMakeCompletion;
    h.cards[0].agentMeta = JSON.stringify({
      cindyMakeCompletion: {
        ...meta,
        continuedAt: 4,
        test: { status: 'failed', error: 'launchFailed' },
      },
    });
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item.test).toBeUndefined();
    expect(item.actions).not.toContain('test');
  });
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
  it('separates retained source conflicts from work that blocks version switching', async () => {
    h.state.upstreamMerge = { id: 'update', status: 'conflict', hasWorkspace: true };
    expect(await getCindyMakeHistory('aaaa')).toMatchObject({
      busy: true,
      activeWork: false,
      canBuild: false,
    });
    await expect(generateHistoryPersonalVersion()).rejects.toThrow('busy');
    expect(h.build).not.toHaveBeenCalled();
    h.busy = true;
    expect(await getCindyMakeHistory('aaaa')).toMatchObject({
      busy: true,
      activeWork: true,
      canBuild: false,
    });
    h.busy = false;
    h.testUsing = true;
    expect(await getCindyMakeHistory('aaaa')).toMatchObject({
      busy: true,
      activeWork: true,
      canBuild: false,
    });
    h.testUsing = false;
    expect(await getCindyMakeHistory('aaaa')).toMatchObject({
      busy: true,
      activeWork: false,
      canBuild: false,
    });
  });
  it('keeps builds and integrations blocked until cancellation finishes even if its directory is gone', async () => {
    h.state.upstreamMerge = {
      id: 'update',
      status: 'failed',
      error: 'cancelFailed',
      hasWorkspace: false,
      cancellationRequested: true,
    };
    const blocked = await getCindyMakeHistory('aaaa');
    expect(blocked).toMatchObject({ busy: true, canBuild: false });
    expect(blocked.items[0].actions).not.toContain('integrate');
    await expect(actCindyMakeHistory('aaaa', 'integrate')).rejects.toThrow('unavailable');
    expect(h.merge).not.toHaveBeenCalled();
    h.state.upstreamMerge = { id: 'update', status: 'cancelled', hasWorkspace: false };
    const released = await getCindyMakeHistory('aaaa');
    expect(released).toMatchObject({ busy: false, canBuild: true });
    expect(released.items[0].actions).toContain('integrate');
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
    expect(h.historyChanged).toHaveBeenCalledOnce();
    expect(JSON.stringify(buildState)).not.toContain('private test output');
  });
  it('syncs the latest official source before a global build only when the setting is on', async () => {
    let buildState: CindyMakePersonalBuildState | undefined;
    store.readBuild.mockImplementation(() => buildState);
    store.saveBuild.mockImplementation((value) => {
      buildState = value;
    });
    h.syncBeforeBuild = true;
    h.build.mockResolvedValueOnce({ commit: 'b'.repeat(40), tree: 'd'.repeat(40) });

    await generateHistoryPersonalVersion();
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(buildState?.status).toBe('ready'));

    expect(h.syncBuild).toHaveBeenCalledOnce();
    expect(h.syncBuild.mock.invocationCallOrder[0]).toBeLessThan(h.build.mock.invocationCallOrder[0]);
    expect(buildState).toMatchObject({ syncLatestSource: true });
    expect(buildState?.logs?.map((entry) => entry.step)).toContain('syncing');
  });
  it('keeps the originating history session visibly running for a source build', async () => {
    let finish!: (value: { commit: string; tree: string }) => void;
    h.build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await generateHistoryPersonalVersion(undefined, ['session']);
    await vi.waitFor(() => expect(realGetState().personalBuildSessionIds).toEqual(['session']));
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledOnce());
    finish({ commit: 'b'.repeat(40), tree: 'd'.repeat(40) });
    await vi.waitFor(() => expect(realGetState().personalBuildSessionIds).toBeUndefined());
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
      actions: ['open'],
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
  it.each(['running', 'testing', 'cleaning'] as const)(
    'rejects a stale cleanup action when the target task becomes %s',
    async (activity) => {
      expect((await getCindyMakeHistory('aaaa')).items[0].canHide).toBe(true);
      if (activity === 'running') h.running = true;
      else if (activity === 'testing') h.testUsing = true;
      else {
        h.busy = true;
        h.state.taskActions = { session: { status: 'running' } };
      }
      await expect(actCindyMakeHistory('aaaa', 'hide')).rejects.toThrow('busy');
      expect(h.end).not.toHaveBeenCalled();
      expect(store.hide).not.toHaveBeenCalled();
    },
  );
  it('keeps cleanup available for an idle history record while another task owns global work', async () => {
    h.busy = true;
    expect((await getCindyMakeHistory('aaaa')).items[0].actions).toContain('end');
    const state = await actCindyMakeHistory('aaaa', 'hide');
    expect(h.end).toHaveBeenCalledWith('session', 'end');
    expect(store.hide).toHaveBeenCalledWith('aaaa');
    expect(state).toMatchObject({ busy: true, canBuild: false, items: [] });
  });
  it('cleans an ended history entry while another build continues', async () => {
    await getCindyMakeHistory('aaaa');
    const record = h.records.get('aaaa')!;
    record.endedAt = 5;
    h.rows[0].status = 'deleted';
    h.testBuild = {
      buildId: 'other-build',
      sessionId: 'other-session',
      status: 'packaging',
    };
    store.readBuild.mockImplementation(() => h.testBuild);
    const item = (await getCindyMakeHistory('aaaa')).items[0];
    expect(item).toMatchObject({
      lifecycle: 'ended',
      actions: [],
      actionReason: 'busy',
      canHide: true,
    });
    const state = await actCindyMakeHistory('aaaa', 'hide');
    expect(state).toMatchObject({ busy: true, canBuild: false, items: [], build: h.testBuild });
    expect(store.hide).toHaveBeenCalledWith('aaaa');
    expect(record.completions).toHaveLength(1);
    expect(h.end).not.toHaveBeenCalled();
    expect(h.cancelTestBuild).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
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
      undefined,
    );
    await expect(actCindyMakeHistory('../source', 'revert')).rejects.toThrow('Invalid');
  });
});

/** Two independent completed tasks; the newer row is intentionally listed first. */
async function batchFixture() {
  const original = h.rows[0];
  h.rows = [
    { ...original, createdAt: 20 },
    {
      ...original,
      id: 'older-session',
      createdAt: 10,
      workingDir: path.join(path.dirname(original.workingDir), 'bbbb'),
    },
  ];
  h.cards.push(...h.cards.map((card) => ({ ...card, sessionId: 'older-session' })));
  const state = await getCindyMakeHistory();
  const pins = state.items.map((item) => ({
    runId: item.runId,
    completionId: item.completionId!,
    commit: item.completions.at(-1)!.commit!,
    tree: item.completions.at(-1)!.tree!,
  }));
  let buildState: any;
  store.saveBuild.mockImplementation((value) => {
    buildState = value;
  });
  store.readBuild.mockImplementation(() => buildState);
  h.merge.mockImplementation(async (plan) => {
    h.records
      .get(plan.runId)!
      .receipts.push({ ...receipt, id: 'merge-' + plan.runId, taskTree: plan.taskTree });
    return { id: 'merge-' + plan.runId, status: 'merged', hasWorkspace: false };
  });
  h.build.mockResolvedValue({
    commit: 'b'.repeat(40),
    tree: 'd'.repeat(40),
    includedFeatures: [
      { runId: 'aaaa', operationId: 'merge-aaaa' },
      { runId: 'bbbb', operationId: 'merge-bbbb' },
    ],
  });
  return {
    pins,
    state: () => buildState,
    settled: async () => {
      await vi.waitFor(() => expect(realHasActiveWork()).toBe(false));
    },
  };
}

describe('one personal version from selected history', () => {
  it('keeps generation of an ended task alive while its restored change is resolving', async () => {
    const f = await batchFixture();
    const record = h.records.get('aaaa')!;
    record.endedAt = 5;
    h.rows.find((row) => row.id === 'session').status = 'archived';
    h.git.mockImplementation(async (_env, args: string[]) => {
      if (args[0] === 'branch') return 'cindy-personal';
      if (args[0] === 'rev-parse')
        return args.at(-1)?.endsWith('^{tree}') ? 'e'.repeat(40) : 'f'.repeat(40);
      return '';
    });
    let resolved!: () => void;
    h.merge.mockImplementationOnce(async () => {
      h.state.upstreamMerge = {
        id: 'conflict',
        status: 'resolving',
        hasWorkspace: true,
        feature: { runId: 'aaaa', action: 'integrate', awaitingResolution: true },
      };
      return h.state.upstreamMerge;
    });
    h.waitForMerge.mockImplementationOnce(async (_state, _signal, publish) => {
      await publish({ status: 'merging', mergeStep: 'conflicts' });
      await new Promise<void>((resolve) => {
        resolved = resolve;
      });
      record.receipts.push(receipt);
      h.state.upstreamMerge = undefined;
    });
    await actCindyMakeHistory('aaaa', 'build');
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'));
    expect(f.state()).toMatchObject({ status: 'merging', mergeStep: 'conflicts' });
    expect(realGetState().personalBuildSessionIds).toEqual(['session']);
    expect(h.testAction).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    resolved();
    await f.settled();
    expect(h.build).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({ status: 'ready' });
  });
  it('persists the builder diagnostic for Settings after a history build fails', async () => {
    const f = await batchFixture();
    h.build.mockRejectedValueOnce(
      Object.assign(new Error('buildFailed'), {
        code: 'buildFailed',
        diagnostic: {
          kind: 'outOfMemory',
          exitCode: 134,
          message: 'FATAL ERROR: JavaScript heap out of memory',
        },
      }),
    );
    await generateHistoryPersonalVersion(f.pins);
    await f.settled();
    expect(f.state()).toMatchObject({
      status: 'failed',
      error: 'buildFailed',
      diagnostic: {
        kind: 'outOfMemory',
        exitCode: 134,
        message: 'FATAL ERROR: JavaScript heap out of memory',
      },
    });
  });
  it('merges oldest first and packages once with both feature receipts', async () => {
    const f = await batchFixture();
    await generateHistoryPersonalVersion(f.pins);
    await f.settled();
    expect(h.merge.mock.calls.map(([plan]) => plan.runId)).toEqual(['bbbb', 'aaaa']);
    expect(h.build).toHaveBeenCalledOnce();
    expect(h.testAction).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({
      status: 'ready',
      includedFeatures: [
        { runId: 'aaaa', operationId: 'merge-aaaa' },
        { runId: 'bbbb', operationId: 'merge-bbbb' },
      ],
    });
    expect(h.historyChanged).toHaveBeenCalledOnce();
    expect(store.version).toHaveBeenCalledTimes(2);
  });
  it('validates every selected workspace before merging any of them', async () => {
    const f = await batchFixture();
    h.verify.mockImplementation(async ({ runId }) => {
      if (runId === 'aaaa') throw Object.assign(new Error('changed'), { code: 'changed' });
    });
    await generateHistoryPersonalVersion(f.pins);
    await f.settled();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ status: 'failed' });
    expect(['changed', 'cleanupFailed']).toContain(f.state().error);
  });
  it('rejects stale, duplicate and foreign selections before stopping tests or changing source', async () => {
    const f = await batchFixture();
    await expect(generateHistoryPersonalVersion([])).rejects.toThrow('Invalid');
    await expect(generateHistoryPersonalVersion([f.pins[0], f.pins[0]])).rejects.toThrow(
      'Duplicate',
    );
    await expect(
      generateHistoryPersonalVersion([{ ...f.pins[0], runId: '../other' }]),
    ).rejects.toThrow('Invalid');
    await expect(
      generateHistoryPersonalVersion([{ ...f.pins[0], runId: 'foreign' }]),
    ).rejects.toThrow('unavailable');
    await expect(
      generateHistoryPersonalVersion([{ ...f.pins[0], tree: 'a'.repeat(40) }]),
    ).rejects.toThrow('unavailable');
    expect(h.stopTest).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  });
  it('waits for a conflict and its cleanup before merging the next item and packaging', async () => {
    const f = await batchFixture();
    let resolved!: () => void;
    let cleaned!: () => void;
    h.merge.mockImplementationOnce(async () => {
      h.state.upstreamMerge = {
        id: 'conflict',
        status: 'conflict',
        hasWorkspace: true,
        feature: { runId: 'bbbb', action: 'integrate', awaitingResolution: true },
      };
      return h.state.upstreamMerge;
    });
    h.waitForMerge.mockImplementationOnce(async (_state, _signal, publish) => {
      await publish({ status: 'merging', mergeStep: 'conflicts' });
      await new Promise<void>((resolve) => {
        resolved = resolve;
      });
      h.records.get('bbbb')!.receipts.push(receipt);
      h.state.upstreamMerge = undefined;
      await publish({ status: 'merging', mergeStep: 'cleanup' });
      await new Promise<void>((resolve) => {
        cleaned = resolve;
      });
    });
    await generateHistoryPersonalVersion(f.pins);
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'));
    expect(h.merge).toHaveBeenCalledOnce();
    expect(h.build).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ status: 'merging', mergeStep: 'conflicts' });
    resolved();
    await vi.waitFor(() => expect(cleaned).toBeTypeOf('function'));
    expect(h.merge).toHaveBeenCalledOnce();
    expect(h.build).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ status: 'merging', mergeStep: 'cleanup' });
    cleaned();
    await f.settled();
    expect(h.merge).toHaveBeenCalledTimes(2);
    expect(h.build).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({ status: 'ready' });
  });
  it('rechecks later completions and refuses a new round that arrived while merging', async () => {
    const f = await batchFixture();
    h.merge.mockImplementationOnce(async (plan) => {
      h.records.get(plan.runId)!.receipts.push({ ...receipt, taskTree: plan.taskTree });
      h.cards.push({ ...h.cards[1], id: 10, createdAt: 100, clientId: 'new-edit' });
    });
    await generateHistoryPersonalVersion(f.pins);
    await f.settled();
    expect(h.merge).toHaveBeenCalledOnce();
    expect(h.build).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ status: 'failed' });
    expect(['changed', 'cleanupFailed']).toContain(f.state().error);
  });
  it.each(['conflict', 'resolving', 'failed'])(
    'preserves the merged prefix while the next candidate is %s',
    async (status) => {
      const f = await batchFixture();
      const project = vi.spyOn(cindyMakeManager, 'withProject');
      h.merge.mockImplementation(async (plan) => {
        if (plan.runId === 'bbbb') {
          h.records.get(plan.runId)!.receipts.push({ ...receipt, taskTree: plan.taskTree });
        } else {
          h.state.upstreamMerge = {
            id: 'conflict',
            status,
            hasWorkspace: true,
            baselineCommit: receipt.commit,
            feature: { runId: 'aaaa', action: 'integrate', awaitingResolution: true },
          };
          return h.state.upstreamMerge;
        }
      });
      h.waitForMerge.mockImplementationOnce(async (_state, signal: AbortSignal, publish) => {
        if (status !== 'failed') {
          await publish({ status: 'merging', mergeStep: 'conflicts' });
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
        }
        throw Object.assign(new Error('interrupted'), { code: 'interrupted' });
      });
      await generateHistoryPersonalVersion(f.pins);
      if (status !== 'failed') {
        await vi.waitFor(() => expect(f.state().mergeStep).toBe('conflicts'));
        await cancelHistoryPersonalVersion(f.state().buildId);
      }
      await f.settled();
      expect(h.merge.mock.calls.map(([plan]) => plan.runId)).toEqual(['bbbb', 'aaaa']);
      expect(h.build).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
      expect(h.records.get('bbbb')!.receipts).toEqual([receipt]);
      expect(f.state()).toMatchObject({
        status: 'failed',
        error: status === 'failed' ? 'interrupted' : 'cancelled',
      });
      expect(h.state.upstreamMerge.baselineCommit).toBe(receipt.commit);
    },
  );
  it('exposes merge progress, blocks another build and cancels before the next merge', async () => {
    const f = await batchFixture();
    let finish!: () => void;
    h.merge.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await generateHistoryPersonalVersion(f.pins);
    await vi.waitFor(() => expect(h.merge).toHaveBeenCalledOnce());
    const expectedSessions = f.pins.map((pin) => h.records.get(pin.runId)!.sessionId);
    expect(realGetState().personalBuildSessionIds).toEqual(
      expect.arrayContaining(expectedSessions),
    );
    expect(realGetState().personalBuildSessionIds).toHaveLength(expectedSessions.length);
    expect((await getCindyMakeHistory()).batch).toMatchObject({
      current: 1,
      total: 2,
      runId: 'bbbb',
    });
    await expect(generateHistoryPersonalVersion()).rejects.toThrow('busy');
    await cancelHistoryPersonalVersion(f.state().buildId);
    expect(realGetState().personalBuildSessionIds).toHaveLength(expectedSessions.length);
    finish();
    await f.settled();
    expect(realGetState().personalBuildSessionIds).toBeUndefined();
    expect(h.merge).toHaveBeenCalledOnce();
    expect(h.build).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ status: 'failed', error: 'cancelled' });
  });
  it('stops the ready test before restarting the same completed round', async () => {
    const meta = JSON.parse(h.cards[0].agentMeta).cindyMakeCompletion;
    h.cards[0].agentMeta = JSON.stringify({
      cindyMakeCompletion: { ...meta, test: { status: 'ready' } },
    });
    h.testStatus.mockResolvedValue({ ...meta, test: { status: 'ready' } });
    h.testUsing = true;
    await actCindyMakeHistory('aaaa', 'test');
    expect(h.stopTest).toHaveBeenCalledWith('session');
    expect(h.testAction).toHaveBeenCalledWith('session', 'complete', 'start');
    expect(h.stopTest.mock.invocationCallOrder[0]).toBeLessThan(
      h.testAction.mock.invocationCallOrder[0],
    );
  });
});
