import { describe, expect, it, vi } from 'vitest';
import {
  UpstreamMergeController,
  parseSavedUpstreamMerge,
  type SavedUpstreamMerge,
  type UpstreamMergeDependencies,
} from '../upstreamMergeController';
import { mergeError } from '../upstreamMerge';
import type { CindyMakeMergeState, MakeFeatureMergePlan } from '../../../shared/cindyMakeMerge';

const candidate: CindyMakeMergeState = {
  id: '12345678-1234-1234-1234-123456789abc',
  status: 'conflict',
  ref: 'main',
  upstreamCommit: 'a'.repeat(40),
  baselineCommit: 'b'.repeat(40),
  hasWorkspace: true,
};
const feature: MakeFeatureMergePlan = {
  runId: 'run',
  taskSessionId: 'original-task',
  action: 'integrate',
  taskTree: 'a'.repeat(40),
  steps: [],
  nextStep: 0,
};
function harness(initial?: SavedUpstreamMerge, actualWorkspace = !!initial?.state.hasWorkspace) {
  let saved = initial ? structuredClone(initial) : undefined;
  let owner = 'alice';
  let workspace = actualWorkspace;
  const deps: UpstreamMergeDependencies = {
    read: () => saved,
    write: vi.fn((next) => {
      saved = structuredClone(next);
    }),
    publish: vi.fn(),
    owner: () => owner,
    hasWorkspace: () => workspace,
    exclusive: async (run) => run(),
    latest: vi.fn(async () => ({ ref: 'main', commit: 'a'.repeat(40) })),
    prepare: vi.fn(async (state, publish) => {
      workspace = true;
      await publish({
        ...state,
        hasWorkspace: true,
        baselineCommit: 'b'.repeat(40),
        status: 'merging',
      });
      return { ...state, hasWorkspace: true, status: 'merged', commit: 'c'.repeat(40) };
    }),
    apply: vi.fn(async (state) => ({ ...state, status: 'merged', commit: 'c'.repeat(40) })),
    session: vi.fn(async (state, _options, bind) => {
      const id = state.sessionId ?? 'merge-session';
      bind(id);
      return id;
    }),
    running: vi.fn(() => false),
    sleep: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {
      workspace = false;
      return true;
    }),
    cancel: vi.fn(async () => {
      workspace = false;
    }),
    discard: vi.fn(async () => {
      workspace = false;
      return true;
    }),
  };
  const controller = new UpstreamMergeController(deps);
  return {
    controller,
    deps,
    saved: () => saved,
    setOwner: (next: string) => {
      owner = next;
    },
    setWorkspace: (next: boolean) => {
      workspace = next;
    },
  };
}
describe('upstream merge lifecycle', () => {
  it('retains an unresolved feature step in the same task instead of dispatching another resolver', async () => {
    const h = harness({
      state: {
        ...candidate,
        feature: { ...feature, awaitingResolution: true },
        sessionId: 'resolver',
      },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('resolver')();
    h.deps.apply = vi.fn(async (state) => ({ ...state, status: 'conflict' }));
    const waiting = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .catch((error) => error);

    await h.controller.finish('resolver');

    expect(h.deps.session).not.toHaveBeenCalled();
    expect(await waiting).toMatchObject({ code: 'checksFailed' });
    expect(h.saved()?.state).toMatchObject({
      status: 'failed',
      error: 'checksFailed',
      sessionId: 'resolver',
      hasWorkspace: true,
      feature: { nextStep: 0, awaitingResolution: true },
    });
    expect(h.deps.cleanup).not.toHaveBeenCalled();
  });
  it('invalidates a pending resolver dispatch when Stop arrives before its acceptance callback', async () => {
    const h = harness({
      state: { ...candidate, feature: { ...feature, awaitingResolution: true } },
      sessionOwner: 'alice',
    });
    let accept!: () => void;
    let current!: () => boolean;
    let release!: () => void;
    h.deps.session = vi.fn(async (_state, _options, bind, isCurrent) => {
      bind('resolver');
      current = isCurrent;
      accept = h.controller.prepareTurn('resolver');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'resolver';
    });
    const resolving = h.controller.resolve();
    await vi.waitFor(() => expect(h.deps.session).toHaveBeenCalledOnce());
    const waiting = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .catch((error) => error);
    const stopping = h.controller.interrupt('resolver');
    const validAfterStop = current();
    accept();
    release();
    await resolving;
    await stopping;
    await h.controller.finish('resolver');

    expect(validAfterStop).toBe(false);
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(await waiting).toMatchObject({ code: 'interrupted' });
    expect(h.saved()?.state).toMatchObject({
      status: 'failed',
      error: 'interrupted',
      sessionId: 'resolver',
      hasWorkspace: true,
    });
    expect(h.deps.cleanup).not.toHaveBeenCalled();
    expect(h.deps.discard).not.toHaveBeenCalled();
  });
  it('keeps Stop Making pending until resolver shutdown and cleanup, then ignores late turns', async () => {
    const h = harness({
      state: { ...candidate, feature, sessionId: 'resolver', status: 'resolving' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('resolver')();
    let finishCleanup!: () => void;
    h.deps.discard = vi.fn(async (state, current) => {
      expect(state.cancellationRequested).toBe(true);
      expect(current()).toBe(true);
      await new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      h.setWorkspace(false);
      return true;
    });
    const abort = new AbortController();
    let settled = false;
    const waiting = h.controller.waitForCompletion(candidate.id, abort.signal).catch((error) => {
      settled = true;
      return error;
    });
    abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    await vi.waitFor(() => expect(h.deps.discard).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    h.controller.prepareTurn('resolver')();
    await h.controller.finish('resolver');
    expect(h.deps.apply).not.toHaveBeenCalled();
    finishCleanup();
    expect(await waiting).toMatchObject({ code: 'cancelled' });
    expect(h.saved()?.state).toMatchObject({
      status: 'cancelled',
      hasWorkspace: false,
      sessionId: 'resolver',
    });
    await h.controller.interrupt('resolver');
    await h.controller.finish('resolver');
    expect(h.saved()?.state.status).toBe('cancelled');
    expect(h.deps.apply).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    'does not continue conflict step %s after Stop during the preceding check',
    async (nextStep) => {
      const h = harness({
        state: {
          ...candidate,
          feature: { ...feature, awaitingResolution: true },
          sessionId: 'resolver',
        },
        sessionOwner: 'alice',
      });
      h.controller.prepareTurn('resolver')();
      let release!: () => void;
      let canApply!: () => boolean;
      h.deps.apply = vi.fn(async (state, current, publish) => {
        canApply = current;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const result = {
          ...state,
          status: 'conflict' as const,
          feature: { ...state.feature!, nextStep },
        };
        await publish?.(result);
        expect(h.saved()?.state).toMatchObject({ status: 'failed', error: 'interrupted' });
        return result;
      });
      const waiting = h.controller
        .waitForCompletion(candidate.id, new AbortController().signal)
        .catch((error) => error);
      const finishing = h.controller.finish('resolver');
      await vi.waitFor(() => expect(h.deps.apply).toHaveBeenCalledOnce());
      const stopping = h.controller.interrupt('resolver');
      expect(canApply()).toBe(false);
      expect(h.controller.isApplying('resolver')).toBe(true);
      // The Stop survives a restart even while the in-flight check is settling.
      expect(h.saved()?.state).toMatchObject({ status: 'failed', error: 'interrupted' });
      const restored = harness(h.saved());
      await restored.controller.finish('resolver');
      expect(restored.deps.apply).not.toHaveBeenCalled();
      release();
      await finishing;
      await stopping;
      expect(h.controller.isApplying('resolver')).toBe(false);
      expect(await waiting).toMatchObject({ code: 'interrupted' });
      expect(h.saved()?.state).toMatchObject({
        status: 'failed',
        error: 'interrupted',
        sessionId: 'resolver',
        hasWorkspace: true,
      });
      expect(h.deps.session).not.toHaveBeenCalled();
      expect(h.deps.cleanup).not.toHaveBeenCalled();
      expect(h.deps.discard).not.toHaveBeenCalled();
    },
  );
  it('continues a genuinely later conflict in the same task and releases the build after cleanup', async () => {
    const plan = {
      ...feature,
      action: 'revert' as const,
      awaitingResolution: true,
      steps: [
        { before: 'a'.repeat(40), after: 'b'.repeat(40) },
        { before: 'c'.repeat(40), after: 'd'.repeat(40) },
      ],
    };
    const h = harness({
      state: { ...candidate, feature: plan, sessionId: 'resolver' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('resolver')();
    h.deps.session = vi.fn(async (state, _options, bind) => {
      expect(state.sessionId).toBe('resolver');
      bind('resolver');
      h.controller.prepareTurn('resolver')();
      return 'resolver';
    });
    h.deps.apply = vi.fn(async (state) => ({
      ...state,
      status: state.feature!.nextStep === 0 ? 'conflict' : 'merged',
      feature: {
        ...state.feature!,
        nextStep: state.feature!.nextStep + 1,
        awaitingResolution: state.feature!.nextStep === 0,
      },
    }));
    h.deps.applied = vi.fn(async () => {});
    const resumed = vi.fn();
    const waiting = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .then(resumed);
    await h.controller.finish('resolver');
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(h.saved()?.state).toMatchObject({
      status: 'resolving',
      sessionId: 'resolver',
      feature: { nextStep: 1 },
    });
    expect(resumed).not.toHaveBeenCalled();
    expect(h.deps.cleanup).not.toHaveBeenCalled();
    await h.controller.finish('resolver');
    await waiting;
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(h.deps.applied).toHaveBeenCalledOnce();
    expect(h.deps.cleanup).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'merged',
        sessionId: 'resolver',
        hasWorkspace: false,
      }),
    );
  });
  it('opening the stopped resolver preserves interruption until a new message is accepted', async () => {
    const h = harness({
      state: { ...candidate, sessionId: 'resolver' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('resolver')();
    const staleAcceptance = h.controller.prepareTurn('resolver');
    await h.controller.interrupt('resolver');
    await h.controller.resolve();
    staleAcceptance();
    await h.controller.finish('resolver');
    expect(h.saved()?.state).toMatchObject({
      status: 'failed',
      error: 'interrupted',
      sessionId: 'resolver',
    });
    expect(h.deps.apply).not.toHaveBeenCalled();
    h.controller.prepareTurn('resolver')();
    await h.controller.finish('resolver');
    expect(h.saved()?.state.status).toBe('merged');
  });
  it('an explicit native retry can finish interrupted adoption and cleanup without another resolver', async () => {
    const h = harness({
      state: { ...candidate, feature, status: 'checking', sessionId: 'resolver' },
      sessionOwner: 'alice',
    });
    h.deps.applied = vi.fn(async () => {});
    expect(h.saved()?.state.error).toBe('interrupted');
    await h.controller.resolve();
    expect(h.saved()?.state).toMatchObject({ status: 'merged', hasWorkspace: false });
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.deps.applied).toHaveBeenCalledOnce();
    expect(h.deps.cleanup).toHaveBeenCalledOnce();
  });
  it('a deliberate new turn cannot revive the old build while its stopped dispatch settles', async () => {
    const h = harness({ state: candidate, sessionOwner: 'alice' });
    let release!: () => void;
    h.deps.session = vi.fn(async (_state, _options, bind) => {
      bind('resolver');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'resolver';
    });
    const resolving = h.controller.resolve();
    await vi.waitFor(() => expect(h.deps.session).toHaveBeenCalledOnce());
    const waiting = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .catch((error) => error);
    const stopping = h.controller.interrupt('resolver');
    h.controller.prepareTurn('resolver')();
    release();
    await resolving;
    await stopping;
    expect(await waiting).toMatchObject({ code: 'interrupted' });
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.deps.cleanup).not.toHaveBeenCalled();
  });
  it('does not dispatch a resolver when Stop arrives during native feature preparation', async () => {
    const h = harness();
    const abort = new AbortController();
    h.deps.prepareFeature = async (state, _plan, publish) => {
      h.setWorkspace(true);
      const next = { ...state, hasWorkspace: true, status: 'conflict' as const };
      await publish(next);
      abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      expect(h.saved()?.state.cancellationRequested).toBe(true);
      return next;
    };
    const state = await h.controller.feature(feature, undefined, abort.signal);
    expect(h.deps.session).not.toHaveBeenCalled();
    await expect(h.controller.waitForCompletion(state!.id, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(h.deps.discard).toHaveBeenCalledOnce();
    expect(h.saved()?.state.hasWorkspace).toBe(false);
  });
  it('does not cancel an older candidate when a new build stops while waiting for the Git lock', async () => {
    const initial = { ...candidate, feature, status: 'merged' as const, hasWorkspace: false };
    const h = harness({ state: initial, sessionOwner: 'alice' });
    const abort = new AbortController();
    h.deps.prepareFeature = vi.fn();
    h.deps.exclusive = async (run) => {
      abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      return run();
    };
    await expect(h.controller.feature(feature, undefined, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(h.deps.prepareFeature).not.toHaveBeenCalled();
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(h.saved()?.state).toEqual(initial);
  });
  it('finishes an in-flight adoption receipt before cancelling so the build can roll it back', async () => {
    const h = harness({
      state: { ...candidate, feature, sessionId: 'resolver', status: 'resolving' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('resolver')();
    let adopted!: () => void;
    h.deps.applied = vi.fn(async () => {});
    h.deps.apply = vi.fn(async (state, current) => {
      await new Promise<void>((resolve) => {
        adopted = resolve;
      });
      expect(current()).toBe(true);
      return { ...state, status: 'merged' };
    });
    const finish = h.controller.finish('resolver');
    await vi.waitFor(() => expect(h.deps.apply).toHaveBeenCalled());
    const cancelled = h.controller.cancelBuild(candidate.id);
    expect(h.deps.discard).not.toHaveBeenCalled();
    adopted();
    await finish;
    await cancelled;
    expect(h.deps.applied).toHaveBeenCalledOnce();
    expect(h.deps.discard).toHaveBeenCalledOnce();
    expect(h.saved()?.state.status).toBe('cancelled');
  });
  it.each([false, true])(
    'retains failed build cancellation for retry after restart (directory remains=%s)',
    async (workspace) => {
      const h = harness({
        state: { ...candidate, feature, sessionId: 'resolver' },
        sessionOwner: 'alice',
      });
      h.deps.discard = vi.fn(async () => {
        h.setWorkspace(workspace);
        return false;
      });
      await expect(h.controller.cancelBuild(candidate.id)).rejects.toMatchObject({
        code: 'cancelFailed',
      });
      const reopened = harness(h.saved(), workspace);
      expect(reopened.deps.discard).not.toHaveBeenCalled();
      expect(reopened.saved()?.state).toMatchObject({
        cancellationRequested: true,
        error: 'cancelFailed',
        hasWorkspace: workspace,
      });
      await reopened.controller.cancel(candidate.id);
      expect(reopened.saved()?.state).toMatchObject({ status: 'cancelled', hasWorkspace: false });
    },
  );
  it('never discards a stale operation or another owner', async () => {
    const h = harness({ state: { ...candidate, feature }, sessionOwner: 'alice' });
    await expect(h.controller.cancelBuild('old-operation')).rejects.toMatchObject({ code: 'busy' });
    h.setOwner('bob');
    await expect(h.controller.cancelBuild(candidate.id)).rejects.toMatchObject({ code: 'busy' });
    expect(h.deps.discard).not.toHaveBeenCalled();
  });
  it('restores an interrupted resolver with its task and candidate intact without replaying Git', async () => {
    const h = harness({
      state: { ...candidate, status: 'resolving', sessionId: 'task' },
      sessionOwner: 'alice',
    });
    expect(h.controller.status()).toMatchObject({
      id: candidate.id,
      status: 'failed',
      error: 'interrupted',
      sessionId: 'task',
      hasWorkspace: true,
    });
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.deps.prepare).not.toHaveBeenCalled();
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.deps.cleanup).not.toHaveBeenCalled();
    await h.controller.finish('task');
    expect(h.deps.apply).not.toHaveBeenCalled();
    const reopened = harness(h.saved());
    await reopened.controller.finish('task');
    expect(reopened.deps.apply).not.toHaveBeenCalled();
  });
  it('ends the build wait on explicit stop and ignores late completion until a new message is accepted', async () => {
    const h = harness({
      state: { ...candidate, status: 'resolving', sessionId: 'task' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('task')();
    const wait = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .catch((e) => e);
    await h.controller.interrupt('task');
    expect(await wait).toMatchObject({ code: 'interrupted' });
    await h.controller.finish('task');
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.deps.cleanup).not.toHaveBeenCalled();
    expect(h.controller.status()).toMatchObject({
      status: 'failed',
      sessionId: 'task',
      hasWorkspace: true,
    });
    h.controller.prepareTurn('task')();
    expect(h.controller.status()).toMatchObject({ status: 'resolving', error: undefined });
    await h.controller.finish('task');
    expect(h.deps.apply).toHaveBeenCalledOnce();
    expect(h.controller.status()).toMatchObject({
      status: 'merged',
      sessionId: 'task',
      hasWorkspace: false,
    });
  });
  it('resumes a waiting build only after adoption and cleanup outside the Git lock', async () => {
    const h = harness({
      state: { ...candidate, status: 'resolving', sessionId: 'task' },
      sessionOwner: 'alice',
    });
    let gitLocked = false;
    h.deps.exclusive = async (work) => {
      gitLocked = true;
      try {
        return await work();
      } finally {
        gitLocked = false;
      }
    };
    let cleaned!: () => void;
    h.deps.cleanup = vi.fn(async (_state, current) => {
      expect(gitLocked).toBe(false);
      expect(h.controller.isApplying('task')).toBe(true);
      expect(current()).toBe(true);
      expect(h.saved()?.state.cleanupPending).toBe(true);
      await new Promise<void>((resolve) => {
        cleaned = resolve;
      });
      h.setWorkspace(false);
      return true;
    });
    h.controller.prepareTurn('task')();
    const resumed = vi.fn();
    const waiting = h.controller
      .waitForCompletion(candidate.id, new AbortController().signal)
      .then(resumed);
    const finishing = h.controller.finish('task');
    await vi.waitFor(() => expect(h.deps.cleanup).toHaveBeenCalledOnce());
    expect(h.saved()?.state.status).toBe('merged');
    expect(resumed).not.toHaveBeenCalled();
    cleaned();
    await finishing;
    await waiting;
    expect(resumed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'merged',
        hasWorkspace: false,
        cleanupPending: undefined,
      }),
    );
  });
  it('does not adopt a stopped turn when its idle notification arrives during the next turn', async () => {
    const h = harness({
      state: { ...candidate, status: 'resolving', sessionId: 'task' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('task')();
    let release!: () => void;
    h.deps.running = () => true;
    h.deps.sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const finishing = h.controller.finish('task');
    await vi.waitFor(() => expect(h.deps.sleep).toHaveBeenCalledOnce());
    await h.controller.interrupt('task');
    h.controller.prepareTurn('task')();
    h.deps.running = () => false;
    release();
    await finishing;
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.controller.status()?.status).toBe('resolving');
    await h.controller.finish('task');
    expect(h.deps.apply).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'owner', 'failure'])(
    'ends a waiting build on %s without adopting it',
    async (reason) => {
      const h = harness({
        state: { ...candidate, status: 'resolving', sessionId: 'task' },
        sessionOwner: 'alice',
      });
      h.controller.prepareTurn('task')();
      const abort = new AbortController();
      const waiting = h.controller
        .waitForCompletion(candidate.id, abort.signal)
        .catch((error) => error);
      if (reason === 'abort') abort.abort();
      else if (reason === 'owner') {
        h.setOwner('bob');
        h.controller.status();
      } else await h.controller.interrupt('task');
      expect(await waiting).toBeInstanceOf(Error);
      expect(h.deps.apply).not.toHaveBeenCalled();
      expect(h.deps.cleanup).not.toHaveBeenCalled();
      if (reason === 'abort') {
        // Completing the independent resolution task cannot resurrect the cancelled wait.
        await h.controller.finish('task');
        expect(h.saved()?.state.status).toBe('merged');
      }
    },
  );
  it('retains deferred cleanup across restart and finishes it before starting a new merge', async () => {
    const h = harness({
      state: { ...candidate, status: 'resolving', sessionId: 'task' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('task')();
    h.deps.cleanup = vi.fn(async () => false);
    await h.controller.finish('task');
    expect(h.saved()?.state).toMatchObject({ status: 'merged', cleanupPending: true });
    await expect(h.controller.update()).rejects.toMatchObject({ code: 'dirty' });
    expect(h.deps.prepare).not.toHaveBeenCalled();
    const restored = harness(h.saved());
    const next = await restored.controller.update();
    expect(restored.deps.cleanup).toHaveBeenCalledBefore(vi.mocked(restored.deps.prepare));
    expect(next).toMatchObject({ status: 'merged', hasWorkspace: false });
    expect(next?.id).not.toBe(candidate.id);
  });
  it('keeps Git adoption recoverable until its durable feature receipt has been saved', async () => {
    const h = harness();
    const plan: MakeFeatureMergePlan = {
      runId: 'aaaa',
      taskSessionId: 'original-task',
      action: 'revert',
      taskTree: 'e'.repeat(40),
      nextStep: 0,
      steps: [{ before: 'a'.repeat(40), after: 'b'.repeat(40) }],
    };
    h.deps.hasWorkspace = () => true;
    h.deps.prepareFeature = vi.fn(async (state) => ({
      ...state,
      ...candidate,
      status: 'merged',
      feature: { ...plan, nextStep: 1 },
      commit: 'c'.repeat(40),
      tree: 'd'.repeat(40),
      baselineTree: 'e'.repeat(40),
    }));
    h.deps.applied = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    expect(await h.controller.feature(plan)).toMatchObject({
      status: 'failed',
      commit: 'c'.repeat(40),
      hasWorkspace: true,
    });
    expect(h.deps.cleanup).not.toHaveBeenCalled();
    const resumed = harness(h.saved());
    resumed.deps.applied = vi.fn(async () => {});
    expect(await resumed.controller.resolve()).toMatchObject({ status: 'merged' });
    expect(resumed.deps.applied).toHaveBeenCalledOnce();
    expect(resumed.deps.session).not.toHaveBeenCalled();
    expect(resumed.deps.cleanup).toHaveBeenCalledOnce();
  });
  it('uses the existing dedicated-task lifecycle for feature conflicts and never starts a second operation beside one', async () => {
    const h = harness();
    const plan: MakeFeatureMergePlan = {
      runId: 'aaaa',
      taskSessionId: 'original-task',
      action: 'revert',
      taskTree: 'e'.repeat(40),
      nextStep: 0,
      steps: [{ before: 'a'.repeat(40), after: 'b'.repeat(40) }],
    };
    h.deps.prepareFeature = vi.fn(async (state) => ({
      ...state,
      ...candidate,
      feature: { ...plan, awaitingResolution: true },
    }));
    expect(await h.controller.feature(plan)).toMatchObject({
      status: 'resolving',
      sessionId: 'merge-session',
    });
    await expect(h.controller.feature(plan)).rejects.toMatchObject({ code: 'busy' });
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(h.deps.prepareFeature).toHaveBeenCalledOnce();
  });
  it('rejects corrupt recovery data rather than treating it as an empty operation', () => {
    for (const raw of [
      '{',
      '{}',
      JSON.stringify({ state: { ...candidate, id: '../source' } }),
      JSON.stringify({ state: { ...candidate, sessionId: 'unowned-task' } }),
    ]) {
      expect(() => parseSavedUpstreamMerge(raw, '/user-data')).toThrow();
    }
    expect(parseSavedUpstreamMerge(JSON.stringify({ state: candidate }), '/user-data')).toEqual({
      state: candidate,
    });
  });
  it('automatically applies a clean update and never creates an agent task', async () => {
    const h = harness();
    expect(await h.controller.update()).toMatchObject({ status: 'merged', hasWorkspace: false });
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.saved()?.state.commit).toBe('c'.repeat(40));
    expect(h.deps.cleanup).toHaveBeenCalledOnce();
  });
  it('normalizes a completed merge whose candidate worktree was already removed', () => {
    const h = harness(
      {
        state: {
          ...candidate,
          status: 'merged',
          hasWorkspace: true,
          commit: 'c'.repeat(40),
        },
      },
      false,
    );
    expect(h.controller.status()).toMatchObject({ status: 'merged', hasWorkspace: false });
    expect(h.saved()).toMatchObject({
      state: { status: 'merged', hasWorkspace: false },
    });
  });
  it('deduplicates updates, waits at a conflict, and starts one task only after explicit confirmation', async () => {
    const h = harness();
    h.deps.prepare = vi.fn(async (state) => ({ ...state, ...candidate }));
    const options = { agentKind: 'codex' as const, model: 'test-model' };
    const results = await Promise.all([h.controller.update(options), h.controller.update(options)]);
    expect(h.deps.prepare).toHaveBeenCalledOnce();
    expect(results.map((r) => r?.status)).toEqual(['conflict', 'conflict']);
    expect(h.deps.session).not.toHaveBeenCalled();
    await h.controller.update();
    expect(h.deps.prepare).toHaveBeenCalledOnce();
    expect(h.deps.session).not.toHaveBeenCalled();
    await Promise.all([
      h.controller.resolve(options, candidate.id),
      h.controller.resolve(options, candidate.id),
    ]);
    expect(h.deps.session).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.session).mock.calls[0][1]).toEqual(options);
    expect(h.saved()).toMatchObject({
      sessionOwner: 'alice',
      state: { sessionId: 'merge-session', status: 'resolving' },
    });
  });
  it('cancels an unassigned conflict, persists that result, and permits a later update', async () => {
    const h = harness({ state: candidate, sessionOwner: 'alice' });
    expect(await h.controller.cancel(candidate.id)).toMatchObject({
      status: 'cancelled',
      hasWorkspace: false,
      error: undefined,
    });
    expect(h.saved()?.state.sessionId).toBeUndefined();
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.deps.apply).not.toHaveBeenCalled();
    expect(h.deps.cancel).toHaveBeenCalledOnce();
    const reopened = harness(parseSavedUpstreamMerge(JSON.stringify(h.saved()), '/user-data'));
    expect(reopened.controller.status()).toMatchObject({
      status: 'cancelled',
      hasWorkspace: false,
    });
    await reopened.controller.cancel(candidate.id);
    expect(reopened.deps.cancel).not.toHaveBeenCalled();
    await expect(reopened.controller.resolve(undefined, candidate.id)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(reopened.saved()?.state.status).toBe('cancelled');
    expect(await reopened.controller.update()).toMatchObject({ status: 'merged' });
    expect(reopened.deps.prepare).toHaveBeenCalledOnce();
  });
  it('retains a failed cancellation for retry, including after the directory has been removed', async () => {
    const h = harness({ state: candidate, sessionOwner: 'alice' });
    vi.mocked(h.deps.cancel).mockImplementationOnce(async () => {
      expect(h.saved()?.state.cancellationRequested).toBe(true);
      h.setWorkspace(false);
      throw new Error('ref lock');
    });
    expect(await h.controller.cancel(candidate.id)).toMatchObject({
      status: 'failed',
      error: 'cancelFailed',
      hasWorkspace: false,
      cancellationRequested: true,
    });
    const reopened = harness(h.saved());
    expect(await reopened.controller.cancel(candidate.id)).toMatchObject({
      status: 'cancelled',
      error: undefined,
      hasWorkspace: false,
    });
    expect(reopened.deps.cancel).toHaveBeenCalledOnce();
    expect(reopened.deps.session).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'restores interrupted cancellation for explicit retry (workspace=%s)',
    async (workspace) => {
      const h = harness(
        { state: { ...candidate, cancellationRequested: true }, sessionOwner: 'alice' },
        workspace,
      );
      expect(h.saved()?.state).toMatchObject({
        status: 'failed',
        error: 'cancelFailed',
        hasWorkspace: workspace,
        cancellationRequested: true,
      });
      expect(h.deps.cancel).not.toHaveBeenCalled();
      await h.controller.update();
      await expect(h.controller.resolve(undefined, candidate.id)).rejects.toMatchObject({
        code: 'busy',
      });
      expect(h.deps.prepare).not.toHaveBeenCalled();
      expect(h.deps.session).not.toHaveBeenCalled();
      expect(await h.controller.cancel(candidate.id)).toMatchObject({
        status: 'cancelled',
        hasWorkspace: false,
        cancellationRequested: undefined,
      });
      expect(h.deps.cancel).toHaveBeenCalledOnce();
    },
  );
  it('rejects a stale decision and another account before cancelling or starting a task', async () => {
    const h = harness({ state: candidate, sessionOwner: 'alice' });
    await expect(h.controller.cancel('previous-update')).rejects.toMatchObject({ code: 'busy' });
    await expect(h.controller.resolve(undefined, 'previous-update')).rejects.toMatchObject({
      code: 'busy',
    });
    h.setOwner('bob');
    await expect(h.controller.cancel(candidate.id)).rejects.toMatchObject({ code: 'busy' });
    await expect(h.controller.resolve(undefined, candidate.id)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(h.deps.cancel).not.toHaveBeenCalled();
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.saved()?.state.status).toBe('conflict');
  });
  it.each(['resolving', 'checking', 'merged'] as const)(
    'cannot cancel an assigned %s task',
    async (status) => {
      const h = harness({
        state: { ...candidate, status, sessionId: 'existing-task' },
        sessionOwner: 'alice',
      });
      await expect(h.controller.cancel(candidate.id)).rejects.toMatchObject({ code: 'busy' });
      expect(h.deps.cancel).not.toHaveBeenCalled();
    },
  );
  it('never turns a late resolve into a task after cancellation has started', async () => {
    const h = harness({ state: candidate, sessionOwner: 'alice' });
    let finish!: () => void;
    h.deps.cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const cancelling = h.controller.cancel(candidate.id);
    await Promise.resolve();
    await expect(h.controller.resolve(undefined, candidate.id)).rejects.toMatchObject({
      code: 'busy',
    });
    finish();
    await cancelling;
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.saved()?.state.status).toBe('cancelled');
  });
  it('retains a conflict without starting a task for an account that changed during the update', async () => {
    const h = harness();
    h.deps.prepare = vi.fn(async (state) => {
      h.setOwner('bob');
      return { ...state, ...candidate };
    });
    expect(await h.controller.update()).toMatchObject({ status: 'conflict', hasWorkspace: true });
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.saved()?.state.sessionId).toBeUndefined();
    expect(h.deps.cleanup).not.toHaveBeenCalled();
  });
  it('keeps the bound task identity across a failed dispatch and restart', async () => {
    const h = harness({ state: candidate });
    h.deps.session = vi.fn(async (_state, _options, bind) => {
      bind('same-task');
      throw mergeError('startFailed');
    });
    await h.controller.resolve();
    expect(h.saved()).toMatchObject({ state: { sessionId: 'same-task', status: 'failed' } });
    const reopened = harness(h.saved());
    await reopened.controller.resolve();
    expect(reopened.saved()?.state.sessionId).toBe('same-task');
  });
  it('never resumes an interrupted Git write at startup', () => {
    const h = harness({ state: { ...candidate, status: 'merging' } });
    expect(h.controller.status()).toMatchObject({
      status: 'failed',
      error: 'interrupted',
      hasWorkspace: true,
    });
    expect(h.deps.prepare).not.toHaveBeenCalled();
    expect(h.deps.apply).not.toHaveBeenCalled();
  });
  it('does not expose or dispatch another account’s task', async () => {
    const h = harness({
      state: { ...candidate, sessionId: 'private-task' },
      sessionOwner: 'alice',
    });
    h.setOwner('bob');
    expect(h.controller.status()).toMatchObject({
      sessionId: undefined,
      ownedByAnotherAccount: true,
    });
    await expect(h.controller.resolve()).rejects.toMatchObject({ code: 'busy' });
    await h.controller.finish('private-task');
    expect(h.deps.session).not.toHaveBeenCalled();
    expect(h.deps.apply).not.toHaveBeenCalled();
  });
  it('applies only the bound idle session and retains a failed candidate', async () => {
    const h = harness({
      state: { ...candidate, sessionId: 'task', status: 'resolving' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('task')();
    await h.controller.finish('ordinary-task');
    expect(h.deps.apply).not.toHaveBeenCalled();
    h.deps.running = () => true;
    await h.controller.finish('task');
    expect(h.deps.apply).not.toHaveBeenCalled();
    h.deps.running = () => false;
    h.deps.apply = vi.fn(async () => {
      throw mergeError('baselineChanged');
    });
    await h.controller.finish('task');
    expect(h.saved()?.state).toMatchObject({
      status: 'failed',
      error: 'baselineChanged',
      hasWorkspace: true,
    });
    h.deps.apply = vi.fn(async (state) => ({ ...state, status: 'merged' }));
    await h.controller.finish('task');
    expect(h.saved()?.state.status).toBe('merged');
  });
  it('waits for a terminal session to become idle before applying the candidate', async () => {
    const h = harness({
      state: { ...candidate, sessionId: 'task', status: 'resolving' },
      sessionOwner: 'alice',
    });
    h.controller.prepareTurn('task')();
    let running = true;
    h.deps.running = vi.fn(() => running);
    h.deps.sleep = vi.fn(async () => {
      running = false;
    });

    await h.controller.finish('task');

    expect(h.deps.apply).toHaveBeenCalledOnce();
    expect(h.deps.sleep).toHaveBeenCalledOnce();
    expect(h.saved()?.state.status).toBe('merged');
  });
  it('allows retry after a preflight failure with no workspace and does not undo merge success on refresh failure', async () => {
    const h = harness();
    h.deps.latest = vi
      .fn()
      .mockRejectedValueOnce(mergeError('unavailable'))
      .mockResolvedValue({ ref: 'main', commit: 'a'.repeat(40) });
    expect(await h.controller.update()).toMatchObject({ status: 'failed', hasWorkspace: false });
    h.deps.refresh = async () => {
      throw new Error('read failed');
    };
    expect(await h.controller.update()).toMatchObject({ status: 'merged' });
  });
});
