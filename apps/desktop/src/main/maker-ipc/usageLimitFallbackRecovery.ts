import {
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  type AutoResumeInfo,
} from '../../shared/agentInputQueue.js';
import type { AutoRetryOutcome } from './agent-input-coordinator.js';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import {
  isConfirmedUsageLimit,
  matchesUsageLimitFallbackSource,
  usageLimitFallbackLabels,
  type SessionUsageLimitFallback,
  type UsageLimitFallbackRoute,
} from './sessionUsageLimitFallback.js';

export interface UsageLimitFallbackSelectionResult {
  deferred: boolean;
  superseded: boolean;
  contextWindowConfirmationRequired?: number;
  contextTokensForConfirmation?: number;
}

export interface UsageLimitFallbackRecoveryDeps {
  readPolicy(sessionId: string): SessionUsageLimitFallback | null;
  /** 还能走额度自动继续的任务（伙伴、Worker、共享、暂停、目标模式都不行）。 */
  isEligible(sessionId: string): Promise<boolean>;
  /** 远程 Agent 与 SSH 远程会话不吃本策略。 */
  runsOffThisMachine(sessionId: string): Promise<boolean>;
  /** 归供应商组的任务先换电脑；组内全失败也不换模型，仍等额度重置。 */
  isBoundToProviderGroup(sessionId: string): boolean | Promise<boolean>;
  readProfiles(sessionId: string): Promise<{
    effective: SessionRuntimeProfile;
    generation: number;
  } | null>;
  canApplySelection(sessionId: string, generation: number): boolean;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  applySelection(input: {
    sessionId: string;
    from: SessionRuntimeProfile;
    target: UsageLimitFallbackRoute;
    generation: number;
  }): Promise<UsageLimitFallbackSelectionResult>;
  /** 这次错误仍归本次恢复时返回不透明句柄；候选状态（未排期）也算有效。 */
  lease(sessionId: string, token: number): object | null;
  isLeaseCurrent(sessionId: string, lease: object): boolean;
  /** `resumeAt` 为 null 表示退回候选状态（立刻到点前/交回等重置前都用它）。 */
  rearm(sessionId: string, lease: object, resumeAt: number | null): number | null;
  continueAfterReset(sessionId: string, token: number, info: AutoResumeInfo): Promise<AutoRetryOutcome>;
  /** 交回既有的「等额度重置」流程。 */
  armResetWait(sessionId: string, signals: InterruptedTurnErrorSignals, token: number): void;
  now(): number;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface UsageLimitFallbackRecovery {
  /**
   * 所有额度错误路径的汇合点：配了任务级备用路线就先试换路续跑，没成就交回等额度重置。
   * 两条恢复路只能中一条。
   */
  handBack(sessionId: string, signals: InterruptedTurnErrorSignals, token: number): void;
  /**
   * 单独暴露给测试：`token` 返回交回等重置时应该用的候选令牌
   * （重新挂过等待后令牌会变，拿旧令牌排期会被判为已接手）。
   */
  recover(params: {
    sessionId: string;
    signals: InterruptedTurnErrorSignals;
    policy: SessionUsageLimitFallback;
    token: number;
  }): Promise<{ resumed: boolean; token: number }>;
}

/**
 * 任务级额度备用（docs/product-rules/usage-limit-auto-continue.md § 额度用尽换模型）。
 *
 * 关键顺序：先按候选令牌 `lease` 下这次错误 → 换路 → `rearm` 出立即到点的等待 → 续跑。
 * 换路可能以 `runtime-refresh` 关闭旧会话并撤销额度等待，所以租用必须发生在换路之前；
 * 判据也必须是 `lease`（候选状态认），不能用 `isUsageLimitWaitCurrent`（那要求已经排期到点）。
 */
export function createUsageLimitFallbackRecovery(
  deps: UsageLimitFallbackRecoveryDeps,
): UsageLimitFallbackRecovery {
  async function recover(params: {
    sessionId: string;
    signals: InterruptedTurnErrorSignals;
    policy: SessionUsageLimitFallback;
    token: number;
  }): Promise<{ resumed: boolean; token: number }> {
    const { sessionId, signals, policy, token } = params;
    const stop = { resumed: false, token };
    if (!isConfirmedUsageLimit(signals)) return stop;
    // 组核验额度的失败按组自己的恢复走。
    if (signals.providerGroupUsageLimit) return stop;
    // 候选判据：这条错误仍是当前那一条（没被用户接手、没有新 turn）。
    const lease = deps.lease(sessionId, token);
    if (!lease) return stop;
    if (!deps.isLeaseCurrent(sessionId, lease)) return stop;
    if (!await deps.isEligible(sessionId)) return stop;
    if (await deps.runsOffThisMachine(sessionId)) return stop;
    if (await deps.isBoundToProviderGroup(sessionId)) return stop;
    // await 期间用户可能发消息、点重试或换模型：再核一次才继续。
    if (!deps.isLeaseCurrent(sessionId, lease)) return stop;
    const profiles = await deps.readProfiles(sessionId);
    if (!profiles || !matchesUsageLimitFallbackSource(policy, profiles.effective)) return stop;
    if (!deps.canApplySelection(sessionId, profiles.generation)) return stop;
    let resumeToken: number | null = null;
    try {
      const switched = await deps.withSessionLock(sessionId, async () => {
        if (!deps.canApplySelection(sessionId, profiles.generation)) return false;
        if (!deps.isLeaseCurrent(sessionId, lease)) return false;
        const result = await deps.applySelection({
          sessionId,
          from: profiles.effective,
          target: policy.target,
          generation: profiles.generation,
        });
        return (
          !result.superseded &&
          !result.deferred &&
          result.contextWindowConfirmationRequired === undefined &&
          result.contextTokensForConfirmation === undefined
        );
      });
      if (!switched) return stop;
      // 换路已完成：立刻到点续跑一次（有产出发续跑指令、零产出重发原文）。
      resumeToken = deps.rearm(sessionId, lease, deps.now());
      if (resumeToken === null) return stop;
      const labels = usageLimitFallbackLabels(policy);
      const outcome = await deps.continueAfterReset(sessionId, resumeToken, {
        reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
        agentSwitch: { from: labels.from, to: labels.to, cause: 'usage-limit', kind: 'model' },
        attempt: 1,
        maxAttempts: 1,
        sessionTotal: 0,
        ...(signals.message !== undefined ? { error: signals.message } : {}),
      });
      deps.log.info('usage-limit fallback resumed', {
        sessionId,
        outcome,
        fromModel: labels.from,
        toModel: labels.to,
      });
      if (outcome === 'resumed') return { resumed: true, token: resumeToken };
      // 到点了却没续跑成：把等待退回候选，并交出仍然有效的那张令牌。
      const backToken = deps.rearm(sessionId, lease, null);
      return { resumed: false, token: backToken ?? resumeToken };
    } catch (error: unknown) {
      // 换路可能在关闭旧会话之后才抛（重新挂接/终态校验失败）：那时等待已被关闭清掉，
      // 只剩租约还能把它拉回来。不抢回来就会变成“没续跑也没等待”。
      deps.log.warn('usage-limit fallback interrupted', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      const backToken = deps.rearm(sessionId, lease, null);
      return { resumed: false, token: backToken ?? resumeToken ?? token };
    }
  }

  function handBack(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
  ): void {
    const policy = signals.providerGroupUsageLimit ? null : deps.readPolicy(sessionId);
    if (!policy) {
      deps.armResetWait(sessionId, signals, token);
      return;
    }
    void recover({ sessionId, signals, policy, token })
      .catch((error: unknown) => {
        deps.log.warn('usage-limit fallback failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { resumed: false, token };
      })
      .then((result) => {
        if (result.resumed) return;
        // 放弃时不能 cancel：候选令牌是 onTurnError 排期用的入口，清掉就再也挂不上等待。
        deps.armResetWait(sessionId, signals, result.token);
      });
  }

  return { handBack, recover };
}
