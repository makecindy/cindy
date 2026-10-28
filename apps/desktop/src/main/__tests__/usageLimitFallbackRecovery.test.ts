import { describe, expect, it, vi } from 'vitest';

import {
  createUsageLimitFallbackRecovery,
  type UsageLimitFallbackRecoveryDeps,
} from '../maker-ipc/usageLimitFallbackRecovery.js';
import type { SessionRuntimeProfile } from '../maker-ipc/sessionRuntimeControl.js';
import type { SessionUsageLimitFallback } from '../maker-ipc/sessionUsageLimitFallback.js';

const source: SessionRuntimeProfile = {
  agentKind: 'codex',
  model: 'gpt-6.1-sol',
  providerId: 'openai',
  effort: 'medium',
  fastMode: false,
  agentDeviceId: null,
};

const policy: SessionUsageLimitFallback = {
  source,
  target: { providerId: 'xd', model: 'deepseek-v4-flash' },
};

/** 一条结构化的账号额度耗尽错误（Codex tag，不必靠文案猜）。 */
const quotaSignals = {
  codexErrorInfo: 'usageLimitExceeded',
  message: "You've hit your usage limit.",
};

type AutoRetryOutcome = 'resumed' | 'superseded' | 'no-progress';

/**
 * 按协调器真实语义模拟三件独立的东西：
 * - `recovery`：这一次错误的恢复入口，会话关闭后仍在（lease 的实体）
 * - `wait`：候选/等待登记，`resumeAt: null` 表示“只是候选”，会话关闭时会被清掉
 * - `error`：错误是否仍当前；用户接手会把它清掉
 */
function harness(options: {
  continueOutcome?: AutoRetryOutcome;
  closeOnSwitch?: boolean;
  overrides?: Partial<UsageLimitFallbackRecoveryDeps>;
} = {}) {
  const recovery = { id: 'recovery-1' };
  let error: string | null = 'quota';
  let wait: { token: number; resumeAt: number | null } | null = { token: 7, resumeAt: null };
  let nextToken = 100;
  const state = { effective: { ...source } as SessionRuntimeProfile, generation: 3 };
  const armResetWait = vi.fn((...args: unknown[]) => {
    void args;
    // 真实的 usageLimitAutoResume 只在候选仍有效时挂得上定时器。
    if (!wait || error === null) return;
  });
  const continueAfterReset = vi.fn(
    async (_sessionId: string, _token: number, _info: unknown): Promise<AutoRetryOutcome> =>
      options.continueOutcome ?? 'resumed',
  );

  const deps: UsageLimitFallbackRecoveryDeps = {
    readPolicy: () => policy,
    isEligible: async () => true,
    runsOffThisMachine: async () => false,
    isBoundToProviderGroup: async () => false,
    readProfiles: async () => ({ effective: state.effective, generation: state.generation }),
    canApplySelection: () => true,
    withSessionLock: async (_sessionId, task) => task(),
    applySelection: async ({ target }) => {
      state.effective = { ...state.effective, providerId: target.providerId, model: target.model };
      // 换路可能以 runtime-refresh 关闭旧会话：等待被撤销，recovery 保留。
      if (options.closeOnSwitch) wait = null;
      return { deferred: false, superseded: false };
    },
    lease: (_sessionId, token) => (wait?.token === token && error !== null ? recovery : null),
    isLeaseCurrent: (_sessionId, lease) => lease === recovery && error !== null,
    rearm: (_sessionId, lease, resumeAt) => {
      if (lease !== recovery || error === null) return null;
      wait = { token: ++nextToken, resumeAt };
      return wait.token;
    },
    continueAfterReset,
    armResetWait,
    now: () => 1_000,
    log: { info: vi.fn(), warn: vi.fn() },
    ...options.overrides,
  };

  return {
    deps,
    state,
    recovery: createUsageLimitFallbackRecovery(deps),
    continueAfterReset,
    armResetWait,
    /** 用户在这条错误上接手（发新消息 / 点重试 / 收下错误）。 */
    takeOver: () => {
      error = null;
      wait = null;
    },
    currentWait: () => wait,
  };
}

describe('usage-limit fallback recovery', () => {
  it('switches the route and resumes while the error is still only a candidate', async () => {
    const h = harness();
    await expect(
      h.recovery.recover({ sessionId: 's1', signals: quotaSignals, policy, token: 7 }),
    ).resolves.toEqual({ resumed: true, token: expect.any(Number) });
    expect(h.state.effective.model).toBe('deepseek-v4-flash');
    expect(h.continueAfterReset).toHaveBeenCalledTimes(1);
    const info = h.continueAfterReset.mock.calls[0]![2] as {
      reason: string;
      agentSwitch: { from: string; to: string; kind: string; cause: string };
    };
    // 与额度重置后的自动继续同一条活动行，用 kind 区分“换模型”与“换电脑”。
    expect(info.reason).toBe('usage-limit-reset');
    expect(info.agentSwitch).toEqual({
      from: 'gpt-6.1-sol',
      to: 'deepseek-v4-flash',
      cause: 'usage-limit',
      kind: 'model',
    });
    expect(h.armResetWait).not.toHaveBeenCalled();
  });

  it('keeps the resume working when the route switch closes the session', async () => {
    const h = harness({ closeOnSwitch: true });
    const result = await h.recovery.recover({
      sessionId: 's1',
      signals: quotaSignals,
      policy,
      token: 7,
    });
    // 等待被关闭清掉了，但 recovery 还在：必须能 rearm 出新令牌再续跑。
    expect(result.resumed).toBe(true);
    expect(h.continueAfterReset).toHaveBeenCalledTimes(1);
    expect(h.currentWait()?.resumeAt).toBe(1_000);
  });

  it('gives the reset wait a token that is still valid after a failed resume', async () => {
    const h = harness({ continueOutcome: 'superseded' });
    const result = await h.recovery.recover({
      sessionId: 's1',
      signals: quotaSignals,
      policy,
      token: 7,
    });
    expect(result.resumed).toBe(false);
    // 退回候选后的令牌才是 onTurnError 能用的那张，不能拿旧令牌。
    expect(result.token).toBe(h.currentWait()?.token);
    expect(h.currentWait()?.resumeAt).toBeNull();
  });

  it('hands a failed attempt back to reset waiting without destroying the candidate', async () => {
    const h = harness({ continueOutcome: 'superseded' });
    h.recovery.handBack('s1', quotaSignals, 7);
    await vi.waitFor(() => expect(h.armResetWait).toHaveBeenCalledTimes(1));
    const token = h.armResetWait.mock.calls[0]![2] as number;
    expect(h.currentWait()?.token).toBe(token);
    expect(h.currentWait()).not.toBeNull();
  });

  it('falls back to reset waiting when no policy is configured', () => {
    const h = harness({ overrides: { readPolicy: () => null } });
    h.recovery.handBack('s1', quotaSignals, 7);
    expect(h.armResetWait).toHaveBeenCalledWith('s1', quotaSignals, 7);
  });

  it('does not fire on transient rate limits, auth failures or group-verified quota', async () => {
    const h = harness();
    for (const signals of [
      { usageLimit: true, message: 'rate limit reached, too many requests' },
      { ...quotaSignals, sdkError: 'billing_error' },
      { ...quotaSignals, providerGroupUsageLimit: { resetAtMs: 1 } },
    ]) {
      await expect(
        h.recovery.recover({ sessionId: 's1', signals, policy, token: 7 }),
      ).resolves.toMatchObject({ resumed: false });
    }
    expect(h.continueAfterReset).not.toHaveBeenCalled();
    expect(h.state.effective.model).toBe('gpt-6.1-sol');
  });

  it('never switches for tasks that must keep waiting', async () => {
    for (const overrides of [
      { isEligible: async () => false },
      { runsOffThisMachine: async () => true },
      { isBoundToProviderGroup: async () => true },
      { canApplySelection: () => false },
      { applySelection: async () => ({ deferred: true, superseded: false }) },
    ] satisfies Array<Partial<UsageLimitFallbackRecoveryDeps>>) {
      const h = harness({ overrides });
      await expect(
        h.recovery.recover({ sessionId: 's1', signals: quotaSignals, policy, token: 7 }),
      ).resolves.toMatchObject({ resumed: false });
      expect(h.continueAfterReset).not.toHaveBeenCalled();
    }
  });

  it('drops the attempt when the user takes over during an await', async () => {
    const h = harness();
    const taken = h.takeOver;
    const baseEligible = h.deps.isEligible;
    h.deps.isEligible = async (sessionId) => {
      const eligible = await baseEligible(sessionId);
      taken();
      return eligible;
    };
    await expect(
      h.recovery.recover({ sessionId: 's1', signals: quotaSignals, policy, token: 7 }),
    ).resolves.toMatchObject({ resumed: false });
    expect(h.continueAfterReset).not.toHaveBeenCalled();
    expect(h.state.effective.model).toBe('gpt-6.1-sol');
  });
});
