import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind } from '../../types/common.js';
import type { ToolLoopEvidence, ToolLoopGuard, ToolLoopGuardVerdict } from './loop-guard.js';

export type HardToolLoopVerdict = Extract<ToolLoopGuardVerdict, { kind: 'hard' }>;

export interface ToolLoopReviewRequest {
  sessionId: string;
  agentKind: AgentKind;
  model: string;
  verdict: Pick<HardToolLoopVerdict, 'reason' | 'count' | 'toolName'>;
  /**
   * 最近的普通调用(旧→新)。均为未脱敏原文,input 保留原结构;发送前必须在未转义的
   * 字符串上先脱敏,再序列化与截断。
   */
  evidence: readonly ToolLoopEvidence[];
}

/** continue = 在等外部进度,放行;stop = 确实在空转。 */
export type ToolLoopReviewDecision = 'continue' | 'stop';

/** Host 注入的复核入口(辅助模型)。抛错、超时都按 stop 处理。 */
export type ToolLoopReviewer = (
  request: ToolLoopReviewRequest,
  opts: { signal: AbortSignal },
) => Promise<ToolLoopReviewDecision>;

const REVIEW_TIMEOUT_MS = 20_000;
/** 每个 turn 最多复核几次;用完后疑似判定直接中断。 */
const MAX_REVIEWS_PER_TURN = 3;
/** 复核放行后,接下来多少次普通结果不再报疑似。 */
const REVIEW_GRACE_RESULTS = 20;

/** 同一 turn 内复核次数的计数;多个 monitor(Claude Code 各 sidechain)可共用一份。 */
export interface ToolLoopReviewBudget {
  used: number;
}

export interface ToolLoopMonitorOptions {
  reviewer?: ToolLoopReviewer;
  /** 缺省为本 monitor 独占;传入同一对象即共享每 turn 的复核上限。 */
  reviewBudget?: ToolLoopReviewBudget;
  context: () => { sessionId: string; agentKind: AgentKind; model: string };
  /** 复核判定 stop(含失败/超时)时调用;调用方自行确认 turn 仍然有效再中断。 */
  onReviewedStop: (verdict: HardToolLoopVerdict) => void;
  logger: Logger;
}

/**
 * ToolLoopGuard 外加辅助模型复核。
 *
 * onToolResult 只返回需要立即中断的判定:最终上限、没有复核入口、或本 turn 复核
 * 次数用完。其余疑似判定转入后台复核并返回 ok,Agent 继续运行;复核中再出现的
 * 疑似判定不重复发起,也不因次数上限提前中断,等进行中的复核给出结论;若新的普通结果已
 * 不再疑似(模式被打破),进行中的复核作废。复核 continue → guard 暂缓疑似判定;stop/失败/超时 →
 * onReviewedStop。dispose / resetTurn 会作废进行中的复核,其结果被丢弃。
 */
export class ToolLoopMonitor {
  private review: AbortController | null = null;
  /** 进行中复核所针对的调用集合;新结果的调用不在其中即视为模式已被替换。 */
  private reviewedPattern: ReadonlySet<string> | null = null;
  private readonly budget: ToolLoopReviewBudget;

  constructor(
    private readonly guard: ToolLoopGuard,
    private readonly opts: ToolLoopMonitorOptions,
  ) {
    this.budget = opts.reviewBudget ?? { used: 0 };
  }

  onToolUse(toolUseId: string, toolName: unknown, input: unknown): void {
    this.guard.onToolUse(toolUseId, toolName, input);
  }

  onToolResult(
    toolUseId: string,
    output: string,
    isError = false,
    toolResultBatchId?: string,
  ): ToolLoopGuardVerdict {
    const verdict = this.guard.onToolResult(toolUseId, output, isError, toolResultBatchId);
    // 被复核的模式已打破(新结果不再疑似)或被替换(新调用不属于被复核的调用集合):
    // 迟到的结论不适用于后续调用。等待/轮询工具与未配对结果不算。
    if (this.review && this.guard.lastResultObserved && (verdict.kind !== 'hard'
      || !this.reviewedPattern?.has(this.guard.lastResultCallFingerprint ?? ''))) {
      this.cancelReview();
    }
    if (verdict.kind !== 'hard') return verdict;
    if (verdict.final || !this.opts.reviewer) {
      this.cancelReview();
      return verdict;
    }
    if (this.review) return { kind: 'ok' };
    if (this.budget.used >= MAX_REVIEWS_PER_TURN) return verdict;
    this.startReview(verdict, this.opts.reviewer);
    return { kind: 'ok' };
  }

  resetTurn(): void {
    this.cancelReview();
    this.budget.used = 0;
    this.guard.resetTurn();
  }

  dispose(): void {
    this.cancelReview();
  }

  private cancelReview(): void {
    this.review?.abort();
    this.review = null;
    this.reviewedPattern = null;
  }

  private startReview(verdict: HardToolLoopVerdict, reviewer: ToolLoopReviewer): void {
    const controller = new AbortController();
    this.review = controller;
    this.reviewedPattern = this.guard.lastSuspectPattern;
    this.budget.used += 1;
    const request: ToolLoopReviewRequest = {
      ...this.opts.context(),
      verdict: { reason: verdict.reason, count: verdict.count, toolName: verdict.toolName },
      evidence: this.guard.recentEvidence(),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), REVIEW_TIMEOUT_MS);
    });
    void Promise.race([
      reviewer(request, { signal: controller.signal }).catch((error: unknown) => {
        this.opts.logger.warn('tool loop review failed', { error: String(error) });
        return 'stop' as const;
      }),
      timeout,
    ]).then((outcome) => {
      clearTimeout(timer);
      if (this.review !== controller) return;
      const pattern = this.reviewedPattern;
      this.review = null;
      this.reviewedPattern = null;
      controller.abort();
      // 结论到达时统一校验一次:仍有在途调用不属于被复核模式(已换做法、结果未到),
      // 结论不适用于它,直接丢弃。此时流式调用的参数已补齐,不会误判。
      if (pattern && this.guard.hasPendingCallOutside(pattern)) {
        this.opts.logger.info('tool loop review discarded: pattern replaced by an in-flight call', {
          reason: verdict.reason,
        });
        return;
      }
      const decision: ToolLoopReviewDecision = outcome === 'continue' ? 'continue' : 'stop';
      this.opts.logger.info('tool loop review settled', {
        decision,
        timedOut: outcome === 'timeout',
        reason: verdict.reason,
        count: verdict.count,
        toolName: verdict.toolName,
      });
      if (decision === 'continue') {
        this.guard.acceptCurrentPattern(REVIEW_GRACE_RESULTS);
        return;
      }
      try {
        this.opts.onReviewedStop(verdict);
      } catch (error) {
        this.opts.logger.warn('tool loop reviewed stop handler threw', { error: String(error) });
      }
    });
  }
}
