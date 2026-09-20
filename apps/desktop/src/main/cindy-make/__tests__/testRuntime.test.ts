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
  build: vi.fn(),
  saveBuild: vi.fn(),
  artifactPath: vi.fn(),
  showItem: vi.fn(),
  rememberOriginal: vi.fn(async () => {}),
  historyIntegrate: vi.fn(async () => ({ items: [{ runId: 'run', integration: 'integrated' }] })),
  history: vi.fn(async () => ({ items: [{ runId: 'run', integration: 'integrated' }] })),
}));
vi.mock('../historyOwner.js', () => ({
  captureMakeHistoryStore: () => ({
    completion: vi.fn(),
    version: vi.fn(),
    list: () => [],
    saveBuild: h.saveBuild,
  }),
}));
vi.mock('../historyRuntime.js', () => ({
  getCindyMakeHistory: h.history,
  actCindyMakeHistory: h.historyIntegrate,
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
  vi.clearAllMocks();
  h.verify.mockReset().mockResolvedValue(undefined);
  h.build.mockReset().mockResolvedValue(installer);
  h.artifactPath.mockReset().mockResolvedValue(path.join(os.tmpdir(), 'installer.exe'));
  h.current = true;
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
  configureCindyMakeTestRuntime(() => false);
});
afterEach(() => cindyMakeTestController.stopAll());

describe('Cindy Make test IPC ownership and persistence', () => {
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
      }),
    );
    expect(h.rememberOriginal).toHaveBeenCalledWith(process.execPath);
    expect(h.build.mock.calls[0][0].profile.userData).toBe(h.profile);
    await actCindyMakeTest('session', 'completion', 'open-build');
    expect(h.artifactPath).toHaveBeenCalledWith(h.profile, expect.any(String), {
      status: 'ready',
      ...installer,
      buildId: expect.any(String),
      startedAt: expect.any(Number),
      generatedAt: expect.any(Number),
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
    finishCleanup();
    await vi.waitFor(() =>
      expect(cindyMakeTestController.isUsingWorkspace(String(h.row.workingDir))).toBe(false),
    );
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
