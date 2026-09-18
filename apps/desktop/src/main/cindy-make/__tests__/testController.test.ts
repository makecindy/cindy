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
  const launch = vi.fn(async (_context, signal: AbortSignal) => {
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
    await vi.waitFor(() => expect(h.meta().test).toEqual({ status: 'failed', error: 'changed' }));
    expect(h.leased()).toBe(false);
    expect(h.controller.isUsingWorkspace('/profile/task')).toBe(false);
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
      expect(h.meta().personal).toEqual({ status: 'failed', error: 'conflict' }),
    );
    expect(h.leased()).toBe(false);
  });
});
