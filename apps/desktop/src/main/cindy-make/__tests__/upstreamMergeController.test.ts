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
    refresh: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    cancel: vi.fn(async () => {
      workspace = false;
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
    h.deps.cleanup = vi.fn(async () => h.setWorkspace(false));
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
