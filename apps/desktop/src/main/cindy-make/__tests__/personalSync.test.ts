import { describe, expect, it, vi } from 'vitest';
import {
  PersonalSync,
  syncWaiting,
  type PersonalSyncDeps,
  type PersonalSyncRecord,
  type PersonalSyncRemote,
} from '../personalSync';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import type { CindyMakeSyncState } from '../../../shared/cindyMakeSync';

const BASE = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const REMOTE = 'd'.repeat(40);
const merged = (id: string, extra: Partial<CindyMakeMergeState> = {}): CindyMakeMergeState => ({
  id,
  status: 'merged',
  ref: 'v1.2.0',
  upstreamCommit: TARGET,
  ...extra,
});
const conflict = (id: string, extra: Partial<CindyMakeMergeState> = {}): CindyMakeMergeState => ({
  id,
  status: 'resolving',
  ref: 'v1.2.0',
  upstreamCommit: TARGET,
  hasWorkspace: true,
  sessionId: 'resolver',
  ...extra,
});

function harness(
  options: {
    remote?: PersonalSyncRemote;
    base?: string;
    held?: boolean;
    record?: PersonalSyncRecord;
    operation?: CindyMakeMergeState;
  } = {},
) {
  let base: string | undefined = 'base' in options ? options.base : BASE;
  let record: PersonalSyncRecord = options.record ?? {};
  let operation = options.operation;
  const release = vi.fn();
  const states: CindyMakeSyncState[] = [];
  // The shared lifecycle keeps the latest operation; every mock result becomes it.
  const track = (state: CindyMakeMergeState | undefined) => {
    operation = state;
    return state;
  };
  const deps: PersonalSyncDeps = {
    remote: () => options.remote,
    target: vi.fn(async () => ({
      ref: 'v1.2.0',
      commit: TARGET,
      ...(options.held ? { held: { ref: 'v1.3.0', commit: 'e'.repeat(40) } } : {}),
    })),
    base: vi.fn(async () => base),
    isAncestor: async (ancestor, descendant) => ancestor === BASE && descendant === TARGET,
    unbuilt: vi.fn(async () => false),
    operation: () => operation,
    resume: vi.fn(async () => operation),
    combine: vi.fn(async () => track(merged('combine', { remote: { base: BASE, commit: REMOTE } }))),
    update: vi.fn(async () => {
      base = TARGET;
      return track(merged('update'));
    }),
    abandon: vi.fn(async (id: string) =>
      track({
        ...(operation?.id === id ? operation : conflict(id)),
        status: 'cancelled',
        hasWorkspace: false,
        sessionId: undefined,
      }),
    ),
    accept: vi.fn(async (id: string) => track(merged(id))),
    reserve: vi.fn(() => release),
    load: () => record,
    save: (next) => {
      record = next;
    },
    publish: (state) => states.push(state),
    now: () => 42,
  };
  const sync = new PersonalSync(deps);
  return {
    sync,
    deps,
    states,
    release,
    record: () => record,
    setOperation: (state: CindyMakeMergeState | undefined) => {
      operation = state;
      sync.operationChanged(state);
    },
    track,
    last: () => states.at(-1),
  };
}

describe('the single Sync', () => {
  it('without GitHub only moves to the official version, the same pipeline otherwise', async () => {
    const h = harness({ held: true });
    h.sync.sync({ agentKind: 'codex' });
    await h.sync.settled();
    expect(h.deps.update).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'v1.2.0', commit: TARGET }),
      { agentKind: 'codex' },
    );
    expect(h.deps.combine).not.toHaveBeenCalled();
    // Nothing retained: no "continuing" flash.
    expect(h.deps.resume).not.toHaveBeenCalled();
    expect(h.states.map((state) => state.step).filter(Boolean)).toEqual(['official']);
    expect(h.last()).toEqual({ done: { at: 42, ref: 'v1.2.0', held: 'v1.3.0' } });
    // The result survives a restart.
    expect(h.record()).toEqual({ done: { at: 42, ref: 'v1.2.0', held: 'v1.3.0' } });
  });

  it('does not touch a personal version already on (or past) the official version', async () => {
    const h = harness({ base: TARGET });
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.last()?.done?.ref).toBe('v1.2.0');
  });

  it('stops before moving anything when the personal version has no known official base', async () => {
    const h = harness({ base: undefined });
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ error: 'source' });
  });

  it('with GitHub takes in other computers’ changes, combines, updates and uploads in order', async () => {
    const calls: string[] = [];
    const remote: PersonalSyncRemote = {
      sync: vi.fn(async () => {
        calls.push('github');
        return calls.length === 1 ? ('needsMerge' as const) : ('synced' as const);
      }),
      tips: async () => ({ commit: REMOTE, base: BASE }),
      keep: vi.fn(),
    };
    const h = harness({ remote });
    vi.mocked(h.deps.combine).mockImplementation(async () => {
      calls.push('combine');
      return h.track(merged('combine', { remote: { base: BASE, commit: REMOTE } }));
    });
    vi.mocked(h.deps.update).mockImplementation(async () => {
      calls.push('official');
      return h.track(merged('update'));
    });
    h.sync.sync();
    await h.sync.settled();
    expect(calls).toEqual(['github', 'combine', 'official', 'github']);
    expect(h.deps.combine).toHaveBeenCalledWith({ commit: REMOTE, base: BASE }, undefined);
    expect(h.last()?.done).toBeTruthy();
  });

  it('waits for a conflict task and continues by itself once its result is adopted', async () => {
    const remote: PersonalSyncRemote = {
      sync: vi.fn(async () => 'needsMerge' as const),
      tips: async () => ({ commit: REMOTE, base: BASE }),
      keep: vi.fn(),
    };
    const h = harness({ remote });
    vi.mocked(h.deps.combine).mockImplementationOnce(async () =>
      h.track(conflict('combine', { remote: { base: BASE, commit: REMOTE } })),
    );
    h.sync.sync({ agentKind: 'codex' });
    await h.sync.settled();
    expect(h.last()).toEqual({
      waiting: { kind: 'combine', reason: 'working', sessionId: 'resolver' },
    });
    expect(h.record().waiting).toBe('combine');
    expect(h.deps.update).not.toHaveBeenCalled();

    vi.mocked(remote.sync).mockResolvedValue('synced');
    h.setOperation(merged('combine'));
    await h.sync.settled();
    expect(h.deps.update).toHaveBeenCalledWith(expect.anything(), { agentKind: 'codex' });
    expect(h.last()?.done).toBeTruthy();
    expect(h.record().waiting).toBeUndefined();
  });

  it('finishes an operation retained from before a restart first', async () => {
    const remote: PersonalSyncRemote = { sync: vi.fn(), tips: vi.fn(), keep: vi.fn() };
    const h = harness({ remote, operation: conflict('earlier', { status: 'conflict' }) });
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.resume).toHaveBeenCalledOnce();
    expect(h.last()?.waiting).toMatchObject({ kind: 'official', reason: 'working' });
    expect(remote.sync).not.toHaveBeenCalled();
  });

  it('does not start while a change-history operation is retained', async () => {
    const h = harness({
      operation: conflict('feature', {
        feature: {
          runId: 'run',
          taskSessionId: 'task',
          action: 'integrate',
          taskTree: 'a'.repeat(40),
          steps: [],
          nextStep: 0,
        },
      }),
    });
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ error: 'featurePending' });
  });

  it.each([
    [{ needsInput: true, status: 'conflict' as const }, 'input'],
    [{ status: 'conflict' as const, sessionId: undefined }, 'paused'],
    [{ status: 'failed' as const, error: 'startFailed' as const, sessionId: undefined }, 'paused'],
    // Its task was removed: Continue opens a new one for the same work.
    [{ status: 'failed' as const, error: 'unavailable' as const }, 'paused'],
    [{ status: 'failed' as const, error: 'interrupted' as const }, 'interrupted'],
    [
      { status: 'failed' as const, error: 'checksFailed' as const, missing: { count: 2, commits: [] } },
      'missing',
    ],
    [{ status: 'failed' as const, error: 'baselineChanged' as const }, 'stale'],
    [{ status: 'failed' as const, error: 'gitFailed' as const }, 'failed'],
    [{ status: 'checking' as const }, 'working'],
  ])('names why it waits: %o → %s', (extra, reason) => {
    expect(syncWaiting(conflict('x', extra))?.reason).toBe(reason);
  });

  it('shows an operation it did not start (task preparation) and continues once adopted', async () => {
    const h = harness();
    h.setOperation(conflict('task-prep', { status: 'conflict', needsInput: true }));
    expect(h.last()).toEqual({
      waiting: { kind: 'official', reason: 'input', sessionId: 'resolver' },
    });
    // Using it anyway adopts it on the user's behalf; Sync then continues.
    h.setOperation(
      conflict('task-prep', {
        status: 'failed',
        error: 'checksFailed',
        missing: { count: 1, commits: [] },
      }),
    );
    expect(h.last()?.waiting).toMatchObject({ reason: 'missing', missing: 1 });
    await h.sync.accept();
    expect(h.deps.accept).toHaveBeenCalledWith('task-prep');
    await h.sync.settled();
    expect(h.deps.target).toHaveBeenCalled();
    expect(h.last()?.done).toBeTruthy();
  });

  it('keeps the line while Abandon is carried out, then says nothing changed', async () => {
    const h = harness();
    vi.mocked(h.deps.update).mockImplementationOnce(async () => h.track(conflict('stuck')));
    h.sync.sync();
    await h.sync.settled();
    expect(h.record().waiting).toBe('stuck');
    vi.mocked(h.deps.abandon).mockImplementationOnce(async (id) => {
      // The lifecycle publishes its persisted decision before the candidate is gone.
      h.setOperation(conflict(id, { cancellationRequested: true }));
      expect(h.last()?.waiting).toMatchObject({ abandoning: true });
      return h.track({ ...conflict(id), status: 'cancelled', hasWorkspace: false });
    });
    await h.sync.abandon();
    expect(h.deps.abandon).toHaveBeenCalledWith('stuck');
    expect(h.last()).toEqual({ error: 'cancelled', abandoned: 'official' });
    expect(h.record().waiting).toBeUndefined();
  });

  it('says another account owns an operation, never runs over it, and continues it later', async () => {
    const h = harness({ record: { waiting: 'mine' } });
    h.setOperation(conflict('mine'));
    expect(h.last()?.waiting).toBeTruthy();
    h.setOperation({ ...conflict('mine'), ownedByAnotherAccount: true, sessionId: undefined });
    expect(h.last()).toEqual({ waiting: { kind: 'official', reason: 'otherAccount' } });
    expect(h.record().waiting).toBe('mine');
    // Neither Sync nor Abandon touches it under this account.
    h.sync.sync();
    await h.sync.settled();
    await h.sync.abandon();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.deps.abandon).not.toHaveBeenCalled();
    h.setOperation(merged('mine'));
    await h.sync.settled();
    expect(h.deps.update).toHaveBeenCalledOnce();
  });

  it('does not continue unasked at startup for an operation adopted before the restart', () => {
    const h = harness({ record: { waiting: 'old' }, operation: merged('old') });
    expect(h.deps.reserve).not.toHaveBeenCalled();
    expect(h.record().waiting).toBeUndefined();
  });

  it('restores the waiting line and the last result after a restart', () => {
    const h = harness({
      record: { waiting: 'old', done: { at: 1, ref: 'v1.1.0' } },
      operation: conflict('old', { status: 'failed', error: 'interrupted' }),
    });
    expect(h.sync.state()).toEqual({
      waiting: { kind: 'official', reason: 'interrupted', sessionId: 'resolver' },
      done: { at: 1, ref: 'v1.1.0' },
    });
  });

  it('forgets an operation replaced by a newer one', () => {
    const h = harness({ record: { waiting: 'old' } });
    h.setOperation(merged('newer'));
    expect(h.record().waiting).toBeUndefined();
  });

  const diverged: PersonalSyncRemote['sync'] = async () => 'diverged';
  const rejected: PersonalSyncRemote['sync'] = async () => {
    throw Object.assign(new Error('account'), { code: 'account' });
  };
  it.each([
    ['diverged', diverged, 'diverged'],
    ['a GitHub error', rejected, 'github'],
  ] as const)(
    'still updates this computer when %s, then says why sharing stopped',
    async (_case, sync, error) => {
      const remote: PersonalSyncRemote = { tips: vi.fn(), keep: vi.fn(), sync: vi.fn(sync) };
      const h = harness({ remote });
      h.sync.sync();
      await h.sync.settled();
      expect(h.deps.update).toHaveBeenCalledOnce();
      // Nothing is uploaded after a failed GitHub step.
      expect(remote.sync).toHaveBeenCalledOnce();
      expect(h.last()).toEqual({ error, done: { at: 42, ref: 'v1.2.0' } });
    },
  );

  it('reports a busy source instead of success and notes uploads that wait for a build', async () => {
    const busy = harness({
      remote: { tips: vi.fn(), keep: vi.fn(), sync: vi.fn(async () => 'pending' as const) },
    });
    busy.sync.sync();
    await busy.sync.settled();
    expect(busy.last()?.error).toBe('busy');

    const later = harness({
      remote: {
        tips: vi.fn(),
        keep: vi.fn(),
        sync: vi.fn().mockResolvedValueOnce('synced').mockResolvedValueOnce('pendingBuild'),
      },
    });
    later.sync.sync();
    await later.sync.settled();
    expect(later.last()).toEqual({
      done: { at: 42, ref: 'v1.2.0', uploadAfterBuild: true },
    });
  });

  it('asks to generate first when both computers changed and this one’s are not generated', async () => {
    const remote: PersonalSyncRemote = { tips: vi.fn(), keep: vi.fn(), sync: vi.fn(async () => 'buildFirst' as const) };
    const h = harness({ remote });
    h.sync.sync();
    await h.sync.settled();
    // The official step still runs; nothing is uploaded.
    expect(h.deps.update).toHaveBeenCalledOnce();
    expect(remote.sync).toHaveBeenCalledOnce();
    expect(h.last()).toEqual({ done: { at: 42, ref: 'v1.2.0', buildFirst: true } });
  });

  it('takes in an upload another computer made during Sync once more by itself', async () => {
    const remote: PersonalSyncRemote = {
      tips: vi.fn(),
      keep: vi.fn(),
      sync: vi
        .fn()
        .mockResolvedValueOnce('synced')
        .mockResolvedValueOnce('remoteAhead')
        .mockResolvedValue('synced'),
    };
    const h = harness({ remote });
    h.sync.sync();
    await h.sync.settled();
    expect(remote.sync).toHaveBeenCalledTimes(4);
    expect(h.last()).toEqual({ done: { at: 42, ref: 'v1.2.0' } });
  });

  it('says so when another computer keeps uploading during Sync', async () => {
    const remote: PersonalSyncRemote = {
      tips: vi.fn(),
      keep: vi.fn(),
      sync: vi.fn().mockResolvedValueOnce('synced').mockResolvedValue('remoteAhead'),
    };
    const h = harness({ remote });
    h.sync.sync();
    await h.sync.settled();
    expect(h.last()?.error).toBe('changed');
  });

  it('names no version when another computer already moved past the target', async () => {
    const h = harness({ base: 'f'.repeat(40) });
    h.deps.isAncestor = async () => true;
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ done: { at: 42, ahead: true } });
  });

  it('reserves the source for the whole run and releases it on every outcome', async () => {
    const h = harness();
    vi.mocked(h.deps.update).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'busy' }));
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.reserve).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.last()?.error).toBe('busy');
  });

  it.each([
    ['gitOutdated', 'gitOutdated'],
    ['forkUnavailable', 'forkMissing'],
    ['forkArchived', 'forkArchived'],
    ['workflowScope', 'github'],
  ])('reports the GitHub error %s as %s', async (code, error) => {
    const remote: PersonalSyncRemote = {
      tips: vi.fn(),
      keep: vi.fn(),
      sync: vi.fn(async () => {
        throw Object.assign(new Error(code), { code });
      }),
    };
    const h = harness({ remote });
    h.sync.sync();
    await h.sync.settled();
    expect(h.last()?.error).toBe(error);
  });

  it('keeps one side when the two versions cannot be combined, then continues like Sync', async () => {
    const remote: PersonalSyncRemote = {
      tips: vi.fn(),
      keep: vi.fn(async () => 'retrieved' as const),
      sync: vi.fn().mockResolvedValueOnce('diverged').mockResolvedValue('synced'),
    };
    const h = harness({ remote });
    // Only offered after unrelated versions or an abandoned combine.
    h.sync.keep('github');
    await h.sync.settled();
    expect(remote.keep).not.toHaveBeenCalled();
    h.sync.sync();
    await h.sync.settled();
    expect(h.last()?.error).toBe('diverged');
    h.sync.keep('github', { agentKind: 'codex' });
    await h.sync.settled();
    expect(remote.keep).toHaveBeenCalledExactlyOnceWith('github');
    expect(h.last()).toEqual({ done: { at: 42, ref: 'v1.2.0' } });
  });

  it('offers keeping one side after an abandoned combine, not after an abandoned update', async () => {
    const h = harness({ remote: { tips: vi.fn(), keep: vi.fn(), sync: vi.fn() } });
    h.setOperation(conflict('combine', { remote: { base: BASE, commit: REMOTE } }));
    await h.sync.abandon();
    expect(h.last()).toMatchObject({ error: 'cancelled', abandoned: 'combine' });
    h.setOperation(conflict('update'));
    await h.sync.abandon();
    expect(h.last()).toMatchObject({ error: 'cancelled', abandoned: 'official' });
  });

  it('waits with an official update until changes are generated, and says so', async () => {
    const h = harness();
    vi.mocked(h.deps.unbuilt).mockResolvedValue(true);
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.update).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ done: { at: 42, generateFirst: 'v1.2.0' } });
  });

  it('runs one Sync at a time', async () => {
    const h = harness();
    h.sync.sync();
    h.sync.sync();
    await h.sync.settled();
    expect(h.deps.target).toHaveBeenCalledOnce();
  });
});
