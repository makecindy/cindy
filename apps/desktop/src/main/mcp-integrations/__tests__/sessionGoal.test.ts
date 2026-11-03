import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { SessionGoalRequest } from '@cindy/mcps';
import { GoalController } from '../../goal-host/controller.js';
import type { GoalState, GoalStorageLike, GoalStatusPayload, SessionLike } from '../../goal-host/types.js';
import { createSessionGoalControl, createRemoteSessionGoalControl } from '../sessionGoal.js';

// Value: the new Host entry must control the real GoalController without UI, preserve
// a busy caller, and never resume on inspection (agent-user-parity / goal lifecycle).
// Existing controller and UI tests do not exercise this Agent adapter or remote receipts.
// Minimal failures: a running caller creates/edits its goal; a dormant goal is read;
// account/action revocation or a lost write response. Unit tier, in-memory storage/transport.
const request = (action: SessionGoalRequest['action'], extra: Partial<SessionGoalRequest> = {}): SessionGoalRequest => ({
  callerSessionId: 's1', sessionId: 's1', action, ...extra,
});
const state = (): GoalState => ({
  sessionId: 's1', objective: 'Deliver A1 with evidence', status: 'active',
  turnsUsed: 4, tokensUsed: 500, maxTurns: null, budgetTokens: null, noProgressLimit: 3,
  noProgressStreak: 0, usageResetAt: null, startedAt: 1000, updatedAt: 1000,
  lastReason: null, agentKind: 'codex',
});

function fixture(initial: GoalState | null = null) {
  let saved = initial;
  let current = true;
  let busy = true;
  const storage: GoalStorageLike = {
    get: async () => saved ? { ...saved } : null,
    upsert: async value => { saved = { ...value }; },
    update: async (_id, patch) => saved ? (saved = { ...saved, ...patch }) : null,
    clear: async () => { saved = null; },
    listActive: async () => saved?.status === 'active' ? [saved] : [],
    listUsageLimited: async () => [],
  };
  const session: SessionLike = {
    id: 's1', agentKind: 'codex', send: vi.fn(async () => ({ accepted: true as const })),
    onEvent: () => () => {}, abort: vi.fn(async () => {}), isTurnRunning: () => busy,
  };
  const ensureSession = vi.fn(async () => session);
  const controller = new GoalController({
    storage, ensureSession, getSession: () => session, isSessionInTurn: () => busy,
    stopActiveGoalTurn: vi.fn(), emitStatus: vi.fn(),
    getDefaults: () => ({ maxTurns: null, budgetTokens: null, noProgressLimit: 3 }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, now: () => 2000,
  });
  const readTask = vi.fn(async () => ({ status: 'active' }));
  const assertActionCurrent = vi.fn(async () => {});
  const execute = createSessionGoalControl({
    capture: () => ({ controller, readTask, assertCurrent: () => { if (!current) throw new Error('owner changed'); } }),
    assertActionCurrent,
  });
  return { controller, execute, ensureSession, session, storage, readTask, assertActionCurrent,
    revoke: () => { current = false; }, finishTurn: () => { busy = false; } };
}

describe('Agent goal control', () => {
  it('creates, reads, edits, pauses, resumes and clears through the real controller while the caller is busy', async () => {
    vi.useFakeTimers();
    const h = fixture();
    try {
      expect(await h.execute(request('set', { objective: 'Deliver A1 with evidence' })))
        .toMatchObject({ ok: true, goal: { objective: 'Deliver A1 with evidence', status: 'active', budgetTokens: null } });
      expect(await h.execute(request('get'))).toMatchObject({ ok: true, goal: { status: 'active' } });
      expect(await h.execute(request('update', { patch: { objective: 'Deliver A1 and A2', maxTurns: 20 } })))
        .toMatchObject({ ok: true, goal: { objective: 'Deliver A1 and A2', maxTurns: 20 } });
      expect(h.session.abort).not.toHaveBeenCalled();
      expect(h.session.send).not.toHaveBeenCalled(); // No competing turn while its tool is running.
      expect(await h.execute(request('pause'))).toMatchObject({ ok: true, goal: { status: 'paused' } });
      // The native controller defers resume until this caller's current turn ends.
      expect(await h.execute(request('resume'))).toMatchObject({ ok: true, goal: { status: 'paused' } });
      h.finishTurn();
      await h.controller.maybeContinueActiveGoal('s1'); // Host turn-complete observer.
      await vi.advanceTimersByTimeAsync(200);
      expect(await h.execute(request('get'))).toMatchObject({ ok: true, goal: { status: 'active' } });
      expect(h.session.send).toHaveBeenCalledOnce();
      expect(await h.execute(request('clear'))).toEqual({ ok: true, goal: null });
    } finally { await h.controller.dispose(); vi.useRealTimers(); }
  });

  it('observes a dormant active goal without restoring it and preserves counters on identical set', async () => {
    const h = fixture(state());
    try {
      expect(await h.execute(request('get'))).toMatchObject({ ok: true, goal: { status: 'active', turnsUsed: 4 } });
      expect(await h.execute(request('set', { objective: state().objective })))
        .toMatchObject({ ok: true, goal: { turnsUsed: 4, tokensUsed: 500 } });
      expect(h.ensureSession).not.toHaveBeenCalled();
      expect(h.session.send).not.toHaveBeenCalled();
      expect(await h.execute(request('set', { objective: 'unrelated goal' })))
        .toMatchObject({ ok: false, errorCode: 'GOAL_EXISTS' });
      expect((await h.storage.get('s1'))?.objective).toBe(state().objective);
    } finally { await h.controller.dispose(); }
  });

  it.each(['account', 'action'] as const)('rejects %s revocation before mutation without leaking state', async kind => {
    const h = fixture(state());
    try {
      if (kind === 'account') h.readTask.mockImplementation(async () => { h.revoke(); return { status: 'active' }; });
      else h.assertActionCurrent.mockRejectedValue(new Error('revoked'));
      expect(await h.execute(request('clear'))).toMatchObject({ ok: false,
        errorCode: kind === 'account' ? 'HOST_NOT_READY' : 'TASK_ACTION_AUTHORIZATION_EXPIRED' });
      expect((await h.storage.get('s1'))?.objective).toBe(state().objective);
    } finally { await h.controller.dispose(); }
  });

  it('rejects missing goals and reports a write/readback race without claiming success', async () => {
    const h = fixture();
    try {
      expect(await h.execute(request('update', { patch: { objective: 'new' } })))
        .toMatchObject({ ok: false, errorCode: 'GOAL_NOT_FOUND' });
      vi.spyOn(h.controller, 'setGoal').mockResolvedValue(null);
      expect(await h.execute(request('set', { objective: 'new' })))
        .toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    } finally { await h.controller.dispose(); }
  });
});

describe('remote Agent goal control', () => {
  function remote() {
    let saved: GoalStatusPayload | null = null;
    const invoke = vi.fn(async (_device: string, channel: string, args: unknown[], opts?: { preSend?: () => void }): Promise<InvokeResultPayload> => {
      opts?.preSend?.();
      if (channel === 'maker:goal:inspect') return { ok: true, result: saved };
      if (channel === 'maker:goal:set') saved = { ...state(), objective: (args[0] as { objective: string }).objective };
      return { ok: true, result: { ok: true } };
    });
    const access = vi.fn(() => {});
    const guard = vi.fn(() => {});
    const action = vi.fn(async () => {});
    const execute = createRemoteSessionGoalControl({ captureAccess: () => access, assertActionCurrent: action,
      captureActionGuard: () => guard, invoke });
    return { invoke, execute, access, guard, action };
  }

  it('probes the pure read protocol, writes once, and reads the owning computer back', async () => {
    const h = remote();
    expect(await h.execute(request('set', { deviceId: 'device-b', objective: 'verified result' })))
      .toMatchObject({ ok: true, goal: { objective: 'verified result' } });
    expect(h.invoke.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['device-b', 'maker:goal:inspect'], ['device-b', 'maker:goal:set'], ['device-b', 'maker:goal:inspect'],
    ]);
    expect(h.guard).toHaveBeenCalledOnce();
  });

  it('refuses an old host rather than falling back to the state-changing UI getter', async () => {
    const h = remote();
    h.invoke.mockRejectedValue(new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old host'));
    expect(await h.execute(request('set', { deviceId: 'b', objective: 'result' })))
      .toMatchObject({ ok: false, errorCode: 'REMOTE_UNSUPPORTED' });
    expect(h.invoke).toHaveBeenCalledOnce();
  });

  it.each(['write', 'readback'] as const)('reports unknown on lost %s response without resending', async stage => {
    const h = remote();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (...args) => {
      if ((stage === 'write' && args[1] === 'maker:goal:set') || (stage === 'readback' && h.invoke.mock.calls.length === 3))
        throw new DeviceLinkError('INVOKE_TIMEOUT', 'lost response');
      return original(...args);
    });
    expect(await h.execute(request('set', { deviceId: 'b', objective: 'result' })))
      .toMatchObject({ ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN' });
    expect(h.invoke.mock.calls.filter(c => c[1] === 'maker:goal:set')).toHaveLength(1);
  });

  it('checks action revocation in the transport pre-send boundary', async () => {
    const h = remote();
    h.guard.mockImplementation(() => { throw new Error('permission changed'); });
    expect(await h.execute(request('set', { deviceId: 'b', objective: 'result' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED' });
    h.guard.mockReset();
    expect(await h.execute(request('get', { deviceId: 'b' }))).toEqual({ ok: true, goal: null });
  });
});
