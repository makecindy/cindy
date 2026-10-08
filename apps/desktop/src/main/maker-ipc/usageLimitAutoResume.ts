/**
 * 普通任务的账号限额自动继续 —— 撞上 5 小时 / 周限额后照常报错，同时等额度重置；
 * 到点用户仍没处理，就自动继续这个任务。
 *
 * 分工：
 *  - coordinator 持有用户可见状态（错误 + `usageLimitWait`），并以「同一个 recovery 仍在」
 *    作为「用户没接手」的唯一判据（`armUsageLimitWait` / `continueAfterUsageLimitReset`）。
 *  - 本模块只做判定、求重置时刻和定时；所有用户动作（发消息、重试、收下错误、取消、清空）
 *    都由 coordinator 自然作废等待，这里到点复核即可，不需要逐个入口撤销。
 *
 * 产品约束（2026-10-07）：
 *  - 只在本次运行内有效，不落盘；重启后停在报错，交给用户。
 *  - 拿不到可靠重置时刻（Coding Plan、API key、网关个人额度等）就不等，也不定时试探。
 *  - 同一任务连续自动继续而没有任何实质产出达到上限后停下，防止重置时刻算早时反复撞限额。
 */

import type { AutoResumeInfo } from '../../shared/agentInputQueue.js';
import { USAGE_LIMIT_RESET_AUTO_RESUME_REASON } from '../../shared/agentInputQueue.js';
import { classifyTurnOverload, classifyTurnUsageLimit } from '../goal-host/usageLimit.js';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';

/** 重置后再等一会儿：上游各窗口的重置有秒级偏差，过早会再撞一次。 */
export const USAGE_LIMIT_RESUME_BUFFER_MS = 60_000;
/** 同一账号的多个任务会在同一刻醒来，错开一点避免同时涌入。 */
export const USAGE_LIMIT_RESUME_JITTER_MS = 30_000;
/** 超过这个等待时长不排（周限额最长 7 天；更远的时刻多半是解析错误）。 */
export const USAGE_LIMIT_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;
/** 两次实质产出之间最多自动继续几次。 */
export const USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES = 3;

export type UsageLimitContinueOutcome = 'resumed' | 'superseded' | 'no-progress';

export interface UsageLimitAutoResumeDeps {
  now(): number;
  random(): number;
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** 该会话是否交给本机制（排除目标模式、Orca worker、伙伴等由别的机制负责的会话）。 */
  isEligible(sessionId: string): Promise<boolean>;
  /** 会话所用账号的重置时刻（unix ms）：错误自带 → 报错原文 → 订阅快照；拿不到为 null。 */
  resolveResetAt(sessionId: string, signals: InterruptedTurnErrorSignals): Promise<number | null>;
  /** 用终态错误时 coordinator 下发的候选令牌挂上等待；false = 那次错误已不是当前状态。 */
  arm(sessionId: string, token: number, resumeAt: number): boolean;
  isCurrent(sessionId: string, token: number): boolean;
  /** 放弃这一次等待（到点时已不归本机制管），撤掉横幅上的自动继续提示。 */
  cancel(sessionId: string, token: number): void;
  continueSession(
    sessionId: string,
    token: number,
    info: AutoResumeInfo,
  ): Promise<UsageLimitContinueOutcome>;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** 是否为账号额度用尽（不含上游容量过载：那由中断自愈按秒级退避处理）。 */
export function isAccountUsageLimitError(signals: InterruptedTurnErrorSignals): boolean {
  return classifyTurnUsageLimit(signals) && !classifyTurnOverload(signals);
}

export class UsageLimitAutoResume {
  private readonly timers = new Map<string, { token: number; handle: unknown }>();
  private readonly consecutive = new Map<string, number>();
  /** 每次新错误 / 用户接手 / 任务关闭都递增；迟到的异步解析结果据此丢弃。 */
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: UsageLimitAutoResumeDeps) {}

  onTurnError(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    candidateToken: number,
  ): void {
    if (this.disposed || !isAccountUsageLimitError(signals)) return;
    const used = this.consecutive.get(sessionId) ?? 0;
    if (used >= USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES) {
      this.deps.log('usage-limit auto-resume exhausted', { sessionId, used });
      return;
    }
    const generation = this.bumpGeneration(sessionId);
    void this.schedule(sessionId, signals, candidateToken, generation).catch((err) => {
      this.deps.log('usage-limit auto-resume scheduling failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private bumpGeneration(sessionId: string): number {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    return generation;
  }

  private async schedule(
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    token: number,
    generation: number,
  ): Promise<void> {
    if (!(await this.deps.isEligible(sessionId))) return;
    const resetAt = await this.deps.resolveResetAt(sessionId, signals);
    if (this.disposed || this.generations.get(sessionId) !== generation) return;
    const now = this.deps.now();
    if (resetAt === null || resetAt - now > USAGE_LIMIT_MAX_WAIT_MS) {
      this.deps.log('usage-limit auto-resume skipped: no usable reset time', {
        sessionId,
        hasResetAt: resetAt !== null,
      });
      return;
    }
    // 已过点（错误到达时额度刚好重置）也按最短缓冲继续。
    const resumeAt =
      Math.max(resetAt, now) +
      USAGE_LIMIT_RESUME_BUFFER_MS +
      Math.floor(this.deps.random() * USAGE_LIMIT_RESUME_JITTER_MS);
    if (!this.deps.arm(sessionId, token, resumeAt)) return;
    this.clear(sessionId);
    const handle = this.deps.setTimer(() => {
      void this.fire(sessionId, token);
    }, resumeAt - now);
    this.timers.set(sessionId, { token, handle });
    this.deps.log('usage-limit auto-resume scheduled', { sessionId, resumeAt });
  }

  private async fire(sessionId: string, token: number): Promise<void> {
    const pending = this.timers.get(sessionId);
    if (pending?.token === token) this.timers.delete(sessionId);
    if (this.disposed || !this.deps.isCurrent(sessionId, token)) return;
    // 等待期间可能开了目标模式、暂停了执行等：到点再判一次归属。放弃时撤掉提示，
    // 不留下一个过了点却不会执行的「将于 X 自动继续」。
    if (!(await this.deps.isEligible(sessionId))) {
      this.deps.cancel(sessionId, token);
      return;
    }
    const attempt = (this.consecutive.get(sessionId) ?? 0) + 1;
    this.consecutive.set(sessionId, attempt);
    let outcome: UsageLimitContinueOutcome;
    try {
      outcome = await this.deps.continueSession(sessionId, token, {
        reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
        attempt,
        maxAttempts: USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES,
        // sessionTotal 兼作中断自愈的 attempt 令牌(见 register 的 autoResumeAttemptTokenFromAgentMeta);
        // 0 永远不是有效令牌,避免与进行中的重连记账串号。本行也不展示累计次数。
        sessionTotal: 0,
      });
    } catch (err) {
      this.deps.log('usage-limit auto-resume failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.cancel(sessionId, token);
      return;
    }
    // 没真正续上(如判断不了有无产出):撤掉已过点的提示,保留原错误与手动重试,不再自动等待。
    if (outcome !== 'resumed') this.deps.cancel(sessionId, token);
    this.deps.log('usage-limit auto-resume fired', { sessionId, outcome, attempt });
  }

  /** 任务有了实质产出：重新计算连续自动继续次数。 */
  noteProgress(sessionId: string): void {
    this.consecutive.delete(sessionId);
  }

  /** 用户亲自接手（发消息 / 手动重试）：作废在途查询、撤掉定时器并重置次数。 */
  noteUserAction(sessionId: string): void {
    this.consecutive.delete(sessionId);
    this.bumpGeneration(sessionId);
    this.clear(sessionId);
  }

  /** 任务被关闭：作废在途查询与定时器（coordinator 侧等待同时撤销）。 */
  noteSessionClosed(sessionId: string): void {
    this.bumpGeneration(sessionId);
    this.clear(sessionId);
  }

  clear(sessionId: string): void {
    const pending = this.timers.get(sessionId);
    if (!pending) return;
    this.deps.clearTimer(pending.handle);
    this.timers.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const { handle } of this.timers.values()) this.deps.clearTimer(handle);
    this.timers.clear();
  }
}
