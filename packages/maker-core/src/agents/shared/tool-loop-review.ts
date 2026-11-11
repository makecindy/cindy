import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind } from '../../types/common.js';
import { captureEvidence, type ToolLoopEvidence, type ToolLoopGuard, type ToolLoopGuardVerdict } from './loop-guard.js';
import type { AutoReviewUserIntent } from './auto-review-decision.js';

export type HardToolLoopVerdict = Extract<ToolLoopGuardVerdict, { kind: 'hard' }>;

export interface ToolLoopReviewRequest {
  sessionId: string;
  agentKind: AgentKind;
  model: string;
  /** 已有的用户原话及最近补充要求；沿用宿主的有界上下文，不另调模型摘要。 */
  userIntent?: AutoReviewUserIntent;
  /** 当前检测 scope 最近一次调用前的公开说明，不包含私有 thinking。 */
  assistantExplanation?: string;
  verdict: Pick<HardToolLoopVerdict, 'reason' | 'count' | 'toolName'>;
  /**
   * 最近的普通调用(旧→新)。均为未脱敏原文,input 保留原结构;发送前必须在未转义的
   * 字符串上先脱敏,再序列化与截断。
   */
  evidence: readonly ToolLoopEvidence[];
}

/** continue = 有合理继续理由或证据不足;stop = 明确在无进展地空转。 */
export type ToolLoopReviewDecision = 'continue' | 'stop';

/** Host 注入的复核入口(辅助模型)。抛错、超时不构成死循环证据。 */
export type ToolLoopReviewer = (
  request: ToolLoopReviewRequest,
  opts: { signal: AbortSignal },
) => Promise<ToolLoopReviewDecision>;

const REVIEW_TIMEOUT_MS = 20_000;
/** 每个 turn 最多复核几次;用完后放行疑似判定,保留 guard 的最终上限。 */
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
  context: () => Pick<ToolLoopReviewRequest, 'sessionId' | 'agentKind' | 'model' | 'userIntent'>;
  /** 复核明确判定 stop 时调用;调用方自行确认 turn 仍然有效再中断。 */
  onReviewedStop: (verdict: HardToolLoopVerdict) => void;
  logger: Logger;
}

/**
 * ToolLoopGuard 外加辅助模型复核。
 *
 * onToolResult 只在最终上限时返回立即中断的判定。没有复核入口或次数用完时放行疑似。
 * 其余疑似判定转入后台复核并返回 ok,Agent 继续运行;复核中再出现的
 * 疑似判定不重复发起,也不因次数上限提前中断,等进行中的复核给出结论;若新的普通结果已
 * 不再疑似(模式被打破),进行中的复核作废。continue/失败/超时 → guard 暂缓疑似判定;
 * 只有明确 stop 才调用 onReviewedStop。用户目标改变、dispose / resetTurn 会使旧结论作废。
 */
export class ToolLoopMonitor {
  private review: AbortController | null = null;
  /** 进行中复核所针对的调用集合;新结果的调用不在其中即视为模式已被替换。 */
  private reviewedPattern: ReadonlySet<string> | null = null;
  private readonly budget: ToolLoopReviewBudget;
  private assistantExplanation = '';
  private explanationBeforeTool = false;

  constructor(
    private readonly guard: ToolLoopGuard,
    private readonly opts: ToolLoopMonitorOptions,
  ) {
    this.budget = opts.reviewBudget ?? { used: 0 };
  }

  onToolUse(toolUseId: string, toolName: unknown, input: unknown): void {
    this.guard.onToolUse(toolUseId, toolName, input);
    this.explanationBeforeTool = true;
  }

  /** 复用公开 text 事件：增量拼接，final 全文校准；工具后新说明替换旧说明。 */
  onAssistantText(text: string, isFinal = false): void {
    if (!text && !isFinal) return;
    if (this.explanationBeforeTool || isFinal) this.assistantExplanation = '';
    this.explanationBeforeTool = false;
    // 多保留一个字符作为截断信号，发送前复用证据截断器丢弃残缺凭证。
    this.assistantExplanation = (this.assistantExplanation + text).slice(0, 4_001);
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
    if (verdict.final) {
      this.cancelReview();
      return verdict;
    }
    if (this.review) return { kind: 'ok' };
    if (!this.opts.reviewer || this.budget.used >= MAX_REVIEWS_PER_TURN) {
      this.guard.acceptCurrentPattern(REVIEW_GRACE_RESULTS);
      return { kind: 'ok' };
    }
    this.startReview(verdict, this.opts.reviewer);
    return { kind: 'ok' };
  }

  resetTurn(): void {
    this.cancelReview();
    this.budget.used = 0;
    this.guard.resetTurn();
    this.assistantExplanation = '';
    this.explanationBeforeTool = false;
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
      assistantExplanation: captureEvidence(this.assistantExplanation),
      verdict: { reason: verdict.reason, count: verdict.count, toolName: verdict.toolName },
      evidence: this.guard.recentEvidence(),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), REVIEW_TIMEOUT_MS);
    });
    void Promise.race([
      (async () => reviewer(request, { signal: controller.signal }))().catch((error: unknown) => {
        this.opts.logger.warn('tool loop review failed', { error: String(error) });
        return 'unavailable' as const;
      }),
      timeout,
    ]).then((outcome) => {
      clearTimeout(timer);
      if (this.review !== controller) return;
      const pattern = this.reviewedPattern;
      this.review = null;
      this.reviewedPattern = null;
      controller.abort();
      if (request.userIntent !== this.opts.context().userIntent) return;
      // 结论到达时统一校验一次:仍有在途调用不属于被复核模式(已换做法、结果未到),
      // 结论不适用于它,直接丢弃。此时流式调用的参数已补齐,不会误判。
      if (pattern && this.guard.hasPendingCallOutside(pattern)) {
        this.opts.logger.info('tool loop review discarded: pattern replaced by an in-flight call', {
          reason: verdict.reason,
        });
        return;
      }
      const decision: ToolLoopReviewDecision = outcome === 'stop' ? 'stop' : 'continue';
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
