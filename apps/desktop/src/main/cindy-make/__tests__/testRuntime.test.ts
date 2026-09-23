import os from 'node:os';
import path from 'node:path';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  profile: '',
  row: {} as Record<string, unknown>,
  card: {} as Record<string, unknown>,
  laterUser: false,
  current: true,
  query: vi.fn(),
  write: vi.fn(),
  broadcast: vi.fn(),
  launch: vi.fn(),
  probe: vi.fn(),
  verify: vi.fn(),
  prepare: vi.fn(),
  build: vi.fn(),
  saveBuild: vi.fn(),
  artifactPath: vi.fn(),
  showItem: vi.fn(),
  rememberOriginal: vi.fn(async () => {}),
  recoverBuild: vi.fn(async () => {}),
  rollbackGuard: undefined as ((commit: string) => boolean) | undefined,
  publishedCommit: vi.fn(() => true),
  pendingRollback: false,
  historyIntegrate: vi.fn(),
  syncBuild: vi.fn(),
  syncBeforeBuild: false,
  historyChanged: vi.fn(),
  history: vi.fn(async () => ({ items: [{ runId: 'run', integration: 'integrated' }] })),
}));
vi.mock('../historyOwner.js', () => ({
  captureMakeHistoryStore: () => ({
    completion: vi.fn(),
    version: vi.fn(),
    list: () => [],
    saveBuild: h.saveBuild,
    readBuildRollback: () => (h.pendingRollback ? [{}] : []),
  }),
}));
vi.mock('../historyRuntime.js', () => ({
  getCindyMakeHistory: h.history,
  integrateCompletionForBuild: h.historyIntegrate,
  recoverHistoryBuildRollback: h.recoverBuild,
}));
vi.mock('../testRecovery.js', () => ({ prepareCindyMakeTest: h.prepare }));
vi.mock('../settingsStore.js', () => ({
  readCindyMakeSettings: () => ({ syncLatestBeforeBuild: h.syncBeforeBuild }),
}));
vi.mock('../upstreamMergeRuntime.js', () => ({
  syncSourceBeforeCindyMakeBuild: h.syncBuild,
}));
vi.mock('../buildRollback.js', () => ({
  historyBuildRollback: (...args: [unknown, unknown, (commit: string) => boolean]) => {
    h.rollbackGuard = args[2];
    return { prepareRollback: vi.fn(), recoverRollback: vi.fn() };
  },
}));
vi.mock('../versionStore.js', () => ({
  hasPublishedPersonalVersionCommit: h.publishedCommit,
}));
vi.mock('../versionStartup.js', () => ({
  rememberOriginalVersion: h.rememberOriginal,
  currentVersionProfile: () => ({
    userData: h.profile,
    appName: 'Cindy',
    region: 'global',
    passive: false,
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => h.profile },
  shell: { showItemInFolder: h.showItem },
}));
vi.mock('../personalBuild.js', () => ({
  buildCindyPersonal: h.build,
  personalArtifactPath: h.artifactPath,
  personalBuildEnvironment: async (env: unknown) => env,
}));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: async () => ({
    probe: h.probe,
  }),
  resolveMakeToolEnvironment: async () => ({}),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => client }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
vi.mock('../../localDb/sessionRouteLock.js', () => ({
  withSessionRouteLock: async (_id: string, run: () => unknown) => run(),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ broadcastMessageAgentMetaUpdate: h.broadcast }));
vi.mock('../testRunner.js', async (original) => ({
  ...(await original<typeof import('../testRunner.js')>()),
  launchMakeTest: h.launch,
  verifyMakeTestWorkspace: h.verify,
}));
import { sessions } from '../../localDb/schema';
import {
  actCindyMakeTest,
  cindyMakeTestController,
  configureCindyMakeTestRuntime,
} from '../testRuntime';
import { makeTaskWorktreePath, makeSourceRoot } from '../sourcePaths';
import { cindyMakeManager } from '../manager';
const installer = {
  commit: 'b'.repeat(40),
  artifactDirectory: 'completion-output',
  artifactName: 'Cindy.exe',
  sha256: 'f'.repeat(64),
};
const dialect = new SQLiteSyncDialect();
const client = {
  drizzle: {
    select: (columns?: Record<string, unknown>) => {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit() {
          h.query();
          return table === sessions
            ? [h.row]
            : columns
              ? h.laterUser
                ? [{ id: 'later' }]
                : []
              : [h.card];
        },
      };
      return query;
    },
    update: () => {
      const query = {
        set(values: { agentMeta: Parameters<typeof dialect.sqlToQuery>[0] }) {
          h.write();
          const params = dialect.sqlToQuery(values.agentMeta).params;
          const next = JSON.parse(String(params[0]));
          h.card.agentMeta = JSON.stringify({
            ...JSON.parse(String(h.card.agentMeta)),
            cindyMakeCompletion: next,
          });
          return query;
        },
        where() {
          return query;
        },
        async returning() {
          return [{ id: 'card' }];
        },
      };
      return query;
    },
  },
};
beforeEach(() => {
  cindyMakeManager.setVersionSwitchingProbe(() => false);
  vi.clearAllMocks();
  h.verify.mockReset().mockResolvedValue(undefined);
  h.build.mockReset().mockResolvedValue(installer);
  h.recoverBuild.mockReset().mockResolvedValue(undefined);
  h.historyIntegrate.mockReset().mockResolvedValue(undefined);
  h.syncBuild.mockReset().mockImplementation(async (_signal, publish) => {
    await publish({ status: 'syncing', syncLatestSource: true });
  });
  h.syncBeforeBuild = false;
  h.artifactPath.mockReset().mockResolvedValue(path.join(os.tmpdir(), 'installer.exe'));
  h.current = true;
  h.pendingRollback = false;
  h.laterUser = false;
  h.profile = path.join(os.tmpdir(), 'make-runtime-unit');
  h.probe.mockReset().mockImplementation(async (command) => ({
    status: 'ok',
    path: command === 'pnpm' ? path.join(h.profile, 'tools', 'pnpm.cmd') : process.execPath,
  }));
  h.row = {
    id: 'session',
    source: 'cindy-make',
    status: 'active',
    workingDir: makeTaskWorktreePath(h.profile, 'run'),
    remoteHostId: null,
  };
  h.card = {
    id: 'card',
    clientId: 'completion',
    createdAt: '2026-09-17T08:00:00Z',
    agentMeta: JSON.stringify({
      otherMetadata: 'preserved',
      cindyMakeCompletion: { reportedAt: 123, changedFiles: 2, commit: 'a'.repeat(40) },
    }),
  };
  configureCindyMakeTestRuntime(() => false, h.historyChanged);
});
afterEach(() => cindyMakeTestController.stopAll());

describe('Cindy Make test IPC ownership and persistence', () => {
  it.each(['start', 'build'] as const)(
    'prepares a fresh result and directly runs the requested %s action',
    async (action) => {
      h.prepare.mockImplementationOnce(async () => {
        h.card.clientId = 'fresh-completion';
        return { completionId: 'fresh-completion', isCurrent: () => h.current };
      });
      if (action === 'start')
        h.launch.mockResolvedValueOnce({
          stop: vi.fn(),
          ready: Promise.resolve(),
          closed: Promise.resolve(),
        });
      const next = await actCindyMakeTest('session', 'reply', 'resume-' + action);
      expect(h.prepare).toHaveBeenCalledWith('session', 'reply', expect.any(Function));
      expect(next.lastAction).toBe(action === 'start' ? 'test' : 'build');
      if (action === 'start') await vi.waitFor(() => expect(h.verify).toHaveBeenCalledOnce());
      else await vi.waitFor(() => expect(h.historyIntegrate).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));
      expect(h.historyChanged).toHaveBeenCalledTimes(action === 'build' ? 1 : 0);
    },
  );
  it('runs the enabled latest-source step before integrating and packaging a completion', async () => {
    h.syncBeforeBuild = true;

    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));

    expect(h.syncBuild).toHaveBeenCalledOnce();
    expect(h.syncBuild.mock.invocationCallOrder[0]).toBeLessThan(
      h.historyIntegrate.mock.invocationCallOrder[0],
    );
    expect(h.historyIntegrate.mock.invocationCallOrder[0]).toBeLessThan(
      h.build.mock.invocationCallOrder[0],
    );
    const personal = JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal;
    expect(personal.syncLatestSource).toBe(true);
    expect(personal.logs.map((entry: { step: string }) => entry.step)).toContain('syncing');
  });
  it('rejects recovery generation before capturing files while a source conflict is pending', async () => {
    h.history.mockResolvedValueOnce({ busy: true, items: [] } as never);
    await expect(actCindyMakeTest('session', 'reply', 'resume-build')).rejects.toThrow(
      'unavailable',
    );
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  });
  it('keeps the card building through conflict resolution and cleanup, then packages once', async () => {
    let resolved!: () => void;
    let cleaned!: () => void;
    h.historyIntegrate.mockImplementationOnce(async (_task, _signal, publish) => {
      expect(cindyMakeTestController.isBuilding('session')).toBe(true);
      expect(cindyMakeManager.getState().personalBuildSessionIds).toEqual(['session']);
      await publish({ status: 'merging', mergeStep: 'conflicts' });
      await new Promise<void>((done) => {
        resolved = done;
      });
      await publish({ status: 'merging', mergeStep: 'cleanup' });
      await new Promise<void>((done) => {
        cleaned = done;
      });
    });
    const personal = () => JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal;
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'));
    expect(personal()).toMatchObject({ status: 'merging', mergeStep: 'conflicts' });
    expect(personal().error).toBeUndefined();
    expect(h.build).not.toHaveBeenCalled();
    resolved();
    await vi.waitFor(() => expect(cleaned).toBeTypeOf('function'));
    expect(personal()).toMatchObject({ status: 'merging', mergeStep: 'cleanup' });
    expect(h.build).not.toHaveBeenCalled();
    cleaned();
    await vi.waitFor(() => expect(cindyMakeTestController.isBuilding('session')).toBe(false));
    expect(h.build).toHaveBeenCalledOnce();
    expect(personal()).toMatchObject({ status: 'ready' });
    expect(personal().logs.map((entry: { step: string }) => entry.step)).toEqual([
      'environment',
      'original',
      'resolving-conflicts',
      'cleaning-merge',
      'ready',
    ]);
  });
  it('does not package after cancellation during conflict handling', async () => {
    let signal!: AbortSignal;
    h.historyIntegrate.mockImplementationOnce(async (_task, abort: AbortSignal, publish) => {
      signal = abort;
      await publish({ status: 'merging', mergeStep: 'conflicts' });
      await new Promise<void>((resolve) =>
        abort.addEventListener('abort', () => resolve(), { once: true }),
      );
      // Even a late successful resolution must pass the build cancellation check.
    });
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(signal).toBeDefined());
    await cindyMakeTestController.cancelBuild(cindyMakeTestController.activeBuild()!.buildId!);
    await vi.waitFor(() => expect(cindyMakeTestController.isBuilding('session')).toBe(false));
    expect(signal.aborted).toBe(true);
    expect(h.build).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toMatchObject({
      status: 'failed',
      error: 'cancelled',
    });
  });
  it('rejects a completion build when history retains a source conflict without active work', async () => {
    h.history.mockResolvedValueOnce({
      items: [],
      busy: true,
      activeWork: false,
      canBuild: false,
    } as Awaited<ReturnType<typeof h.history>>);
    await expect(actCindyMakeTest('session', 'completion', 'build')).rejects.toThrow('unavailable');
    expect(h.historyIntegrate).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.saveBuild).not.toHaveBeenCalled();
  });
  it('reports a stop failure without inspecting or modifying personal source', async () => {
    const stop = vi
      .spyOn(cindyMakeTestController, 'stopTestForBuild')
      .mockRejectedValueOnce(Object.assign(new Error('stopFailed'), { code: 'stopFailed' }));
    try {
      await expect(actCindyMakeTest('session', 'completion', 'build')).rejects.toThrow(
        'stopFailed',
      );
      expect(h.history).not.toHaveBeenCalled();
      expect(h.historyIntegrate).not.toHaveBeenCalled();
      expect(h.build).not.toHaveBeenCalled();
    } finally {
      stop.mockRestore();
    }
  });

  it('stops the running test and waits for cleanup before inspecting history or building', async () => {
    let clean!: () => void;
    const closed = new Promise<void>((resolve) => {
      clean = resolve;
    });
    const stop = vi.fn();
    h.launch.mockResolvedValueOnce({ ready: Promise.resolve(), closed, stop });
    await actCindyMakeTest('session', 'completion', 'start');
    await vi.waitFor(() =>
      expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.test.status).toBe('ready'),
    );
    const building = actCindyMakeTest('session', 'completion', 'build');
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
      expect(h.history).not.toHaveBeenCalled();
      expect(h.historyIntegrate).not.toHaveBeenCalled();
      expect(h.build).not.toHaveBeenCalled();
    } finally {
      clean();
    }
    await building;
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledOnce());
    expect(h.history).toHaveBeenCalledBefore(h.build);
    await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));
  });

  it('pushes environment, workspace and child progress through the same completion receipt', async () => {
    const steps: string[] = [];
    h.broadcast.mockImplementationOnce(() => {});
    h.broadcast.mockImplementation(() => {
      const test = JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.test;
      if (test?.step) steps.push(test.step);
    });
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    h.launch.mockImplementationOnce((_context, _node, _env, _region, _signal, _spawn, publish) => {
      publish('assets');
      publish('launching');
      return { ready: Promise.resolve(), closed, stop: close };
    });
    try {
      await actCindyMakeTest('session', 'completion', 'start');
      await vi.waitFor(() =>
        expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.test).toEqual({
          status: 'ready',
        }),
      );
      expect(steps).toEqual(['environment', 'workspace', 'stopping', 'assets', 'launching']);
      expect(h.verify).toHaveBeenCalledOnce();
      expect(h.launch.mock.calls[0][1]).toEqual({
        node: process.execPath,
        pnpm: path.join(h.profile, 'tools', 'pnpm.cmd'),
      });
      expect(JSON.parse(String(h.card.agentMeta)).otherMetadata).toBe('preserved');
    } finally {
      close();
      await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));
      h.broadcast.mockReset();
    }
  });
  it.each([{ status: 'missing' }, { status: 'ok', path: 'pnpm.cmd' }])(
    'does not launch when the checked pnpm entry is unavailable: %j',
    async (pnpm) => {
      h.probe.mockImplementation(async (command) =>
        command === 'pnpm' ? pnpm : { status: 'ok', path: process.execPath },
      );
      await actCindyMakeTest('session', 'completion', 'start');
      await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));
      expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.test).toMatchObject({
        status: 'failed',
        error: 'environment',
      });
      expect(h.launch).not.toHaveBeenCalled();
    },
  );
  it('does not start a completion build while Settings owns another build', async () => {
    const release = cindyMakeManager.claimPersonalBuild();
    try {
      await expect(actCindyMakeTest('session', 'completion', 'build')).rejects.toThrow(
        'unavailable',
      );
      expect(h.build).not.toHaveBeenCalled();
      expect(cindyMakeTestController.hasActiveJobs()).toBe(false);
    } finally {
      release();
    }
  });
  it('does not start a completion build while a version handoff is running', async () => {
    cindyMakeManager.setVersionSwitchingProbe(() => true);
    await expect(actCindyMakeTest('session', 'completion', 'build')).rejects.toThrow('unavailable');
    expect(h.build).not.toHaveBeenCalled();
    expect(cindyMakeTestController.hasActiveJobs()).toBe(false);
  });
  it('publishes one build identity to Settings and persists cancellation for a reopened card', async () => {
    let release!: () => void;
    h.build.mockImplementationOnce(
      async (_context, _node, _env, _region, signal: AbortSignal, publish) => {
        await publish({ status: 'packaging' });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        signal.throwIfAborted();
        return installer;
      },
    );
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const buildId = cindyMakeTestController.activeBuild()!.buildId!;
    expect(h.saveBuild).toHaveBeenLastCalledWith(
      expect.objectContaining({ buildId, status: 'packaging' }),
    );
    expect(h.build.mock.calls[0][0].completionId).toBe(buildId);
    await cindyMakeTestController.cancelBuild(buildId);
    expect((await actCindyMakeTest('session', 'completion', 'status')).personal).toMatchObject({
      buildId,
      stopping: true,
    });
    expect(cindyMakeManager.hasActiveWork()).toBe(true);
    release();
    await vi.waitFor(() => expect(cindyMakeTestController.hasActiveJobs()).toBe(false));
    expect(h.saveBuild).toHaveBeenLastCalledWith(
      expect.objectContaining({ buildId, status: 'failed', error: 'cancelled' }),
    );
    expect((await actCindyMakeTest('session', 'completion', 'status')).personal).toMatchObject({
      buildId,
      status: 'failed',
      error: 'cancelled',
    });
    expect(cindyMakeManager.hasActiveWork()).toBe(false);
  });
  it('only reads a valid completion on status requests', async () => {
    expect(await actCindyMakeTest('session', 'completion', 'status')).toMatchObject({
      reportedAt: 123,
    });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each([{}, ['start'], 'other'])(
    'rejects invalid action payload %j before touching data',
    async (action) => {
      await expect(actCindyMakeTest('session', 'completion', action)).rejects.toThrow();
      expect(h.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    { source: 'desktop' },
    { remoteHostId: 'ssh-host' },
    { status: 'deleted' },
    { workingDir: os.tmpdir() },
  ])('rejects an unavailable or nonlocal Make task %j', async (patch) => {
    Object.assign(h.row, patch);
    await expect(actCindyMakeTest('session', 'completion', 'start')).rejects.toThrow();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('rejects stale completions and newer user work instead of testing old code', async () => {
    await expect(actCindyMakeTest('session', 'old-completion', 'start')).rejects.toThrow();
    h.laterUser = true;
    await expect(actCindyMakeTest('session', 'completion', 'start')).rejects.toThrow();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('persists continue while retaining verified facts and unrelated agent metadata', async () => {
    const result = await actCindyMakeTest('session', 'completion', 'continue');
    expect(result.continuedAt).toEqual(expect.any(Number));
    expect(result.changedFiles).toBe(2);
    expect(JSON.parse(String(h.card.agentMeta)).otherMetadata).toBe('preserved');
    expect(h.broadcast).toHaveBeenCalledWith('session', 'completion', expect.any(Object));
    expect(h.launch).not.toHaveBeenCalled();
  });
  it('persists personal build progress and opens only the verified recorded output', async () => {
    h.build.mockImplementationOnce(async (_context, _node, _env, _region, _signal, publish) => {
      await publish({ status: 'packaging' });
      return installer;
    });
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() =>
      expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toEqual({
        status: 'ready',
        ...installer,
        buildId: expect.any(String),
        startedAt: expect.any(Number),
        generatedAt: expect.any(Number),
        logs: [
          { step: 'environment', at: expect.any(Number) },
          { step: 'original', at: expect.any(Number) },
          { step: 'packaging', at: expect.any(Number) },
          { step: 'ready', at: expect.any(Number) },
        ],
      }),
    );
    expect(h.rememberOriginal).toHaveBeenCalledWith(process.execPath);
    expect(h.build.mock.calls[0][0].profile.userData).toBe(h.profile);
    expect(h.rollbackGuard?.('published-commit')).toBe(true);
    expect(h.publishedCommit).toHaveBeenCalledWith(h.profile, 'published-commit');
    await actCindyMakeTest('session', 'completion', 'open-build');
    expect(h.artifactPath).toHaveBeenCalledWith(h.profile, expect.any(String), {
      status: 'ready',
      ...installer,
      buildId: expect.any(String),
      startedAt: expect.any(Number),
      generatedAt: expect.any(Number),
      logs: [
        { step: 'environment', at: expect.any(Number) },
        { step: 'original', at: expect.any(Number) },
        { step: 'packaging', at: expect.any(Number) },
        { step: 'ready', at: expect.any(Number) },
      ],
    });
    expect(h.showItem).toHaveBeenCalledWith(path.join(os.tmpdir(), 'installer.exe'));
    expect(JSON.parse(String(h.card.agentMeta)).otherMetadata).toBe('preserved');
    expect(h.launch).not.toHaveBeenCalled();
    h.artifactPath.mockRejectedValueOnce(new Error('installer moved'));
    await expect(actCindyMakeTest('session', 'completion', 'open-build')).rejects.toThrow();
    expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toEqual({
      status: 'failed',
      error: 'unavailable',
    });
    expect(h.showItem).toHaveBeenCalledOnce();
  });
  it('cancels a queued personal build promptly without running it after the queue is released', async () => {
    let release!: () => void;
    const queued = cindyMakeManager.withProject(
      makeSourceRoot(h.profile) + ':personal-build',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await actCindyMakeTest('session', 'completion', 'build');
      await actCindyMakeTest('session', 'completion', 'continue');
      await vi.waitFor(() =>
        expect(cindyMakeTestController.isUsingWorkspace(String(h.row.workingDir))).toBe(false),
      );
      expect(h.build).not.toHaveBeenCalled();
      expect(h.recoverBuild).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      release();
      await queued;
      // Wait behind the cancelled job to prove it cannot run later.
      await cindyMakeManager.withProject(
        makeSourceRoot(h.profile) + ':personal-build',
        async () => {},
      );
    }
    expect(h.build).not.toHaveBeenCalled();
    expect(h.recoverBuild).toHaveBeenCalledOnce();
  });
  it('finishes automatic withdrawal before releasing a build that fails during environment setup', async () => {
    h.probe.mockResolvedValue({ status: 'missing' });
    let release!: () => void;
    h.recoverBuild.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.recoverBuild).toHaveBeenCalledWith(true));
    expect(cindyMakeTestController.isBuilding('session')).toBe(true);
    expect(cindyMakeManager.getState().personalBuildSessionIds).toEqual(['session']);
    expect(h.build).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(cindyMakeTestController.isBuilding('session')).toBe(false));
    expect(cindyMakeManager.getState().personalBuildSessionIds).toBeUndefined();
    expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toMatchObject({
      status: 'failed',
      error: 'environment',
    });
  });
  it('rechecks integration after completing an interrupted withdrawal, before generating again', async () => {
    h.pendingRollback = true;
    h.recoverBuild.mockImplementationOnce(async () => {
      h.pendingRollback = false;
      h.history.mockResolvedValueOnce({ items: [{ runId: 'run', integration: 'unintegrated' }] });
    });
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(cindyMakeTestController.isBuilding('session')).toBe(false));
    expect(h.recoverBuild).toHaveBeenCalledExactlyOnceWith();
    expect(h.historyIntegrate).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run', completionId: 'completion' }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(h.build).toHaveBeenCalledOnce();
  });
  it('reports incomplete automatic cleanup instead of claiming the source was restored', async () => {
    h.probe.mockResolvedValue({ status: 'missing' });
    h.recoverBuild.mockRejectedValueOnce(
      Object.assign(new Error('cleanup failed'), { code: 'cleanupFailed' }),
    );
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(cindyMakeTestController.isBuilding('session')).toBe(false));
    expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toMatchObject({
      status: 'failed',
      error: 'cleanupFailed',
    });
  });
  it('retains active build ownership until cancelled cleanup is done', async () => {
    let finishCleanup!: () => void;
    let cancelled = false;
    h.build.mockImplementationOnce(async (_context, _node, _env, _region, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      await new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      throw new Error('cancelled');
    });
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledOnce());
    await actCindyMakeTest('session', 'completion', 'continue');
    expect(cancelled).toBe(true);
    expect(cindyMakeTestController.isUsingWorkspace(String(h.row.workingDir))).toBe(true);
    expect(cindyMakeManager.getState().personalBuildSessionIds).toEqual(['session']);
    finishCleanup();
    await vi.waitFor(() =>
      expect(cindyMakeTestController.isUsingWorkspace(String(h.row.workingDir))).toBe(false),
    );
    expect(cindyMakeManager.getState().personalBuildSessionIds).toBeUndefined();
    expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion).toMatchObject({
      continuedAt: expect.any(Number),
      personal: { status: 'failed', error: 'interrupted' },
    });
  });
  it('rejects personal builds for superseded completions and while the task is running', async () => {
    h.laterUser = true;
    await expect(actCindyMakeTest('session', 'completion', 'build')).rejects.toThrow();
    h.laterUser = false;
    configureCindyMakeTestRuntime(() => true);
    await actCindyMakeTest('session', 'completion', 'build');
    await vi.waitFor(() =>
      expect(JSON.parse(String(h.card.agentMeta)).cindyMakeCompletion.personal).toMatchObject({
        status: 'failed',
        error: 'unavailable',
      }),
    );
    expect(h.build).not.toHaveBeenCalled();
  });
});
