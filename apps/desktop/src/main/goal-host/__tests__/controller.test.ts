import { describe, expect, it, beforeEach, vi } from 'vitest';

import type { AgentEvent, SessionSendResult } from '@cindy/maker-core';

import {
  GoalController,
  GoalUpdateSupersededError,
  decideNextGoalState,
  deriveObjectiveFromAnswers,
  questionsLookLikeGoalClarification,
  type TurnOutcome,
  type GoalCounters,
} from '../controller';
import { buildContinuationDirective, buildFirstTurnDirective } from '../directive';
import { MAX_CONSECUTIVE_OVERLOAD_TURNS } from '../usageLimit';
import type {
  AccountLimitInfo,
  GoalCompletionSummary,
  GoalControllerDeps,
  GoalLimits,
  GoalState,
  GoalStatusUpdate,
  GoalStorageLike,
  SessionLike,
} from '../types';

// ── decideNextGoalState (pure) ───────────────────────────────────────────────

const BASE: GoalCounters = {
  status: 'active',
  turnsUsed: 0,
  tokensUsed: 0,
  noProgressStreak: 0,
  budgetTokens: null,
  maxTurns: null,
  noProgressLimit: null,
};

function outcome(partial: Partial<TurnOutcome>): TurnOutcome {
  return {
    origin: 'goal',
    sawToolUse: true,
    tokensThisTurn: 0,
    verdict: null,
    errored: false,
    ...partial,
  };
}

describe('decideNextGoalState', () => {
  it('pauses when a non-goal (user) turn finishes', () => {
    const d = decideNextGoalState(BASE, outcome({ origin: 'other' }));
    expect(d.status).toBe('paused');
    expect(d.shouldFire).toBe(false);
    expect(d.turnsUsed).toBe(0); // user turn does not count toward goal turns
  });

  it('blocks on a terminal error', () => {
    const d = decideNextGoalState(BASE, outcome({ errored: true, errorMessage: 'boom' }));
    expect(d.status).toBe('blocked');
    expect(d.shouldFire).toBe(false);
    expect(d.lastReason).toContain('boom');
  });

  it('pauses (not blocks) when the turn was aborted by the user', () => {
    const d = decideNextGoalState(BASE, outcome({ errored: true, errorMessage: 'AbortError: aborted' }));
    expect(d.status).toBe('paused');
    expect(d.shouldFire).toBe(false);
  });

  it('marks usageLimited (not blocked) on a usage-limit error', () => {
    const d = decideNextGoalState(BASE, outcome({ errored: true, errorKind: 'usage_limit', errorMessage: 'rate limit' }));
    expect(d.status).toBe('usageLimited');
    expect(d.shouldFire).toBe(false);
  });

  it('completes on a complete verdict', () => {
    const d = decideNextGoalState(BASE, outcome({ verdict: { status: 'complete', reason: 'done' } }));
    expect(d.status).toBe('complete');
    expect(d.shouldFire).toBe(false);
  });

  it('blocks on a blocked verdict', () => {
    const d = decideNextGoalState(BASE, outcome({ verdict: { status: 'blocked', reason: 'need key' } }));
    expect(d.status).toBe('blocked');
    expect(d.shouldFire).toBe(false);
  });

  it('continues + fires on a continue verdict', () => {
    const d = decideNextGoalState(BASE, outcome({ verdict: { status: 'continue', reason: 'wip' } }));
    expect(d.status).toBe('active');
    expect(d.shouldFire).toBe(true);
    expect(d.turnsUsed).toBe(1);
  });

  it('treats a missing verdict as continue', () => {
    const d = decideNextGoalState(BASE, outcome({ verdict: null }));
    expect(d.status).toBe('active');
    expect(d.shouldFire).toBe(true);
  });

  // ── token budget guard (仅设了预算时生效) ──
  it('stops at the token budget when budgetTokens is set', () => {
    const prev: GoalCounters = { ...BASE, tokensUsed: 900, budgetTokens: 1000 };
    const d = decideNextGoalState(prev, outcome({ verdict: { status: 'continue', reason: '' }, tokensThisTurn: 150 }));
    expect(d.tokensUsed).toBe(1050);
    expect(d.status).toBe('budgetLimited');
    expect(d.shouldFire).toBe(false);
    expect(d.lastReason).toContain('token budget');
  });

  it('never hits budgetLimited when budgetTokens is null', () => {
    const prev: GoalCounters = { ...BASE, tokensUsed: 5_000_000, budgetTokens: null };
    const d = decideNextGoalState(prev, outcome({ verdict: { status: 'continue', reason: '' }, tokensThisTurn: 9_999_999 }));
    expect(d.status).toBe('active');
    expect(d.shouldFire).toBe(true);
  });

  // ── max turns guard (仅设了 maxTurns 时生效) ──
  it('stops at max turns when maxTurns is set', () => {
    const prev: GoalCounters = { ...BASE, turnsUsed: 9, maxTurns: 10 };
    const d = decideNextGoalState(prev, outcome({ verdict: { status: 'continue', reason: '' } }));
    expect(d.turnsUsed).toBe(10);
    expect(d.status).toBe('budgetLimited');
    expect(d.lastReason).toContain('max turns');
  });

  it('has no turn cap when maxTurns is null — continues past arbitrarily many turns', () => {
    const prev: GoalCounters = { ...BASE, turnsUsed: 999, maxTurns: null };
    const d = decideNextGoalState(prev, outcome({ verdict: { status: 'continue', reason: '' } }));
    expect(d.turnsUsed).toBe(1000);
    expect(d.status).toBe('active');
    expect(d.shouldFire).toBe(true);
  });

  // ── empty-turn (noProgress) guard (仅设了 noProgressLimit 时生效) ──
  it('increments no-progress streak on empty turns and pauses at noProgressLimit', () => {
    const prev: GoalCounters = { ...BASE, noProgressStreak: 2, noProgressLimit: 3 };
    const d = decideNextGoalState(prev, outcome({ sawToolUse: false, verdict: { status: 'continue', reason: '' } }));
    expect(d.noProgressStreak).toBe(3);
    expect(d.status).toBe('paused');
    expect(d.shouldFire).toBe(false);
  });

  it('resets no-progress streak when a turn uses tools', () => {
    const prev: GoalCounters = { ...BASE, noProgressStreak: 2, noProgressLimit: 3 };
    const d = decideNextGoalState(prev, outcome({ sawToolUse: true, verdict: { status: 'continue', reason: '' } }));
    expect(d.noProgressStreak).toBe(0);
    expect(d.status).toBe('active');
  });

  it('never pauses on empty turns when noProgressLimit is null', () => {
    const prev: GoalCounters = { ...BASE, noProgressStreak: 50, noProgressLimit: null };
    const d = decideNextGoalState(prev, outcome({ sawToolUse: false, verdict: { status: 'continue', reason: '' } }));
    expect(d.status).toBe('active');
    expect(d.shouldFire).toBe(true);
  });
});

// ── deriveObjectiveFromAnswers (pure, Option B) ──────────────────────────────
describe('deriveObjectiveFromAnswers', () => {
  it('returns the single answer for a clean single-question single-select', () => {
    expect(deriveObjectiveFromAnswers({ '你想做什么?': '整理工作环境' })).toBe('整理工作环境');
  });
  it('returns null for multiple questions (ambiguous)', () => {
    expect(deriveObjectiveFromAnswers({ q1: 'a', q2: 'b' })).toBeNull();
  });
  it('returns null when all answers are empty / skipped', () => {
    expect(deriveObjectiveFromAnswers({ q1: '   ', q2: '' })).toBeNull();
    expect(deriveObjectiveFromAnswers({})).toBeNull();
  });
  it('returns null for a multi-select (JSON array) answer', () => {
    expect(deriveObjectiveFromAnswers({ q: '["a","b"]' })).toBeNull();
  });
  it('handles null / non-object', () => {
    expect(deriveObjectiveFromAnswers(null)).toBeNull();
    expect(deriveObjectiveFromAnswers(undefined)).toBeNull();
  });
});

// ── questionsLookLikeGoalClarification (pure, Option B 确定性标记) ─────────────
describe('questionsLookLikeGoalClarification', () => {
  it('is true when some option label equals the current objective verbatim', () => {
    expect(
      questionsLookLikeGoalClarification(
        [{ options: [{ label: '想想' }, { label: '整理工作环境' }] }],
        '想想',
      ),
    ).toBe(true);
  });
  it('matches with surrounding whitespace trimmed on both sides', () => {
    expect(questionsLookLikeGoalClarification([{ options: [{ label: '  想想 ' }] }], ' 想想 ')).toBe(true);
  });
  it('is false for an arbitrary work question (no verbatim-goal option)', () => {
    expect(
      questionsLookLikeGoalClarification(
        [{ options: [{ label: 'staging' }, { label: 'prod' }] }],
        '修复登录 bug',
      ),
    ).toBe(false);
  });
  it('is false for missing / empty questions or empty objective', () => {
    expect(questionsLookLikeGoalClarification(undefined, '想想')).toBe(false);
    expect(questionsLookLikeGoalClarification([], '想想')).toBe(false);
    expect(questionsLookLikeGoalClarification([{ options: [{ label: '想想' }] }], '   ')).toBe(false);
    expect(questionsLookLikeGoalClarification([{}], '想想')).toBe(false);
  });
});

// ── GoalController (integration with fakes) ──────────────────────────────────

class FakeSession implements SessionLike {
  readonly id: string;
  readonly agentKind: SessionLike['agentKind'];
  readonly sends: Array<{ content: string; originKind?: string }> = [];
  private listener: ((event: AgentEvent) => void) | null = null;
  running = false;

  constructor(id: string, agentKind: SessionLike['agentKind'] = 'claude-code') {
    this.id = id;
    this.agentKind = agentKind;
  }

  async send(
    message: { type: 'user'; content: string } | string,
    opts?: { origin?: { kind?: string }; onDispatching?: () => void; signal?: AbortSignal },
  ): Promise<SessionSendResult> {
    const content = typeof message === 'string' ? message : message.content;
    this.sends.push({ content, originKind: opts?.origin?.kind });
    opts?.onDispatching?.();
    return { accepted: true };
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  isTurnRunning(): boolean {
    return this.running;
  }

  async abort(): Promise<void> {
    this.running = false;
    this.emit({
      type: 'error',
      data: { isTerminal: true, message: 'AbortError: aborted' },
      source: 'claude-code',
      turnOrigin: { kind: 'goal' },
    } as never);
  }

  emit(event: AgentEvent): void {
    this.listener?.(event);
  }

  /** 模拟一整轮 goal turn:可选 tool_use → text(含裁决) → status(tokens) → done(origin)。 */
  emitGoalTurn(opts: { toolUse?: boolean; verdictJson?: string; tokens?: number; origin?: 'goal' | 'user' }): void {
    const originKind = opts.origin ?? 'goal';
    if (opts.toolUse) {
      this.emit({ type: 'tool_use', data: { name: 'Bash' } });
    }
    if (opts.verdictJson) {
      this.emit({ type: 'text', data: { text: opts.verdictJson, isFinal: true } });
    }
    this.emit({ type: 'status', data: { isRunning: false, tokenUsage: opts.tokens ?? 0 } });
    this.emit({ type: 'done', data: {}, turnOrigin: { kind: originKind } as never });
  }

  /** 模拟一轮以终止型 error 收尾的 goal turn(turnOrigin 同 done,见 session.ts:524)。 */
  emitErrorTurn(data: Record<string, unknown>): void {
    this.emit({
      type: 'error',
      data: { isTerminal: true, ...data },
      source: 'claude-code',
      turnOrigin: { kind: 'goal' },
    } as never);
  }
}

class FakeStorage implements GoalStorageLike {
  private rows = new Map<string, GoalState>();
  async get(sessionId: string): Promise<GoalState | null> {
    return this.rows.get(sessionId) ?? null;
  }
  async upsert(state: GoalState): Promise<void> {
    this.rows.set(state.sessionId, { ...state });
  }
  async update(sessionId: string, patch: Partial<GoalState>): Promise<GoalState | null> {
    const existing = this.rows.get(sessionId);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    this.rows.set(sessionId, next);
    return { ...next };
  }
  async clear(sessionId: string): Promise<void> {
    this.rows.delete(sessionId);
  }
  async listActive(): Promise<GoalState[]> {
    return [...this.rows.values()].filter((s) => s.status === 'active');
  }
  async listUsageLimited(): Promise<GoalState[]> {
    return [...this.rows.values()].filter((s) => s.status === 'usageLimited');
  }

  async set(state: GoalState): Promise<void> {
    this.rows.set(state.sessionId, { ...state });
  }
}

// 让 finalizeTurn(async)→ scheduleContinuation(setTimeout 0)→ fireTurn(async)整条链 drain。
const tick = () => new Promise((r) => setTimeout(r, 10));

const DEFAULT_LIMITS: GoalLimits = { maxTurns: 20, budgetTokens: null, noProgressLimit: 3 };

function makeController(depOverrides: Partial<GoalControllerDeps> = {}) {
  const storage = new FakeStorage();
  const session = new FakeSession('s1');
  const updates: GoalStatusUpdate[] = [];
  const completions: Array<{ sessionId: string; summary: GoalCompletionSummary }> = [];
  const persistedLimits: GoalLimits[] = [];
  const notices: Array<{ sessionId: string; kind: string }> = [];
  const userMessages: Array<{ sessionId: string; content: string; updated?: boolean }> = [];
  // 可变:测试按需设置"账号是否受限 + resetAt"。
  let accountLimit: AccountLimitInfo | null = null;
  // 可变:模拟"会话已关闭 / 此刻 hydrate 不出来"(ensureSession 返回 undefined)。
  let hydratable = true;
  const deps: GoalControllerDeps = {
    storage,
    getSession: (id) => (id === 's1' ? session : undefined),
    ensureSession: async (id) => (hydratable && id === 's1' ? session : undefined),
    isSessionInTurn: () => false,
    stopActiveGoalTurn: () => {},
    emitStatus: (u) => updates.push(u),
    getDefaults: () => ({ ...DEFAULT_LIMITS }),
    persistGoalSettingsOverride: (l) => persistedLimits.push(l),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => 1000,
    continuationDebounceMs: 0,
    persistGoalCompletion: async (sessionId, summary) => {
      completions.push({ sessionId, summary });
    },
    getAccountLimit: async () => accountLimit,
    persistGoalNotice: async (sessionId, kind) => {
      notices.push({ sessionId, kind });
    },
    persistUserMessage: async (sessionId, content, opts) => {
      userMessages.push({ sessionId, content, updated: opts?.goalObjective?.updated });
    },
    ...depOverrides,
  };
  const controller = new GoalController(deps);
  return {
    controller,
    storage,
    session,
    updates,
    completions,
    persistedLimits,
    notices,
    userMessages,
    setAccountLimit: (v: AccountLimitInfo | null) => {
      accountLimit = v;
    },
    setHydratable: (v: boolean) => {
      hydratable = v;
    },
  };
}

function seededGoal(partial: Partial<GoalState> = {}): GoalState {
  return {
    sessionId: 's1',
    objective: 'old objective',
    status: 'active',
    budgetTokens: null,
    maxTurns: null,
    noProgressLimit: null,
    turnsUsed: 0,
    tokensUsed: 0,
    noProgressStreak: 0,
    usageResetAt: null,
    lastReason: null,
    agentKind: 'claude-code',
    startedAt: 100,
    updatedAt: 100,
    ...partial,
  };
}

function startGoal(h: ReturnType<typeof makeController>, objective = 'make tests pass'): Promise<GoalState | null> {
  return h.controller.setGoal({ sessionId: 's1', objective, agentKind: 'claude-code' });
}

describe('GoalController', () => {
  let h: ReturnType<typeof makeController>;
  beforeEach(() => {
    h = makeController();
  });

  // ── setGoal / updateGoal ──
  it('setGoal creates a new goal directly with default limits and fires the first turn', async () => {
    await h.controller.setGoal({ sessionId: 's1', objective: 'ship the feature' });
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.objective).toBe('ship the feature');
    expect(st?.turnsUsed).toBe(0);
    expect(st?.maxTurns).toBe(DEFAULT_LIMITS.maxTurns);
    expect(st?.budgetTokens).toBe(DEFAULT_LIMITS.budgetTokens);
    expect(st?.noProgressLimit).toBe(DEFAULT_LIMITS.noProgressLimit);
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('[Goal] Work autonomously toward this goal');
    expect(h.session.sends[0].content).toContain('ship the feature');
    expect(h.session.sends[0].content).toContain('goal_status');
    expect(h.session.sends[0].content).not.toContain('goal_setup');
    expect(h.persistedLimits).toHaveLength(0);
  });

  it('applies a deferred agent switch before Goal sends and uses the refreshed live session', async () => {
    const oldSession = new FakeSession('s1', 'claude-code');
    const switchedSession = new FakeSession('s1', 'codex');
    let live = oldSession;
    const releaseAgentSwitchLock = vi.fn();
    const acquirePendingAgentSwitch = vi.fn(async () => {
      live = switchedSession;
      return releaseAgentSwitchLock;
    });
    const local = makeController({
      getSession: () => live,
      ensureSession: async () => live,
      acquirePendingAgentSwitch,
    });

    await local.controller.setGoal({
      sessionId: 's1',
      objective: 'continue on the selected engine',
      agentKind: 'claude-code',
    });

    expect(acquirePendingAgentSwitch).toHaveBeenCalledWith('s1');
    expect(oldSession.sends).toHaveLength(0);
    expect(switchedSession.sends).toHaveLength(1);
    expect(switchedSession.sends[0].originKind).toBe('goal');
    expect(releaseAgentSwitchLock).toHaveBeenCalledTimes(1);
  });

  it('migrates the Goal listener to the switched session so the new engine turn can finalize (reviewer P1)', async () => {
    const oldSession = new FakeSession('s1', 'claude-code');
    const switchedSession = new FakeSession('s1', 'codex');
    let live: FakeSession = oldSession;
    // deferred switch commit:关旧 live session + spawn 目标引擎 → maker.getSession 换新对象。
    const acquirePendingAgentSwitch = vi.fn(async () => {
      live = switchedSession;
      return () => {};
    });
    const local = makeController({
      getSession: () => live,
      ensureSession: async () => live,
      acquirePendingAgentSwitch,
    });

    // setGoal 先在 oldSession 上挂 listener,首轮 fireTurn 落实切换 → listener 必须迁到 switchedSession。
    await local.controller.setGoal({
      sessionId: 's1',
      objective: 'finish on the new engine',
      agentKind: 'claude-code',
    });
    expect(switchedSession.sends).toHaveLength(1);

    // 旧引擎已关闭并 detach:往旧 session 发终止事件不应再推进目标(否则说明 listener 没迁走)。
    oldSession.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"stale"}\n```',
      tokens: 7,
    });
    await tick();
    expect(local.completions).toHaveLength(0);
    expect(await local.storage.get('s1')).not.toBeNull();

    // 新引擎 turn 的 done 事件必须进 finalizeTurn → 目标正常收口,不再永远卡在 active。
    switchedSession.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"green"}\n```',
      tokens: 42,
    });
    await tick();
    expect(local.completions).toHaveLength(1);
    expect(local.completions[0].summary.reason).toBe('green');
    expect(await local.storage.get('s1')).toBeNull();
  });

  it('aborts the git baseline when a goal continuation send is not accepted', async () => {
    const order: string[] = [];
    const beforeDispatchUserTurn = vi.fn(async () => {
      order.push('baseline');
    });
    const onUndispatchedUserTurn = vi.fn(() => {
      order.push('abort');
    });
    const local = makeController({
      beforeDispatchUserTurn,
      onUndispatchedUserTurn,
    });
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      order.push('send');
      return { accepted: false, reason: 'cancelled-before-dispatch' };
    });

    await local.controller.setGoal({ sessionId: 's1', objective: 'ship the feature' });

    expect(order).toEqual(['baseline', 'send', 'abort']);
    expect(beforeDispatchUserTurn).toHaveBeenCalledWith('s1');
    expect(onUndispatchedUserTurn).toHaveBeenCalledWith('s1');
    expect(local.session.sends).toHaveLength(1);
  });

  it('setGoal create resolves agentKind from the ensured (resumed) session for a dormant Codex session (no claude-code fallback)', async () => {
    // reviewer #354:重启后 dormant —— getSession 返回空,ensureSession 才把 Codex 会话 resume 出来。
    // /goal 命令与 setGoal IPC 都可能不带 agentKind,必须从活化后的会话推导,否则会错存成 claude-code
    // → getAccountLimit 读错账号配额快照。
    const storage = new FakeStorage();
    const codexSession = new FakeSession('s1', 'codex');
    const deps: GoalControllerDeps = {
      storage,
      getSession: () => undefined, // dormant:此刻没有 live session
      ensureSession: async () => codexSession, // resume 出真正的 Codex 会话
      isSessionInTurn: () => false,
      stopActiveGoalTurn: () => {},
      emitStatus: () => {},
      getDefaults: () => ({ ...DEFAULT_LIMITS }),
      persistGoalSettingsOverride: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => 1000,
      continuationDebounceMs: 0,
      persistGoalCompletion: async () => {},
      getAccountLimit: async () => null,
      persistGoalNotice: async () => {},
      persistUserMessage: async () => {},
    };
    const controller = new GoalController(deps);
    await controller.setGoal({ sessionId: 's1', objective: '修一修' }); // 不带 agentKind
    expect((await storage.get('s1'))?.agentKind).toBe('codex');
  });

  it('setGoal edits an existing goal directly, preserves counters/start, resets streak, and fires continuation', async () => {
    await h.storage.set(seededGoal({
      objective: 'previous objective',
      maxTurns: 10,
      budgetTokens: 1000,
      noProgressLimit: 3,
      turnsUsed: 3,
      tokensUsed: 400,
      noProgressStreak: 2,
      startedAt: 123,
      status: 'paused',
      usageResetAt: 999,
    }));
    await h.controller.setGoal({ sessionId: 's1', objective: 'new objective' });
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('new objective');
    expect(st?.status).toBe('active');
    expect(st?.maxTurns).toBe(10);
    expect(st?.budgetTokens).toBe(1000);
    expect(st?.noProgressLimit).toBe(3);
    expect(st?.turnsUsed).toBe(3);
    expect(st?.tokensUsed).toBe(400);
    expect(st?.startedAt).toBe(123);
    expect(st?.noProgressStreak).toBe(0);
    expect(st?.usageResetAt).toBeNull();
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('new objective');
    expect(h.session.sends[0].content).toContain('[Goal] Continue working toward this goal');
    expect(h.persistedLimits).toHaveLength(0);
  });

  it('keeps a goal edit alive when a normal turn resets while session hydration is pending', async () => {
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return ensureCalls === 3 ? blockedEnsure : liveSession;
      },
      continuationDebounceMs: 60_000,
    });
    await local.controller.setGoal({ sessionId: 's1', objective: 'old objective' });

    const editPromise = local.controller.setGoal({ sessionId: 's1', objective: 'new objective' });
    await vi.waitFor(() => expect(ensureCalls).toBe(3));

    liveSession.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"normal turn finished"}\n```',
      tokens: 25,
    });
    await vi.waitFor(async () => {
      expect((await local.storage.get('s1'))?.turnsUsed).toBe(1);
    });

    releaseEnsure(liveSession);
    await expect(editPromise).resolves.toMatchObject({
      status: 'active',
      objective: 'new objective',
      turnsUsed: 1,
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'new objective',
      turnsUsed: 1,
    });
    expect(liveSession.sends.at(-1)?.content).toContain('new objective');
  });

  it('does not let a goal edit waiting for session hydration overwrite a later Stop', async () => {
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return blockedEnsure;
      },
    });
    await local.storage.set(seededGoal({ status: 'active', objective: 'old objective' }));

    const editPromise = local.controller.setGoal({ sessionId: 's1', objective: 'stale edit' });
    await vi.waitFor(() => expect(ensureCalls).toBe(1));
    await local.controller.pauseGoal('s1');
    releaseEnsure(liveSession);

    await expect(editPromise).resolves.toBeNull();
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      objective: 'old objective',
    });
    expect(liveSession.sends).toHaveLength(0);
  });

  it('cancels goal creation when Stop lands while the new session is hydrating', async () => {
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return blockedEnsure;
      },
    });

    const createPromise = local.controller.setGoal({ sessionId: 's1', objective: 'do not resurrect' });
    await vi.waitFor(() => expect(ensureCalls).toBe(1));
    await local.controller.pauseGoal('s1');
    releaseEnsure(liveSession);

    await expect(createPromise).resolves.toBeNull();
    expect(await local.storage.get('s1')).toBeNull();
    expect(liveSession.sends).toHaveLength(0);
  });

  it('buildFirstTurnDirective tells the agent to use AskUserQuestion when concerned, mentions the budget, and keeps a blocked fallback', () => {
    const text = buildFirstTurnDirective('do the thing', { maxTurns: 20 });
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('20 turns'); // tells the model the current budget so it can judge it
    expect(text).toContain('"goal_status":"blocked"');
    expect(text).toContain('goal_status'); // verdict contract still present
    expect(text).not.toContain('goal_assessment'); // no custom block anymore
  });

  it('buildFirstTurnDirective omits the budget line when maxTurns is null', () => {
    const text = buildFirstTurnDirective('do the thing', { maxTurns: null });
    expect(text).toContain('AskUserQuestion');
    expect(text).not.toContain('turn budget');
  });

  it('buildFirstTurnDirective routes a vague goal to AskUserQuestion and reserves blocked for danger/credential', () => {
    const text = buildFirstTurnDirective('think about it', { maxTurns: null });
    // 含糊/开放目标 → 用 AskUserQuestion 确认(而非默默猜或 stall)
    expect(text).toContain('AskUserQuestion');
    expect(text.toLowerCase()).toContain('vague');
    // blocked 仅保留给危险 / 不可逆 / 凭证 / 权限,不因"含糊"就 blocked
    expect(text).toContain('credential');
    expect(text).toContain('never a reason to block');
  });

  it('首轮裁决块模板带 refined_objective 字段;续轮不带', () => {
    // 关键:refined_objective 必须长在"end with EXACTLY this block"的模板里,模型才会可靠带上。
    const first = buildFirstTurnDirective('think about it', { maxTurns: null });
    expect(first).toContain('"refined_objective"');
    const cont = buildContinuationDirective('think about it', null);
    expect(cont).not.toContain('refined_objective');
    expect(cont).toContain('goal_status'); // 续轮仍有裁决块
  });

  it('updateGoal changes objective on an active goal without changing counters or firing an extra turn', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: 'old objective', turnsUsed: 2, tokensUsed: 100 }));
    await h.controller.updateGoal('s1', { objective: 'updated objective' });
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('updated objective');
    expect(st?.status).toBe('active');
    expect(st?.turnsUsed).toBe(2);
    expect(st?.tokensUsed).toBe(100);
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal resumes a paused goal when the objective changes', async () => {
    await h.storage.set(seededGoal({
      status: 'paused',
      objective: 'old objective',
      turnsUsed: 2,
      tokensUsed: 100,
      noProgressStreak: 2,
      lastReason: 'paused',
    }));
    await h.controller.updateGoal('s1', { objective: 'updated objective' });
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('updated objective');
    expect(st?.status).toBe('active');
    expect(st?.turnsUsed).toBe(2);
    expect(st?.tokensUsed).toBe(100);
    expect(st?.noProgressStreak).toBe(0);
    expect(st?.lastReason).toBeNull();
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('[Goal] Continue working toward this goal');
    expect(h.session.sends[0].content).toContain('updated objective');
  });

  it('updateGoal does not resume a paused goal when only limits change', async () => {
    await h.storage.set(seededGoal({ status: 'paused', objective: 'same objective', maxTurns: 5 }));
    await h.controller.updateGoal('s1', { maxTurns: 8 });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('paused');
    expect(st?.maxTurns).toBe(8);
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal resumes a usageLimited goal when the objective changes', async () => {
    await h.storage.set(seededGoal({
      status: 'usageLimited',
      objective: 'old objective',
      usageResetAt: 5_000,
      noProgressStreak: 2,
      lastReason: 'usage limit reached',
    }));
    await h.controller.updateGoal('s1', { objective: 'updated after usage limit' });
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('updated after usage limit');
    expect(st?.status).toBe('active');
    expect(st?.usageResetAt).toBeNull();
    expect(st?.noProgressStreak).toBe(0);
    expect(st?.lastReason).toBeNull();
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('updated after usage limit');
  });

  it('does not let an objective update consume a later Stop boundary', async () => {
    let persistCalls = 0;
    let releasePersist!: () => void;
    const blockedPersist = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const local = makeController({
      persistUserMessage: async () => {
        persistCalls += 1;
        await blockedPersist;
      },
    });
    await local.storage.set(seededGoal({ status: 'paused', objective: 'old objective' }));

    const updatePromise = local.controller.updateGoal('s1', { objective: 'updated objective' });
    await vi.waitFor(() => expect(persistCalls).toBe(1));
    let stopSettled = false;
    const stopPromise = local.controller.pauseGoal('s1').then(() => {
      stopSettled = true;
    });
    await tick();
    expect(stopSettled).toBe(false);
    releasePersist();

    const [updated] = await Promise.all([updatePromise, stopPromise]);
    expect(updated).toMatchObject({
      status: 'paused',
      objective: 'updated objective',
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      objective: 'updated objective',
    });
    expect(persistCalls).toBe(1);
    expect(local.updates.at(-1)?.goal).toMatchObject({
      status: 'paused',
      objective: 'updated objective',
    });
    expect(local.session.sends).toHaveLength(0);
  });

  it('reports a superseded update instead of GOAL_NOT_FOUND when Stop wins before the patch is written', async () => {
    const initial = seededGoal({ status: 'active', objective: 'old objective' });
    await h.storage.set(initial);
    let releaseGet!: (state: GoalState | null) => void;
    const blockedGet = new Promise<GoalState | null>((resolve) => {
      releaseGet = resolve;
    });
    const getSpy = vi.spyOn(h.storage, 'get').mockReturnValueOnce(blockedGet);

    const updatePromise = h.controller.updateGoal('s1', { objective: 'stale objective' });
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));
    await h.controller.pauseGoal('s1');
    releaseGet(initial);

    await expect(updatePromise).rejects.toBeInstanceOf(GoalUpdateSupersededError);
    expect(await h.storage.get('s1')).toMatchObject({
      status: 'paused',
      objective: 'old objective',
    });
    expect(h.userMessages).toHaveLength(0);
    expect(h.session.sends).toHaveLength(0);
  });

  it('keeps a later setGoal authoritative over a dormant objective update already writing', async () => {
    const local = makeController();
    await local.storage.set(seededGoal({ status: 'active', objective: 'old objective' }));
    const originalUpdate = local.storage.update.bind(local.storage);
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const blockedUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async (sessionId, patch) => {
      markUpdateStarted();
      await blockedUpdate;
      return originalUpdate(sessionId, patch);
    });

    const staleUpdate = local.controller.updateGoal('s1', { objective: 'stale objective' });
    await updateStarted;
    const replacement = local.controller.setGoal({ sessionId: 's1', objective: 'replacement objective' });
    await tick();
    expect((await local.storage.get('s1'))?.objective).toBe('old objective');

    releaseUpdate();
    await Promise.allSettled([staleUpdate, replacement]);

    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'replacement objective',
    });
    expect(local.session.sends.at(-1)?.content).toContain('replacement objective');
  });

  it('keeps a later setGoal authoritative over a clarification objective write', async () => {
    const local = makeController();
    await local.storage.set(seededGoal({ status: 'active', objective: 'old objective', turnsUsed: 0 }));
    const originalUpdate = local.storage.update.bind(local.storage);
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const blockedUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async (sessionId, patch) => {
      markUpdateStarted();
      await blockedUpdate;
      return originalUpdate(sessionId, patch);
    });

    const clarification = local.controller.applyClarificationAnswer(
      's1',
      { q: 'clarified objective' },
      [{ options: [{ label: 'old objective' }, { label: 'clarified objective' }] }],
    );
    await updateStarted;
    const replacement = local.controller.setGoal({ sessionId: 's1', objective: 'replacement objective' });

    releaseUpdate();
    await Promise.allSettled([clarification, replacement]);

    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'replacement objective',
    });
    expect(local.userMessages.map((message) => message.content)).toEqual([
      'clarified objective',
      'replacement objective',
    ]);
  });

  it('does not emit an old budgetLimited snapshot after a newer setGoal wins during its marker write', async () => {
    let releaseLimitedMarker!: () => void;
    const blockedLimitedMarker = new Promise<void>((resolve) => {
      releaseLimitedMarker = resolve;
    });
    let limitedMarkerStarted = false;
    const local = makeController({
      persistUserMessage: async (_sessionId, content, opts) => {
        if (opts?.goalObjective?.updated && content === 'limited objective') {
          limitedMarkerStarted = true;
          await blockedLimitedMarker;
        }
      },
    });
    await startGoal(local, 'old objective');
    const active = await local.storage.get('s1');
    await local.storage.set({ ...active!, turnsUsed: 5, maxTurns: 10 });

    const limitedUpdate = local.controller.updateGoal('s1', {
      objective: 'limited objective',
      maxTurns: 3,
    });
    await vi.waitFor(() => expect(limitedMarkerStarted).toBe(true));

    let replacementSettled = false;
    const replacement = local.controller
      .setGoal({ sessionId: 's1', objective: 'replacement objective' })
      .then((goal) => {
        replacementSettled = true;
        return goal;
      });
    await tick();
    expect(replacementSettled).toBe(false);
    releaseLimitedMarker();
    await replacement;
    const updatesAfterReplacement = local.updates.length;
    await expect(limitedUpdate).rejects.toBeInstanceOf(GoalUpdateSupersededError);

    expect(await local.storage.get('s1')).toMatchObject({
      status: 'budgetLimited',
      objective: 'replacement objective',
    });
    expect(
      local.updates
        .slice(updatesAfterReplacement)
        .some((update) => update.goal?.objective === 'limited objective'),
    ).toBe(false);
    expect(local.updates.at(-1)?.goal).toMatchObject({
      status: 'budgetLimited',
      objective: 'replacement objective',
    });
  });

  it('returns the authoritative paused goal when Stop wins while a budget edit is hydrating the session', async () => {
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return blockedEnsure;
      },
    });
    await local.storage.set(seededGoal({
      status: 'budgetLimited',
      maxTurns: 5,
      turnsUsed: 5,
      lastReason: 'max turns reached',
    }));

    const updatePromise = local.controller.updateGoal('s1', { maxTurns: 6 });
    await vi.waitFor(() => expect(ensureCalls).toBe(1));
    await local.controller.pauseGoal('s1');
    releaseEnsure(liveSession);

    await expect(updatePromise).resolves.toMatchObject({
      status: 'paused',
      maxTurns: 6,
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      maxTurns: 6,
    });
    expect(local.updates.at(-1)?.goal).toMatchObject({ status: 'paused', maxTurns: 6 });
    expect(liveSession.sends).toHaveLength(0);
  });

  it('returns and re-emits the committed objective when a turn finalizes during marker persistence', async () => {
    let updatedMarkerCalls = 0;
    let releaseMarker!: () => void;
    const blockedMarker = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const local = makeController({
      persistUserMessage: async (_sessionId, _content, opts) => {
        if (opts?.goalObjective?.updated) {
          updatedMarkerCalls += 1;
          await blockedMarker;
        }
      },
    });
    await local.controller.setGoal({ sessionId: 's1', objective: 'old objective' });

    const updatePromise = local.controller.updateGoal('s1', { objective: 'updated objective' });
    await vi.waitFor(() => expect(updatedMarkerCalls).toBe(1));
    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"keep going"}\n```',
      tokens: 25,
    });
    await vi.waitFor(async () => {
      expect((await local.storage.get('s1'))?.turnsUsed).toBe(1);
    });
    releaseMarker();

    await expect(updatePromise).resolves.toMatchObject({
      objective: 'updated objective',
      turnsUsed: 1,
    });
    expect(updatedMarkerCalls).toBe(1);
    expect(local.updates.at(-1)?.goal).toMatchObject({
      objective: 'updated objective',
      turnsUsed: 1,
    });
  });

  it('rejects a committed update when a turn refinement supersedes its objective', async () => {
    let requestedMarkerCalls = 0;
    let refinedMarkerCalls = 0;
    let releaseRequestedMarker!: () => void;
    const blockedRequestedMarker = new Promise<void>((resolve) => {
      releaseRequestedMarker = resolve;
    });
    const local = makeController({
      persistUserMessage: async (_sessionId, content, opts) => {
        if (!opts?.goalObjective?.updated) return;
        if (content === 'requested objective') {
          requestedMarkerCalls += 1;
          await blockedRequestedMarker;
        } else if (content === 'refined by turn') {
          refinedMarkerCalls += 1;
        }
      },
    });
    await local.controller.setGoal({ sessionId: 's1', objective: 'old objective' });

    const updatePromise = local.controller.updateGoal('s1', { objective: 'requested objective' });
    await vi.waitFor(() => expect(requestedMarkerCalls).toBe(1));
    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson:
        '```json\n{"goal_status":"continue","reason":"clarified","refined_objective":"refined by turn"}\n```',
      tokens: 25,
    });
    await vi.waitFor(async () => {
      expect((await local.storage.get('s1'))?.objective).toBe('refined by turn');
      expect(refinedMarkerCalls).toBe(1);
    });
    releaseRequestedMarker();

    await expect(updatePromise).rejects.toBeInstanceOf(GoalUpdateSupersededError);
    expect(await local.storage.get('s1')).toMatchObject({
      objective: 'refined by turn',
      turnsUsed: 1,
    });
  });

  // ── active-goal lifecycle ──
  it('setGoal persists active state and fires the first turn (goal origin)', async () => {
    await startGoal(h);
    expect((await h.storage.get('s1'))?.status).toBe('active');
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].originKind).toBe('goal');
    expect(h.session.sends[0].content).toContain('make tests pass');
    expect(h.session.sends[0].content).toContain('goal_status');
  });

  it('does not drop the first turn when the session is busy at creation — retries until idle and still fires as a FIRST turn', async () => {
    // 新建会话后 agent 可能仍在 spawn/init,isTurnRunning() 瞬时为真。
    h.session.running = true;
    await startGoal(h, 'think about it');
    // 首轮撞 busy:不发送,但已重排重试(旧实现会直接丢弃首轮 → 目标卡死)。
    await tick(); // 重试 tick:仍 busy → 再次重排,不发送
    expect(h.session.sends).toHaveLength(0);
    expect((await h.storage.get('s1'))?.status).toBe('active');
    expect((await h.storage.get('s1'))?.turnsUsed).toBe(0);
    // 会话空闲后,重试应发出首轮(buildFirstTurnDirective:含 AskUserQuestion 约定),而非续轮。
    h.session.running = false;
    await tick();
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('[Goal] Work autonomously toward this goal');
    expect(h.session.sends[0].content).toContain('AskUserQuestion');
    expect(h.session.sends[0].content).not.toContain('[Goal] Continue working toward this goal');
    // #3 回归:目标文案只在创建时落一次,busy 重试重发首轮不得重复落库。
    expect(h.userMessages.filter((m) => m.content === 'think about it').length).toBe(1);
  });

  it('continues to a second turn when the verdict is continue', async () => {
    await startGoal(h);
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"continue","reason":"wip"}\n```', tokens: 100 });
    // 固定 10ms tick 在慢 CI(Windows runner)上不够续轮走完异步链,改用有界
    // 轮询等到续轮真正发出,消除调度抖动依赖。
    await vi.waitFor(() => expect(h.session.sends).toHaveLength(2));
    expect((await h.storage.get('s1'))?.turnsUsed).toBe(1);
    expect((await h.storage.get('s1'))?.tokensUsed).toBe(100);
  });

  it('rewrites the objective when a goal turn reports refined_objective, persists an updated marker, and continues with the new goal', async () => {
    await startGoal(h, 'think about it');
    const sendsAfterFirst = h.session.sends.length; // 首轮已发
    h.session.emitGoalTurn({
      toolUse: true,
      verdictJson:
        '```json\n{"goal_status":"continue","reason":"clarified with user","refined_objective":"梳理当前工作:列出待办并标注优先级"}\n```',
      tokens: 50,
    });
    await vi.waitFor(() => expect(h.session.sends).toHaveLength(sendsAfterFirst + 1));
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('梳理当前工作:列出待办并标注优先级'); // 目标被确定性改写
    expect(st?.status).toBe('active');
    expect(st?.turnsUsed).toBe(1);
    // 落了一条「目标已更新」标记(updated:true),内容是改写后的目标
    expect(
      h.userMessages.some((m) => m.updated === true && m.content === '梳理当前工作:列出待办并标注优先级'),
    ).toBe(true);
    // 续轮已发,且用的是改写后的目标
    expect(h.session.sends.at(-1)?.content).toContain('梳理当前工作:列出待办并标注优先级');
  });

  it('does not let refined_objective overwrite a goal already clarified instantly by Option B (no double change)', async () => {
    await startGoal(h, '想想');
    // B 即时改写:这次 AskUserQuestion 的选项含原目标「想想」verbatim → 确认是目标澄清问题。
    await h.controller.applyClarificationAnswer('s1', { q: '整理工作环境' }, [
      { options: [{ label: '想想' }, { label: '整理工作环境' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('整理工作环境');
    const markersAfterB = h.userMessages.filter((m) => m.updated === true).length;
    // 回合末模型又回报了一个不同的 refined_objective → 因 B 已澄清,C 不再改写(避免二次跳变)。
    h.session.emitGoalTurn({
      toolUse: true,
      verdictJson:
        '```json\n{"goal_status":"continue","reason":"x","refined_objective":"整理并归档所有 worktree"}\n```',
      tokens: 10,
    });
    await tick();
    expect((await h.storage.get('s1'))?.objective).toBe('整理工作环境'); // 仍是 B 的值,未被 C 覆盖
    expect(h.userMessages.filter((m) => m.updated === true).length).toBe(markersAfterB); // 无新增标记
  });

  it('does not rewrite the objective when refined_objective equals the current goal', async () => {
    await startGoal(h, 'ship the feature');
    const markersBefore = h.userMessages.filter((m) => m.updated === true).length;
    h.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"no change","refined_objective":"ship the feature"}\n```',
      tokens: 10,
    });
    await tick();
    expect((await h.storage.get('s1'))?.objective).toBe('ship the feature');
    // 相同目标 → 不落额外的更新标记
    expect(h.userMessages.filter((m) => m.updated === true).length).toBe(markersBefore);
  });

  it('enforces a per-goal maxTurns set at activation', async () => {
    await startGoal(h);
    await h.controller.updateGoal('s1', { maxTurns: 1 });
    // 第一轮 continue → turnsUsed 到 1 == maxTurns 1 → budgetLimited,不再续
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"continue","reason":"wip"}\n```' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('budgetLimited');
    expect(h.session.sends).toHaveLength(1); // 无续轮
  });

  it('Codex goal turn counts per-turn done.data.usage, not the cumulative status snapshot, against the token budget', async () => {
    await startGoal(h);
    // 模拟 Codex 一轮:status 带"累积上下文快照"(大),done 带 per-turn 真实量(小)。
    h.session.emit({ type: 'tool_use', data: { name: 'Bash' } } as never);
    h.session.emit({ type: 'text', data: { text: '```json\n{"goal_status":"continue","reason":"wip"}\n```', isFinal: true } } as never);
    h.session.emit({ type: 'status', data: { status: 'Done', isRunning: false, tokenUsage: 100000 } } as never);
    h.session.emit({
      type: 'done',
      data: { type: 'codex/event/task_complete', usage: { promptTokens: 200, completionTokens: 50, reasoningTokens: 0, cachedTokens: 10 } },
      turnOrigin: { kind: 'goal' },
    } as never);
    await tick();
    // 取 per-turn 的 200+50=250,而不是 status 的 100000 累积快照。
    expect((await h.storage.get('s1'))?.tokensUsed).toBe(250);
  });

  it('Claude goal turn (no per-turn usage on done) keeps the per-turn status.tokenUsage', async () => {
    await startGoal(h);
    h.session.emit({ type: 'tool_use', data: { name: 'Bash' } } as never);
    h.session.emit({ type: 'text', data: { text: '```json\n{"goal_status":"continue","reason":"wip"}\n```', isFinal: true } } as never);
    h.session.emit({ type: 'status', data: { status: 'Done', isRunning: false, tokenUsage: 777 } } as never);
    // Claude done.data 是 SDKResultMessage(无 promptTokens/completionTokens)→ 不覆盖,沿用 status。
    h.session.emit({ type: 'done', data: { usage: { input_tokens: 700, output_tokens: 77 } }, turnOrigin: { kind: 'goal' } } as never);
    await tick();
    expect((await h.storage.get('s1'))?.tokensUsed).toBe(777);
  });

  it('on complete: persists a completion record, clears the row, emits null, no continuation', async () => {
    await startGoal(h);
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"complete","reason":"green"}\n```', tokens: 42 });
    await tick();
    expect(await h.storage.get('s1')).toBeNull();
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]).toMatchObject({ sessionId: 's1' });
    expect(h.completions[0].summary.turnsUsed).toBe(1);
    expect(h.completions[0].summary.tokensUsed).toBe(42);
    expect(h.completions[0].summary.reason).toBe('green');
    expect(h.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
    expect(h.session.sends).toHaveLength(1); // no continuation
  });

  it('pauseGoal pauses an active goal, preserves counters, and stops continuation', async () => {
    await startGoal(h);
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"continue","reason":"wip"}\n```', tokens: 50 });
    await tick();
    await h.controller.pauseGoal('s1');
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('paused');
    expect(st?.turnsUsed).toBe(1);
    expect(st?.tokensUsed).toBe(50);
    const sendsAfterPause = h.session.sends.length;
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"continue","reason":"x"}\n```' });
    await tick();
    expect(h.session.sends.length).toBe(sendsAfterPause);
  });

  it('detaches goal continuation synchronously before pause persistence can block', async () => {
    await startGoal(h);
    const active = await h.storage.get('s1');
    expect(active?.status).toBe('active');

    let releaseGet!: (state: GoalState | null) => void;
    const blockedGet = new Promise<GoalState | null>((resolve) => {
      releaseGet = resolve;
    });
    vi.spyOn(h.storage, 'get').mockReturnValueOnce(blockedGet);

    const sendsBeforePause = h.session.sends.length;
    const pausePromise = h.controller.pauseGoal('s1');

    // 模拟 Stop 之后立刻到达旧 turn 的终态。即使 pause 的 DB 读仍悬着，listener
    // 也必须已经摘掉，不能让 idle 兜底再 fire 一轮。
    h.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"late done"}\n```',
    });
    await tick();
    expect(h.session.sends).toHaveLength(sendsBeforePause);

    // 打开会话触发的 dormant resume 也不能越过正在落盘的 Stop 边界。
    await h.controller.resumeOnOpen('s1');
    expect(h.session.sends).toHaveLength(sendsBeforePause);

    releaseGet(active);
    await pausePromise;
    expect((await h.storage.get('s1'))?.status).toBe('paused');
  });

  it('keeps the Stop boundary fail-closed when paused persistence fails', async () => {
    await startGoal(h);
    const sendsBeforeStop = h.session.sends.length;
    const updateSpy = vi
      .spyOn(h.storage, 'update')
      .mockRejectedValueOnce(new Error('goal storage unavailable'));

    await expect(h.controller.pauseGoal('s1')).rejects.toThrow('goal storage unavailable');
    expect((await h.storage.get('s1'))?.status).toBe('active');

    // GET_GOAL_STATUS 会 fire-and-forget 调 resumeOnOpen；失败的 Stop 仍必须挡住它。
    await h.controller.resumeOnOpen('s1');
    expect(h.session.sends).toHaveLength(sendsBeforeStop);

    updateSpy.mockRestore();
    await h.controller.pauseGoal('s1');
    expect((await h.storage.get('s1'))?.status).toBe('paused');
  });

  it('keeps the Stop boundary fail-closed when reading Goal state fails', async () => {
    await startGoal(h);
    const sendsBeforeStop = h.session.sends.length;
    const getSpy = vi
      .spyOn(h.storage, 'get')
      .mockRejectedValueOnce(new Error('goal storage read unavailable'));

    await expect(h.controller.pauseGoal('s1')).rejects.toThrow('goal storage read unavailable');
    await h.controller.resumeOnOpen('s1');
    expect(h.session.sends).toHaveLength(sendsBeforeStop);

    getSpy.mockRestore();
    await h.controller.pauseGoal('s1');
    expect((await h.storage.get('s1'))?.status).toBe('paused');
  });

  it('persists an explicitly stopped usage-limited goal as paused so restart cannot auto-resume it', async () => {
    await h.storage.set(seededGoal({
      status: 'usageLimited',
      usageResetAt: 9_999,
      lastReason: 'usage limit reached',
    }));

    await h.controller.pauseGoal('s1');

    expect(await h.storage.get('s1')).toMatchObject({
      status: 'paused',
      usageResetAt: null,
      lastReason: 'paused by user',
    });
  });

  it('cancels a goal fire that was already waiting across an async boundary', async () => {
    const liveSession = new FakeSession('s1');
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return ensureCalls <= 2 ? liveSession : blockedEnsure;
      },
    });
    await startGoal(local);
    expect(liveSession.sends).toHaveLength(1);

    const firePromise = (
      local.controller as unknown as { fireTurn(sessionId: string): Promise<void> }
    ).fireTurn('s1');
    await vi.waitFor(() => expect(ensureCalls).toBe(3));

    await local.controller.pauseGoal('s1');
    releaseEnsure(liveSession);
    await firePromise;

    expect(liveSession.sends).toHaveLength(1);
    expect((await local.storage.get('s1'))?.status).toBe('paused');
  });

  it('does not rehydrate a session after Stop cancels a fire waiting on the route lock', async () => {
    const liveSession = new FakeSession('s1');
    let acquireCalls = 0;
    let ensureCalls = 0;
    let releaseAcquire!: (release: () => void) => void;
    const blockedAcquire = new Promise<() => void>((resolve) => {
      releaseAcquire = resolve;
    });
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return liveSession;
      },
      acquirePendingAgentSwitch: async () => {
        acquireCalls += 1;
        return acquireCalls === 1 ? () => {} : blockedAcquire;
      },
    });
    await startGoal(local);
    expect(ensureCalls).toBe(2);

    const firePromise = (
      local.controller as unknown as { fireTurn(sessionId: string): Promise<void> }
    ).fireTurn('s1');
    await vi.waitFor(() => expect(acquireCalls).toBe(2));

    await local.controller.pauseGoal('s1');
    releaseAcquire(() => {});
    await firePromise;

    expect(ensureCalls).toBe(2);
    expect(liveSession.sends).toHaveLength(1);
    expect((await local.storage.get('s1'))?.status).toBe('paused');
  });

  it('does not let stale budget preflight cleanup delete the Stop boundary', async () => {
    const local = makeController();
    await startGoal(local);
    const active = await local.storage.get('s1');
    expect(active).not.toBeNull();
    await local.storage.set({ ...active!, turnsUsed: 1, maxTurns: 1 });

    const originalUpdate = local.storage.update.bind(local.storage);
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const blockedUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async (sessionId, patch) => {
      const result = await originalUpdate(sessionId, patch);
      markUpdateStarted();
      await blockedUpdate;
      return result;
    });
    const internals = local.controller as unknown as {
      fireTurn(sessionId: string): Promise<void>;
      turns: Map<string, { cancelled: boolean }>;
    };

    const staleFire = internals.fireTurn('s1');
    await updateStarted;
    const pausePromise = local.controller.pauseGoal('s1');
    const stopBoundary = internals.turns.get('s1');
    expect(stopBoundary?.cancelled).toBe(true);

    releaseUpdate();
    await Promise.all([staleFire, pausePromise]);
    expect(internals.turns.get('s1')).toBe(stopBoundary);
    expect((await local.storage.get('s1'))?.status).toBe('budgetLimited');
    expect(local.session.sends).toHaveLength(1);
  });

  it('does not let an old fire cleanup clear the resumed generation firing owner', async () => {
    const liveSession = new FakeSession('s1');
    let acquireCalls = 0;
    let releaseOldAcquire!: (release: () => void) => void;
    let releaseNewAcquire!: (release: () => void) => void;
    const blockedOldAcquire = new Promise<() => void>((resolve) => {
      releaseOldAcquire = resolve;
    });
    const blockedNewAcquire = new Promise<() => void>((resolve) => {
      releaseNewAcquire = resolve;
    });
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => liveSession,
      acquirePendingAgentSwitch: async () => {
        acquireCalls += 1;
        if (acquireCalls === 1) return () => {};
        return acquireCalls === 2 ? blockedOldAcquire : blockedNewAcquire;
      },
    });
    await startGoal(local);
    const internals = local.controller as unknown as {
      fireTurn(sessionId: string): Promise<void>;
      firing: Map<string, object>;
      goalDispatchAbortControllers: Map<string, { owner: object; controller: AbortController }>;
    };

    const oldFire = internals.fireTurn('s1');
    await vi.waitFor(() => expect(acquireCalls).toBe(2));
    await local.controller.pauseGoal('s1');

    const resumePromise = local.controller.resumeGoal('s1');
    await vi.waitFor(() => expect(acquireCalls).toBe(3));
    expect(internals.firing.has('s1')).toBe(true);
    const resumedDispatchCancellation = internals.goalDispatchAbortControllers.get('s1');
    expect(resumedDispatchCancellation).toBeDefined();

    releaseOldAcquire(() => {});
    await oldFire;
    expect(internals.firing.has('s1')).toBe(true);
    expect(internals.goalDispatchAbortControllers.get('s1')).toBe(resumedDispatchCancellation);

    releaseNewAcquire(() => {});
    await resumePromise;
    expect(liveSession.sends).toHaveLength(2);
  });

  it('does not let a stale send result erase the resumed goal turn marker', async () => {
    const local = makeController();
    let sendCalls = 0;
    let releaseOldSend!: (result: SessionSendResult) => void;
    const blockedOldSend = new Promise<SessionSendResult>((resolve) => {
      releaseOldSend = resolve;
    });
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      opts?.onDispatching?.();
      sendCalls += 1;
      return sendCalls === 2 ? blockedOldSend : { accepted: true };
    });
    await startGoal(local);
    const internals = local.controller as unknown as {
      fireTurn(sessionId: string): Promise<void>;
      goalTurnsInFlight: Set<string>;
    };

    const oldFire = internals.fireTurn('s1');
    await vi.waitFor(() => expect(sendCalls).toBe(2));
    await local.controller.pauseGoal('s1');
    await local.controller.resumeGoal('s1');
    expect(sendCalls).toBe(3);
    expect(internals.goalTurnsInFlight.has('s1')).toBe(true);

    releaseOldSend({ accepted: false, reason: 'cancelled-before-dispatch' });
    await oldFire;
    expect(internals.goalTurnsInFlight.has('s1')).toBe(true);
  });

  it('cancels an in-flight turn finalizer when Stop pauses the goal', async () => {
    let limitCalls = 0;
    let releaseLimit!: (limit: AccountLimitInfo | null) => void;
    const blockedLimit = new Promise<AccountLimitInfo | null>((resolve) => {
      releaseLimit = resolve;
    });
    const local = makeController({
      getAccountLimit: async () => {
        limitCalls += 1;
        return blockedLimit;
      },
    });
    await startGoal(local);
    const sendsBeforeStop = local.session.sends.length;

    // continue 裁决会在账号限额查询处跨 async 边界。Stop 必须让这条旧 finalize
    // 失效，查询回来后不能再以旧 active 快照覆盖 pauseGoal 写下的 paused。
    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"late finalize"}\n```',
      tokens: 20,
    });
    await vi.waitFor(() => expect(limitCalls).toBe(1));

    await local.controller.pauseGoal('s1');
    releaseLimit(null);
    await tick();

    expect((await local.storage.get('s1'))?.status).toBe('paused');
    expect(local.session.sends).toHaveLength(sendsBeforeStop);
  });

  it('keeps repeated Stop behind an already-issued finalize write so paused wins last', async () => {
    const local = makeController();
    await startGoal(local);
    const originalUpdate = local.storage.update.bind(local.storage);
    let markFinalizeWriteStarted!: () => void;
    const finalizeWriteStarted = new Promise<void>((resolve) => {
      markFinalizeWriteStarted = resolve;
    });
    let releaseFinalizeWrite!: () => void;
    const blockedFinalizeWrite = new Promise<void>((resolve) => {
      releaseFinalizeWrite = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async (sessionId, patch) => {
      markFinalizeWriteStarted();
      await blockedFinalizeWrite;
      return originalUpdate(sessionId, patch);
    });
    const sendsBeforeStop = local.session.sends.length;

    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"late finalize"}\n```',
      tokens: 20,
    });
    await finalizeWriteStarted;

    const updatesBeforeStop = local.updates.length;
    let firstSettled = false;
    let secondSettled = false;
    const firstStop = local.controller.pauseGoal('s1');
    void firstStop.then(() => { firstSettled = true; });
    const secondStop = local.controller.pauseGoal('s1');
    void secondStop.then(() => { secondSettled = true; });
    await tick();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseFinalizeWrite();
    await Promise.all([firstStop, secondStop]);
    await tick();

    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      turnsUsed: 1,
      tokensUsed: 20,
    });
    expect(local.session.sends).toHaveLength(sendsBeforeStop);
    expect(
      local.updates.slice(updatesBeforeStop).some((update) => update.goal?.status === 'active'),
    ).toBe(false);
  });

  it('lets Stop persist paused while completion-message persistence is still pending', async () => {
    let completionCalls = 0;
    let releaseCompletion!: () => void;
    const blockedCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const local = makeController({
      persistGoalCompletion: async () => {
        completionCalls += 1;
        await blockedCompletion;
      },
    });
    await startGoal(local);

    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"done"}\n```',
    });
    await vi.waitFor(() => expect(completionCalls).toBe(1));

    await local.controller.pauseGoal('s1');
    expect((await local.storage.get('s1'))?.status).toBe('paused');
    expect(local.updates.filter((update) => update.goal === null)).toHaveLength(0);

    releaseCompletion();
    await tick();

    expect(await local.storage.get('s1')).toBeNull();
    expect(local.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
    expect(local.updates.filter((update) => update.goal === null)).toHaveLength(1);
  });

  it('finishes the completion commit if Stop arrives while clearing goal storage', async () => {
    const local = makeController();
    const originalClear = local.storage.clear.bind(local.storage);
    let clearCalls = 0;
    let releaseClear!: () => void;
    const blockedClear = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    vi.spyOn(local.storage, 'clear').mockImplementation(async (sessionId) => {
      clearCalls += 1;
      await blockedClear;
      await originalClear(sessionId);
    });
    await startGoal(local);

    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"done"}\n```',
    });
    await vi.waitFor(() => expect(clearCalls).toBe(1));

    await local.controller.pauseGoal('s1');
    expect((await local.storage.get('s1'))?.status).toBe('paused');
    releaseClear();
    await tick();

    expect(await local.storage.get('s1')).toBeNull();
    expect(local.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
  });

  it('waits for an old completion clear before creating a replacement Goal', async () => {
    const local = makeController();
    const originalClear = local.storage.clear.bind(local.storage);
    let clearCalls = 0;
    let releaseClear!: () => void;
    const blockedClear = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    vi.spyOn(local.storage, 'clear').mockImplementation(async (sessionId) => {
      clearCalls += 1;
      await blockedClear;
      await originalClear(sessionId);
    });
    await startGoal(local, 'completed objective');

    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"done"}\n```',
    });
    await vi.waitFor(() => expect(clearCalls).toBe(1));
    await local.controller.pauseGoal('s1');

    let replacementSettled = false;
    const replacement = local.controller.setGoal({
      sessionId: 's1',
      objective: 'replacement objective',
    });
    void replacement.then(() => { replacementSettled = true; });
    await tick();
    expect(replacementSettled).toBe(false);
    expect((await local.storage.get('s1'))?.status).toBe('paused');

    releaseClear();
    await expect(replacement).resolves.toMatchObject({
      status: 'active',
      objective: 'replacement objective',
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'replacement objective',
    });
    expect(local.updates.at(-1)?.goal).toMatchObject({
      status: 'active',
      objective: 'replacement objective',
    });
  });

  it('resumeGoal resumes a paused goal: preserves counters, fires a continuation', async () => {
    await startGoal(h);
    h.session.emitGoalTurn({ verdictJson: '```json\n{"goal_status":"continue","reason":""}\n```', tokens: 30 });
    await tick();
    await h.controller.pauseGoal('s1');
    const sendsBeforeResume = h.session.sends.length;
    await h.controller.resumeGoal('s1');
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.turnsUsed).toBe(1);
    expect(st?.tokensUsed).toBe(30);
    expect(st?.noProgressStreak).toBe(0);
    expect(h.session.sends.length).toBe(sendsBeforeResume + 1);
  });

  it('keeps Stop behind every active write from concurrent Resume calls', async () => {
    const local = makeController();
    await local.storage.set(seededGoal({ status: 'paused', lastReason: 'paused by user' }));
    const originalUpdate = local.storage.update.bind(local.storage);
    let activeWrites = 0;
    let releaseFirst!: () => void;
    const blockedFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const blockedSecond = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementation(async (sessionId, patch) => {
      if (patch.status === 'active') {
        activeWrites += 1;
        await (activeWrites === 1 ? blockedFirst : blockedSecond);
      }
      return originalUpdate(sessionId, patch);
    });

    const firstResume = local.controller.resumeGoal('s1');
    const secondResume = local.controller.resumeGoal('s1');
    await vi.waitFor(() => expect(activeWrites).toBe(2));
    releaseFirst();
    await firstResume;

    const updatesBeforeStop = local.updates.length;
    let stopSettled = false;
    const stop = local.controller.pauseGoal('s1');
    void stop.then(() => { stopSettled = true; });
    await tick();
    expect(stopSettled).toBe(false);

    releaseSecond();
    await Promise.all([secondResume, stop]);

    expect((await local.storage.get('s1'))?.status).toBe('paused');
    expect(
      local.updates.slice(updatesBeforeStop).some((update) => update.goal?.status === 'active'),
    ).toBe(false);
  });

  it('does not bind Resume to the old vendor turn before Stop reaches idle', async () => {
    let sessionInTurn = false;
    const local = makeController({ isSessionInTurn: () => sessionInTurn });
    await startGoal(local);
    await local.controller.pauseGoal('s1');
    const sendsBeforeResume = local.session.sends.length;

    sessionInTurn = true;
    await local.controller.pauseGoal('s1'); // 连续第二次 Stop 也必须保留同一取消边界。
    await local.controller.resumeGoal('s1');
    expect((await local.storage.get('s1'))?.status).toBe('paused');
    expect(local.session.sends).toHaveLength(sendsBeforeResume);

    // 旧 abort terminal 在 cancelled boundary 期间没有 listener，不能结算到下一代。
    local.session.emitErrorTurn({ message: 'AbortError: interrupted' });
    sessionInTurn = false;
    await local.controller.resumeGoal('s1');

    expect((await local.storage.get('s1'))?.status).toBe('active');
    expect(local.session.sends).toHaveLength(sendsBeforeResume + 1);
  });

  it('does not let an older Resume consume the fresh boundary from a later Stop', async () => {
    await startGoal(h);
    await h.controller.pauseGoal('s1');
    const paused = await h.storage.get('s1');
    const sendsBeforeResume = h.session.sends.length;
    let releaseGet!: (state: GoalState | null) => void;
    const blockedGet = new Promise<GoalState | null>((resolve) => {
      releaseGet = resolve;
    });
    const getSpy = vi.spyOn(h.storage, 'get').mockReturnValueOnce(blockedGet);

    const olderResume = h.controller.resumeGoal('s1');
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));
    await h.controller.pauseGoal('s1');
    releaseGet(paused);
    await olderResume;

    expect((await h.storage.get('s1'))?.status).toBe('paused');
    expect(h.session.sends).toHaveLength(sendsBeforeResume);
  });

  it('keeps a manual Resume paused when the session cannot hydrate, then allows retry', async () => {
    await startGoal(h);
    await h.controller.pauseGoal('s1');
    const sendsBeforeResume = h.session.sends.length;

    h.setHydratable(false);
    await h.controller.resumeGoal('s1');
    expect((await h.storage.get('s1'))?.status).toBe('paused');
    expect(h.session.sends).toHaveLength(sendsBeforeResume);

    h.setHydratable(true);
    await h.controller.resumeGoal('s1');
    expect((await h.storage.get('s1'))?.status).toBe('active');
    expect(h.session.sends).toHaveLength(sendsBeforeResume + 1);
  });

  it('does not reattach or emit stale active when Stop cancels resume during ensureSession', async () => {
    const liveSession = new FakeSession('s1');
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return ensureCalls <= 2 ? liveSession : blockedEnsure;
      },
    });
    await startGoal(local);
    await local.controller.pauseGoal('s1');
    const sendsBeforeResume = liveSession.sends.length;

    const resumePromise = local.controller.resumeGoal('s1');
    await vi.waitFor(() => expect(ensureCalls).toBe(3));
    await local.controller.pauseGoal('s1');
    expect((await local.storage.get('s1'))?.status).toBe('paused');

    releaseEnsure(liveSession);
    await resumePromise;

    expect((await local.storage.get('s1'))?.status).toBe('paused');
    expect(local.updates.at(-1)?.goal?.status).toBe('paused');
    expect(liveSession.sends).toHaveLength(sendsBeforeResume);
  });

  it('resumeGoal is a no-op for a non-paused/blocked goal (e.g. active)', async () => {
    await startGoal(h);
    const sends = h.session.sends.length;
    await h.controller.resumeGoal('s1');
    expect(h.session.sends.length).toBe(sends);
  });

  it('resumeOnOpen activates a dormant active goal (attach + fire) when the conversation is opened', async () => {
    // 模拟重启后 dormant:有 active 目标行,但没挂 listener、没 fire。
    await h.storage.set(seededGoal({ status: 'active', objective: 'keep going', turnsUsed: 0 }));
    expect(h.session.sends).toHaveLength(0);
    await h.controller.resumeOnOpen('s1');
    expect(h.session.sends.length).toBeGreaterThanOrEqual(1); // 已活化并续了一轮
    expect(h.session.sends.at(-1)?.content).toContain('keep going');
  });

  it('does not let a stale startup active snapshot overwrite a concurrent Stop', async () => {
    const active = seededGoal({ status: 'active', objective: 'stay stopped' });
    await h.storage.set(active);
    let releaseList!: (states: GoalState[]) => void;
    const blockedList = new Promise<GoalState[]>((resolve) => {
      releaseList = resolve;
    });
    vi.spyOn(h.storage, 'listActive').mockReturnValueOnce(blockedList);

    const startupResume = h.controller.resumeActiveGoals();
    await h.controller.pauseGoal('s1');
    expect((await h.storage.get('s1'))?.status).toBe('paused');

    releaseList([active]);
    await startupResume;

    expect((await h.storage.get('s1'))?.status).toBe('paused');
    expect(h.updates.at(-1)?.goal?.status).toBe('paused');
    expect(h.session.sends).toHaveLength(0);
  });

  it('resumeOnOpen 在释放 route 锁前挂 listener，并在会话随即关闭后迁移到重建会话', async () => {
    const firstSession = new FakeSession('s1', 'claude-code');
    const recreatedSession = new FakeSession('s1', 'claude-code');
    let live: FakeSession | undefined = firstSession;
    let acquireCount = 0;
    const acquirePendingAgentSwitch = vi.fn(async () => {
      acquireCount += 1;
      if (acquireCount === 1) {
        return () => {
          // 模拟 resumeOnOpen 释放锁后，queued SET_MODEL 立即关闭刚确保的 session。
          live = undefined;
        };
      }
      return () => {};
    });
    const local = makeController({
      getSession: () => live,
      ensureSession: async () => {
        if (!live) live = recreatedSession;
        return live;
      },
      acquirePendingAgentSwitch,
    });
    await local.storage.set(seededGoal({ status: 'active', objective: 'survive rewire' }));

    await local.controller.resumeOnOpen('s1');
    expect(recreatedSession.sends).toHaveLength(1);

    recreatedSession.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"complete","reason":"rewired"}\n```',
      tokens: 5,
    });
    await tick();

    expect(local.completions).toHaveLength(1);
    expect(local.completions[0].summary.reason).toBe('rewired');
  });

  it('resumeOnOpen is a no-op for non-active goals and for goals already being managed', async () => {
    // paused → 不自动续(走手动 resume)
    await h.storage.set(seededGoal({ status: 'paused', objective: 'p' }));
    await h.controller.resumeOnOpen('s1');
    expect(h.session.sends).toHaveLength(0);
    // active 且已在管(setGoal 已挂 listener + 发首轮)→ resumeOnOpen 不重复 fire
    const h2 = makeController();
    await h2.controller.setGoal({ sessionId: 's1', objective: 'managed' });
    const n = h2.session.sends.length;
    await h2.controller.resumeOnOpen('s1');
    expect(h2.session.sends.length).toBe(n);
  });

  it('maybeContinueActiveGoal fires only when an active goal is attached and idle', async () => {
    await h.controller.maybeContinueActiveGoal('s1'); // 无 goal → no-op
    expect(h.session.sends).toHaveLength(0);
    await startGoal(h);
    const before = h.session.sends.length;
    await h.controller.maybeContinueActiveGoal('s1');
    await tick();
    expect(h.session.sends.length).toBe(before + 1);
    await h.controller.pauseGoal('s1');
    const afterPause = h.session.sends.length;
    await h.controller.maybeContinueActiveGoal('s1');
    await tick();
    expect(h.session.sends.length).toBe(afterPause);
  });

  it('pauses when a user-origin turn finishes mid-goal', async () => {
    await startGoal(h);
    h.session.emitGoalTurn({ origin: 'user', toolUse: true, verdictJson: '' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('paused');
    expect(h.session.sends).toHaveLength(1);
  });

  // ── applyClarificationAnswer(Option B:答完卡片即时改写目标)──
  it('applyClarificationAnswer rewrites the objective on the first turn, persists an updated marker, and emits', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: '想想', turnsUsed: 0 }));
    await h.controller.applyClarificationAnswer('s1', { '你想让我做什么?': '整理工作环境' }, [
      { options: [{ label: '想想' }, { label: '整理工作环境' }] },
    ]);
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('整理工作环境');
    expect(h.userMessages.some((m) => m.updated === true && m.content === '整理工作环境')).toBe(true);
    expect(h.updates.at(-1)?.goal?.objective).toBe('整理工作环境');
  });

  it('keeps a clarification objective and marker committed before a later Stop settles', async () => {
    const markers: string[] = [];
    let releaseMarker!: () => void;
    const blockedMarker = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const local = makeController({
      persistUserMessage: async (_sessionId, content, opts) => {
        if (!opts?.goalObjective?.updated) return;
        markers.push(content);
        await blockedMarker;
      },
    });
    await local.storage.set(
      seededGoal({ status: 'active', objective: 'old objective', turnsUsed: 0 }),
    );

    const clarification = local.controller.applyClarificationAnswer(
      's1',
      { q: 'clarified objective' },
      [{ options: [{ label: 'old objective' }, { label: 'clarified objective' }] }],
    );
    await vi.waitFor(() => expect(markers).toEqual(['clarified objective']));
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'clarified objective',
    });

    let stopSettled = false;
    const stop = local.controller.pauseGoal('s1').then(() => {
      stopSettled = true;
    });
    await tick();
    expect(stopSettled).toBe(false);

    releaseMarker();
    await Promise.all([clarification, stop]);
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      objective: 'clarified objective',
    });
    expect(markers).toEqual(['clarified objective']);

    await local.controller.resumeGoal('s1');
    await local.controller.applyClarificationAnswer(
      's1',
      { q: 'second objective' },
      [{ options: [{ label: 'clarified objective' }, { label: 'second objective' }] }],
    );
    expect((await local.storage.get('s1'))?.objective).toBe('clarified objective');
    expect(markers).toEqual(['clarified objective']);
  });

  it('releases only its own clarification claim when persistence fails after Stop takes over', async () => {
    const local = makeController();
    await local.storage.set(
      seededGoal({ status: 'active', objective: 'old objective', turnsUsed: 0 }),
    );
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const blockedUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async () => {
      markUpdateStarted();
      await blockedUpdate;
      throw new Error('clarification write failed');
    });

    const clarification = local.controller.applyClarificationAnswer(
      's1',
      { q: 'failed objective' },
      [{ options: [{ label: 'old objective' }, { label: 'failed objective' }] }],
    );
    await updateStarted;
    const stop = local.controller.pauseGoal('s1');
    releaseUpdate();

    await expect(clarification).rejects.toThrow('clarification write failed');
    await stop;
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'paused',
      objective: 'old objective',
    });

    await local.controller.resumeGoal('s1');
    await local.controller.applyClarificationAnswer(
      's1',
      { q: 'retry objective' },
      [{ options: [{ label: 'old objective' }, { label: 'retry objective' }] }],
    );
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'active',
      objective: 'retry objective',
    });
    expect(local.userMessages.filter((message) => message.updated === true)).toEqual([
      { sessionId: 's1', content: 'retry objective', updated: true },
    ]);
  });

  it('ignores a clarification answer that arrives after its first turn has begun finalizing', async () => {
    const local = makeController();
    await startGoal(local, 'old objective');
    const initial = await local.storage.get('s1');
    let releaseGet!: (state: GoalState | null) => void;
    const blockedGet = new Promise<GoalState | null>((resolve) => {
      releaseGet = resolve;
    });
    const getSpy = vi.spyOn(local.storage, 'get').mockReturnValueOnce(blockedGet);

    const clarification = local.controller.applyClarificationAnswer(
      's1',
      { q: 'late objective' },
      [{ options: [{ label: 'old objective' }, { label: 'late objective' }] }],
    );
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));
    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"keep going"}\n```',
      tokens: 10,
    });
    await vi.waitFor(async () => expect((await local.storage.get('s1'))?.turnsUsed).toBe(1));

    releaseGet(initial);
    await clarification;
    expect(await local.storage.get('s1')).toMatchObject({
      turnsUsed: 1,
      objective: 'old objective',
    });
    expect(local.userMessages.filter((message) => message.updated === true)).toHaveLength(0);
  });

  it('allows only one concurrent clarification answer to commit per goal', async () => {
    const local = makeController();
    await startGoal(local, 'old objective');
    const initial = await local.storage.get('s1');
    let releaseFirstGet!: (state: GoalState | null) => void;
    let releaseSecondGet!: (state: GoalState | null) => void;
    const firstGet = new Promise<GoalState | null>((resolve) => {
      releaseFirstGet = resolve;
    });
    const secondGet = new Promise<GoalState | null>((resolve) => {
      releaseSecondGet = resolve;
    });
    const getSpy = vi
      .spyOn(local.storage, 'get')
      .mockReturnValueOnce(firstGet)
      .mockReturnValueOnce(secondGet);

    const first = local.controller.applyClarificationAnswer(
      's1',
      { q: 'first objective' },
      [{ options: [{ label: 'old objective' }, { label: 'first objective' }] }],
    );
    const second = local.controller.applyClarificationAnswer(
      's1',
      { q: 'second objective' },
      [{ options: [{ label: 'old objective' }, { label: 'second objective' }] }],
    );
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));
    releaseFirstGet(initial);
    releaseSecondGet(initial);
    await Promise.all([first, second]);

    expect((await local.storage.get('s1'))?.objective).toBe('first objective');
    expect(
      local.userMessages
        .filter((message) => message.updated === true)
        .map((message) => message.content),
    ).toEqual(['first objective']);
  });

  it('applyClarificationAnswer does NOT rewrite for an arbitrary first-turn work question (no verbatim-goal option)', async () => {
    // reviewer #354:模型首轮问个普通工作问题(选项是环境名,不含原目标 verbatim)→ 不得被当成目标改写。
    await h.storage.set(seededGoal({ status: 'active', objective: '修复登录 bug', turnsUsed: 0 }));
    await h.controller.applyClarificationAnswer('s1', { '用哪个环境?': 'staging' }, [
      { options: [{ label: 'staging' }, { label: 'prod' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('修复登录 bug');
    expect(h.userMessages.some((m) => m.updated === true)).toBe(false);
    // 标记未被消耗:后续真正的目标澄清问题仍能改写。
    await h.controller.applyClarificationAnswer('s1', { q: '整理登录模块测试' }, [
      { options: [{ label: '修复登录 bug' }, { label: '整理登录模块测试' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('整理登录模块测试');
  });

  it('applyClarificationAnswer does NOT rewrite once the goal has run a turn (turnsUsed>0)', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: '原目标', turnsUsed: 2 }));
    await h.controller.applyClarificationAnswer('s1', { q: '一个中途的回答' }, [
      { options: [{ label: '原目标' }, { label: '一个中途的回答' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('原目标');
    expect(h.userMessages.some((m) => m.updated === true)).toBe(false);
  });

  it('applyClarificationAnswer is a no-op when the answer equals the current objective (keep-as-is)', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: '想想', turnsUsed: 0 }));
    await h.controller.applyClarificationAnswer('s1', { q: '想想' }, [
      { options: [{ label: '想想' }, { label: '整理一下' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('想想');
    expect(h.userMessages.some((m) => m.updated === true)).toBe(false);
  });

  it('applyClarificationAnswer rewrites only ONCE per goal (a second ask on the first turn cannot overwrite)', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: '想想', turnsUsed: 0 }));
    await h.controller.applyClarificationAnswer('s1', { q1: '整理工作环境' }, [
      { options: [{ label: '想想' }, { label: '整理工作环境' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('整理工作环境');
    // 同一轮里模型又问了一个工作型问题 → 不得再覆盖目标(clarificationApplied 已封)
    await h.controller.applyClarificationAnswer('s1', { q2: '/some/dir' }, [
      { options: [{ label: '/some/dir' }, { label: '/other' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('整理工作环境');
    // setGoal 新建/编辑会重置闸门 → 可再次澄清
    await h.controller.setGoal({ sessionId: 's1', objective: '新目标' });
    await h.controller.applyClarificationAnswer('s1', { q: '具体化的新目标' }, [
      { options: [{ label: '新目标' }, { label: '具体化的新目标' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('具体化的新目标');
  });

  it('applyClarificationAnswer is a no-op for a non-active goal', async () => {
    await h.storage.set(seededGoal({ status: 'paused', objective: '原目标', turnsUsed: 0 }));
    await h.controller.applyClarificationAnswer('s1', { q: '新方向' }, [
      { options: [{ label: '原目标' }, { label: '新方向' }] },
    ]);
    expect((await h.storage.get('s1'))?.objective).toBe('原目标');
  });

  it('clearGoal removes the row and emits a null goal', async () => {
    await startGoal(h);
    await h.controller.clearGoal('s1');
    expect(await h.storage.get('s1')).toBeNull();
    expect(h.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
  });

  it('clearGoal interrupts the in-flight goal turn before removing the goal', async () => {
    const stopActiveGoalTurn = vi.fn();
    const local = makeController({ stopActiveGoalTurn });
    await startGoal(local);

    await local.controller.clearGoal('s1');

    expect(stopActiveGoalTurn).toHaveBeenCalledOnce();
    expect(stopActiveGoalTurn).toHaveBeenCalledWith('s1');
    expect(await local.storage.get('s1')).toBeNull();
    expect(local.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
  });

  it('clearGoal interrupts a goal turn after vendor dispatch starts but before send resolves', async () => {
    const stopActiveGoalTurn = vi.fn();
    const local = makeController({ stopActiveGoalTurn });
    let releaseSend!: () => void;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      opts?.onDispatching?.();
      await sendPending;
      return { accepted: true };
    });

    const setPromise = startGoal(local);
    await vi.waitFor(() => expect(local.session.sends).toHaveLength(1));
    await local.controller.clearGoal('s1');

    expect(stopActiveGoalTurn).toHaveBeenCalledOnce();
    releaseSend();
    await setPromise;
    expect(await local.storage.get('s1')).toBeNull();
  });

  it('clearGoal cancels a goal send waiting before vendor dispatch', async () => {
    const stopActiveGoalTurn = vi.fn();
    const local = makeController({ stopActiveGoalTurn });
    let releasePreDispatchGate!: () => void;
    const preDispatchGate = new Promise<void>((resolve) => {
      releasePreDispatchGate = resolve;
    });
    let signal: AbortSignal | undefined;
    let vendorDispatches = 0;
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      signal = opts?.signal;
      await preDispatchGate;
      if (signal?.aborted) {
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
      opts?.onDispatching?.();
      vendorDispatches += 1;
      return { accepted: true };
    });

    const setPromise = startGoal(local);
    await vi.waitFor(() => expect(local.session.sends).toHaveLength(1));
    await local.controller.clearGoal('s1');
    releasePreDispatchGate();
    await setPromise;

    expect(signal?.aborted).toBe(true);
    expect(vendorDispatches).toBe(0);
    expect(stopActiveGoalTurn).not.toHaveBeenCalled();
    expect(await local.storage.get('s1')).toBeNull();
  });

  it('clearGoal does not interrupt a non-goal turn', async () => {
    const stopActiveGoalTurn = vi.fn();
    const local = makeController({ stopActiveGoalTurn });
    await local.storage.set(seededGoal());
    local.session.running = true;

    await local.controller.clearGoal('s1');

    expect(stopActiveGoalTurn).not.toHaveBeenCalled();
    expect(await local.storage.get('s1')).toBeNull();
  });

  it.each(['done', 'error'] as const)(
    'clearGoal does not interrupt a queued user turn after the goal %s terminal event',
    async (terminalEvent) => {
      const stopActiveGoalTurn = vi.fn();
      const local = makeController({ stopActiveGoalTurn });
      await startGoal(local);
      const active = await local.storage.get('s1');
      let releaseFinalizeGet!: (state: GoalState | null) => void;
      const blockedFinalizeGet = new Promise<GoalState | null>((resolve) => {
        releaseFinalizeGet = resolve;
      });
      vi.spyOn(local.storage, 'get').mockImplementationOnce(() => blockedFinalizeGet);

      // The input coordinator can start the queued user turn as soon as it observes this
      // terminal event, while GoalController's async persistence finalization is still pending.
      if (terminalEvent === 'done') {
        local.session.emitGoalTurn({
          toolUse: true,
          verdictJson: '```json\n{"goal_status":"continue","reason":"next"}\n```',
          origin: 'goal',
        });
      } else {
        local.session.emitErrorTurn({ message: 'goal turn failed' });
      }
      local.session.running = true;

      await local.controller.clearGoal('s1');

      expect(stopActiveGoalTurn).not.toHaveBeenCalled();
      expect(await local.storage.get('s1')).toBeNull();
      releaseFinalizeGet(active);
      await tick();
    },
  );

  it('does not re-mark a goal turn when its terminal event arrives before send resolves', async () => {
    const stopActiveGoalTurn = vi.fn();
    const local = makeController({ stopActiveGoalTurn });
    let releaseFinalizeGet!: (state: GoalState | null) => void;
    const blockedFinalizeGet = new Promise<GoalState | null>((resolve) => {
      releaseFinalizeGet = resolve;
    });
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      opts?.onDispatching?.();
      vi.spyOn(local.storage, 'get').mockImplementationOnce(() => blockedFinalizeGet);
      local.session.emitGoalTurn({
        toolUse: true,
        verdictJson: '```json\n{"goal_status":"continue","reason":"next"}\n```',
        origin: 'goal',
      });
      return { accepted: true };
    });

    await startGoal(local);
    const active = seededGoal({ objective: 'make tests pass' });
    local.session.running = true;

    await local.controller.clearGoal('s1');

    expect(stopActiveGoalTurn).not.toHaveBeenCalled();
    expect(await local.storage.get('s1')).toBeNull();
    releaseFinalizeGet(active);
    await tick();
  });

  it('does not cancel the send signal after the goal crosses the dispatch boundary', async () => {
    const local = makeController();
    let releaseSend!: () => void;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let signal: AbortSignal | undefined;
    vi.spyOn(local.session, 'send').mockImplementation(async (
      message: Parameters<FakeSession['send']>[0],
      opts: Parameters<FakeSession['send']>[1],
    ): Promise<SessionSendResult> => {
      const content = typeof message === 'string' ? message : message.content;
      local.session.sends.push({ content, originKind: opts?.origin?.kind });
      signal = opts?.signal;
      opts?.onDispatching?.();
      local.session.emitGoalTurn({
        toolUse: true,
        verdictJson: '```json\n{"goal_status":"complete","reason":"done"}\n```',
        origin: 'goal',
      });
      await sendPending;
      return signal?.aborted
        ? { accepted: false, reason: 'cancelled-before-dispatch' }
        : { accepted: true };
    });

    const setPromise = startGoal(local);
    await vi.waitFor(() => expect(local.completions).toHaveLength(1));

    expect(signal?.aborted).toBe(false);
    releaseSend();
    await setPromise;
    expect(await local.storage.get('s1')).toBeNull();
  });

  it('clearGoal still removes persisted state when stopping the goal turn throws', async () => {
    const local = makeController({
      stopActiveGoalTurn: () => {
        throw new Error('stop coordinator unavailable');
      },
    });
    await startGoal(local);

    await expect(local.controller.clearGoal('s1')).resolves.toBeUndefined();

    expect(await local.storage.get('s1')).toBeNull();
    expect(local.updates.at(-1)).toEqual({ sessionId: 's1', goal: null });
  });

  // ── updateGoal(纯代码改目标 / 上限,不写默认 override) ──
  it('updateGoal resumes a budgetLimited max-turns goal when the new maxTurns allows more turns', async () => {
    await h.storage.set(seededGoal({ status: 'budgetLimited', turnsUsed: 5, maxTurns: 5, lastReason: 'max turns reached' }));
    const updated = await h.controller.updateGoal('s1', { maxTurns: 6 });
    await tick();
    expect(updated?.status).toBe('active');
    expect((await h.storage.get('s1'))?.maxTurns).toBe(6);
    expect(h.session.sends).toHaveLength(1);
    expect(h.session.sends[0].content).toContain('[Goal] Continue working toward this goal');
    expect(h.persistedLimits).toHaveLength(0);
  });

  it('updateGoal resumes a budgetLimited token-budget goal when the new budget allows more tokens', async () => {
    await h.storage.set(seededGoal({ status: 'budgetLimited', tokensUsed: 1000, budgetTokens: 1000, lastReason: 'token budget reached' }));
    await h.controller.updateGoal('s1', { budgetTokens: 1200 });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.budgetTokens).toBe(1200);
    expect(h.session.sends).toHaveLength(1);
  });

  it('updateGoal keeps a budgetLimited goal stopped when only the objective changes and limits are still exceeded', async () => {
    await h.storage.set(seededGoal({
      status: 'budgetLimited',
      objective: 'old objective',
      turnsUsed: 5,
      maxTurns: 5,
      lastReason: 'max turns reached',
    }));
    await h.controller.updateGoal('s1', { objective: 'new objective' });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('new objective');
    expect(st?.status).toBe('budgetLimited');
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal changes active limits without firing an extra turn', async () => {
    await h.storage.set(seededGoal({ status: 'active', maxTurns: 5 }));
    await h.controller.updateGoal('s1', { maxTurns: 9, budgetTokens: null });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.maxTurns).toBe(9);
    expect(st?.budgetTokens).toBeNull();
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal transitions an active goal to budgetLimited (and stops it) when maxTurns is lowered below turnsUsed', async () => {
    // reviewer #354:把安全上限调到已被当前用量超过 → 立即停,不允许再多跑一轮。
    await h.storage.set(seededGoal({ status: 'active', maxTurns: 10, turnsUsed: 5 }));
    const sendsBefore = h.session.sends.length;
    const res = await h.controller.updateGoal('s1', { maxTurns: 3 });
    await tick();
    expect(res?.status).toBe('budgetLimited');
    expect((await h.storage.get('s1'))?.status).toBe('budgetLimited');
    expect(h.session.sends.length).toBe(sendsBefore); // 不触发新一轮
  });

  it('rechecks the latest counters before lowering an active maxTurns to budgetLimited', async () => {
    const local = makeController();
    await startGoal(local);
    const originalUpdate = local.storage.update.bind(local.storage);
    let markFinalizeWriteStarted!: () => void;
    const finalizeWriteStarted = new Promise<void>((resolve) => {
      markFinalizeWriteStarted = resolve;
    });
    let releaseFinalizeWrite!: () => void;
    const blockedFinalizeWrite = new Promise<void>((resolve) => {
      releaseFinalizeWrite = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementationOnce(async (sessionId, patch) => {
      markFinalizeWriteStarted();
      await blockedFinalizeWrite;
      return originalUpdate(sessionId, patch);
    });

    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"one turn used"}\n```',
      tokens: 25,
    });
    await finalizeWriteStarted;

    const limitUpdate = local.controller.updateGoal('s1', { maxTurns: 1 });
    await tick();
    expect((await local.storage.get('s1'))?.turnsUsed).toBe(0);

    releaseFinalizeWrite();
    await expect(limitUpdate).resolves.toMatchObject({
      status: 'budgetLimited',
      maxTurns: 1,
      turnsUsed: 1,
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'budgetLimited',
      maxTurns: 1,
      turnsUsed: 1,
    });
  });

  it('rechecks budget limits when a turn finalizes after the edit read but before its write', async () => {
    const local = makeController();
    await startGoal(local);
    const originalUpdate = local.storage.update.bind(local.storage);
    let updateCalls = 0;
    let markLimitWriteStarted!: () => void;
    const limitWriteStarted = new Promise<void>((resolve) => {
      markLimitWriteStarted = resolve;
    });
    let releaseLimitWrite!: () => void;
    const blockedLimitWrite = new Promise<void>((resolve) => {
      releaseLimitWrite = resolve;
    });
    vi.spyOn(local.storage, 'update').mockImplementation(async (sessionId, patch) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        markLimitWriteStarted();
        await blockedLimitWrite;
      }
      return originalUpdate(sessionId, patch);
    });

    const limitUpdate = local.controller.updateGoal('s1', { maxTurns: 1 });
    await limitWriteStarted;
    local.session.emitGoalTurn({
      toolUse: true,
      verdictJson: '```json\n{"goal_status":"continue","reason":"finished concurrently"}\n```',
      tokens: 25,
    });
    await vi.waitFor(async () => {
      expect((await local.storage.get('s1'))?.turnsUsed).toBe(1);
    });

    releaseLimitWrite();
    await expect(limitUpdate).resolves.toMatchObject({
      status: 'budgetLimited',
      maxTurns: 1,
      turnsUsed: 1,
    });
    expect(await local.storage.get('s1')).toMatchObject({
      status: 'budgetLimited',
      maxTurns: 1,
      turnsUsed: 1,
    });
  });

  it('updateGoal transitions to budgetLimited when budgetTokens is lowered below tokensUsed', async () => {
    await h.storage.set(seededGoal({ status: 'active', budgetTokens: 5000, tokensUsed: 3000 }));
    const res = await h.controller.updateGoal('s1', { budgetTokens: 1000 });
    expect(res?.status).toBe('budgetLimited');
  });

  it('updateGoal keeps the goal active when the lowered limit still exceeds current usage', async () => {
    await h.storage.set(seededGoal({ status: 'active', maxTurns: 20, turnsUsed: 5 }));
    const res = await h.controller.updateGoal('s1', { maxTurns: 10 });
    expect(res?.status).toBe('active');
  });

  it('fireTurn preflight stops at budgetLimited instead of sending when the goal is already over a lowered budget', async () => {
    // active 但 turnsUsed 已超 maxTurns(模拟限额被调小后调度链仍触达 fireTurn);经 setGoal 编辑路径
    // 触达 fireTurn —— preflight 预算守卫应拦下、不发轮(reviewer #354)。
    await h.storage.set(seededGoal({ status: 'active', maxTurns: 3, turnsUsed: 5 }));
    const sendsBefore = h.session.sends.length;
    await h.controller.setGoal({ sessionId: 's1', objective: '继续推进' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('budgetLimited');
    expect(h.session.sends.length).toBe(sendsBefore);
  });

  it('updateGoal updates objective and limits in the same patch without changing counters', async () => {
    await h.storage.set(seededGoal({ status: 'active', objective: 'old', turnsUsed: 4, tokensUsed: 700, startedAt: 333 }));
    await h.controller.updateGoal('s1', { objective: 'new combined objective', maxTurns: 12, budgetTokens: null });
    const st = await h.storage.get('s1');
    expect(st?.objective).toBe('new combined objective');
    expect(st?.maxTurns).toBe(12);
    expect(st?.budgetTokens).toBeNull();
    expect(st?.turnsUsed).toBe(4);
    expect(st?.tokensUsed).toBe(700);
    expect(st?.startedAt).toBe(333);
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal does not auto-resume usageLimited or blocked goals', async () => {
    await h.storage.set(seededGoal({ status: 'usageLimited', budgetTokens: 100, tokensUsed: 100, usageResetAt: 5000 }));
    await h.controller.updateGoal('s1', { budgetTokens: 200 });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
    expect(h.session.sends).toHaveLength(0);
    await h.storage.set(seededGoal({ status: 'blocked', maxTurns: 1, turnsUsed: 1 }));
    await h.controller.updateGoal('s1', { maxTurns: 3 });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('blocked');
    expect(h.session.sends).toHaveLength(0);
  });

  it('updateGoal rejects illegal values', async () => {
    await h.storage.set(seededGoal());
    await expect(h.controller.updateGoal('s1', { maxTurns: 0 })).rejects.toThrow('positive number');
    await expect(h.controller.updateGoal('s1', { budgetTokens: Number.NaN })).rejects.toThrow('positive number');
    await expect(h.controller.updateGoal('s1', { objective: '   ' })).rejects.toThrow('objective must not be empty');
    const internals = h.controller as unknown as { turns: Map<string, unknown> };
    expect(internals.turns.has('s1')).toBe(false);
  });

  it('updateGoal accepts null as no limit and can unblock budgetLimited', async () => {
    await h.storage.set(seededGoal({ status: 'budgetLimited', turnsUsed: 5, maxTurns: 5, tokensUsed: 1000, budgetTokens: 1000 }));
    await h.controller.updateGoal('s1', { maxTurns: null, budgetTokens: null });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.maxTurns).toBeNull();
    expect(st?.budgetTokens).toBeNull();
    expect(h.session.sends).toHaveLength(1);
  });

  // ── usageLimited(账号用量受限)──
  it('reactive: a usage-limit turn error → usageLimited with resetAt, no continuation', async () => {
    h.setAccountLimit({ limited: true, resetAtMs: 3_601_000 }); // 远未来 → 不在测试窗口自动续
    await startGoal(h);
    h.session.emitErrorTurn({ sdkError: 'rate_limit', message: 'rate limit reached' });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('usageLimited');
    expect(st?.usageResetAt).toBe(3_601_000);
    expect(h.session.sends).toHaveLength(1); // 无续轮
  });

  it('proactive: a would-be-continue turn flips to usageLimited when the account is limited', async () => {
    h.setAccountLimit({ limited: true, resetAtMs: 3_601_000 });
    await startGoal(h);
    h.session.emitGoalTurn({ toolUse: true, verdictJson: '```json\n{"goal_status":"continue","reason":"wip"}\n```' });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('usageLimited');
    expect(h.session.sends).toHaveLength(1); // 本应续跑,但被改判,不续
  });

  it('auto-resumes at resetAt: posts a usage-resumed notice and continues', async () => {
    h.setAccountLimit({ limited: true, resetAtMs: 1000 }); // == now → delay 0,tick 内触发
    await startGoal(h);
    h.session.emitErrorTurn({ sdkError: 'rate_limit' });
    await tick(); // usageLimited → schedule(delay 0) → autoResume → resumeGoal
    expect(h.notices).toEqual([{ sessionId: 's1', kind: 'usage-resumed' }]);
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.usageResetAt).toBeNull(); // resume 清掉
    expect(h.session.sends.length).toBeGreaterThanOrEqual(2); // 自动续了一轮
  });

  it('Stop cancels auto-resume while session hydration is pending without persisting a recovery notice', async () => {
    let ensureCalls = 0;
    let releaseEnsure!: (session: SessionLike | undefined) => void;
    const blockedEnsure = new Promise<SessionLike | undefined>((resolve) => {
      releaseEnsure = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => {
        ensureCalls += 1;
        return blockedEnsure;
      },
    });
    await local.storage.set(seededGoal({
      status: 'usageLimited',
      usageResetAt: 1_000,
      lastReason: 'usage limit reached',
    }));

    const autoResume = (
      local.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await vi.waitFor(() => expect(ensureCalls).toBe(1));
    await local.controller.pauseGoal('s1');
    releaseEnsure(liveSession);
    await autoResume;

    expect(local.notices).toEqual([]);
    expect(await local.storage.get('s1')).toMatchObject({ status: 'paused' });
    expect(local.updates.at(-1)?.goal?.status).toBe('paused');
    expect(liveSession.sends).toHaveLength(0);
  });

  it('Stop prevents resume and dispatch when recovery notice persistence is pending', async () => {
    let noticeCalls = 0;
    let releaseNotice!: () => void;
    const blockedNotice = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    const liveSession = new FakeSession('s1');
    const local = makeController({
      getSession: () => liveSession,
      ensureSession: async () => liveSession,
      persistGoalNotice: async () => {
        noticeCalls += 1;
        await blockedNotice;
      },
    });
    await local.storage.set(seededGoal({
      status: 'usageLimited',
      usageResetAt: 1_000,
      lastReason: 'usage limit reached',
    }));

    const autoResume = (
      local.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await vi.waitFor(() => expect(noticeCalls).toBe(1));
    await local.controller.pauseGoal('s1');
    releaseNotice();
    await autoResume;

    expect(await local.storage.get('s1')).toMatchObject({ status: 'paused' });
    expect(local.updates.at(-1)?.goal?.status).toBe('paused');
    expect(liveSession.sends).toHaveLength(0);
  });

  it('resumeGoal recovers a usageLimited goal (manual), preserving counts', async () => {
    h.setAccountLimit({ limited: true, resetAtMs: 3_601_000 });
    await startGoal(h);
    h.session.emitErrorTurn({ sdkError: 'rate_limit' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
    const before = h.session.sends.length;
    await h.controller.resumeGoal('s1');
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('active');
    expect(st?.usageResetAt).toBeNull();
    expect(h.session.sends.length).toBe(before + 1);
  });

  // ── 上游模型没容量(与账号限流分开)──
  //
  // 自动续跑的 timer 路径本身已由上面的 usageLimited 用例覆盖(同一条路径),
  // 这里只锁"过载能拿到可用的 resetAt"——它才是此前 529 停在原地等人手动 resume
  // 的根因。
  it('reactive: an upstream-capacity turn error → usageLimited with a short resume window', async () => {
    // 账号**没有**被限流：过载分支必须自己给出 resetAt，不能依赖账号快照。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await startGoal(h);
    h.session.emitErrorTurn({
      message: 'Selected model is at capacity. Please try a different model.',
    });
    await tick();
    const st = await h.storage.get('s1');
    // 关键：不是 blocked（Codex 的 at capacity 此前会被判真错）、也不是 resetAt=null。
    expect(st?.status).toBe('usageLimited');
    expect(st?.usageResetAt).toBe(1000 + 60_000); // now() + OVERLOAD_RESUME_DELAY_MS
    expect(st?.lastReason).toBe('model service at capacity');
    expect(h.session.sends).toHaveLength(1); // 不立即续轮
  });

  it('prefers the overload window over the account snapshot for a 529 turn error', async () => {
    // 529 同时命中限流判定。若先走限流分支，就会采用账号快照的 resetAt（这里是
    // 远未来），目标要等一小时才自动续——实际只需等一分钟。
    h.setAccountLimit({ limited: true, resetAtMs: 3_601_000 });
    await startGoal(h);
    h.session.emitErrorTurn({ message: 'Authorization: [REDACTED]', errorStatus: 529 });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.status).toBe('usageLimited');
    expect(st?.usageResetAt).toBe(1000 + 60_000);
    expect(st?.usageResetAt).not.toBe(3_601_000);
  });

  it('stops auto-resuming after consecutive overload turns, even with no budget limits set', async () => {
    // 生产默认就是 maxTurns=null / budgetTokens=null（见 goal-settings-store），而
    // 过载轮既不产出 token 也不推进 noProgressStreak——三道预算护栏一道都拦不住。
    // 没有专用计数器时，这里会每分钟自动续一轮直到天荒地老。
    const noLimits = makeController({
      getDefaults: () => ({ maxTurns: null, budgetTokens: null, noProgressLimit: null }),
    });
    try {
      noLimits.setAccountLimit({ limited: false, resetAtMs: null });
      await noLimits.controller.setGoal({
        sessionId: 's1',
        objective: 'keep going',
        agentKind: 'claude-code',
      });
      const st0 = await noLimits.storage.get('s1');
      expect(st0?.maxTurns).toBeNull();
      expect(st0?.budgetTokens).toBeNull();
      expect(st0?.noProgressLimit).toBeNull();

      const overload = { message: 'Selected model is at capacity. Please try a different model.' };
      // 每轮：过载 → usageLimited（排自动续跑）→ 手动走一次自动续跑路径 → 再过载。
      // resumeGoal({auto:true}) 是 autoResumeFromUsageLimit 实际走的调用，它**不得**
      // 清零计数，否则闸门永远不会触发。
      // 上限含义是「最多这么多个连续过载轮」：前 MAX-1 轮可恢复，第 MAX 轮就停。
      for (let i = 0; i < MAX_CONSECUTIVE_OVERLOAD_TURNS - 1; i += 1) {
        noLimits.session.emitErrorTurn(overload);
        await tick();
        expect((await noLimits.storage.get('s1'))?.status).toBe('usageLimited');
        await noLimits.controller.resumeGoal('s1', { auto: true });
        await tick();
      }
      // 第 MAX 次连续过载：不再当可恢复态，转 blocked 停止自动续跑。
      noLimits.session.emitErrorTurn(overload);
      await tick();
      const st = await noLimits.storage.get('s1');
      expect(st?.status).toBe('blocked');
      expect(st?.usageResetAt).toBeNull();
    } finally {
      noLimits.controller.dispose();
    }
  });

  it('a manual resume clears the consecutive overload streak', async () => {
    // 用户显式恢复 = 给一次干净的重来机会；否则被掐停的目标一恢复就立刻又撞上限。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await startGoal(h);
    const overload = { message: 'Selected model is at capacity.' };

    for (let i = 0; i < MAX_CONSECUTIVE_OVERLOAD_TURNS; i += 1) {
      h.session.emitErrorTurn(overload);
      await tick();
      await h.controller.resumeGoal('s1', { auto: true });
      await tick();
    }
    // 手动恢复（无 auto）→ 计数清零，下一次过载重新被当作可恢复态。
    h.session.emitErrorTurn(overload);
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('blocked');
    await h.controller.resumeGoal('s1');
    await tick();

    h.session.emitErrorTurn(overload);
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
  });

  it('announces capacity recovery, not a quota reset, after an overload backoff', async () => {
    // 过载与账号限流共用 usageLimited 状态和同一个自动续跑 timer。账号从没被限流
    // 时报「额度已重置」是假信息（review #844 codex P1）。
    // 直接驱动 autoResumeFromUsageLimit：它是 timer 回调本体，而过载的等待窗口是
    // 固定 60s、无法像限额那样用 resetAtMs 压到 0 来触发。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await startGoal(h);
    h.session.emitErrorTurn({ message: 'Selected model is at capacity.' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');

    await (
      h.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await tick();

    expect(h.notices).toEqual([{ sessionId: 's1', kind: 'capacity-resumed' }]);
    expect((await h.storage.get('s1'))?.status).toBe('active');
  });

  it('skips the resume notice when the goal budget is already exhausted', async () => {
    // resumeGoal → fireTurn 的 preflight 预算守卫会立刻把目标转成 budgetLimited、
    // 一轮都不发。先落卡片的话, 会话里永久留下一句根本没发生过的重试
    // (review #844 codex P1)。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await h.controller.setGoal({
      sessionId: 's1',
      objective: 'make tests pass',
      agentKind: 'claude-code',
      limits: { maxTurns: 1, budgetTokens: null, noProgressLimit: 3 },
    });
    h.session.emitErrorTurn({ message: 'Selected model is at capacity.' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
    // 这一轮已经把 maxTurns 用满。
    expect((await h.storage.get('s1'))?.turnsUsed).toBe(1);
    h.notices.length = 0;

    await (
      h.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await tick();

    // 一条提示都不该落库, 状态直接转成 budgetLimited。
    expect(h.notices).toEqual([]);
    expect((await h.storage.get('s1'))?.status).toBe('budgetLimited');
  });

  it('keeps the goal usageLimited when the session cannot be hydrated at resume time', async () => {
    // 第二种"这条重试根本没发生": 到点时会话已关闭 / hydrate 不出来。resumeGoal 忽略
    // ensureSession 的结果照样转 active, 而 fireTurn 拿不到 session 就直接 return ——
    // 既没有 listener 也没有续跑 timer, 目标停在 active 不动, 卡片却说"正在重试目标"
    // (review #844 codex P1)。要求: 不落卡片, 原样留在 usageLimited(可恢复态,
    // 存档的 usageResetAt 会在下次启动时被重排)。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await startGoal(h);
    h.session.emitErrorTurn({ message: 'Selected model is at capacity.' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
    const resetAtBefore = (await h.storage.get('s1'))?.usageResetAt ?? null;
    expect(resetAtBefore).not.toBeNull();
    h.notices.length = 0;

    // 到点了, 但此刻 hydrate 不出 live session。
    h.setHydratable(false);
    await (
      h.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await tick();

    expect(h.notices).toEqual([]);
    const after = await h.storage.get('s1');
    expect(after?.status).toBe('usageLimited');
    // 可恢复:重排 timer 靠的就是它。
    expect(after?.usageResetAt).toBe(resetAtBefore);

    // 会话回来之后再到点 → 照常落卡片续跑。
    h.setHydratable(true);
    await (
      h.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await tick();
    expect(h.notices).toEqual([{ sessionId: 's1', kind: 'capacity-resumed' }]);
    expect((await h.storage.get('s1'))?.status).toBe('active');
  });

  it('finalizes an exhausted budget even when the session cannot be hydrated', async () => {
    // 预算耗尽的目标不需要 live session 就能收口: fireTurn 的预算 preflight 跑在
    // ensureSession 之前, 会转成 budgetLimited(终态)并 stopSession。把 no-live-session
    // 守卫排在它前面, 这种目标会停在 usageLimited + 已过期的 usageResetAt, 直到手动 resume
    // 或进程重启才收口(review #844 codex P1)。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await h.controller.setGoal({
      sessionId: 's1',
      objective: 'make tests pass',
      agentKind: 'claude-code',
      limits: { maxTurns: 1, budgetTokens: null, noProgressLimit: 3 },
    });
    h.session.emitErrorTurn({ message: 'Selected model is at capacity.' });
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
    expect((await h.storage.get('s1'))?.turnsUsed).toBe(1); // 这一轮已把 maxTurns 用满
    h.notices.length = 0;

    // 到点了, 而且此刻 hydrate 不出 live session。
    h.setHydratable(false);
    await (
      h.controller as unknown as { autoResumeFromUsageLimit(id: string): Promise<void> }
    ).autoResumeFromUsageLimit('s1');
    await tick();

    // 一条卡片都不落(那次重试确实没发生), 但状态必须收口成终态。
    expect(h.notices).toEqual([]);
    expect((await h.storage.get('s1'))?.status).toBe('budgetLimited');
  });

  it('setGoal gives a replacement objective its own overload budget', async () => {
    // 连续过载计数是 per-goal 状态。换目标不清零的话，上一个目标撞上限变 blocked
    // 后，新目标第一次容量错误就直接 blocked、拿不到自己的重试预算（review #844 P1）。
    h.setAccountLimit({ limited: false, resetAtMs: null });
    await startGoal(h);
    const overload = { message: 'Selected model is at capacity.' };

    for (let i = 0; i < MAX_CONSECUTIVE_OVERLOAD_TURNS; i += 1) {
      h.session.emitErrorTurn(overload);
      await tick();
      await h.controller.resumeGoal('s1', { auto: true });
      await tick();
    }
    h.session.emitErrorTurn(overload);
    await tick();
    expect((await h.storage.get('s1'))?.status).toBe('blocked');

    // 换一个新目标（setGoal 的替换既有目标路径）。
    await h.controller.setGoal({ sessionId: 's1', objective: 'a fresh goal', agentKind: 'claude-code' });
    await tick();
    h.session.emitErrorTurn(overload);
    await tick();
    // 新目标应拿到完整预算 → 仍是可恢复的 usageLimited，不是 blocked。
    expect((await h.storage.get('s1'))?.status).toBe('usageLimited');
  });

  it('still treats a real account rate limit as a usage limit', async () => {
    // 回归防线：过载判定不得把真限额抢走，否则限额会被缩成一分钟反复重撞。
    h.setAccountLimit({ limited: true, resetAtMs: 3_601_000 });
    await startGoal(h);
    h.session.emitErrorTurn({ sdkError: 'rate_limit', message: 'rate limit reached' });
    await tick();
    const st = await h.storage.get('s1');
    expect(st?.usageResetAt).toBe(3_601_000);
    expect(st?.lastReason).toBe('usage limit reached');
  });

});
