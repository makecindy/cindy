import { describe, expect, it, vi } from 'vitest';

import {
  USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS,
  USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS,
  createUsageLimitFallbackEpisode,
  createUsageLimitFallbackRevert,
  usageLimitFallbackRevertBackoffMs,
  type UsageLimitFallbackRevertDeps,
} from '../maker-ipc/usageLimitFallbackRevert.js';
import type { SessionRuntimeProfile } from '../maker-ipc/sessionRuntimeControl.js';
import type { SessionUsageLimitFallback } from '../maker-ipc/sessionUsageLimitFallback.js';
import type { SessionUsageLimitFallbackEpisode } from '../maker-host/session-usage-limit-fallback-store.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

const source: SessionRuntimeProfile = {
  agentKind: 'codex',
  model: 'gpt-6.1-sol',
  providerId: 'openai',
  effort: 'medium',
  fastMode: false,
  agentDeviceId: null,
};

/** 降级后的组合：换来源与模型，Harness 不变。 */
const targetRoute = { providerId: 'xd', model: 'deepseek-v4-flash' };
const onTarget: SessionRuntimeProfile = {
  ...source,
  providerId: targetRoute.providerId,
  model: targetRoute.model,
};

const policy: SessionUsageLimitFallback = { source, target: targetRoute };

function episode(overrides: Partial<SessionUsageLimitFallbackEpisode> = {}): SessionUsageLimitFallbackEpisode {
  return {
    failedAtMs: T0,
    knownResetAtMs: null,
    targetRoute,
    attempts: 0,
    // 默认「已到期」：单测通过 now 控制时间门。
    nextEligibleAtMs: T0,
    ...overrides,
  };
}

function harness(options: {
  episodes?: Array<{ sessionId: string; policy: SessionUsageLimitFallback; episode: SessionUsageLimitFallbackEpisode }>;
  effective?: SessionRuntimeProfile;
  hasPendingSelection?: boolean;
  profilesMissing?: boolean;
  turnRunning?: boolean;
  hasRecovery?: boolean;
  eligible?: boolean;
  offMachine?: boolean;
  grouped?: boolean;
  knownLimited?: boolean;
  applyResult?: Partial<{ deferred: boolean; superseded: boolean; contextWindowConfirmationRequired: number }>;
  throwOnApply?: boolean;
} = {}) {
  const state = {
    now: T0,
    episodes: new Map(
      (options.episodes ?? [{ sessionId: 's1', policy, episode: episode() }]).map((entry) => [
        entry.sessionId,
        entry,
      ]),
    ),
    effective: options.effective ?? { ...onTarget },
    pending: options.hasPendingSelection ?? false,
    turnRunning: options.turnRunning ?? false,
    hasRecovery: options.hasRecovery ?? false,
    /** 测试用：标记“中途被换了 episode”，避免重入。 */
    replaced: false,
    eligible: options.eligible ?? true,
  };
  const applySourceSelection = vi.fn(async (input: {
    sessionId: string;
    from: SessionRuntimeProfile;
    source: SessionRuntimeProfile;
    generation: number;
  }) => {
    if (options.throwOnApply) throw new Error('switch failed');
    const applied = { deferred: false, superseded: false, ...options.applyResult };
    // 只有真正切成功，任务才离开降级组合；deferred / 需要确认 / superseded 都还停在原地。
    if (
      !applied.deferred &&
      !applied.superseded &&
      applied.contextWindowConfirmationRequired === undefined
    ) {
      state.effective = { ...input.source };
    }
    return applied;
  });
  const writeEpisode = vi.fn(async (sessionId: string, next: SessionUsageLimitFallbackEpisode | null) => {
    const entry = state.episodes.get(sessionId);
    if (!next) {
      state.episodes.delete(sessionId);
      return;
    }
    if (entry) state.episodes.set(sessionId, { ...entry, episode: next });
  });
  const claimAttempt = vi.fn(
    async (
      sessionId: string,
      expected: { failedAtMs: number; attempts: number },
      next: SessionUsageLimitFallbackEpisode,
    ) => {
      const entry = state.episodes.get(sessionId);
      // 与真实 store 一样做比较-写入：期间被清掉/改过就不认领。
      if (
        !entry ||
        entry.episode.failedAtMs !== expected.failedAtMs ||
        entry.episode.attempts !== expected.attempts
      ) {
        return false;
      }
      state.episodes.set(sessionId, { ...entry, episode: next });
      return true;
    },
  );
  /** 与真实 store 同语义：只有 episode 仍是那一份才删。 */
  const clearEpisode = vi.fn(
    async (sessionId: string, expected: { failedAtMs: number; attempts: number }) => {
      const entry = state.episodes.get(sessionId);
      if (
        !entry ||
        entry.episode.failedAtMs !== expected.failedAtMs ||
        entry.episode.attempts !== expected.attempts
      ) {
        return false;
      }
      state.episodes.delete(sessionId);
      return true;
    },
  );
  const notifyReverted = vi.fn();
  const deps: UsageLimitFallbackRevertDeps = {
    readEpisodes: () => [...state.episodes.values()],
    readProfiles: async (sessionId) => {
      if (options.profilesMissing) return null;
      return sessionId === 's1'
        ? { effective: state.effective, generation: 3, hasPendingSelection: state.pending }
        : null;
    },
    isEligible: async () => state.eligible,
    runsOffThisMachine: async () => options.offMachine ?? false,
    isBoundToProviderGroup: () => options.grouped ?? false,
    isTurnRunning: () => state.turnRunning,
    hasUsageLimitRecovery: () => state.hasRecovery,
    canApplySelection: () => true,
    withSessionLock: (_sessionId, task) => task(),
    applySourceSelection,
    isSourceKnownLimited: async () => options.knownLimited ?? false,
    writeEpisode,
    clearEpisode,
    claimAttempt,
    notifyReverted,
    now: () => state.now,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return {
    deps,
    applySourceSelection,
    writeEpisode,
    clearEpisode,
    claimAttempt,
    notifyReverted,
    state,
  };
}

describe('usage-limit fallback revert (episode accounting)', () => {
  it('没有 episode 的任务永远不切（降级没发生 / 用户已选过模型）', async () => {
    const { deps, applySourceSelection } = harness({ episodes: [] });
    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(result).toEqual({ episodes: 0, due: 0, reverted: 0, failed: 0, exhausted: 0 });
  });

  it('没到已知重置时刻就不切', async () => {
    const { deps, applySourceSelection } = harness({
      episodes: [
        {
          sessionId: 's1',
          policy,
          episode: episode({ knownResetAtMs: T0 + 60 * MIN, nextEligibleAtMs: T0 }),
        },
      ],
    });
    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(result.due).toBe(0);
  });

  it('没到退避时刻就不切', async () => {
    const { deps, applySourceSelection } = harness({
      episodes: [
        {
          sessionId: 's1',
          policy,
          episode: episode({ knownResetAtMs: T0 - 1, nextEligibleAtMs: T0 + 5 * MIN }),
        },
      ],
    });
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('到期且切成功 → 用 policy.source 的完整组合切回，并清掉 episode', async () => {
    const { deps, applySourceSelection, clearEpisode, notifyReverted } = harness({
      episodes: [
        {
          sessionId: 's1',
          policy,
          episode: episode({ knownResetAtMs: T0 - 1, nextEligibleAtMs: T0 }),
        },
      ],
    });
    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).toHaveBeenCalledWith({
      sessionId: 's1',
      from: expect.objectContaining({ providerId: targetRoute.providerId, model: targetRoute.model }),
      source: policy.source,
      generation: 3,
    });
    // 收尾用 CAS 清（只有仍是自己那一份才删），不是无条件 write(null)。
    expect(clearEpisode).toHaveBeenCalledWith('s1', expect.objectContaining({ attempts: 1 }));
    // 会话提示只在真的换成功时发一次，带的就是这次换掉的两个模型。
    expect(notifyReverted).toHaveBeenCalledTimes(1);
    expect(notifyReverted).toHaveBeenCalledWith({
      sessionId: 's1',
      fromModel: targetRoute.model,
      toModel: source.model,
      at: T0,
    });
    expect(result.reverted).toBe(1);
  });

  it('没切成 / 没轮到它的时候不发会话提示', async () => {
    const deferred = harness({ applyResult: { deferred: true } });
    await createUsageLimitFallbackRevert(deferred.deps).sweep();
    expect(deferred.notifyReverted).not.toHaveBeenCalled();

    const notDue = harness({
      episodes: [
        {
          sessionId: 's1',
          policy,
          episode: episode({ knownResetAtMs: T0 + 60 * MIN, nextEligibleAtMs: T0 }),
        },
      ],
    });
    await createUsageLimitFallbackRevert(notDue.deps).sweep();
    expect(notDue.notifyReverted).not.toHaveBeenCalled();
  });

  it('失败后 attempts 递增、退避翻倍，用完预算就清 episode 不再试', async () => {
    const { deps, applySourceSelection, state } = harness({
      applyResult: { deferred: true },
    });
    const revert = createUsageLimitFallbackRevert(deps);

    for (let attempt = 1; attempt <= USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS; attempt += 1) {
      const entry = [...state.episodes.values()][0];
      if (!entry) break;
      const before = entry.episode.attempts;
      // 每次到点再扫。
      state.now = Math.max(state.now, entry.episode.nextEligibleAtMs);
      await revert.sweep();
      if (attempt < USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS) {
        const next = [...state.episodes.values()][0]?.episode;
        expect(next?.attempts).toBe(before + 1);
        expect(next?.nextEligibleAtMs).toBe(
          state.now + USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS * 2 ** before,
        );
      }
    }

    expect(state.episodes.size).toBe(0);
    // 预算用完后即便再扫也不会动手。
    state.now += 24 * 60 * MIN;
    await revert.sweep();
    expect(applySourceSelection).toHaveBeenCalledTimes(USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS);
  });

  it('退避公式：第 n 次尝试后等 base * 2^(n-1)', () => {
    expect(usageLimitFallbackRevertBackoffMs(1)).toBe(USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS);
    expect(usageLimitFallbackRevertBackoffMs(2)).toBe(USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS * 2);
    expect(usageLimitFallbackRevertBackoffMs(3)).toBe(USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS * 4);
  });

  it('episode 初始时间门：有重置时刻取它（至少 1 分钟），没有则 30 分钟宽限', () => {
    const withReset = createUsageLimitFallbackEpisode({
      now: T0,
      knownResetAtMs: T0 + 10 * MIN,
      targetRoute,
    });
    expect(withReset.nextEligibleAtMs).toBe(T0 + 10 * MIN);

    const resetAlreadyPast = createUsageLimitFallbackEpisode({
      now: T0,
      knownResetAtMs: T0 - MIN,
      targetRoute,
    });
    expect(resetAlreadyPast.nextEligibleAtMs).toBe(T0 + MIN);

    const noReset = createUsageLimitFallbackEpisode({ now: T0, knownResetAtMs: null, targetRoute });
    expect(noReset.nextEligibleAtMs).toBe(T0 + 30 * MIN);
    expect(noReset.attempts).toBe(0);
    expect(noReset.failedAtMs).toBe(T0);
  });

  it('共享 / 暂停 / 远程 / SSH（isEligible=false）时不切', async () => {
    const { deps, applySourceSelection } = harness({ eligible: false });
    await createUsageLimitFallbackRevert(deps).sweep();
    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('Agent 在别的电脑运行（含 SSH 远程）时不切', async () => {
    const { deps, applySourceSelection } = harness({ offMachine: true });
    await createUsageLimitFallbackRevert(deps).sweep();
    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('归供应商组的任务不切', async () => {
    const { deps, applySourceSelection } = harness({ grouped: true });
    await createUsageLimitFallbackRevert(deps).sweep();
    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('待生效选模存在时不切', async () => {
    const { deps, applySourceSelection } = harness({ hasPendingSelection: true });
    await createUsageLimitFallbackRevert(deps).sweep();
    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('锁内发现刚挂上额度恢复 → 不切，也不消耗一次尝试', async () => {
    const { deps, applySourceSelection, state, claimAttempt } = harness();
    deps.withSessionLock = async (_sessionId, task) => {
      state.hasRecovery = true; // 判定之后、进锁之前挂上了等待
      return task();
    };
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(claimAttempt).not.toHaveBeenCalled();
    expect([...state.episodes.values()][0]?.episode.attempts).toBe(0);
  });

  it('扫到一半用户选了同一个模型（episode 被清）→ 不切，也不把 episode 复活', async () => {
    const { deps, applySourceSelection, state } = harness();
    deps.withSessionLock = async (_sessionId, task) => {
      // 模拟用户在锁外选了模型：SET_MODEL 先清 episode，随后才轮到这里。
      state.episodes.delete('s1');
      return task();
    };
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(state.episodes.size).toBe(0);
  });

  it('锁内发现任务刚开始共享（isEligible 变 false）→ 不切', async () => {
    const { deps, applySourceSelection, state } = harness();
    deps.withSessionLock = async (_sessionId, task) => {
      state.eligible = false; // 判定之后、进锁之前任务被共享/暂停
      return task();
    };
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect([...state.episodes.values()][0]?.episode.attempts).toBe(0);
  });

  it('仍在限额里（快照否定条件）不白试，也不消耗尝试', async () => {
    const { deps, applySourceSelection, clearEpisode } = harness({ knownLimited: true });
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(clearEpisode).not.toHaveBeenCalled();
  });

  it('已经不在降级组合上（用户换走过）→ 清 episode、不切', async () => {
    const { deps, applySourceSelection, state, clearEpisode } = harness({
      effective: { ...source, model: 'glm-4.6', providerId: 'zhipu' },
    });
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    // 清是 CAS 的：只删读到的那一份。
    expect(clearEpisode).toHaveBeenCalledWith('s1', expect.objectContaining({ attempts: 0 }));
    expect(state.episodes.size).toBe(0);
  });

  it('任务已不存在 → 清 episode', async () => {
    const { deps, applySourceSelection, state } = harness({ profilesMissing: true });
    await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).not.toHaveBeenCalled();
    expect(state.episodes.size).toBe(0);
  });

  it('需要弹上下文窗口确认也算失败（自动动作不替用户跳过确认）', async () => {
    const { deps, applySourceSelection, state } = harness({
      applyResult: { contextWindowConfirmationRequired: 200_000 },
    });
    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(applySourceSelection).toHaveBeenCalledTimes(1);
    expect(result.reverted).toBe(0);
    expect(result.failed).toBe(1);
    expect([...state.episodes.values()][0]?.episode.attempts).toBe(1);
  });

  it('单个任务抛错只记警告，不影响整轮', async () => {
    const { deps } = harness({ throwOnApply: true });
    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(result.reverted).toBe(0);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('同一时刻只跑一轮扫描', async () => {
    const { deps, applySourceSelection } = harness();
    const revert = createUsageLimitFallbackRevert(deps);

    const [a, b] = await Promise.all([revert.sweep(), revert.sweep()]);
    expect(applySourceSelection).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('抛错也要计入次数：到上限就清 episode，不会无限重试', async () => {
    const { deps, state } = harness({ throwOnApply: true });
    const revert = createUsageLimitFallbackRevert(deps);

    let exhausted = 0;
    for (let i = 0; i < 6; i += 1) {
      state.now += 3 * 60 * 60 * 1000;
      const result = await revert.sweep();
      exhausted += result.exhausted;
    }

    // 第 5 次失败就收口；第 6 轮已经没有 episode 可扫。
    expect(exhausted).toBe(1);
    expect(state.episodes.size).toBe(0);
  });

  it('回切收尾不会抹掉期间新写进来的 episode', async () => {
    const { deps, state } = harness();
    const original = deps.applySourceSelection;
    deps.applySourceSelection = async (input) => {
      // 模拟：切回的同时又降级了一次，写下了新的 episode。
      const entry = state.episodes.get(input.sessionId)!;
      state.episodes.set(input.sessionId, {
        sessionId: input.sessionId,
        policy: entry.policy,
        episode: { ...entry.episode, failedAtMs: entry.episode.failedAtMs + 1, attempts: 0 },
      });
      return original(input);
    };

    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(result.reverted).toBe(1);
    // 旧回切只能用 CAS 清自己那一份，新 episode 必须活下来。
    const survivor = [...state.episodes.values()][0];
    expect(survivor?.episode.attempts).toBe(0);
    expect(survivor?.episode.failedAtMs).toBeGreaterThan(survivor!.episode.knownResetAtMs ?? 0);
  });

  it('认领成功但落盘期间挂上了额度恢复，就不再选模', async () => {
    const { deps, state, applySourceSelection } = harness();
    const baseClaim = deps.claimAttempt;
    deps.claimAttempt = async (sessionId, expected, next) => {
      const claimed = await baseClaim(sessionId, expected, next);
      // 模拟：认领落盘的同时，这一轮撞上额度并挂上了恢复。
      state.hasRecovery = true;
      return claimed;
    };

    const result = await createUsageLimitFallbackRevert(deps).sweep();

    expect(result.reverted).toBe(0);
    expect(applySourceSelection).not.toHaveBeenCalled();
  });

  it('“已不在降级组合上”的收尾也不抹掉期间新写的 episode', async () => {
    const { deps, state, clearEpisode } = harness();
    const original = deps.readProfiles;
    deps.readProfiles = async (sessionId) => {
      const profiles = await original(sessionId);
      // 模拟：读 profile 的时候用户手选回源、紧接着又降级一次写下新 episode。
      const entry = state.episodes.get(sessionId);
      if (entry && !state.replaced) {
        state.replaced = true;
        state.episodes.set(sessionId, {
          sessionId,
          policy: entry.policy,
          episode: { ...entry.episode, failedAtMs: entry.episode.failedAtMs + 1, attempts: 0 },
        });
        state.effective = { ...state.effective, providerId: 'openai', model: 'gpt-6.1-sol' };
      }
      return profiles;
    };

    await createUsageLimitFallbackRevert(deps).sweep();

    // 我们的清是 CAS：读到的旧 episode 已不匹配，新 episode 必须活下来。
    expect(clearEpisode).toHaveBeenCalledWith('s1', expect.objectContaining({ attempts: 0 }));
    expect([...state.episodes.values()][0]?.episode.attempts).toBe(0);
    expect(state.episodes.size).toBe(1);
  });
});
