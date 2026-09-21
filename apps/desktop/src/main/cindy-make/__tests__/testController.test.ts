import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMakeTestController,
  type MakeTestContext,
  type MakeTestControllerDeps,
} from '../testController';
import { makeTestError } from '../testRunner';
import type { PersonalArtifact } from '../personalBuild';
import type { CindyMakeCompletionMeta } from '../../../shared/cindyMakeSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(initial: Partial<CindyMakeCompletionMeta> = {}) {
  let meta: CindyMakeCompletionMeta = { reportedAt: 1, commit: 'a'.repeat(40), ...initial };
  let current = true;
  let leased = false;
  const ready = deferred<void>();
  const closed = deferred<void>();
  const artifact = deferred<PersonalArtifact>();
  const build = vi.fn<NonNullable<MakeTestControllerDeps['build']>>(
    async (_context, signal, publish) => {
      signal.addEventListener('abort', () => artifact.reject(makeTestError('interrupted')), {
        once: true,
      });
      await publish({ status: 'packaging' });
      return artifact.promise;
    },
  );
  const openBuild = vi.fn(async () => {});
  const stop = vi.fn(() => {
    ready.reject(makeTestError('interrupted'));
    closed.resolve();
  });
  const context = (): MakeTestContext => ({
    sessionId: 'session',
    completionId: 'completion',
    userData: '/profile',
    workingDir: '/profile/task',
    runId: 'run',
    commit: meta.commit ?? '',
    meta,
    isCurrent: () => current,
  });
  const save = vi.fn(async (_context, patch) => {
    meta = { ...meta, ...patch };
    return meta;
  });
  const launch = vi.fn<MakeTestControllerDeps['launch']>(async (_context, signal) => {
    signal.addEventListener('abort', stop, { once: true });
    return { ready: ready.promise, closed: closed.promise, stop };
  });
  const controller = createMakeTestController({
    load: async () => context(),
    save,
    launch,
    build,
    openBuild,
    now: () => 123,
    withUse: async (_context, run) => {
      leased = true;
      try {
        await run();
      } finally {
        leased = false;
      }
    },
  });
  return {
    controller,
    launch,
    build,
    openBuild,
    artifact,
    save,
    ready,
    closed,
    stop,
    meta: () => meta,
    leased: () => leased,
    changeOwner: () => {
      current = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('Main-owned Cindy Make test lifecycle', () => {
  it('saves specific build failures and removes old diagnostics on a fresh attempt', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'build');
    h.artifact.reject(
      Object.assign(new Error('buildFailed'), {
        code: 'buildFailed',
        diagnostic: {
          kind: 'outOfMemory',
          exitCode: 134,
          message: 'FATAL ERROR: JavaScript heap out of memory',
        },
      }),
    );
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('failed'));
    expect(h.meta().personal?.diagnostic).toEqual({
      kind: 'outOfMemory',
      exitCode: 134,
      message: 'FATAL ERROR: JavaScript heap out of memory',
    });
    const next = deferred<PersonalArtifact>();
    h.build.mockImplementationOnce(async () => next.promise);
    await h.controller.act('session', 'completion', 'build');
    expect(h.meta().personal?.diagnostic).toBeUndefined();
    next.reject(makeTestError('interrupted'));
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
  });
  it.each(['continue', 'build', 'stop-for-build'] as const)(
    'bounds a missing stop receipt for %s without releasing the live workspace',
    async (action) => {
      vi.useFakeTimers();
      const h = harness();
      h.stop.mockImplementation(() => {});
      await h.controller.act('session', 'completion', 'start');
      h.ready.resolve();
      await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
      const pending =
        action === 'stop-for-build'
          ? h.controller.stopTestForBuild('session')
          : h.controller.act('session', 'completion', action);
      const failed = expect(pending).rejects.toMatchObject({ code: 'stopFailed' });
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      expect(h.leased()).toBe(true);
      expect(h.controller.isUsingSession('session')).toBe(true);
      expect(h.meta().continuedAt).toBeUndefined();
      expect(h.build).not.toHaveBeenCalled();
      // A retry may succeed once the test window really exits; no false exit receipt.
      const continued = h.controller.act('session', 'completion', 'continue');
      h.closed.resolve();
      await continued;
      expect(h.leased()).toBe(false);
      expect(h.meta().continuedAt).toBe(123);
    },
  );

  it('waits for test shutdown and temporary cleanup before starting a personal build', async () => {
    const h = harness();
    h.stop.mockImplementation(() => {});
    await h.controller.act('session', 'completion', 'start');
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    const pending = h.controller.act('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalled());
    expect(h.build).not.toHaveBeenCalled();
    expect(h.leased()).toBe(true);
    h.closed.resolve();
    await pending;
    expect(h.build).toHaveBeenCalledOnce();
    h.artifact.resolve(installer);
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
  });

  it('awaits test cleanup when the host quits', async () => {
    const h = harness();
    h.stop.mockImplementation(() => {});
    await h.controller.act('session', 'completion', 'start');
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    const done = vi.fn();
    const shutdown = h.controller.stopAllAndWait().then(done);
    await Promise.resolve();
    expect(h.stop).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    h.closed.resolve();
    await shutdown;
    expect(h.leased()).toBe(false);
    expect(done).toHaveBeenCalledOnce();
  });

  it('blocks Continue Editing during startup, then allows it once the test is ready', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'start');
    await expect(h.controller.act('session', 'completion', 'continue')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.meta().continuedAt).toBeUndefined();
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    await h.controller.act('session', 'completion', 'continue');
    expect(h.controller.isUsingSession('session')).toBe(false);
    expect(h.leased()).toBe(false);
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
    expect(h.meta().continuedAt).toBe(123);
  });
  it('orders slow progress writes before readiness and ignores progress after readiness', async () => {
    const h = harness();
    const persistence = deferred<void>();
    const original = h.save.getMockImplementation()!;
    h.save.mockImplementation(async (context, patch) => {
      if (patch.test?.step === 'dependencies') await persistence.promise;
      return original(context, patch);
    });
    await h.controller.act('session', 'completion', 'start');
    const publish = h.launch.mock.calls[0][2];
    publish('dependencies');
    publish('assets');
    h.ready.resolve();
    expect(h.meta().test?.status).toBe('starting');
    persistence.resolve();
    await vi.waitFor(() => expect(h.meta().test).toEqual({ status: 'ready' }));
    const count = h.save.mock.calls.length;
    publish('launching');
    await Promise.resolve();
    expect(h.save).toHaveBeenCalledTimes(count);
    h.closed.resolve();
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
  });
  it('retains the failed step and starts a fresh attempt on retry', async () => {
    const h = harness();
    h.launch.mockImplementationOnce(async (_context, _signal, publish) => {
      publish('dependencies');
      throw makeTestError('environment');
    });
    await h.controller.act('session', 'completion', 'start');
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
    expect(h.meta().test).toEqual({ status: 'failed', step: 'dependencies', error: 'environment' });
    await h.controller.act('session', 'completion', 'start');
    expect(h.launch).toHaveBeenCalledTimes(2);
    expect(h.meta().test).toEqual({ status: 'starting', step: 'waiting' });
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    h.closed.resolve();
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
  });
  it('coalesces repeated starts, broadcasts readiness and keeps a workspace lease until exit', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'start');
    await h.controller.act('session', 'completion', 'start');
    expect(h.launch).toHaveBeenCalledOnce();
    expect(h.meta().test?.status).toBe('starting');
    expect(h.leased()).toBe(true);
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    expect((await h.controller.act('session', 'completion', 'start')).test?.status).toBe('ready');
    expect(h.launch).toHaveBeenCalledOnce();
    h.closed.resolve();
    await vi.waitFor(() => expect(h.leased()).toBe(false));
    expect(h.meta().test?.status).toBe('stopped');
    expect(h.controller.isUsingWorkspace('/profile/task')).toBe(false);
  });
  it('continues editing without losing the persisted choice to a late process exit', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'start');
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    await h.controller.act('session', 'completion', 'continue');
    await vi.waitFor(() => expect(h.leased()).toBe(false));
    expect(h.meta().continuedAt).toBe(123);
    expect(h.meta().commit).toBe('a'.repeat(40));
    await expect(h.controller.act('session', 'completion', 'start')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('turns an unowned persisted launch into interrupted state without replaying it', async () => {
    const h = harness({ test: { status: 'starting' } });
    const result = await h.controller.act('session', 'completion', 'status');
    expect(result.test).toEqual({ status: 'stopped', error: 'interrupted' });
    expect(h.launch).not.toHaveBeenCalled();
  });
  it('preserves failure and releases the lease when validation fails before spawning', async () => {
    const h = harness();
    h.launch.mockRejectedValueOnce(makeTestError('changed'));
    await h.controller.act('session', 'completion', 'start');
    await vi.waitFor(() => {
      expect(h.meta().test).toEqual({ status: 'failed', step: 'waiting', error: 'changed' });
      expect(h.leased()).toBe(false);
      expect(h.controller.isUsingWorkspace('/profile/task')).toBe(false);
    });
    void h.ready.promise.catch(() => {});
  });
  it('stops owned processes on account change without publishing to the new owner', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.act('session', 'completion', 'start');
    await Promise.resolve();
    h.changeOwner();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.stop).toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.leased()).toBe(false);
  });
  it('requires a verified commit even if the renderer asks to start', async () => {
    const h = harness({ commit: undefined });
    await expect(h.controller.act('session', 'completion', 'start')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(h.launch).not.toHaveBeenCalled();
  });
});

const installer: PersonalArtifact = {
  artifactDirectory: 'completion-output',
  artifactName: 'Cindy.exe',
  sha256: 'f'.repeat(64),
  commit: 'b'.repeat(40),
};

describe('personal build completion choices', () => {
  it('does not let a concurrent stop overwrite the final adopted artifact', async () => {
    const h = harness();
    h.build.mockImplementationOnce(async () => h.artifact.promise);
    const entered = deferred<void>();
    const persistence = deferred<void>();
    const save = h.save.getMockImplementation()!;
    h.save.mockImplementation(async (context, patch) => {
      if (patch.personal?.status === 'ready') {
        entered.resolve();
        await persistence.promise;
      }
      return save(context, patch);
    });
    await h.controller.act('session', 'completion', 'build');
    const id = h.meta().personal!.buildId!;
    h.artifact.resolve(installer);
    await entered.promise;
    const stopping = h.controller.cancelBuild(id);
    persistence.resolve();
    await stopping;
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
    expect(h.meta().personal).toMatchObject({ buildId: id, status: 'ready', ...installer });
    expect(h.meta().personal?.stopping).toBeUndefined();
  });
  it('preserves cleanup failures instead of reporting a completed cancellation', async () => {
    const h = harness();
    h.build.mockImplementationOnce(async (_context, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw Object.assign(new Error('locked'), { code: 'cleanupFailed' });
    });
    await h.controller.act('session', 'completion', 'build');
    await h.controller.cancelBuild(h.meta().personal!.buildId!);
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
    expect(h.meta().personal).toMatchObject({ status: 'failed', error: 'cleanupFailed' });
  });
  it('stops only the current build, keeps cleanup leased, and gives retry a new identity', async () => {
    const h = harness();
    const cleanup = deferred<void>();
    let signal!: AbortSignal;
    h.build.mockImplementationOnce(async (_context, abort, publish) => {
      signal = abort;
      await publish({ status: 'packaging' });
      await cleanup.promise;
      abort.throwIfAborted();
      throw new Error('unreachable');
    });
    await h.controller.act('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('packaging'));
    const id = h.meta().personal!.buildId!;
    await h.controller.cancelBuild('stale-build');
    expect(signal.aborted).toBe(false);
    await h.controller.cancelBuild(id);
    expect(signal.aborted).toBe(true);
    expect(h.meta().personal).toMatchObject({ buildId: id, stopping: true });
    expect(h.leased()).toBe(true);
    cleanup.resolve();
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
    expect(h.meta()).toMatchObject({
      personal: { buildId: id, status: 'failed', error: 'cancelled' },
    });
    expect(h.meta().continuedAt).toBeUndefined();
    await h.controller.act('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('packaging'));
    expect(h.meta().personal?.buildId).not.toBe(id);
    await h.controller.cancelBuild(id);
    expect(h.meta().personal?.stopping).toBeUndefined();
    await h.controller.cancelBuild(h.meta().personal!.buildId!);
    await vi.waitFor(() => expect(h.controller.hasActiveJobs()).toBe(false));
  });
  it('coalesces build clicks, persists progress and opens only the recorded installer', async () => {
    const h = harness();
    await Promise.all([
      h.controller.act('session', 'completion', 'build'),
      h.controller.act('session', 'completion', 'build'),
    ]);
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('packaging'));
    expect(h.build).toHaveBeenCalledOnce();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.leased()).toBe(true);
    await expect(h.controller.act('session', 'completion', 'open-build')).rejects.toMatchObject({
      code: 'unavailable',
    });
    h.artifact.resolve(installer);
    await vi.waitFor(() => expect(h.leased()).toBe(false));
    expect(h.meta()).toMatchObject({
      personal: { status: 'ready', ...installer },
      lastAction: 'build',
    });
    await h.controller.act('session', 'completion', 'open-build');
    expect(h.openBuild).toHaveBeenCalledOnce();
  });
  it('records visible build stages without persisting process output', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'build');
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('packaging'));
    expect(h.meta().personal?.logs?.map((entry) => entry.step)).toEqual(['packaging']);
    h.artifact.resolve(installer);
    await vi.waitFor(() => expect(h.meta().personal?.status).toBe('ready'));
    expect(h.meta().personal?.logs?.map((entry) => entry.step)).toEqual(['packaging', 'ready']);
  });
  it('closes a running test before building the personal installer', async () => {
    const h = harness();
    await h.controller.act('session', 'completion', 'start');
    h.ready.resolve();
    await vi.waitFor(() => expect(h.meta().test?.status).toBe('ready'));
    await h.controller.act('session', 'completion', 'build');
    expect(h.stop).toHaveBeenCalled();
    expect(h.meta().test?.status).toBe('stopped');
    expect(h.build).toHaveBeenCalledOnce();
    h.artifact.resolve(installer);
    await vi.waitFor(() => expect(h.leased()).toBe(false));
  });
  it('keeps the lease until cancelled build cleanup finishes and never loses Continue Editing', async () => {
    const h = harness();
    const cleanup = deferred<void>();
    h.build.mockImplementation(async (_context, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await cleanup.promise;
      throw makeTestError('interrupted');
    });
    await h.controller.act('session', 'completion', 'build');
    await h.controller.act('session', 'completion', 'continue');
    expect(h.meta().continuedAt).toBe(123);
    expect(h.leased()).toBe(true);
    expect(h.controller.isUsingWorkspace('/profile/task')).toBe(true);
    cleanup.resolve();
    await vi.waitFor(() => expect(h.leased()).toBe(false));
    expect(h.meta()).toMatchObject({
      continuedAt: 123,
      personal: { status: 'failed', error: 'interrupted' },
    });
  });
  it('retains the adopted build receipt if the user continues during final adoption', async () => {
    const h = harness();
    h.build.mockImplementation(async () => h.artifact.promise);
    await h.controller.act('session', 'completion', 'build');
    await h.controller.act('session', 'completion', 'continue');
    h.artifact.resolve(installer);
    await vi.waitFor(() => expect(h.leased()).toBe(false));
    expect(h.meta()).toMatchObject({
      continuedAt: 123,
      personal: { status: 'ready', ...installer },
    });
  });
  it('marks persisted in-flight packaging as interrupted after restart without resuming it', async () => {
    const h = harness({ lastAction: 'build', personal: { status: 'packaging' } });
    expect(await h.controller.act('session', 'completion', 'status')).toMatchObject({
      personal: { status: 'failed', error: 'interrupted' },
    });
    expect(h.build).not.toHaveBeenCalled();
  });
  it('keeps actionable conflict errors and releases the workspace on build failure', async () => {
    const h = harness();
    h.build.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }));
    await h.controller.act('session', 'completion', 'build');
    await vi.waitFor(() =>
      expect(h.meta().personal).toMatchObject({ status: 'failed', error: 'conflict' }),
    );
    expect(h.leased()).toBe(false);
  });
});
