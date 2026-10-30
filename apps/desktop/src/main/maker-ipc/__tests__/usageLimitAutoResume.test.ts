import { describe, expect, it, vi } from 'vitest';

import {
  USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES,
  USAGE_LIMIT_RESUME_BUFFER_MS,
  UsageLimitAutoResume,
  isAccountUsageLimitError,
  type UsageLimitAutoResumeDeps,
} from '../usageLimitAutoResume';
import { USAGE_LIMIT_RESET_AUTO_RESUME_REASON } from '../../../shared/agentInputQueue';

const NOW = 1_000_000;
const RESET_AT = NOW + 60 * 60 * 1000;
const LIMIT = { sdkError: 'rate_limit', message: "You've hit your session limit" };

function harness(overrides: Partial<UsageLimitAutoResumeDeps> = {}) {
  const timers: Array<{ fn: () => void; delayMs: number; cleared: boolean }> = [];
  let tokenSeq = 0;
  const current = new Set<number>();
  // coordinator 在终态错误时下发候选令牌;测试里每次 onTurnError 用新令牌。
  const nextCandidate = () => ++tokenSeq;
  const deps: UsageLimitAutoResumeDeps = {
    now: () => NOW,
    random: () => 0,
    setTimer: (fn, delayMs) => {
      const timer = { fn, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    isEligible: vi.fn(async () => true),
    resolveResetAt: vi.fn(async () => RESET_AT),
    arm: vi.fn((_sessionId: string, token: number) => {
      current.add(token);
      return true;
    }),
    isCurrent: (_sessionId, token) => current.has(token),
    cancel: vi.fn((_sessionId: string, token: number) => {
      current.delete(token);
    }),
    continueSession: vi.fn(async () => 'resumed' as const),
    log: () => {},
    ...overrides,
  };
  const raw = new UsageLimitAutoResume(deps);
  // 测试里省掉候选令牌参数:每次报错自动取一个新令牌。
  const guard = Object.assign(raw, {
    onTurnError: (sessionId: string, signals: Parameters<UsageLimitAutoResume['onTurnError']>[1]) =>
      UsageLimitAutoResume.prototype.onTurnError.call(raw, sessionId, signals, nextCandidate()),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fireLast = async () => {
    const timer = timers.at(-1)!;
    expect(timer.cleared).toBe(false);
    timer.fn();
    await flush();
  };
  return { guard, deps, timers, current, flush, fireLast };
}

describe('isAccountUsageLimitError', () => {
  it('accepts account limits and rejects overload or unrelated errors', () => {
    expect(isAccountUsageLimitError(LIMIT)).toBe(true);
    expect(isAccountUsageLimitError({ codexErrorInfo: 'usageLimitExceeded', message: 'x' })).toBe(true);
    expect(isAccountUsageLimitError({ errorStatus: 529, message: 'overloaded_error' })).toBe(false);
    expect(isAccountUsageLimitError({ sdkError: 'billing_error', message: 'credit balance too low' })).toBe(false);
    expect(isAccountUsageLimitError({ sdkError: 'billing_error', message: 'quota exceeded' })).toBe(false);
    expect(isAccountUsageLimitError({ errorStatus: 429, message: 'insufficient_quota' })).toBe(false);
    expect(isAccountUsageLimitError({ message: 'Connection closed mid-response' })).toBe(false);
  });
});

describe('UsageLimitAutoResume', () => {
  it('restores the saved deadline and attempt budget; overdue startup waits buffer once', async () => {
    const h = harness();
    expect(h.guard.restore('restarted', 42, RESET_AT, 2)).toBe(true);
    expect(h.timers.at(-1)?.delayMs).toBe(RESET_AT - NOW);
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledWith('restarted', 42, expect.objectContaining({ attempt: 3 }));
    expect(h.guard.restore('overdue', 43, NOW - 1, 0)).toBe(true);
    expect(h.timers.at(-1)?.delayMs).toBe(USAGE_LIMIT_RESUME_BUFFER_MS);
    h.guard.suspend();
    expect(h.timers.at(-1)?.cleared).toBe(true);
    expect(h.guard.restore('capped', 44, RESET_AT, 3)).toBe(false);
  });

  it('does not arm a timer when persistence fails or cancellation wins the save', async () => {
    const failed = harness({ saveWait: async () => { throw new Error('disk full'); } });
    await failed.guard.onTurnError('s1', LIMIT);
    expect(failed.timers).toHaveLength(0);
    expect(failed.deps.cancel).toHaveBeenCalledWith('s1', 1);
    let release!: (saved: boolean) => void;
    const h = harness({ saveWait: () => new Promise(resolve => { release = resolve; }) });
    const scheduling = h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    h.current.clear(); h.guard.noteUserAction('s1'); release(true);
    await scheduling;
    expect(h.timers).toHaveLength(0);
  });

  it('waits for scheduler capacity without consuming quota retries or spinning on restored quota', async () => {
    let available = false;
    const h = harness({ continueSession: vi.fn(async () => available ? 'resumed' : 'capacity-wait') });
    h.guard.onTurnError('scheduled', LIMIT);
    await h.flush();
    await h.guard.resumeRestored(async () => true);
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
    expect(h.timers.at(-1)?.delayMs).toBe(USAGE_LIMIT_RESUME_BUFFER_MS);
    for (let index = 0; index < USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES; index++) await h.fireLast();
    available = true;
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenLastCalledWith('scheduled', 1, expect.objectContaining({ attempt: 1 }));
    expect(h.deps.cancel).not.toHaveBeenCalled();
  });

  it('reports unarmed waits so their scheduler run can settle', async () => {
    const h = harness({ resolveResetAt: async () => null });
    await expect(UsageLimitAutoResume.prototype.onTurnError.call(h.guard, 'scheduled', LIMIT, 42)).resolves.toBe(false);
    expect(h.deps.cancel).toHaveBeenCalledWith('scheduled', 42);
    expect(h.timers).toHaveLength(0);
  });

  // Unit regression: a failed disk write while capacity is full must not leave a dead countdown.
  it('cancels the wait if persisting a capacity deferral fails', async () => {
    const saveWait = vi.fn(async () => true);
    const h = harness({ saveWait, continueSession: vi.fn(async () => 'capacity-wait' as const) });
    await h.guard.onTurnError('scheduled', LIMIT);
    saveWait.mockRejectedValueOnce(new Error('disk full'));
    await h.fireLast();
    expect(h.deps.cancel).toHaveBeenCalledWith('scheduled', 1);
    expect(h.timers).toHaveLength(1);
    expect(h.current.size).toBe(0);
  });
  // Unit regression: a pending group switch can still have the previous local route saved.
  // Resetting that local account must not wake the group's wait or consume its retry budget.
  it('keeps a group quota wait until its timer even when the old account resets', async () => {
    const h = harness();
    h.guard.onTurnError('group', { usageLimit: true, providerGroupUsageLimit: { resetAtMs: RESET_AT } });
    await h.flush();
    const matches = vi.fn(async () => true);
    await h.guard.resumeRestored(matches);
    expect(matches).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it('resumes only matching armed waits after a reset and respects user cancellation', async () => {
    const h = harness();
    h.guard.onTurnError('matching', LIMIT); h.guard.onTurnError('other', LIMIT);
    await h.flush();
    await h.guard.resumeRestored(async id => id === 'matching');
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.continueSession).mock.calls[0][0]).toBe('matching');
    h.current.clear();
    await h.guard.resumeRestored(async () => true);
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it('arms a wait after the reset plus buffer and continues the session when it fires', async () => {
    const h = harness();
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();

    expect(h.deps.arm).toHaveBeenCalledWith('s1', 1, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS - NOW);

    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 1, {
      reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
      attempt: 1,
      maxAttempts: USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES,
      sessionTotal: 0,
    });
  });

  it('does not wait without a usable reset time or for an ineligible session', async () => {
    const noReset = harness({ resolveResetAt: vi.fn(async () => null) });
    noReset.guard.onTurnError('s1', LIMIT);
    await noReset.flush();
    expect(noReset.deps.arm).not.toHaveBeenCalled();

    const tooFar = harness({ resolveResetAt: vi.fn(async () => NOW + 30 * 24 * 60 * 60 * 1000) });
    tooFar.guard.onTurnError('s1', LIMIT);
    await tooFar.flush();
    expect(tooFar.deps.arm).not.toHaveBeenCalled();

    const goal = harness({ isEligible: vi.fn(async () => false) });
    goal.guard.onTurnError('s1', LIMIT);
    await goal.flush();
    expect(goal.deps.resolveResetAt).not.toHaveBeenCalled();
    expect(goal.deps.arm).not.toHaveBeenCalled();

    const other = harness();
    other.guard.onTurnError('s1', { message: 'Connection closed mid-response' });
    await other.flush();
    expect(other.deps.isEligible).not.toHaveBeenCalled();
  });

  it('skips the continuation when the user already took over', async () => {
    const h = harness();
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    h.current.clear(); // coordinator 侧 recovery 已被用户动作替换
    await h.fireLast();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
  });

  it('re-checks eligibility when the timer fires (e.g. Goal started meanwhile)', async () => {
    const isEligible = vi.fn(async () => true);
    const h = harness({ isEligible });
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    isEligible.mockResolvedValue(false);
    await h.fireLast();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    // 放弃时撤掉横幅上的自动继续提示。
    expect(h.deps.cancel).toHaveBeenCalledWith('s1', 1);
  });

  it('withdraws the wait when the continuation does not start', async () => {
    for (const continueSession of [
      vi.fn(async () => 'no-progress' as const),
      vi.fn(async () => {
        throw new Error('db read failed');
      }),
    ]) {
      const h = harness({ continueSession });
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      await h.fireLast();
      expect(h.deps.cancel).toHaveBeenCalledWith('s1', 1);
    }
    const ok = harness();
    ok.guard.onTurnError('s1', LIMIT);
    await ok.flush();
    await ok.fireLast();
    expect(ok.deps.cancel).not.toHaveBeenCalled();
  });

  it('stops after the consecutive cap until progress or a human action resets it', async () => {
    const h = harness();
    for (let i = 0; i < USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES; i += 1) {
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      await h.fireLast();
    }
    expect(h.deps.continueSession).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES);

    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES);

    h.guard.noteProgress('s1');
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES + 1);
  });

  it('drops a stale resolution when a newer error arrives, and clears timers on user action', async () => {
    let release!: (value: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const resolveResetAt = vi
      .fn<UsageLimitAutoResumeDeps['resolveResetAt']>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(RESET_AT);
    const h = harness({ resolveResetAt });
    h.guard.onTurnError('s1', LIMIT);
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    release(RESET_AT + 999);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(1);
    expect(h.deps.arm).toHaveBeenCalledWith('s1', 2, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);

    h.guard.noteUserAction('s1');
    expect(h.timers.at(-1)!.cleared).toBe(true);
  });

  it('drops an in-flight resolution once the user takes over or the task closes', async () => {
    for (const interrupt of ['noteUserAction', 'noteSessionClosed'] as const) {
      let release!: (value: number) => void;
      const pending = new Promise<number>((resolve) => { release = resolve; });
      const h = harness({ resolveResetAt: vi.fn(() => pending) });
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      h.guard[interrupt]('s1');
      release(RESET_AT);
      await h.flush();
      expect(h.deps.arm).not.toHaveBeenCalled();
    }
  });
});
