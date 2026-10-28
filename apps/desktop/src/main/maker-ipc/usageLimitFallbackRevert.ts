import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import type { SessionUsageLimitFallback } from './sessionUsageLimitFallback.js';
import type { SessionUsageLimitFallbackEpisode } from '../maker-host/session-usage-limit-fallback-store.js';

/** 回切尝试的退避基数：第 n 次尝试后等 base * 2^(n-1)。 */
export const USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS = 2 * 60_000;
/** 自动回切最多尝试几次；用完就清 episode（策略保留）。 */
export const USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS = 5;
/** 那一次错误没有可信重置时刻时，降级后至少等这么久再试回切。 */
export const USAGE_LIMIT_FALLBACK_REVERT_NO_RESET_GRACE_MS = 30 * 60_000;
/** 有重置时刻时也至少等一下，避免刚降级完立刻切来切去。 */
const MIN_INITIAL_DELAY_MS = 60_000;

/**
 * 一次「降级并成功续跑」的记账。回切只认它，不认「effective 是否等于 target」——
 * 后者分不清「降级后停在这里」和「用户自己就要这个模型」。
 */
export function createUsageLimitFallbackEpisode(input: {
  now: number;
  knownResetAtMs: number | null;
  targetRoute: { providerId: string; model: string };
}): SessionUsageLimitFallbackEpisode {
  const { now, knownResetAtMs, targetRoute } = input;
  return {
    failedAtMs: now,
    knownResetAtMs,
    targetRoute: { providerId: targetRoute.providerId, model: targetRoute.model },
    attempts: 0,
    nextEligibleAtMs: knownResetAtMs === null
      // 没有可信时刻：保守的宽限期，从降级成功那一刻算起。
      ? now + USAGE_LIMIT_FALLBACK_REVERT_NO_RESET_GRACE_MS
      // 有重置时刻：不早于它，也不早于降级后 1 分钟。
      : Math.max(knownResetAtMs, now + MIN_INITIAL_DELAY_MS),
  };
}

/** 第 `attempts` 次尝试之后的退避间隔。 */
export function usageLimitFallbackRevertBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return USAGE_LIMIT_FALLBACK_REVERT_BASE_INTERVAL_MS * 2 ** exponent;
}

export interface UsageLimitFallbackRevertSelectionResult {
  deferred: boolean;
  superseded: boolean;
  contextWindowConfirmationRequired?: number;
  contextTokensForConfirmation?: number;
}

export interface UsageLimitFallbackRevertDeps {
  /** 同时有策略和 episode 的任务（store 只读快照，sweep 自己配对）。 */
  readEpisodes(): Array<{
    sessionId: string;
    policy: SessionUsageLimitFallback;
    episode: SessionUsageLimitFallbackEpisode;
  }>;
  readProfiles(sessionId: string): Promise<{
    effective: SessionRuntimeProfile;
    generation: number;
    /** 已登记、等下一轮生效的选模；有它时不动。 */
    hasPendingSelection: boolean;
  } | null>;
  /** 与额度自动继续同一套适用范围（伙伴 / Worker / 共享 / 暂停 / 目标模式）。 */
  isEligible(sessionId: string): Promise<boolean>;
  /** 远程 Agent 与 SSH 远程会话：本机证明不了那条路线。 */
  runsOffThisMachine(sessionId: string): Promise<boolean>;
  /** 归供应商组的任务由组负责换电脑/换回。 */
  isBoundToProviderGroup(sessionId: string): boolean;
  isTurnRunning(sessionId: string): boolean;
  /** 协调器里是否还挂着一个额度恢复（含 arm 了但没落盘的）。 */
  hasUsageLimitRecovery(sessionId: string): boolean;
  canApplySelection(sessionId: string, generation: number): boolean;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  applySourceSelection(input: {
    sessionId: string;
    from: SessionRuntimeProfile;
    source: SessionRuntimeProfile;
    generation: number;
  }): Promise<UsageLimitFallbackRevertSelectionResult>;
  /**
   * 仅作**否定**条件：快照明确显示原路线仍受限时不动。
   * 绝不能用快照证明「已恢复」——旧快照过了重置点会报 limited:false。
   */
  isSourceKnownLimited(policy: SessionUsageLimitFallback): Promise<boolean>;
  writeEpisode(sessionId: string, episode: SessionUsageLimitFallbackEpisode | null): Promise<void>;
  /**
   * 原子地清掉 episode：只有它仍是 `expected` 那个才删，返回是否删成。
   * 回切收尾必须用它——无条件删会抹掉期间新写进来的 episode。
   */
  clearEpisode(
    sessionId: string,
    expected: { failedAtMs: number; attempts: number },
  ): Promise<boolean>;
  /**
   * 原子认领一次尝试：只有 episode 仍是 `expected` 那个才写 `next`，返回是否写成。
   * 期间被清掉（用户选了模型）或被改写时必须返回 false，调用方据此放弃这次回切。
   */
  claimAttempt(
    sessionId: string,
    expected: { failedAtMs: number; attempts: number },
    next: SessionUsageLimitFallbackEpisode,
  ): Promise<boolean>;
  now(): number;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface UsageLimitFallbackRevertSweepResult {
  /** 读到的 episode 数。 */
  episodes: number;
  /** 时间门已到期、进入判定的 episode 数。 */
  due: number;
  /** 真正切回原路线的任务数。 */
  reverted: number;
  /** 尝试了但没切成（失败/被跳过）的次数。 */
  failed: number;
  /** 预算用完、episode 已清的次数。 */
  exhausted: number;
}

export interface UsageLimitFallbackRevert {
  /** 幂等：同一时刻只有一次扫描在跑。 */
  sweep(): Promise<UsageLimitFallbackRevertSweepResult>;
}

/**
 * 额度恢复后自动切回原路线（usage-limit-auto-continue.md § 回切）。
 *
 * 判定只看 episode 与时间：降级成功续跑写了 episode 才开始记账；用户任何显式选模都会
 * 清掉 episode，所以「用户自己选的模型」永远不会被自动改回去。没有任何快照能证明
 * 「原账号已恢复」，所以回切靠时间（重置时刻 + 退避），不靠 `limited:false`。
 */
export function createUsageLimitFallbackRevert(
  deps: UsageLimitFallbackRevertDeps,
): UsageLimitFallbackRevert {
  let inFlight: Promise<UsageLimitFallbackRevertSweepResult> | null = null;

  function isOnFallbackTarget(
    policy: SessionUsageLimitFallback,
    episode: SessionUsageLimitFallbackEpisode,
    effective: SessionRuntimeProfile,
  ): boolean {
    return (
      effective.agentKind === policy.source.agentKind &&
      effective.providerId === episode.targetRoute.providerId &&
      effective.model === episode.targetRoute.model
    );
  }

  /** 时间门：到了已知重置时刻（若有）并且过了退避。 */
  function isDue(episode: SessionUsageLimitFallbackEpisode, now: number): boolean {
    if (now < episode.nextEligibleAtMs) return false;
    return episode.knownResetAtMs === null || now >= episode.knownResetAtMs;
  }

  async function attempt(input: {
    sessionId: string;
    policy: SessionUsageLimitFallback;
    episode: SessionUsageLimitFallbackEpisode;
  }): Promise<'reverted' | 'failed' | 'exhausted' | 'skipped'> {
    const { sessionId, policy, episode } = input;
    const profiles = await deps.readProfiles(sessionId);
    if (!profiles) {
      // 任务没了：episode 留着也没人消费。
      await deps.writeEpisode(sessionId, null);
      return 'skipped';
    }
    if (profiles.hasPendingSelection) return 'skipped';
    if (!isOnFallbackTarget(policy, episode, profiles.effective)) {
      // 已经不在降级组合上（用户换走/换回）——这条 episode 不再适用。
      await deps.writeEpisode(sessionId, null);
      return 'skipped';
    }
    if (!deps.canApplySelection(sessionId, profiles.generation)) return 'skipped';
    // 否定条件：能确定原路线仍在限额里就不白试一次。
    if (await deps.isSourceKnownLimited(policy)) return 'skipped';

    const outcome = await deps.withSessionLock(sessionId, async () => {
      // 锁内复核一整套：拿到锁之前用户可能发了消息、换了模型、开始了共享、或者
      // 刚挂上一个额度恢复。这里再做一次，才敢动路线。
      if (deps.isTurnRunning(sessionId) || deps.hasUsageLimitRecovery(sessionId)) {
        return 'skipped' as const;
      }
      if (await deps.runsOffThisMachine(sessionId)) return 'skipped' as const;
      if (deps.isBoundToProviderGroup(sessionId)) return 'skipped' as const;
      if (!await deps.isEligible(sessionId)) return 'skipped' as const;
      const fresh = await deps.readProfiles(sessionId);
      if (!fresh || fresh.hasPendingSelection) return 'skipped' as const;
      // 组合或 generation 变了（用户换过 / Agent 换过 / 新 turn 落了别的路线）→ 作废。
      if (fresh.generation !== profiles.generation) return 'skipped' as const;
      if (!isOnFallbackTarget(policy, episode, fresh.effective)) {
        await deps.writeEpisode(sessionId, null);
        return 'skipped' as const;
      }
      if (!deps.canApplySelection(sessionId, profiles.generation)) return 'skipped' as const;
      const attempts = episode.attempts + 1;
      const nextEligibleAtMs = deps.now() + usageLimitFallbackRevertBackoffMs(attempts);
      // 先原子记账再动手：切到一半崩了也不能无限重试；期间被用户清掉则放弃。
      const claimed = await deps.claimAttempt(
        sessionId,
        { failedAtMs: episode.failedAtMs, attempts: episode.attempts },
        { ...episode, attempts, nextEligibleAtMs },
      );
      if (!claimed) return 'skipped' as const;
      // claim 是 await：这期间可能新起一轮 turn，或刚挂上一个额度恢复。
      // 那两件事都会让这次换路变成“吞掉恢复”，所以动路线前再核一次。
      if (deps.isTurnRunning(sessionId) || deps.hasUsageLimitRecovery(sessionId)) {
        return 'skipped' as const;
      }
      let applied: UsageLimitFallbackRevertSelectionResult;
      try {
        applied = await deps.applySourceSelection({
          sessionId,
          from: fresh.effective,
          source: policy.source,
          generation: profiles.generation,
        });
      } catch (error: unknown) {
        // 抛错也走“失败”这一条：否则会绕过下面的次数与上限逻辑，episode 永远不清。
        deps.log.warn('usage-limit fallback revert apply threw', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'failed' as const;
      }
      const switched =
        !applied.superseded &&
        !applied.deferred &&
        applied.contextWindowConfirmationRequired === undefined &&
        applied.contextTokensForConfirmation === undefined;
      return switched ? ('reverted' as const) : ('failed' as const);
    });

    const claimedState = { failedAtMs: episode.failedAtMs, attempts: episode.attempts + 1 };
    if (outcome === 'reverted') {
      // CAS 清：期间若又写了新 episode（例如刚又降级一次），不能把它抹掉。
      await deps.clearEpisode(sessionId, claimedState);
      deps.log.info('usage-limit fallback reverted', {
        sessionId,
        fromProviderId: episode.targetRoute.providerId,
        fromModel: episode.targetRoute.model,
        toProviderId: policy.source.providerId,
        toModel: policy.source.model,
        attempts: episode.attempts + 1,
      });
      return 'reverted';
    }
    if (outcome === 'failed') {
      const attempts = episode.attempts + 1;
      if (attempts >= USAGE_LIMIT_FALLBACK_REVERT_MAX_ATTEMPTS) {
        await deps.clearEpisode(sessionId, claimedState);
        deps.log.info('usage-limit fallback revert gave up', { sessionId, attempts });
        return 'exhausted';
      }
    }
    return outcome;
  }

  async function runSweep(): Promise<UsageLimitFallbackRevertSweepResult> {
    const entries = deps.readEpisodes();
    const result: UsageLimitFallbackRevertSweepResult = {
      episodes: entries.length,
      due: 0,
      reverted: 0,
      failed: 0,
      exhausted: 0,
    };
    for (const { sessionId, policy, episode } of entries) {
      try {
        const now = deps.now();
        if (!isDue(episode, now)) continue;
        result.due += 1;
        // 便宜的进程内状态先挡；下面每个 await 之后都还有一次锁内复核。
        if (deps.isTurnRunning(sessionId)) continue;
        if (deps.hasUsageLimitRecovery(sessionId)) continue;
        if (await deps.runsOffThisMachine(sessionId)) continue;
        if (deps.isBoundToProviderGroup(sessionId)) continue;
        if (!await deps.isEligible(sessionId)) continue;
        // await 期间可能进了新 turn 或挂上了恢复：进锁前再挡一次，少排一次无用锁。
        if (deps.isTurnRunning(sessionId) || deps.hasUsageLimitRecovery(sessionId)) continue;
        const outcome = await attempt({ sessionId, policy, episode });
        if (outcome === 'reverted') result.reverted += 1;
        else if (outcome === 'failed') result.failed += 1;
        else if (outcome === 'exhausted') result.exhausted += 1;
      } catch (error: unknown) {
        result.failed += 1;
        deps.log.warn('usage-limit fallback revert failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async function sweep(): Promise<UsageLimitFallbackRevertSweepResult> {
    if (inFlight) return inFlight;
    inFlight = runSweep();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return { sweep };
}
