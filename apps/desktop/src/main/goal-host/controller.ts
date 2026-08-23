/**
 * GoalController —— /goal 自主续跑的编排核心(main,跨 Claude Code / Codex 统一)。
 *
 * 它只消费 Session 的公共 API(send / onEvent / isTurnRunning / abort),不进
 * maker-core 热路径、不碰 system prompt(每轮指令走 user message 后缀,见 directive.ts)。
 *
 * 流程:`/goal X` → setGoal 直接建/改目标并续跑 → 之后每轮用 goal_status 裁决续跑。
 *
 * "裁决/续跑/止损"的确定性逻辑全在代码里(规则 9):
 *   - 续跑闸门:status=active ∧ 会话空闲 ∧ 未在 firing ∧ 守卫全过 才发下一轮
 *   - 防失控守卫(**全部 per-goal 可配置、可空,仅设了上限才生效**):token 预算 / 最大轮数
 *     / 空轮抑制 / complete 自停 / blocked(模型自报 / 出错)/ 用户打断暂停 / in-flight 去重 + 防抖
 * 交给模型的是"目标算不算完成 / 是否应 blocked"的语义判断;上限的确定 / 激活 /
 * 持久化全代码驱动。
 */

import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import type { AgentEvent } from '@cindy/maker-core';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import { buildContinuationDirective, buildFirstTurnDirective } from './directive';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton';
import { prependHandoffToUserMessage } from '../maker-ipc/agentHandoff';
import {
  MAX_CONSECUTIVE_OVERLOAD_TURNS,
  OVERLOAD_LAST_REASON,
  OVERLOAD_RESUME_DELAY_MS,
  classifyTurnOverload,
  classifyTurnUsageLimit,
} from './usageLimit';
import { parseVerdict, type GoalVerdict } from './verdict';
import {
  TERMINAL_GOAL_STATUSES,
  type GoalControllerDeps,
  type GoalState,
  type GoalStatus,
  type GoalStatusPayload,
  type SessionLike,
  type GoalUpdatePatch,
  type SetGoalInput,
} from './types';

const DEFAULT_DEBOUNCE_MS = 150;
const DISPATCH_REJECTION_BASE_DELAY_MS = 500;
const DISPATCH_REJECTION_MAX_DELAY_MS = 4_000;
const DISPATCH_REJECTION_MAX_ATTEMPTS = 4;
const DISPATCH_REJECTION_MAX_WINDOW_MS = 15_000;
const DISPATCH_REJECTION_BLOCK_REASON =
  'turn dispatch failed: provider repeatedly rejected attempts before accepting work';

export class GoalControllerInputError extends Error {
  readonly code = 'INVALID_PARAMS';
}

/** Goal 已保守收敛，但本次入口无法恢复其底层 Agent Session。 */
export class GoalSessionRestoreError extends Error {
  readonly code = 'PRECONDITION_FAILED';

  constructor(cause?: unknown) {
    super(
      'unable to restore the agent session for Goal',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GoalSessionRestoreError';
  }
}

/** Goal 仍存在，但本次编辑已被更新的生命周期或状态覆盖。 */
export class GoalUpdateSupersededError extends Error {
  readonly code = 'PRECONDITION_FAILED';

  constructor() {
    super('goal changed while the update was being saved; review the latest state and try again');
    this.name = 'GoalUpdateSupersededError';
  }
}

function resolveLimitPatchValue(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  throw new GoalControllerInputError('goal limit must be a positive number or null');
}

/**
 * (Option B 纯函数)从 AskUserQuestion 的结构化答案里推导"用作目标"的文本。
 * 只接受**清晰的单问单答(单选)**:多问 / 多选(JSON 数组)/ 全空 一律返回 null(不猜),
 * 交由调用方按"无法确定 → 不改写"处理。可独立单测。
 */
export function deriveObjectiveFromAnswers(answers: Record<string, string> | null | undefined): string | null {
  if (!answers || typeof answers !== 'object') return null;
  const values = Object.values(answers)
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '');
  if (values.length !== 1) return null; // 0 = 全跳过;>1 = 多问歧义,不猜
  const only = values[0];
  // 多选答案被持久化成 JSON 数组字符串 → 不适合做单一目标,跳过。
  if (only.startsWith('[')) {
    try {
      if (Array.isArray(JSON.parse(only))) return null;
    } catch {
      /* 非 JSON,当普通文本用 */
    }
  }
  return only;
}

/** AskUserQuestion 单问的最小结构(只取选项 label),用于"目标澄清问题"识别。 */
export interface GoalClarifyQuestion {
  options?: Array<{ label?: string } | null | undefined>;
}

/**
 * (Option B 确定性标记)判断一组 AskUserQuestion 是否就是 directive 约定的"目标澄清问题"。
 *
 * 约定(与 directive.ts 的 buildClarifyContract 耦合,两边改要一起改):澄清问题**必含**一个
 * `label === 用户当前目标 verbatim` 的选项(让用户可选"保持原目标")。普通工作型提问(如
 * "用哪个目录 / 环境?")的选项里不会出现用户原目标,据此把"答案改写目标"严格限定在真正的
 * 目标澄清场景——杜绝模型首轮随手一问(turnsUsed 仍为 0)的答案被误当成新目标(reviewer #354)。
 * 无 questions / 无匹配选项 → 视为非澄清,调用方不改写(安全 no-op,目标保持原文案)。
 */
export function questionsLookLikeGoalClarification(
  questions: readonly GoalClarifyQuestion[] | undefined,
  objective: string,
): boolean {
  if (!questions || questions.length === 0) return false;
  const target = objective.trim();
  if (!target) return false;
  return questions.some((q) =>
    (q?.options ?? []).some((o) => typeof o?.label === 'string' && o.label.trim() === target),
  );
}

export function normalizeGoalUpdatePatch(patch: GoalUpdatePatch): GoalUpdatePatch {
  const next: GoalUpdatePatch = {};
  if ('objective' in patch) {
    const objective = patch.objective?.trim();
    if (!objective) throw new GoalControllerInputError('objective must not be empty');
    next.objective = objective;
  }
  if ('maxTurns' in patch) next.maxTurns = resolveLimitPatchValue(patch.maxTurns);
  if ('budgetTokens' in patch) next.budgetTokens = resolveLimitPatchValue(patch.budgetTokens);
  if ('noProgressLimit' in patch) next.noProgressLimit = resolveLimitPatchValue(patch.noProgressLimit);
  return next;
}

function goalStateMatchesPatch(state: GoalState, patch: GoalUpdatePatch): boolean {
  return (
    (!('objective' in patch) || state.objective === patch.objective) &&
    (!('maxTurns' in patch) || state.maxTurns === patch.maxTurns) &&
    (!('budgetTokens' in patch) || state.budgetTokens === patch.budgetTokens) &&
    (!('noProgressLimit' in patch) || state.noProgressLimit === patch.noProgressLimit)
  );
}

function exceedsGoalBudget(state: Pick<GoalState, 'maxTurns' | 'turnsUsed' | 'budgetTokens' | 'tokensUsed'>): boolean {
  return (
    (state.maxTurns != null && state.turnsUsed >= state.maxTurns) ||
    (state.budgetTokens != null && state.tokensUsed >= state.budgetTokens)
  );
}

// ── 纯裁决核心(可独立单测)─────────────────────────────────────────────────

/** 一轮 turn 结束时收集到的快照。 */
export interface TurnOutcome {
  /** 'goal' = 本 controller 发起的续跑轮;'other' = 用户/其它来源在 goal active 期间发起的轮。 */
  origin: 'goal' | 'other';
  /** 本轮是否产生过任一 tool_use(空轮抑制守卫用)。 */
  sawToolUse: boolean;
  /** 本轮消耗 token(input+output),从 turn 末 status 事件取。 */
  tokensThisTurn: number;
  /** 从最终文本解析出的裁决;null=没吐有效裁决。 */
  verdict: GoalVerdict | null;
  /** 本轮是否以终止型 error 收尾。 */
  errored: boolean;
  errorMessage?: string;
  /**
   * 错误归类:'usage_limit' = 账号限流,'overload' = 上游模型没容量。两者都置
   * usageLimited(可恢复、到点自动续),区别只在等多久——限额等账号周期重置,
   * 过载等一分钟(见 usageLimit.ts)。其它错误按 abort/真错处理。
   */
  errorKind?: 'usage_limit' | 'overload';
}

export interface GoalDecision {
  status: GoalStatus;
  lastReason: string | null;
  turnsUsed: number;
  tokensUsed: number;
  noProgressStreak: number;
  /** 是否再发一轮续跑。 */
  shouldFire: boolean;
}

export interface GoalCounters {
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  noProgressStreak: number;
  /** 三个护栏上限,各自可空(null = 不设该上限,对应守卫不生效)。 */
  budgetTokens: number | null;
  maxTurns: number | null;
  noProgressLimit: number | null;
}

/**
 * 纯函数:给定上一状态 + 本轮结果 → 下一状态 + 是否续跑。无 IO、无副作用。
 *
 * 停止信号:
 *   - 用户打断(origin 'other')→ paused
 *   - 终止型 error → paused(用户 Stop)/ blocked(真出错)
 *   - 模型自报 complete → complete(终态)/ blocked → blocked
 *   - **仅当设了对应上限**:token 撞预算 / 轮数撞 maxTurns → budgetLimited(终态);
 *     连续空轮撞 noProgressLimit → paused
 * 三个护栏全部 per-goal 可配置、可空;未设的上限不参与判断,
 * 目标会一直续到 complete/blocked/用户停。
 */
export function decideNextGoalState(prev: GoalCounters, outcome: TurnOutcome): GoalDecision {
  // 用户/其它来源在 goal active 期间发起的 turn → 暂停,不计入 goal 计数。
  if (outcome.origin === 'other') {
    return {
      status: 'paused',
      lastReason: 'paused: user sent a message during the goal',
      turnsUsed: prev.turnsUsed,
      tokensUsed: prev.tokensUsed,
      noProgressStreak: prev.noProgressStreak,
      shouldFire: false,
    };
  }

  const turnsUsed = prev.turnsUsed + 1;
  const tokensUsed = prev.tokensUsed + Math.max(0, outcome.tokensThisTurn);

  // 终止型 error:区分"用户 Stop(abort)"与"真出错"。
  //  - 用户 Stop → paused(干净暂停,语义对);
  //  - 其它错误 → blocked(止损,避免反复撞错空转),用户处理后可重起。
  if (outcome.errored) {
    const msg = outcome.errorMessage ?? 'unknown error';
    // 账号限流 / 上游过载 → usageLimited(可恢复、到点自动续;resetAt 由 finalizeTurn
    // 按 errorKind 分别补:限额读账号快照,过载用固定短窗口)。
    if (outcome.errorKind === 'usage_limit' || outcome.errorKind === 'overload') {
      return {
        status: 'usageLimited',
        lastReason:
          outcome.errorKind === 'overload' ? OVERLOAD_LAST_REASON : 'usage limit reached',
        turnsUsed,
        tokensUsed,
        noProgressStreak: prev.noProgressStreak,
        shouldFire: false,
      };
    }
    const stoppedByUser = /abort|cancel|interrupt|stopped/i.test(msg);
    return {
      status: stoppedByUser ? 'paused' : 'blocked',
      lastReason: stoppedByUser ? 'paused: stopped by user' : `turn failed: ${msg}`,
      turnsUsed,
      tokensUsed,
      noProgressStreak: prev.noProgressStreak,
      shouldFire: false,
    };
  }

  // 模型自报完成 → 终态,自停。
  if (outcome.verdict?.status === 'complete') {
    return {
      status: 'complete',
      lastReason: outcome.verdict.reason || 'goal achieved',
      turnsUsed,
      tokensUsed,
      noProgressStreak: prev.noProgressStreak,
      shouldFire: false,
    };
  }
  // 模型自报受阻 → blocked,自停。
  if (outcome.verdict?.status === 'blocked') {
    return {
      status: 'blocked',
      lastReason: outcome.verdict.reason || 'agent reported blocked',
      turnsUsed,
      tokensUsed,
      noProgressStreak: prev.noProgressStreak,
      shouldFire: false,
    };
  }

  // continue(含"没吐有效裁决",默认按 continue 处理)。
  // 空轮抑制:本轮没用任何工具 = 无进展,累计;用过工具即清零。
  const noProgressStreak = outcome.sawToolUse ? 0 : prev.noProgressStreak + 1;

  // 护栏(各自仅在设了上限时生效)—— 预算 → 轮数 → 空轮 → 否则续跑。
  if (prev.budgetTokens != null && tokensUsed >= prev.budgetTokens) {
    return {
      status: 'budgetLimited',
      lastReason: `token budget reached (${tokensUsed}/${prev.budgetTokens})`,
      turnsUsed,
      tokensUsed,
      noProgressStreak,
      shouldFire: false,
    };
  }
  if (prev.maxTurns != null && turnsUsed >= prev.maxTurns) {
    return {
      status: 'budgetLimited',
      lastReason: `max turns reached (${turnsUsed}/${prev.maxTurns})`,
      turnsUsed,
      tokensUsed,
      noProgressStreak,
      shouldFire: false,
    };
  }
  if (prev.noProgressLimit != null && noProgressStreak >= prev.noProgressLimit) {
    return {
      status: 'paused',
      lastReason: `paused: ${noProgressStreak} turns with no tool use`,
      turnsUsed,
      tokensUsed,
      noProgressStreak,
      shouldFire: false,
    };
  }
  return {
    status: 'active',
    lastReason: outcome.verdict?.reason || null,
    turnsUsed,
    tokensUsed,
    noProgressStreak,
    shouldFire: true,
  };
}

// ── 每轮事件累计状态 ─────────────────────────────────────────────────────────

interface TurnAccumulator {
  text: string;
  sawToolUse: boolean;
  tokensThisTurn: number;
  /** Usage already sealed by claimed SDK boundaries inside this product turn. */
  continuationTokens: number;
  /** 本轮是否已 finalize(去重 done / 终止 error 双触发)。 */
  finalized: boolean;
  /** 正常 turn 换代只递增 generation，不替换整个 Goal 生命周期 owner。 */
  generation: number;
  /** 显式 Stop 正在把 paused 落盘；迟到事件与自动恢复都必须停在这条边界外。 */
  cancelled: boolean;
  /** 本生命周期已经发出、但尚未全部 settle 的 Goal 状态持久化写入。 */
  pendingPersistence: Promise<void> | null;
  /** 已进入“达成记录 → clear”顺序提交区；Stop 不等待，但新目标必须等旧 clear 结束。 */
  pendingCompletion: Promise<void> | null;
}

function freshTurn(
  cancelled = false,
  pendingPersistence: Promise<void> | null = null,
  pendingCompletion: Promise<void> | null = null,
): TurnAccumulator {
  return {
    text: '',
    sawToolUse: false,
    tokensThisTurn: 0,
    continuationTokens: 0,
    finalized: false,
    generation: 0,
    cancelled,
    pendingPersistence,
    pendingCompletion,
  };
}

// ── 控制器 ──────────────────────────────────────────────────────────────────

export class GoalController {
  private readonly unsubscribers = new Map<string, () => void>();
  /**
   * 每个 goal listener 当前绑定的 SessionLike 对象引用。deferred agent switch 落实后
   * live session 会被换成目标引擎的新对象(maker.getSession 返回新引用),用它判等
   * 以决定是否需要把 listener 迁到新 session —— 否则新引擎 turn 的 done/error 事件
   * 进不了 finalizeTurn,目标永远卡在 active(reviewer P1)。
   */
  private readonly listenerSessions = new Map<string, SessionLike>();
  private readonly turns = new Map<string, TurnAccumulator>();
  /** blocked 落盘失败时保留同一 fail-closed owner，GET_STATUS 可重试而不是回报旧 active。 */
  private readonly unpersistedDispatchFailures = new Map<
    string,
    { boundary: TurnAccumulator; lastReason: string }
  >();
  /** 正在派发的 fire 及其 owner；旧代 finally 只能清理自己，不能删掉 Resume 新代。 */
  private readonly firing = new Map<string, object>();
  /** 尚在 Session.send 派发边界内的 Goal fire；Stop 必须能取消 dispatch 前的异步 gate。 */
  private readonly goalDispatchAbortControllers = new Map<
    string,
    { owner: object; controller: AbortController }
  >();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** goal controller 自己发起且尚未收到终止事件的 turn。用于编辑时区分 goal turn / user turn。 */
  private readonly goalTurnsInFlight = new Set<string>();
  /**
   * Provider 明确拒绝(确认未接受)的连续重排窗口。只记内存：成功接受或任一显式
   * lifecycle 操作都会清零；未知投递从不进入这里，而是直接走 fence / blocked。
   */
  private readonly dispatchRejectionRetries = new Map<
    string,
    { attempts: number; firstRejectedAt: number; retryNotBefore: number }
  >();
  /** (Option B)已经用 AskUserQuestion 答案改写、或正在提交改写的会话。token 让失败调用
   *  只能释放自己的 claim，不能误删新目标 / 后续调用的闸门。setGoal 与 clearGoal 时重置。 */
  private readonly clarificationApplied = new Map<string, object>();
  /** usageLimited 到点自动续跑 timer,按 sessionId。**stopSession 不清它**(它要熬到限额重置),
   *  只在 clearGoal / resumeGoal / dispose 取消。 */
  private readonly usageResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 用户在旧 vendor turn 尚未完全 idle 时点下 Resume 的一次性意图。
   *
   * 此时不能立刻挂 listener / 改 active，否则旧 turn 的迟到终态会被算进新一代 Goal；
   * 也不能静默 return，否则用户必须猜何时 idle 后再点一次。由 turn idle observer 在
   * 安全边界后重试，Stop / clear / setGoal / session teardown 会显式取消。
   */
  private readonly deferredManualResumes = new Set<string>();
  private readonly deferredManualResumeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * deferred Resume 从等待 idle 到 active 落库之间的生命周期上下文。
   *
   * waiting set 会在真正重试时先被 claim，避免重复 observer 再排一轮；这里继续保留
   * boundary + usageResetAt，供并发 close/replacement 精确释放本次边界，并在提交前被
   * 取消时恢复 usageLimited 的自动续跑 timer。
   */
  private readonly deferredManualResumeContexts = new Map<
    string,
    { boundary: TurnAccumulator; usageResetAt: number | null }
  >();
  /**
   * 连续以"上游没容量"收尾的轮数,按 sessionId。
   *
   * 存在理由:三道预算护栏(budgetTokens / maxTurns / noProgressLimit)**都只在用户
   * 设了对应上限时生效**,而过载轮既不产出 token 也不动 noProgressStreak。没有这个
   * 计数器时,一个没设任何上限的目标遇上持续容量故障就会每分钟自动续一轮、永不停止。
   * 只在内存里记:进程重启本身就打断了循环,重启后重新计数最多多跑几轮,不值得为它
   * 动 schema。有产出的一轮(或手动 resume)即清零。
   */
  private readonly consecutiveOverloadTurns = new Map<string, number>();
  private readonly now: () => number;
  private readonly debounceMs: number;

  constructor(private readonly deps: GoalControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.debounceMs = deps.continuationDebounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // ── 公开 API ───────────────────────────────────────────────────────────────

  /** `/goal X` 入口:无既有 goal 直接创建;已有 goal 直接改 objective 并续跑。 */
  async setGoal(input: SetGoalInput): Promise<GoalState | null> {
    const sessionId = input.sessionId;
    const objective = input.objective.trim();
    if (!objective) throw new GoalControllerInputError('objective must not be empty');
    this.cancelDeferredManualResume(sessionId);
    let entryBoundary = this.turns.get(sessionId);
    let rejectionTakeover:
      | {
          retry: { attempts: number; firstRejectedAt: number; retryNotBefore: number };
          previousBoundary: TurnAccumulator;
          hadGoalTurn: boolean;
          hadFiring: boolean;
        }
      | undefined;
    const rejectionRetry = this.dispatchRejectionRetries.get(sessionId);
    if (rejectionRetry && entryBoundary) {
      // A replacement `/goal` must synchronously fence the old objective before
      // storage or hydration can yield. Keep a cancelled owner on failure so a
      // stale backoff timer cannot dispatch the old objective invisibly.
      rejectionTakeover = {
        retry: { ...rejectionRetry },
        previousBoundary: entryBoundary,
        hadGoalTurn: this.goalTurnsInFlight.has(sessionId),
        hadFiring: this.firing.has(sessionId),
      };
      const previousBoundary = entryBoundary;
      this.stopSession(sessionId);
      entryBoundary = freshTurn(
        true,
        previousBoundary.pendingPersistence,
        previousBoundary.pendingCompletion,
      );
      this.turns.set(sessionId, entryBoundary);
    }
    // 连续过载计数是 per-goal 状态：换目标(含替换既有目标的编辑路径)必须清零，
    // 否则上一个目标撞过载上限变 blocked 后，新目标会继承耗尽的计数，第一次容量
    // 错误就直接 blocked、拿不到自己的重试预算。
    this.consecutiveOverloadTurns.delete(sessionId);
    if (entryBoundary?.pendingCompletion) {
      // 旧目标已经进入“达成记录 → clear”顺序提交区。新 /goal 先同步接管 owner，
      // 等旧 clear 完成后再读行；否则旧 clear 可能在新目标 upsert 之后把它删掉。
      const takeoverBoundary = freshTurn(
        false,
        entryBoundary.pendingPersistence,
        entryBoundary.pendingCompletion,
      );
      this.stopSession(sessionId);
      this.turns.set(sessionId, takeoverBoundary);
      await this.awaitPendingLifecycle(takeoverBoundary);
      if (this.turns.get(sessionId) !== takeoverBoundary) return null;
      entryBoundary = takeoverBoundary;
    }
    let existing: GoalState | null;
    try {
      existing = await this.deps.storage.get(sessionId);
    } catch (error) {
      if (
        rejectionTakeover &&
        this.turns.get(sessionId) === entryBoundary
      ) {
        this.turns.set(sessionId, rejectionTakeover.previousBoundary);
        this.dispatchRejectionRetries.set(sessionId, rejectionTakeover.retry);
        if (rejectionTakeover.hadGoalTurn) this.goalTurnsInFlight.add(sessionId);
        this.attachListener(sessionId);
        if (!rejectionTakeover.hadFiring) this.scheduleContinuation(sessionId);
      }
      throw error;
    }
    if (this.turns.get(sessionId) !== entryBoundary) return null;
    const ts = this.now();

    if (existing) {
      const failureBoundary = entryBoundary ?? freshTurn();
      if (!entryBoundary) {
        entryBoundary = failureBoundary;
        this.turns.set(sessionId, failureBoundary);
      }
      let session: SessionLike | undefined;
      try {
        session = await this.deps.ensureSession(sessionId);
      } catch (error) {
        if (this.turns.get(sessionId) !== failureBoundary) return null;
        this.deps.logger.warn('[goal] setGoal edit: session restore failed', {
          sessionId,
          error: String(error),
        });
        await this.blockDispatchFailure(
          sessionId,
          failureBoundary,
          'turn dispatch failed: unable to restore the agent session',
          () => this.turns.get(sessionId) === failureBoundary,
        );
        throw new GoalSessionRestoreError(error);
      }
      if (this.turns.get(sessionId) !== entryBoundary) return null;
      if (!session) {
        this.deps.logger.warn('[goal] setGoal edit: no live session', { sessionId });
        await this.blockDispatchFailure(
          sessionId,
          failureBoundary,
          'turn dispatch failed: unable to restore the agent session',
          () => this.turns.get(sessionId) === failureBoundary,
        );
        throw new GoalSessionRestoreError();
      }
      const sessionWasBusy =
        rejectionTakeover?.hadGoalTurn === true || this.isBusy(sessionId);
      if (sessionWasBusy) {
        if (
          rejectionTakeover?.hadGoalTurn !== true &&
          !this.goalTurnsInFlight.has(sessionId)
        ) {
          throw new GoalControllerInputError('current conversation is still running; edit the goal after it becomes idle');
        }
        // 先 stopSession(detach listener + 清 goalTurnsInFlight/turn),再 abort:否则 abort 触发的
        // 终止事件可能在 detach 前被 onEvent 消费 → 并发 finalizeTurn 把下面刚写的 active 覆盖成
        // paused(用户编辑目标后 chip 误显"暂停")。detach 在前,abort 的终止事件就不再触达裁决。
      }
      const previousBoundary = this.turns.get(sessionId);
      this.stopSession(sessionId);
      const editBoundary = freshTurn(
        false,
        previousBoundary?.pendingPersistence ?? null,
        previousBoundary?.pendingCompletion ?? null,
      );
      this.turns.set(sessionId, editBoundary);
      let editObjectivePersisted = false;
      let updatedState: GoalState | null = null;
      try {
        if (sessionWasBusy) {
          await session.abort();
          if (this.turns.get(sessionId) !== editBoundary) return null;
        }
        await this.awaitPendingLifecycle(editBoundary);
        if (this.turns.get(sessionId) !== editBoundary) return null;
        this.cancelUsageResume(sessionId);
        const updated = await this.trackPersistence(
          editBoundary,
          this.deps.storage.update(sessionId, {
            objective,
            status: 'active',
            noProgressStreak: 0,
            usageResetAt: null,
            lastReason: null,
            updatedAt: ts,
          }),
          async (persisted) => {
            if (!persisted) return;
            editObjectivePersisted = true;
            // 新目标已经提交后才重置澄清闸门；被 Stop 取消或写入失败的 setGoal
            // 不能重新开放旧目标的澄清改写。
            this.clarificationApplied.delete(sessionId);
            await this.deps.persistUserMessage?.(sessionId, objective, {
              goalObjective: { updated: true },
            });
          },
        );
        if (this.turns.get(sessionId) !== editBoundary) return null;
        if (!updated) {
          this.turns.delete(sessionId);
          return null;
        }
        updatedState = updated;
        this.resetTurn(sessionId);
        const activeBoundary = this.turns.get(sessionId);
        this.attachListener(sessionId);
        this.emit(updated);
        if (this.turns.get(sessionId) === activeBoundary) {
          await this.fireTurn(sessionId, { throwOnRestoreFailure: true });
        }
      } catch (error) {
        if (this.turns.get(sessionId) === editBoundary) {
          if (rejectionTakeover) {
            // Keep the persisted active Goal live after either half of the edit
            // fails. Before objective commit, resume the old rejection budget;
            // after commit, retry only the new objective with a fresh budget.
            if (!editObjectivePersisted) {
              this.dispatchRejectionRetries.set(sessionId, rejectionTakeover.retry);
            }
            this.attachListener(sessionId);
            this.scheduleContinuation(sessionId);
          } else {
            this.turns.delete(sessionId);
          }
        }
        throw error;
      }
      // This is only a return-value refresh. The Goal lifecycle is already
      // established, so a read failure must not tear down its owner or retry.
      return (await this.deps.storage.get(sessionId)) ?? updatedState;
    }

    const limits = input.limits ?? this.deps.getDefaults();
    const previousBoundary = this.turns.get(sessionId);
    this.stopSession(sessionId);
    const createBoundary = freshTurn(
      false,
      previousBoundary?.pendingPersistence ?? null,
      previousBoundary?.pendingCompletion ?? null,
    );
    this.turns.set(sessionId, createBoundary);
    let createdState: GoalState | null = null;
    try {
      // 先活化(resume)会话,再据活化后的会话定 agentKind:dormant(重启后尚未活化)会话此刻
      // getSession 为空,若直接 fallback 'claude-code' 会把 Codex 目标错存成 claude-code,后续
      // getAccountLimit 读错账号配额快照 → Codex 限流目标的 reset/auto-resume 错位(reviewer #354)。
      let ensured: SessionLike | undefined;
      try {
        ensured = await this.deps.ensureSession(sessionId);
      } catch (error) {
        throw new GoalSessionRestoreError(error);
      }
      if (this.turns.get(sessionId) !== createBoundary) return null;
      if (!ensured) throw new GoalSessionRestoreError();
      await this.awaitPendingLifecycle(createBoundary);
      if (this.turns.get(sessionId) !== createBoundary) return null;
      const agentKind = input.agentKind ?? ensured?.agentKind ?? this.deps.getSession(sessionId)?.agentKind ?? 'claude-code';
      const state: GoalState = {
        sessionId,
        objective,
        status: 'active',
        budgetTokens: limits.budgetTokens,
        maxTurns: limits.maxTurns,
        noProgressLimit: limits.noProgressLimit,
        turnsUsed: 0,
        tokensUsed: 0,
        noProgressStreak: 0,
        usageResetAt: null,
        lastReason: null,
        agentKind,
        startedAt: ts,
        updatedAt: ts,
      };
      createdState = state;
      await this.trackPersistence(createBoundary, this.deps.storage.upsert(state), async () => {
        this.clarificationApplied.delete(sessionId);
        // 目标创建 → 落一条目标文案作对话起点(updated:false),**只此一次**。
        // 不放进 fireTurn(Fix A 后 'first' 可能重发,会重复落库;编辑路径自己落 updated:true)。
        await this.deps.persistUserMessage?.(sessionId, objective, {
          goalObjective: { updated: false },
        });
      });
      if (this.turns.get(sessionId) !== createBoundary) return null;
      this.resetTurn(sessionId);
      const activeBoundary = this.turns.get(sessionId);
      this.attachListener(sessionId);
      this.emit(state);
      if (this.turns.get(sessionId) === activeBoundary) {
        await this.fireTurn(sessionId, { throwOnRestoreFailure: true });
      }
    } catch (error) {
      if (this.turns.get(sessionId) === createBoundary) this.turns.delete(sessionId);
      throw error;
    }
    // Same as the edit path: post-dispatch status refresh is observational and
    // cannot revoke a lifecycle that may already own a rejection retry.
    return (await this.deps.storage.get(sessionId)) ?? createdState;
  }

  async updateGoal(sessionId: string, patch: GoalUpdatePatch): Promise<GoalState | null> {
    const normalized = normalizeGoalUpdatePatch(patch);
    const existingBoundary = this.turns.get(sessionId);
    const operationBoundary = existingBoundary ?? freshTurn();
    const ownsOperationBoundary = existingBoundary === undefined;
    if (ownsOperationBoundary) this.turns.set(sessionId, operationBoundary);
    let entryGeneration = operationBoundary.generation;
    let objectiveChanged = false;
    let objectivePersisted = false;
    let rejectionRetryRescheduled = false;
    let frozenRejectionRetry:
      | { attempts: number; firstRejectedAt: number; retryNotBefore: number }
      | undefined;
    const rescheduleRejectedDispatchForObjective = (status: GoalStatus): boolean => {
      if (
        rejectionRetryRescheduled ||
        !objectiveChanged ||
        status !== 'active' ||
        (!frozenRejectionRetry && !this.dispatchRejectionRetries.delete(sessionId))
      ) {
        return false;
      }
      rejectionRetryRescheduled = true;
      this.scheduleContinuation(sessionId);
      return true;
    };
    const entryChanged = (): boolean => {
      const current = this.turns.get(sessionId);
      return current !== operationBoundary || current.generation !== entryGeneration;
    };

    // `null` 只表示权威存储里确实没有 Goal。turn 收尾 / Stop 换代时重读当前行：
    // 本次 patch 仍在就按成功返回并广播最新状态；已被后续操作覆盖则明确报竞态，
    // 不能把生命周期取消伪装成 GOAL_NOT_FOUND，也不能把未应用的编辑谎报成功。
    const reconcileLifecycleChange = async (): Promise<GoalState | null> => {
      const readSettledState = async (): Promise<GoalState | null> => {
        while (true) {
          const boundary = this.turns.get(sessionId);
          await this.awaitPendingLifecycle(boundary);
          if (this.turns.get(sessionId) !== boundary) continue;
          const current = await this.deps.storage.get(sessionId);
          if (this.turns.get(sessionId) === boundary) return current;
        }
      };
      const current = await readSettledState();
      if (!current) return null;
      if (!goalStateMatchesPatch(current, normalized)) {
        throw new GoalUpdateSupersededError();
      }
      // 正常 turn 可能在本次编辑读完旧计数后才 finalize。patch 已成功并不代表后置
      // 预算条件仍成立；必须用 settle 后的最新 counters 再判一次，不能返回超限 active。
      if (current.status === 'active' && exceedsGoalBudget(current)) {
        const previousBoundary = this.turns.get(sessionId);
        this.stopSession(sessionId);
        const limitBoundary = freshTurn(
          true,
          previousBoundary?.pendingPersistence ?? null,
          previousBoundary?.pendingCompletion ?? null,
        );
        this.turns.set(sessionId, limitBoundary);
        await this.awaitPendingLifecycle(limitBoundary);
        if (this.turns.get(sessionId) !== limitBoundary) return reconcileLifecycleChange();
        const limited = await this.trackPersistence(
          limitBoundary,
          this.deps.storage.update(sessionId, {
            status: 'budgetLimited',
            lastReason: 'budget limit lowered below current usage',
            updatedAt: this.now(),
          }),
        );
        if (this.turns.get(sessionId) !== limitBoundary) return reconcileLifecycleChange();
        if (limited) {
          this.stopSession(sessionId);
          this.emit(limited);
        }
        return limited;
      }
      rescheduleRejectedDispatchForObjective(current.status);
      this.emit(current);
      return current;
    };

    try {
      await this.awaitPendingLifecycle(operationBoundary);
      if (this.turns.get(sessionId) !== operationBoundary) return reconcileLifecycleChange();
      entryGeneration = operationBoundary.generation;
      const state = await this.deps.storage.get(sessionId);
      if (entryChanged()) return reconcileLifecycleChange();
      if (!state) return null;
      objectiveChanged =
        normalized.objective != null && normalized.objective !== state.objective;
      if (objectiveChanged && state.status === 'active') {
        const rejectionRetry = this.dispatchRejectionRetries.get(sessionId);
        if (rejectionRetry && this.firing.has(sessionId)) {
          // The old retry already entered Session.send. Its acceptance is not yet
          // known, so committing a replacement objective and scheduling another
          // send could duplicate side effects. Leave both lifecycle and storage
          // untouched; the caller can retry after this dispatch settles.
          throw new GoalControllerInputError(
            'current goal dispatch is still being accepted; retry the update after it settles',
          );
        }
        if (rejectionRetry) {
          // Freeze the old objective synchronously before persistence can yield.
          // Bump generation so a timer callback already waiting on storage cannot
          // cross the dispatch boundary with the stale objective.
          frozenRejectionRetry = { ...rejectionRetry };
          this.dispatchRejectionRetries.delete(sessionId);
          const timer = this.timers.get(sessionId);
          if (timer) {
            clearTimeout(timer);
            this.timers.delete(sessionId);
          }
          operationBoundary.generation += 1;
          entryGeneration = operationBoundary.generation;
        }
      }
      const ts = this.now();
      const preview = { ...state, ...normalized };
      const shouldLimit = state.status === 'active' && exceedsGoalBudget(preview);
      const persistObjectiveMarker = async (changed: GoalState | null): Promise<void> => {
        if (!objectiveChanged || !changed) return;
        objectivePersisted = true;
        await this.deps.persistUserMessage?.(sessionId, changed.objective, {
          goalObjective: { updated: true },
        });
      };

      let changed: GoalState | null;
      let limitBoundary: TurnAccumulator | undefined;
      if (shouldLimit) {
        // 降低上限是显式生命周期接管：同步摘掉旧 listener/timer，等旧 finalize 写完后，
        // 用同一条 UPDATE 同时提交新上限与 budgetLimited，避免暴露可被旧写覆盖的 active 中间态。
        const previousBoundary = this.turns.get(sessionId);
        this.stopSession(sessionId);
        limitBoundary = freshTurn(
          true,
          previousBoundary?.pendingPersistence ?? null,
          previousBoundary?.pendingCompletion ?? null,
        );
        this.turns.set(sessionId, limitBoundary);
        await this.awaitPendingLifecycle(limitBoundary);
        if (this.turns.get(sessionId) !== limitBoundary) return reconcileLifecycleChange();
        changed = await this.trackPersistence(
          limitBoundary,
          this.deps.storage.update(sessionId, {
            ...normalized,
            status: 'budgetLimited',
            lastReason: 'budget limit lowered below current usage',
            updatedAt: ts,
          }),
          persistObjectiveMarker,
        );
        if (this.turns.get(sessionId) !== limitBoundary) return reconcileLifecycleChange();
        if (!changed) {
          this.turns.delete(sessionId);
          return null;
        }
      } else {
        changed = await this.trackPersistence(
          operationBoundary,
          this.deps.storage.update(sessionId, {
            ...normalized,
            updatedAt: ts,
          }),
          persistObjectiveMarker,
        );
        if (entryChanged()) return reconcileLifecycleChange();
      }
      if (!changed) return null;
      rescheduleRejectedDispatchForObjective(changed.status);
      if (shouldLimit) {
        if (this.turns.get(sessionId) !== limitBoundary) return reconcileLifecycleChange();
        this.stopSession(sessionId);
      }
      let next = changed;
      if (changed.status === 'budgetLimited' && !exceedsGoalBudget(changed)) {
        const previousBoundary = this.turns.get(sessionId);
        this.stopSession(sessionId);
        const resumeBoundary = freshTurn(
          false,
          previousBoundary?.pendingPersistence ?? null,
          previousBoundary?.pendingCompletion ?? null,
        );
        this.turns.set(sessionId, resumeBoundary);
        await this.awaitPendingLifecycle(resumeBoundary);
        if (this.turns.get(sessionId) !== resumeBoundary) return reconcileLifecycleChange();
        const resumed = await this.trackPersistence(
          resumeBoundary,
          this.deps.storage.update(sessionId, {
            status: 'active',
            lastReason: null,
            updatedAt: this.now(),
          }),
        );
        if (this.turns.get(sessionId) !== resumeBoundary) return reconcileLifecycleChange();
        if (resumed) {
          next = resumed;
          this.resetTurn(sessionId);
          await this.deps.ensureSession(sessionId);
          if (this.turns.get(sessionId) !== resumeBoundary) return reconcileLifecycleChange();
          this.attachListener(sessionId);
        } else if (this.turns.get(sessionId) === resumeBoundary) {
          this.turns.delete(sessionId);
        }
      }
      if (
        objectiveChanged &&
        (changed.status === 'paused' || changed.status === 'blocked' || changed.status === 'usageLimited')
      ) {
        await this.resumeGoal(sessionId);
        return reconcileLifecycleChange();
      }
      this.emit(next);
      if (
        next.status === 'active' &&
        state.status === 'budgetLimited' &&
        !this.isBusy(sessionId)
      ) {
        this.scheduleContinuation(sessionId);
      }
      return next;
    } finally {
      if (
        frozenRejectionRetry &&
        !rejectionRetryRescheduled &&
        this.turns.get(sessionId) === operationBoundary
      ) {
        // Storage failure keeps the old objective authoritative, so restore its
        // retry budget. Once the objective row committed (even if its marker
        // failed), continue only with a fresh budget for the new objective.
        if (!objectivePersisted) {
          this.dispatchRejectionRetries.set(sessionId, frozenRejectionRetry);
        }
        this.scheduleContinuation(sessionId);
      }
      if (ownsOperationBoundary && this.turns.get(sessionId) === operationBoundary) {
        this.turns.delete(sessionId);
      }
    }
  }

  /**
   * (Option B)用户答完 AskUserQuestion 的**即时**目标改写。由 main 的 interaction 解析链路
   * (register.ts resolvePendingInteraction)在用户点卡片选项的那一刻调用 —— 不等模型、不靠
   * 模型回报。仅在**首轮澄清**(status active ∧ turnsUsed===0)时把目标确定性改写成用户所选答案:
   *   - 中途提问(turnsUsed>0)不动目标(那是干活时的提问,不是在澄清目标);
   *   - 选了"保持原目标"(directive 要求该选项 label = 用户原文)→ next === objective → no-op;
   *   - 多问 / 多选 / 全跳过 → deriveObjectiveFromAnswers 返回 null → no-op;
   *   - 这次 AskUserQuestion **不是目标澄清问题**(questions 里不含原目标 verbatim 选项,见
   *     questionsLookLikeGoalClarification)→ no-op。防模型首轮随手问个工作问题(turnsUsed 仍 0)
   *     就被当成目标改写(reviewer #354)。
   * 改写后即时 emit(chip 立刻更新)+ 落一条「目标已更新」标记,与 setGoal/updateGoal 改目标一致。
   */
  async applyClarificationAnswer(
    sessionId: string,
    answers: Record<string, string>,
    questions?: readonly GoalClarifyQuestion[],
  ): Promise<void> {
    if (this.clarificationApplied.has(sessionId)) return; // 每目标只澄清改写一次
    const next = deriveObjectiveFromAnswers(answers);
    if (!next) return;
    const existingBoundary = this.turns.get(sessionId);
    const operationBoundary = existingBoundary ?? freshTurn();
    const ownsOperationBoundary = existingBoundary === undefined;
    if (ownsOperationBoundary) this.turns.set(sessionId, operationBoundary);
    const entryGeneration = operationBoundary.generation;
    const isCurrentOperation = (): boolean =>
      this.turns.get(sessionId) === operationBoundary &&
      operationBoundary.generation === entryGeneration &&
      !operationBoundary.cancelled &&
      !operationBoundary.finalized;
    const clarificationClaim = {};
    const releaseClarificationClaim = (): void => {
      if (this.clarificationApplied.get(sessionId) === clarificationClaim) {
        this.clarificationApplied.delete(sessionId);
      }
    };
    let objectiveCommitted = false;
    try {
      await this.awaitPendingLifecycle(operationBoundary);
      if (!isCurrentOperation()) return;
      const state = await this.deps.storage.get(sessionId);
      if (!isCurrentOperation()) return;
      if (!state || state.status !== 'active') return;
      if (state.turnsUsed !== 0) return;
      // 确定性标记:只认 directive 约定形状的"目标澄清问题",否则不改写(见函数注释)。
      if (!questionsLookLikeGoalClarification(questions, state.objective)) return;
      // 入口 fast-path 之后可能已有另一个澄清调用完成了读取；在首次写入前同步 claim，
      // JS 同一事件循环内没有 await，保证每个目标最多一个答案进入提交路径。
      if (this.clarificationApplied.has(sessionId)) return;
      this.clarificationApplied.set(sessionId, clarificationClaim);
      if (next === state.objective) {
        return;
      }
      const updated = await this.trackPersistence(
        operationBoundary,
        this.deps.storage.update(sessionId, { objective: next, updatedAt: this.now() }),
        async (persisted) => {
          if (!persisted) return;
          objectiveCommitted = true;
          await this.deps.persistUserMessage?.(sessionId, next, {
            goalObjective: { updated: true },
          });
        },
      );
      if (!updated) {
        releaseClarificationClaim();
        return;
      }
      if (!isCurrentOperation()) return;
      if (updated) this.emit(updated);
    } catch (error) {
      if (!objectiveCommitted) releaseClarificationClaim();
      throw error;
    } finally {
      if (ownsOperationBoundary && this.turns.get(sessionId) === operationBoundary) {
        this.turns.delete(sessionId);
      }
    }
  }

  /** 清除目标(用户主动)。删行 + 停止一切续跑 + 取消 usage 自动续 + 通知 renderer 隐藏指示器。 */
  async clearGoal(sessionId: string): Promise<void> {
    this.clarificationApplied.delete(sessionId);
    this.consecutiveOverloadTurns.delete(sessionId);
    this.cancelDeferredManualResume(sessionId);
    this.cancelUsageResume(sessionId);
    // 只中断 GoalController 自己发起的 turn。目标仍挂着时，用户可能已经让一条普通
    // 消息进入队列；clear 必须保留它，并在旧 goal turn 终止后让 coordinator 正常
    // drain。反过来，若当前跑的是用户 turn，清目标不应误停用户正在做的工作。
    const hasActiveGoalTurn = this.goalTurnsInFlight.has(sessionId);
    const previousBoundary = this.turns.get(sessionId);
    this.stopSession(sessionId);
    const clearBoundary = freshTurn(
      true,
      previousBoundary?.pendingPersistence ?? null,
      previousBoundary?.pendingCompletion ?? null,
    );
    this.turns.set(sessionId, clearBoundary);
    if (hasActiveGoalTurn) {
      try {
        // detach listener / 换 cancelled owner 必须早于 abort。否则 abort 的终态事件可能
        // 被旧 Goal listener 消费，并与下面的 clear 持久化并发重建状态。生产依赖走
        // input coordinator 的 Stop 边界，同时收口 vendor、输入锁和迟到事件。
        this.deps.stopActiveGoalTurn(sessionId);
      } catch (error) {
        // 删除持久目标比中断回调更重要：即便停止协调器异常，也不能把 active 行留到
        // 下次启动继续诈尸。异常留日志，存储 clear 仍继续执行。
        this.deps.logger.warn('[goal] failed to stop active turn while clearing goal', {
          sessionId,
          error: String(error),
        });
      }
    }
    await this.awaitPendingLifecycle(clearBoundary);
    if (this.turns.get(sessionId) !== clearBoundary) return;
    await this.trackPersistence(clearBoundary, this.deps.storage.clear(sessionId));
    if (this.turns.get(sessionId) !== clearBoundary) return;
    this.deps.emitStatus({ sessionId, goal: null });
    this.turns.delete(sessionId);
  }

  /**
   * 暂停一个 active 目标(用户点 Pause / rewind 联动)。**保留计数**,停续跑;
   * 可经 resumeGoal 恢复。非 active(已暂停/受阻/终态)直接忽略。
   * reason 供 UI 展示(如 rewind 传 "paused: conversation rewound")。
   */
  async pauseGoal(sessionId: string, reason?: string): Promise<void> {
    // Stop 的控制边界不能排在存储 IO 后面：读写一旦卡住，在途 turn 的终态事件仍会
    // 落到旧 listener，idle 兜底会把 active goal 立即续起来。先同步 detach listener、
    // continuation timer 与 firing 状态，再用同一 turns owner 留下 cancelled 边界，
    // 阻止 pause 落盘期间的 resume-on-open / 迟到事件重建旧生命周期。
    this.cancelDeferredManualResume(sessionId);
    this.cancelUsageResume(sessionId);
    const previousBoundary = this.turns.get(sessionId);
    this.stopSession(sessionId);
    // 每次 Stop 都换新对象身份：后来的 Stop 必须能超越已在 await 中的 Resume，
    // 不能复用旧 cancelled 对象形成 ABA。边界留到后续显式 Resume / setGoal / clearGoal，
    // 也让暂停落盘失败、乃至目标行尚未创建时的 Stop 都保持 fail-closed。
    const pauseBoundary = freshTurn(
      true,
      previousBoundary?.pendingPersistence ?? null,
      previousBoundary?.pendingCompletion ?? null,
    );
    this.turns.set(sessionId, pauseBoundary);
    await this.awaitPendingPersistence(pauseBoundary);
    if (this.turns.get(sessionId) !== pauseBoundary) return;
    const state = await this.deps.storage.get(sessionId);
    if (this.turns.get(sessionId) !== pauseBoundary) return;
    if (!state) return;
    if (state.status === 'usageLimited') {
      const updated = await this.trackPersistence(
        pauseBoundary,
        this.deps.storage.update(sessionId, {
          status: 'paused',
          usageResetAt: null,
          lastReason: reason ?? 'paused by user',
          updatedAt: this.now(),
        }),
      );
      if (this.turns.get(sessionId) !== pauseBoundary) return;
      if (updated) this.emit(updated);
      return;
    }
    if (state.status !== 'active') return;
    const updated = await this.trackPersistence(
      pauseBoundary,
      this.deps.storage.update(sessionId, {
        status: 'paused',
        lastReason: reason ?? 'paused by user',
        updatedAt: this.now(),
      }),
    );
    if (this.turns.get(sessionId) !== pauseBoundary) return;
    if (updated) this.emit(updated);
  }

  /**
   * 恢复一个 paused / blocked / usageLimited 目标。**保留 turnsUsed/tokensUsed/startedAt**
   * (与 setGoal 全清零相反),重挂 listener,空闲则立即续一轮。终态(complete/budgetLimited)
   * /已 active 不处理。
   */
  async resumeGoal(sessionId: string, opts?: { auto?: boolean }): Promise<void> {
    let existingBoundary = this.turns.get(sessionId);
    let state: GoalState | null | undefined;
    if (existingBoundary?.cancelled) {
      if (opts?.auto) return;
      await this.awaitPendingLifecycle(existingBoundary);
      if (this.turns.get(sessionId) !== existingBoundary) return;
      // Stop 持久化失败时保留 fail-closed 边界；读取失败也不能据此放行恢复。
      state = await this.deps.storage.get(sessionId);
      if (this.turns.get(sessionId) !== existingBoundary) return;
      if (
        !state ||
        (state.status !== 'paused' && state.status !== 'blocked' && state.status !== 'usageLimited')
      ) {
        this.cancelDeferredManualResume(sessionId);
        return;
      }
      if (this.isBusy(sessionId)) {
        this.deferManualResumeUntilIdle(sessionId, existingBoundary, state);
        return;
      }
      this.turns.delete(sessionId);
      existingBoundary = undefined;
    }
    const lookupBoundary = existingBoundary ?? freshTurn();
    const ownsLookupBoundary = existingBoundary === undefined;
    if (ownsLookupBoundary) this.turns.set(sessionId, lookupBoundary);
    if (!opts?.auto) this.rebindDeferredManualResumeBoundary(sessionId, lookupBoundary);
    await this.awaitPendingLifecycle(lookupBoundary);
    if (this.turns.get(sessionId) !== lookupBoundary) return;
    if (state === undefined) {
      try {
        state = await this.deps.storage.get(sessionId);
      } catch (error) {
        if (!opts?.auto) {
          this.cancelDeferredManualResume(sessionId, { restoreUsageResume: true });
        }
        if (ownsLookupBoundary && this.turns.get(sessionId) === lookupBoundary) {
          this.turns.delete(sessionId);
        }
        throw error;
      }
    }
    if (this.turns.get(sessionId) !== lookupBoundary) return;
    if (
      !state ||
      (state.status !== 'paused' && state.status !== 'blocked' && state.status !== 'usageLimited')
    ) {
      if (!opts?.auto) this.cancelDeferredManualResume(sessionId);
      if (ownsLookupBoundary && this.turns.get(sessionId) === lookupBoundary) {
        this.turns.delete(sessionId);
      }
      return;
    }
    if (!opts?.auto && this.isBusy(sessionId)) {
      this.deferManualResumeUntilIdle(sessionId, lookupBoundary, state);
      return;
    }
    if (!opts?.auto) this.claimDeferredManualResume(sessionId, lookupBoundary);
    // 用户显式恢复 = 给一次干净的重来机会,连续过载计数清零(否则上次被过载掐停
    // 的目标一恢复就立刻又撞上限)。
    // **自动续跑(opts.auto)绝不清零**:到点自动续跑正是过载循环的一环,在这里清
    // 等于让计数永远回到 0,止损闸门形同不存在。
    if (!opts?.auto) {
      this.consecutiveOverloadTurns.delete(sessionId);
      this.dispatchRejectionRetries.delete(sessionId);
    }
    const budgetAlreadyExhausted = exceedsGoalBudget(state);
    if (!budgetAlreadyExhausted) {
      let ensured: SessionLike | undefined;
      try {
        ensured = await this.deps.ensureSession(sessionId);
      } catch (error) {
        if (!opts?.auto) {
          this.cancelDeferredManualResume(sessionId, { restoreUsageResume: true });
        }
        if (this.turns.get(sessionId) === lookupBoundary) this.turns.delete(sessionId);
        throw new GoalSessionRestoreError(error);
      }
      if (this.turns.get(sessionId) !== lookupBoundary) return;
      if (!ensured) {
        if (opts?.auto) {
          if (this.turns.get(sessionId) === lookupBoundary) this.turns.delete(sessionId);
          return;
        }
        this.completeDeferredManualResume(sessionId);
        this.cancelUsageResume(sessionId);
        await this.blockDispatchFailure(
          sessionId,
          lookupBoundary,
          'turn dispatch failed: unable to restore the agent session',
          () => this.turns.get(sessionId) === lookupBoundary,
        );
        throw new GoalSessionRestoreError();
      }
      if (!opts?.auto && this.isBusy(sessionId)) {
        this.deferManualResumeUntilIdle(sessionId, lookupBoundary, state);
        return;
      }
    }
    let updated: GoalState | null;
    try {
      updated = await this.trackPersistence(
        lookupBoundary,
        this.deps.storage.update(sessionId, {
          status: 'active',
          noProgressStreak: 0, // 给一次干净续跑机会(原暂停可能正是空轮触顶)
          usageResetAt: null, // 恢复后清掉限额重置标记
          lastReason: null,
          updatedAt: this.now(),
        }),
      );
    } catch (error) {
      if (!opts?.auto) {
        this.cancelDeferredManualResume(sessionId, { restoreUsageResume: true });
      }
      if (ownsLookupBoundary && this.turns.get(sessionId) === lookupBoundary) {
        this.turns.delete(sessionId);
      }
      throw error;
    }
    if (this.turns.get(sessionId) !== lookupBoundary) return;
    if (!updated) {
      if (!opts?.auto) {
        this.cancelDeferredManualResume(sessionId, { restoreUsageResume: true });
      }
      if (ownsLookupBoundary && this.turns.get(sessionId) === lookupBoundary) {
        this.turns.delete(sessionId);
      }
      return;
    }
    if (!opts?.auto) this.completeDeferredManualResume(sessionId);
    // usageLimited 的 reset timer 必须活到 active 写真正提交；否则 deferred Resume 在
    // close/replacement 或持久化失败前被取消时，会同时失去手动意图和唯一自动恢复机会。
    this.cancelUsageResume(sessionId);
    // 并发 Resume 可能已经在同一个 lookup owner 上登记了另一笔 active 写；新 active
    // owner 必须继承整个 barrier，后续 Stop 才能等所有较早 Resume settle 后最后写 paused。
    const resumedBoundary = freshTurn(
      false,
      lookupBoundary.pendingPersistence,
      lookupBoundary.pendingCompletion,
    );
    this.turns.set(sessionId, resumedBoundary);
    this.attachListener(sessionId);
    this.emit(updated);
    if (!this.isBusy(sessionId)) {
      await this.fireTurn(sessionId, { throwOnRestoreFailure: !opts?.auto });
    }
  }

  /**
   * idle 兜底(#9):会话转 idle 时由 main 的 turn-complete observer 调用。
   * 有待兑现的手动 Resume 时先在防抖边界后重试；否则仅当该会话有 controller 挂着的
   * active goal(unsubscribers.has)、未在 firing、会话空闲时,走防抖续跑路径补一轮。
   * **race-free**:scheduleContinuation 幂等
   * (清旧 timer)、stopSession 会清 timer、fireTurn 内再从 storage 重校 status——
   * 与 finalizeTurn 的 scheduleContinuation 任意交错都只会有一次有效续跑。
   * dormant(没挂 listener)的 goal 不归这里管,由 resume-on-open 处理。
   */
  async maybeContinueActiveGoal(sessionId: string): Promise<void> {
    if (this.deferredManualResumes.has(sessionId)) {
      this.scheduleDeferredManualResume(sessionId);
      return;
    }
    if (!this.unsubscribers.has(sessionId)) return;
    if (this.firing.has(sessionId)) return;
    const state = await this.deps.storage.get(sessionId);
    if (!state || state.status !== 'active') return;
    // 不在这里查 isBusy:本方法由 turn 收尾 observer 调用,而 turn idle 标记是延迟生效的
    // (scheduleIdleAfterTerminalBroadcast),此刻查 isBusy 多半仍为真。改走防抖续跑:
    // scheduleContinuation 幂等(与 finalizeTurn 的调度互斥),且其 timer 回调 fireTurn 会
    // 在真正发轮前重新校验 isBusy + status —— 等到那时(150ms 后)turn 已 idle。
    this.scheduleContinuation(sessionId);
  }

  /** Session lifecycle superseded the pending Resume; cancel it without changing Goal state. */
  cancelDeferredManualResume(
    sessionId: string,
    opts?: { restoreUsageResume?: boolean },
  ): void {
    this.clearDeferredManualResumeRetry(sessionId);
    const context = this.deferredManualResumeContexts.get(sessionId);
    this.deferredManualResumeContexts.delete(sessionId);
    if (!context) return;
    // 普通 Stop / clear / setGoal 仍要继承当前 barrier；只有 session teardown 或提交失败
    // 需要把本次 deferred Resume 自己登记的 boundary 精确释放，让恢复后的 usage timer 可跑。
    if (
      opts?.restoreUsageResume &&
      this.turns.get(sessionId) === context.boundary
    ) {
      this.turns.delete(sessionId);
    }
    if (
      opts?.restoreUsageResume &&
      context.usageResetAt != null &&
      !this.usageResumeTimers.has(sessionId)
    ) {
      this.scheduleUsageResume(sessionId, context.usageResetAt);
    }
  }

  /** GET_GOAL_STATUS:返回当前状态扁平 payload(无 goal 返回 null)。 */
  async getStatus(sessionId: string): Promise<GoalStatusPayload | null> {
    const state = await this.deps.storage.get(sessionId);
    return state ? toPayload(state) : null;
  }

  /**
   * resume-on-open(#review):重启后未活会话的 active 目标是 **dormant** —— resumeActiveGoals
   * 不会硬 spawn,留着 status=active 但无 listener/timer。用户**打开该会话**时(renderer
   * useGoalStatus 拉状态)调用此方法把它接着续上:active ∧ 当前未挂 listener(dormant)→
   * ensureSession 活化 + 挂 listener + 空闲则续一轮。已在管 / 非 active 时 no-op；
   * 活化失败则转 blocked 并给出可见原因，不能继续显示成正在推进。
   * 这样重开会话能让 active 目标自己跑下去,而不是卡死等用户重发 /goal。
   */
  async resumeOnOpen(
    sessionId: string,
    opts?: { waitForDispatch?: boolean },
  ): Promise<void> {
    const pendingFailure = this.unpersistedDispatchFailures.get(sessionId);
    if (pendingFailure) {
      const persisted = await this.blockDispatchFailure(
        sessionId,
        pendingFailure.boundary,
        pendingFailure.lastReason,
        () => this.turns.get(sessionId) === pendingFailure.boundary,
      );
      if (!persisted) throw new GoalSessionRestoreError();
      return;
    }
    if (this.unsubscribers.has(sessionId) || this.turns.has(sessionId)) return; // 已在管或正在 Stop
    const lifecycleBoundary = freshTurn();
    this.turns.set(sessionId, lifecycleBoundary);
    let state: GoalState | null;
    try {
      state = await this.deps.storage.get(sessionId);
    } catch (error) {
      if (this.turns.get(sessionId) === lifecycleBoundary) this.turns.delete(sessionId);
      throw error;
    }
    if (this.turns.get(sessionId) !== lifecycleBoundary) return;
    if (!state || state.status !== 'active') {
      if (this.turns.get(sessionId) === lifecycleBoundary) this.turns.delete(sessionId);
      return; // 只续 active dormant;paused/blocked 走手动 resume
    }
    // deferred agent switch 的 commit 会关闭旧 live session。必须在 ensureSession
    // 之前执行,随后重新读取/bootstrap 的才是目标引擎;否则这一轮 directive 会继续
    // 发给 fireTurn 开始时捕获的旧 session。
    let releaseAgentSwitchLock = (): void => {};
    let session: SessionLike | undefined;
    let restoreFailed = false;
    let restoreError: unknown;
    try {
      releaseAgentSwitchLock =
        (await this.deps.acquirePendingAgentSwitch?.(sessionId)) ?? (() => {});
      if (this.turns.get(sessionId) !== lifecycleBoundary) return;
      session = await this.deps.ensureSession(sessionId);
      if (this.turns.get(sessionId) !== lifecycleBoundary) return;
      if (session) {
        // 锁内先建立 listener 身份。释放后即使 queued SET_MODEL 立刻关闭该 session，
        // fireTurn 也能凭 unsubscribers 标记把 listener 迁移到重新创建的新 session。
        this.attachListener(sessionId);
      }
    } catch (error) {
      restoreFailed = true;
      restoreError = error;
    } finally {
      try {
        releaseAgentSwitchLock();
      } catch (error) {
        restoreFailed = true;
        restoreError ??= error;
      }
    }
    if (restoreFailed) {
      this.deps.logger.warn('[goal] resumeOnOpen: session restore failed', {
        sessionId,
        error: String(restoreError),
      });
      const persisted = await this.blockDispatchFailure(
        sessionId,
        lifecycleBoundary,
        'turn dispatch failed: unable to restore the agent session',
        () => this.turns.get(sessionId) === lifecycleBoundary,
      );
      if (!persisted) throw new GoalSessionRestoreError(restoreError);
      return;
    }
    if (!session) {
      const persisted = await this.blockDispatchFailure(
        sessionId,
        lifecycleBoundary,
        'turn dispatch failed: unable to restore the agent session',
        () => this.turns.get(sessionId) === lifecycleBoundary,
      );
      if (!persisted) throw new GoalSessionRestoreError();
      return;
    }
    if (this.turns.get(sessionId) !== lifecycleBoundary) return;
    this.emit(state);
    if (!this.isBusy(sessionId)) {
      const dispatch = this.fireTurn(sessionId, {
        throwOnUnpersistedRestoreFailure: true,
      });
      if (opts?.waitForDispatch === false) {
        void dispatch.catch((error) => {
          this.deps.logger.warn('[goal] detached resume-on-open fire failed', {
            sessionId,
            error: String(error),
          });
        });
      } else {
        await dispatch;
      }
    }
  }

  /**
   * 启动 resume:对每条 active goal 确保会话活着(必要时按存档 resume / spawn agent)、
   * 重挂 listener,空闲则继续推进。这样重启后 active 目标会自己接着跑,而不是卡成
   * "active 却永远不动"的 dormant 死状态。
   */
  async resumeActiveGoals(): Promise<void> {
    const active = await this.deps.storage.listActive();
    let resumed = 0;
    for (const snapshot of active) {
      // listActive 是启动扫描快照；并发 Stop 可能已经立 cancelled boundary 或写成 paused。
      if (this.turns.has(snapshot.sessionId)) continue;
      const state = await this.deps.storage.get(snapshot.sessionId);
      if (!state || state.status !== 'active' || this.turns.has(snapshot.sessionId)) continue;
      // 保守:只对**已经活着**的会话重挂 + 续跑;不在启动时强行 spawn agent
      //(开机就偷偷跑目标过于激进)。没活的留 dormant,等用户重发 /goal 时由
      // setGoal 的 ensureSession 接管。
      const session = this.deps.getSession(state.sessionId);
      if (!session) {
        this.deps.logger.info('[goal] active goal session not live; dormant until next /goal', {
          sessionId: state.sessionId,
        });
        continue;
      }
      this.turns.set(state.sessionId, freshTurn());
      this.attachListener(state.sessionId);
      this.emit(state);
      resumed += 1;
      if (!this.isBusy(state.sessionId)) {
        void this.fireTurn(state.sessionId).catch((error) => {
          this.deps.logger.warn('[goal] detached startup fire failed', {
            sessionId: state.sessionId,
            error: String(error),
          });
        });
      }
    }
    if (active.length > 0) {
      this.deps.logger.info('[goal] resumed active goals', { total: active.length, resumed });
    }

    // usageLimited 行:重启后 timer 丢了,按存档的 usageResetAt 重排自动续跑
    //(已过点 → delay 0 触发;未知 resetAt → 不排,留待手动 resume)。
    const limited = await this.deps.storage.listUsageLimited();
    let rescheduled = 0;
    for (const g of limited) {
      if (g.usageResetAt == null) continue;
      this.scheduleUsageResume(g.sessionId, g.usageResetAt);
      rescheduled += 1;
    }
    if (limited.length > 0) {
      this.deps.logger.info('[goal] rescheduled usage-limited goals', { total: limited.length, rescheduled });
    }
  }

  /** 关停所有监听 + 计时器(测试 / 进程退出)。 */
  dispose(): void {
    for (const sessionId of [...this.unsubscribers.keys()]) {
      this.stopSession(sessionId);
    }
    for (const sessionId of [...this.usageResumeTimers.keys()]) {
      this.cancelUsageResume(sessionId);
    }
    for (const sessionId of [...this.deferredManualResumeTimers.keys()]) {
      this.cancelDeferredManualResume(sessionId);
    }
    this.deferredManualResumes.clear();
    this.deferredManualResumeContexts.clear();
    this.unpersistedDispatchFailures.clear();
    this.turns.clear();
    this.consecutiveOverloadTurns.clear();
    this.dispatchRejectionRetries.clear();
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 停止对某 session 的一切续跑活动(detach listener + 清 timer/firing/turn)。不删行。 */
  private stopSession(sessionId: string): void {
    const off = this.unsubscribers.get(sessionId);
    if (off) {
      try { off(); } catch { /* ignore */ }
      this.unsubscribers.delete(sessionId);
    }
    this.listenerSessions.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    const pendingDispatch = this.goalDispatchAbortControllers.get(sessionId);
    if (pendingDispatch) {
      this.goalDispatchAbortControllers.delete(sessionId);
      pendingDispatch.controller.abort();
    }
    this.firing.delete(sessionId);
    this.goalTurnsInFlight.delete(sessionId);
    this.dispatchRejectionRetries.delete(sessionId);
    this.unpersistedDispatchFailures.delete(sessionId);
    this.turns.delete(sessionId);
  }

  /**
   * 开始下一轮时原地清 accumulator，保留稳定的 Goal 生命周期 owner。
   * 显式 Stop / Resume / setGoal 会另建 owner；generation 只用于淘汰旧 turn finalizer。
   */
  private resetTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn || turn.cancelled) return;
    turn.text = '';
    turn.sawToolUse = false;
    turn.tokensThisTurn = 0;
    turn.continuationTokens = 0;
    turn.finalized = false;
    turn.generation += 1;
  }

  /**
   * 登记已经启动的 Goal 状态写入。显式生命周期接管会先同步换 owner，再等待这里的
   * barrier，保证旧写全部 settle 后才提交自己的最终状态；写入本身仍可并发执行。
   */
  private trackPersistence<T>(
    turn: TurnAccumulator,
    operation: Promise<T>,
    afterPersist?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    const committed = operation.then(async (value) => {
      await afterPersist?.(value);
      return value;
    });
    const settled = committed.then(
      () => undefined,
      () => undefined,
    );
    const previous = turn.pendingPersistence;
    const barrier = previous
      ? Promise.all([previous, settled]).then(() => undefined)
      : settled;
    turn.pendingPersistence = barrier;
    void barrier.then(() => {
      if (turn.pendingPersistence === barrier) turn.pendingPersistence = null;
    });
    return committed;
  }

  private async awaitPendingPersistence(turn: TurnAccumulator | undefined): Promise<void> {
    while (turn?.pendingPersistence) {
      const pending = turn.pendingPersistence;
      await pending;
      if (turn.pendingPersistence === pending) {
        turn.pendingPersistence = null;
        return;
      }
    }
  }

  /**
   * completion commit 保持“达成记录 → clear”的耐久顺序，但不进入 Stop 的等待集合。
   * setGoal / update / resume 等会等待它，确保旧 clear 绝不落在新目标写入之后。
   */
  private trackCompletion<T>(turn: TurnAccumulator, operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    const previous = turn.pendingCompletion;
    const barrier = previous
      ? Promise.all([previous, settled]).then(() => undefined)
      : settled;
    turn.pendingCompletion = barrier;
    void barrier.then(() => {
      if (turn.pendingCompletion === barrier) turn.pendingCompletion = null;
    });
    return operation;
  }

  private async awaitPendingLifecycle(turn: TurnAccumulator | undefined): Promise<void> {
    while (turn?.pendingPersistence || turn?.pendingCompletion) {
      const persistence = turn.pendingPersistence;
      const completion = turn.pendingCompletion;
      await Promise.all([
        persistence ?? Promise.resolve(),
        completion ?? Promise.resolve(),
      ]);
      if (turn.pendingPersistence === persistence) turn.pendingPersistence = null;
      if (turn.pendingCompletion === completion) turn.pendingCompletion = null;
    }
  }

  private isBusy(sessionId: string): boolean {
    if (this.firing.has(sessionId)) return true;
    // PI may acknowledge prompt acceptance before agent_start flips the
    // provider running flag. Goal ownership bridges that acceptance gap.
    if (this.goalTurnsInFlight.has(sessionId)) return true;
    if (this.deps.isSessionInTurn(sessionId)) return true;
    const session = this.deps.getSession(sessionId);
    return session ? session.isTurnRunning() : false;
  }

  private emit(state: GoalState): void {
    this.deps.emitStatus({ sessionId: state.sessionId, goal: toPayload(state) });
  }

  /**
   * 幂等挂一个持久 onEvent listener(覆盖整个 goal 生命周期,跨多个 turn)。
   * 按 **session 对象身份** 判等:已绑到同一 live session → no-op;live session
   * 已被换新(deferred agent switch commit 关旧 + spawn 新引擎)→ 先 detach 旧
   * listener 再重挂到新 session,保证新引擎 turn 的 done/error 事件仍进 finalizeTurn。
   */
  private attachListener(sessionId: string): void {
    const session = this.deps.getSession(sessionId);
    if (!session) return;
    if (this.unsubscribers.has(sessionId)) {
      if (this.listenerSessions.get(sessionId) === session) return; // 已绑到同一 session
      // session 被 agent switch 换掉了 → 迁移 listener 到新对象。
      try { this.unsubscribers.get(sessionId)?.(); } catch { /* ignore */ }
    }
    const off = session.onEvent((event) => {
      try {
        this.onEvent(sessionId, event);
      } catch (e) {
        this.deps.logger.error('[goal] event handler threw', { sessionId, error: String(e) });
      }
    });
    this.unsubscribers.set(sessionId, off);
    this.listenerSessions.set(sessionId, session);
  }

  private onEvent(sessionId: string, event: AgentEvent): void {
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = freshTurn();
      this.turns.set(sessionId, turn);
    }
    if (turn.cancelled) return;
    switch (event.type) {
      case 'text': {
        const d = event.data as { text?: string; isFinal?: boolean } | null;
        if (d && typeof d.text === 'string') {
          if (d.isFinal) turn.text = d.text;
          else turn.text += d.text;
        }
        return;
      }
      case 'tool_use': {
        turn.sawToolUse = true;
        return;
      }
      case 'status': {
        // Claude:status 的 tokenUsage 是"单 turn 累计(input+output),turn end reset"(见 events.ts
        // UsageSnapshot),per-turn 语义正确,直接用。Codex:status 是累积上下文快照(随轮次涨),
        // 会在下面 'done' 分支被 done.data.usage 的 per-turn 真实量覆盖,所以这里取到 Codex 的
        // 快照值也无妨(done 必在 status 之后到)。
        const d = event.data as { isRunning?: boolean; tokenUsage?: number } | null;
        if (d && d.isRunning === false && typeof d.tokenUsage === 'number') {
          if (isTurnContinuationBoundaryEvent(event)) {
            turn.continuationTokens += Math.max(0, d.tokenUsage);
          } else {
            turn.tokensThisTurn = turn.continuationTokens + Math.max(0, d.tokenUsage);
          }
        }
        return;
      }
      case 'done': {
        if (isTurnContinuationBoundaryEvent(event)) return;
        // AgentInputCoordinator releases the input boundary on the same terminal
        // event and may immediately start a queued user turn. Drop Goal ownership
        // synchronously here, before finalizeTurn awaits storage, so Clear cannot
        // mistake that new user turn for the completed Goal turn and abort it.
        if (event.turnOrigin?.kind === 'goal') {
          this.goalTurnsInFlight.delete(sessionId);
        }
        // Codex 的 per-turn 真实用量在 done.data.usage(promptTokens/completionTokens,
        // 见 maker-core codex/index.ts task_complete:"永远是 per-turn 增量")。优先用它覆盖
        // status 带来的累积上下文快照,避免 Codex 目标的 token 预算随上下文增长过早触顶。
        // Claude 的 done.data 是 SDKResultMessage(usage 走 input_tokens/output_tokens),无
        // promptTokens/completionTokens → 不命中,沿用上面 status 的 per-turn tokenUsage。
        const u = (event.data as { usage?: { promptTokens?: number; completionTokens?: number } } | null)?.usage;
        if (u && (typeof u.promptTokens === 'number' || typeof u.completionTokens === 'number')) {
          turn.tokensThisTurn =
            turn.continuationTokens +
            Math.max(0, (u.promptTokens ?? 0) + (u.completionTokens ?? 0));
        }
        void this.finalizeTurn(sessionId, event, false);
        return;
      }
      default: {
        if (isTerminalAgentErrorEvent(event)) {
          if (event.turnOrigin?.kind === 'goal') {
            this.goalTurnsInFlight.delete(sessionId);
          }
          void this.finalizeTurn(sessionId, event, true);
        }
        return;
      }
    }
  }

  private async finalizeTurn(sessionId: string, event: AgentEvent, errored: boolean): Promise<void> {
    const turn = this.turns.get(sessionId);
    // Stop / Pause 会同步删除当前 turn。已经跨过 async 边界的旧 finalize 必须把这个
    // 对象身份当作取消令牌：否则它可能在 paused 落库之后继续把状态写回 active，表现为
    // 用户刚点 Stop 就立刻重新 Running。resume 会创建新 turn，因此也不能只检查 key 存在。
    if (!turn || turn.cancelled || turn.finalized) return;
    turn.finalized = true; // done + 终止 error 双触发去重(同步置位,后续 await 不影响去重)
    const generation = turn.generation;
    const isCurrentTurn = (): boolean =>
      this.turns.get(sessionId) === turn && turn.generation === generation;

    const state = await this.deps.storage.get(sessionId);
    if (!isCurrentTurn()) return;
    // goal 已不存在(被 clear)→ 收尾 detach。
    if (!state) {
      this.stopSession(sessionId);
      return;
    }
    // 本轮期间目标已被 pause / clear(状态不再是 active)→ 不再裁决,停续跑。
    if (state.status !== 'active') {
      this.resetTurn(sessionId);
      this.stopSession(sessionId);
      return;
    }

    const origin: 'goal' | 'other' = event.turnOrigin?.kind === 'goal' ? 'goal' : 'other';
    const errorMessage = errored ? extractErrorMessage(event.data) : undefined;
    // 连续过载计数:自动续跑的止损闸门。三道预算护栏都可能没设,过载轮又不产出
    // token、不推进 noProgressStreak,所以必须有一个不依赖用户配置的上限。
    // 本轮不是过载(成功、真错、或用户 Stop)→ 立刻清零,只掐"连续"过载。
    const isOverloadTurn = errored && classifyTurnOverload(event.data);
    if (!isOverloadTurn) {
      this.consecutiveOverloadTurns.delete(sessionId);
    }
    const overloadStreak = isOverloadTurn
      ? (this.consecutiveOverloadTurns.get(sessionId) ?? 0) + 1
      : 0;
    if (isOverloadTurn) this.consecutiveOverloadTurns.set(sessionId, overloadStreak);
    // `>=`：streak 达到上限的那一轮就停。用 `>` 会让 1/2/3 各续一轮、直到第 4 轮
    // 才判死，实际变成 4 轮 ≈ 20 次上游请求，与承诺的 3 轮 15 次不符
    // （review #844 codex P1）。
    const overloadBudgetExhausted = overloadStreak >= MAX_CONSECUTIVE_OVERLOAD_TURNS;
    if (overloadBudgetExhausted) {
      this.deps.logger.warn('[goal] consecutive overload turns exhausted — stopping auto-resume', {
        sessionId,
        overloadStreak,
        max: MAX_CONSECUTIVE_OVERLOAD_TURNS,
      });
    }
    const outcome: TurnOutcome = {
      origin,
      sawToolUse: turn?.sawToolUse ?? false,
      tokensThisTurn: turn?.tokensThisTurn ?? 0,
      verdict: origin === 'goal' ? parseVerdict(turn?.text ?? '') : null,
      errored,
      errorMessage,
      // 被动检测:本轮以"账号限流"或"上游没容量"型 error 收尾 → 标记,
      // decideNextGoalState 据此置 usageLimited(非终态、到点自动续)。
      // **过载优先判**:529 同时命中两条判定,但只有过载分支能拿到可用的 resetAt
      // ——走限额分支会因 getAccountLimit 不报 limited 而停在原地等人手动 resume。
      // 连续过载超上限后不再当可恢复态:命中过载但预算已耗尽时留空 errorKind,
      // 落回真错分支(blocked)。注意这只收紧过载——真账号限流不受本计数影响,
      // 它有自己的 resetAt 恢复路径。
      ...(errored && isOverloadTurn
        ? overloadBudgetExhausted
          ? {}
          : { errorKind: 'overload' as const }
        : errored && classifyTurnUsageLimit(event.data)
          ? { errorKind: 'usage_limit' as const }
          : {}),
    };
    const decision = decideNextGoalState(
      {
        status: state.status,
        turnsUsed: state.turnsUsed,
        tokensUsed: state.tokensUsed,
        noProgressStreak: state.noProgressStreak,
        budgetTokens: state.budgetTokens,
        maxTurns: state.maxTurns,
        noProgressLimit: state.noProgressLimit,
      },
      outcome,
    );

    // complete 收尾(产品决策):不写 'complete' 行,而是在对话里留一条**持久**达成
    // 记录(role:'assistant' + agentMeta.goalCompletion,重开会话仍在),随后删 goal
    // 行让 chip 消失。视觉由 renderer 渲成"目标已达成 · N 轮 · 耗时 X"分隔条。
    if (decision.status === 'complete') {
      // completion commit 保持“达成记录 → clear”的耐久顺序，但单独登记：Stop 会同步
      // detach 并把 paused 落盘后立即返回；新 setGoal / update / resume 则必须等旧 clear，
      // 防止旧目标的删除迟到并抹掉新目标。
      const elapsedMs = Math.max(0, this.now() - state.startedAt);
      await this.trackCompletion(
        turn,
        (async () => {
          if (this.deps.persistGoalCompletion) {
            try {
              await this.deps.persistGoalCompletion(sessionId, {
                turnsUsed: decision.turnsUsed,
                tokensUsed: decision.tokensUsed,
                elapsedMs,
                reason: decision.lastReason,
              });
            } catch (e) {
              this.deps.logger.warn('[goal] persistGoalCompletion failed', { sessionId, error: String(e) });
            }
          }
          await this.deps.storage.clear(sessionId);
          // null emit 属于同一顺序提交；后续新目标必须在它之后再 emit active，
          // 否则旧 completion 的迟到 null 会把新 chip 隐藏。
          this.deps.emitStatus({ sessionId, goal: null });
        })(),
      );
      if (isCurrentTurn()) this.stopSession(sessionId);
      return;
    }

    // 账号用量受限改判:
    //  - 被动:decision 已是 usageLimited(本轮限流型 error)→ 读快照补 resetAt。
    //  - 主动:本应续跑(shouldFire),但 getAccountLimit 显示已限流 → 改判 usageLimited,不续。
    let status = decision.status;
    let lastReason = decision.lastReason;
    let shouldFire = decision.shouldFire;
    let usageResetAt: number | null = null;
    // 过载改判:上游没容量与账号限流是两种恢复时机。这里用固定短窗口,不去查
    // getAccountLimit——账号并没有被限流,那个接口不会给出可用的 resetAt,查了只会
    // 让目标停在 usageLimited 等人手动 resume。
    if (status === 'usageLimited' && outcome.errorKind === 'overload') {
      usageResetAt = this.now() + OVERLOAD_RESUME_DELAY_MS;
      shouldFire = false;
    } else if (status === 'usageLimited' || shouldFire) {
      const limit = this.deps.getAccountLimit
        ? await this.deps.getAccountLimit(state.agentKind).catch(() => null)
        : null;
      if (!isCurrentTurn()) return;
      if (status === 'usageLimited') {
        usageResetAt = limit?.resetAtMs ?? null; // 被动:补 resetAt(可能拿不到→null,留待手动 resume)
        shouldFire = false;
      } else if (limit?.limited) {
        status = 'usageLimited';
        lastReason = 'usage limit reached';
        usageResetAt = limit.resetAtMs;
        shouldFire = false;
      }
    }

    // 目标改写(Option 1):模型澄清含糊目标后,经 refined_objective 报回更具体的目标。
    // 仅在目标继续推进(shouldFire)且新目标非空、与当前不同时确定性改写 storage.objective,
    // 让 chip 更新、后续续轮按新目标跑。终止/暂停态不改写(避免停掉的目标文案被无意义重写)。
    // refined_objective(回合末模型回报)作为 Option B 的**兜底**:仅当 B 没在本目标即时改写过
    // (clarificationApplied 未命中,如目标本就清晰没弹卡片 / 多问多选 B 跳过的情况)才采用,
    // 避免"B 即时改一次 + C 回合末又改一次"的目标跳变两次。
    const refined = outcome.verdict?.refinedObjective?.trim();
    const objectiveRewrite =
      shouldFire && refined && refined !== state.objective && !this.clarificationApplied.has(sessionId)
        ? refined
        : null;

    if (!isCurrentTurn()) return;
    const updated = await this.trackPersistence(
      turn,
      this.deps.storage.update(sessionId, {
        // active 是保持态，不是 transition；省略它可让迟到 continuation 写在任何
        // 防线失效时仍只能补计数，绝不能把显式 Stop 的 paused 改回 active。
        ...(status === 'active' ? {} : { status }),
        lastReason,
        turnsUsed: decision.turnsUsed,
        tokensUsed: decision.tokensUsed,
        noProgressStreak: decision.noProgressStreak,
        usageResetAt: status === 'usageLimited' ? usageResetAt : null,
        ...(objectiveRewrite ? { objective: objectiveRewrite } : {}),
        updatedAt: this.now(),
      }),
      async (persisted) => {
        // objective 与对应 marker 是同一个可观察提交；Stop 必须等二者都 settle，
        // 不能留下“文案已改但更新标记缺失”的半提交。
        if (objectiveRewrite && persisted) {
          await this.deps.persistUserMessage?.(sessionId, objectiveRewrite, {
            goalObjective: { updated: true },
          });
        }
      },
    );
    if (!isCurrentTurn()) return;
    if (updated) this.emit(updated);

    this.resetTurn(sessionId);

    if (shouldFire && updated?.status === 'active') {
      this.scheduleContinuation(sessionId);
    } else {
      // 停:budgetLimited(终态)/ blocked / paused / usageLimited 都 detach。
      this.stopSession(sessionId);
      // usageLimited 且知道重置时刻 → 排自动续跑(stopSession 不碰 usageResumeTimers)。
      if (status === 'usageLimited') this.scheduleUsageResume(sessionId, usageResetAt);
    }
  }

  private async blockDispatchFailure(
    sessionId: string,
    boundary: TurnAccumulator,
    lastReason: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) return true;
    try {
      const blocked = await this.trackPersistence(
        boundary,
        this.deps.storage.update(sessionId, {
          status: 'blocked',
          lastReason,
          updatedAt: this.now(),
        }),
      );
      if (!isCurrent()) return true;
      if (blocked) this.emit(blocked);
    } catch (persistError) {
      this.deps.logger.error('[goal] failed to persist dispatch failure', {
        sessionId,
        error: String(persistError),
      });
      if (isCurrent()) {
        const failClosedBoundary = freshTurn(
          true,
          boundary.pendingPersistence,
          boundary.pendingCompletion,
        );
        this.stopSession(sessionId);
        this.turns.set(sessionId, failClosedBoundary);
        this.unpersistedDispatchFailures.set(sessionId, {
          boundary: failClosedBoundary,
          lastReason,
        });
      }
      return false;
    }
    if (isCurrent()) this.stopSession(sessionId);
    return true;
  }

  private scheduleContinuation(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const rejectionRetry = this.dispatchRejectionRetries.get(sessionId);
    const delayMs = rejectionRetry
      ? Math.max(this.debounceMs, rejectionRetry.retryNotBefore - this.now())
      : this.debounceMs;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.fireTurn(sessionId).catch((error) => {
        this.deps.logger.warn('[goal] detached continuation fire failed', {
          sessionId,
          error: String(error),
        });
      });
    }, delayMs);
    // Node 环境;不 block 进程退出。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(sessionId, timer);
  }

  private deferManualResumeUntilIdle(
    sessionId: string,
    boundary: TurnAccumulator,
    state: Pick<GoalState, 'status' | 'usageResetAt'>,
  ): void {
    if (this.turns.get(sessionId) !== boundary) return;
    let deferredBoundary = boundary;
    if (!boundary.cancelled) {
      deferredBoundary = freshTurn(
        true,
        boundary.pendingPersistence,
        boundary.pendingCompletion,
      );
      this.stopSession(sessionId);
      this.turns.set(sessionId, deferredBoundary);
    }
    this.deferredManualResumes.add(sessionId);
    this.deferredManualResumeContexts.set(sessionId, {
      boundary: deferredBoundary,
      usageResetAt: state.status === 'usageLimited' ? state.usageResetAt : null,
    });
    // busy 可能只来自一个尚未 dispatch 的旧 Goal fire；上面的 stopSession 已同步
    // 取消它，不会再有 turn terminal 触发 idle observer。此时主动排一次即可。
    if (!this.isBusy(sessionId)) this.scheduleDeferredManualResume(sessionId);
  }

  private rebindDeferredManualResumeBoundary(
    sessionId: string,
    boundary: TurnAccumulator,
  ): void {
    const context = this.deferredManualResumeContexts.get(sessionId);
    if (!context) return;
    this.deferredManualResumeContexts.set(sessionId, { ...context, boundary });
  }

  private claimDeferredManualResume(sessionId: string, boundary: TurnAccumulator): void {
    if (!this.deferredManualResumeContexts.has(sessionId)) return;
    this.clearDeferredManualResumeRetry(sessionId);
    this.rebindDeferredManualResumeBoundary(sessionId, boundary);
  }

  private completeDeferredManualResume(sessionId: string): void {
    this.clearDeferredManualResumeRetry(sessionId);
    this.deferredManualResumeContexts.delete(sessionId);
  }

  private clearDeferredManualResumeRetry(sessionId: string): void {
    this.deferredManualResumes.delete(sessionId);
    const timer = this.deferredManualResumeTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.deferredManualResumeTimers.delete(sessionId);
  }

  private scheduleDeferredManualResume(sessionId: string): void {
    if (!this.deferredManualResumes.has(sessionId)) return;
    const existing = this.deferredManualResumeTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.deferredManualResumeTimers.delete(sessionId);
      if (!this.deferredManualResumes.has(sessionId)) return;
      void this.resumeGoal(sessionId).catch((error) => {
        this.deps.logger.warn('[goal] deferred manual resume failed', {
          sessionId,
          error: String(error),
        });
      });
    }, this.debounceMs);
    (timer as { unref?: () => void }).unref?.();
    this.deferredManualResumeTimers.set(sessionId, timer);
  }

  /**
   * usageLimited 到点自动续跑:resetAtMs 已知则排 timer(已过点 → delay 0 下一 tick 触发);
   * null = 不知道何时恢复,不排 timer,留待用户手动 resume。幂等(清旧 timer)。
   */
  private scheduleUsageResume(sessionId: string, resetAtMs: number | null): void {
    this.cancelUsageResume(sessionId);
    if (resetAtMs == null) return;
    // clamp 到 setTimeout 的 32-bit 上限(~24.8 天):否则超大 delay 会溢出、被当成 1ms
    // 立刻触发(限额窗口正常是 5h / weekly,远小于上限;clamp 只是防御异常 resetAt)。
    const delay = Math.min(Math.max(0, resetAtMs - this.now()), 2_147_483_647);
    const timer = setTimeout(() => {
      void this.autoResumeFromUsageLimit(sessionId).catch((error) => {
        this.deps.logger.warn('[goal] detached usage resume failed', {
          sessionId,
          error: String(error),
        });
      });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.usageResumeTimers.set(sessionId, timer);
  }

  private cancelUsageResume(sessionId: string): void {
    const t = this.usageResumeTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.usageResumeTimers.delete(sessionId);
    }
  }

  /**
   * 退避窗口到点了:若仍 usageLimited,落一条提示后 resume 续跑。
   *
   * 注意这里**没有任何探测**:账号限流用的是账号额度给的重置时刻,过载用的是固定
   * 60s 干等。所以过载那条提示只能说"正在重试",不能说"已恢复"(见 noticeKind)。
   */
  private async autoResumeFromUsageLimit(sessionId: string): Promise<void> {
    this.usageResumeTimers.delete(sessionId);
    // usageLimited 停驻态正常没有 turn owner。为本次 timer 建一代临时 owner，所有 await
    // 都用对象身份复核；Stop 会同步换成 fresh cancelled owner，旧自动恢复因而不能落提示、
    // 不能恢复，也不会误删 Stop 的新边界。已有 owner 表示其它生命周期操作正在接管。
    if (this.turns.has(sessionId)) return;
    const lifecycleBoundary = freshTurn();
    this.turns.set(sessionId, lifecycleBoundary);
    const isCurrent = (): boolean => this.turns.get(sessionId) === lifecycleBoundary;

    try {
      const state = await this.deps.storage.get(sessionId).catch(() => null);
      if (!isCurrent()) return;
      if (!state || state.status !== 'usageLimited') return; // 用户可能已 clear / 手动 resume
      // 预算已经用尽时一条都不该说：下面的 resumeGoal → fireTurn 有 preflight 预算守卫，
      // 会立刻把目标转成 budgetLimited、一轮都不发，而这张卡片已经落库，会在会话里永久
      // 留下一句「正在重试目标 / 用量已恢复」——那次重试根本没发生（review #844 codex P1）。
      // 判据与 fireTurn 用的是同一个 exceedsGoalBudget，结论必然一致；仍照常走 resumeGoal，
      // 由它把状态转成 budgetLimited。
      const budgetAlreadyExhausted = exceedsGoalBudget(state);
      // 同理的第二种"这条重试根本没发生":会话此刻拿不到 live session(已关闭 / 暂时 hydrate
      // 不出来)。resumeGoal 忽略 ensureSession 的结果、照样把目标转 active,而 fireTurn 拿不到
      // session 就直接 return —— 既没有 listener 也没有续跑 timer,目标停在 active 不动,而卡片
      // 已经落库说"正在重试目标"(review #844 codex P1)。
      //
      // 这里先探一次:拿不到就**原样留在 usageLimited**(可恢复态)——存档里 usageResetAt 还在,
      // 用户手动 resume 或下次启动的 usageLimited 重排(见 start() 里按 listUsageLimited 补排
      // timer)都会再试一次;既不落假卡片,也不把目标推进一个停滞的 active。
      // 刻意不在这里重排 timer:hydrate 不出来通常不是几十秒能自愈的,循环重排只会空转。
      // ensureSession 是幂等的 ensure 语义,下面 resumeGoal 再调一次拿到的是同一个 session。
      // **预算已耗尽的目标不需要 live session 就能收口**: fireTurn 的预算 preflight 跑在
      // ensureSession 之前, 会把状态转成 budgetLimited(终态)并 stopSession。把下面的
      // hydrate 守卫排在它前面, 会让这种目标停在 usageLimited + 已过期的 usageResetAt,
      // 直到手动 resume 或进程重启才收口(review #844 codex P1)。
      const liveSession = budgetAlreadyExhausted
        ? null
        : await this.deps.ensureSession(sessionId).catch(() => null);
      if (!isCurrent()) return;
      if (!budgetAlreadyExhausted && !liveSession) {
        this.deps.logger.warn('[goal] skipped auto resume — no live session; staying usageLimited', {
          sessionId,
          lastReason: state.lastReason ?? null,
        });
        return;
      }
      if (this.deps.persistGoalNotice && !budgetAlreadyExhausted) {
        // 过载与账号限流共用 usageLimited 状态和这同一个 timer，但说法必须分开：
        // 账号从没被限流时报「额度已重置」是假信息（review #844 codex P1）。
        // 判据用存档的 lastReason 而不是内存计数——后者在进程重启后会丢，而
        // usageLimited 目标恰好会在重启后按存档的 usageResetAt 重排 timer。
        const noticeKind =
          state.lastReason === OVERLOAD_LAST_REASON ? 'capacity-resumed' : 'usage-resumed';
        try {
          await this.deps.persistGoalNotice(sessionId, noticeKind);
        } catch (e) {
          this.deps.logger.warn('[goal] persistGoalNotice failed', { sessionId, error: String(e) });
        }
        if (!isCurrent()) return;
      } else if (budgetAlreadyExhausted) {
        this.deps.logger.info('[goal] skipped resume notice — budget already exhausted', {
          sessionId,
        });
      }
      // auto:true —— 这是到点自动续跑，不是用户显式恢复，不得清零连续过载计数。
      await this.resumeGoal(sessionId, { auto: true });
    } finally {
      // 早退 / resume no-op 时释放自己；成功 resume 会换成新的 active owner，Stop 会留下它的
      // cancelled owner，二者都不能被旧 timer 的 finally 删除。
      if (isCurrent()) this.turns.delete(sessionId);
    }
  }

  private async fireTurn(
    sessionId: string,
    opts?: {
      throwOnRestoreFailure?: boolean;
      throwOnUnpersistedRestoreFailure?: boolean;
    },
  ): Promise<void> {
    const lifecycleBoundary = this.turns.get(sessionId);
    if (!lifecycleBoundary || lifecycleBoundary.cancelled) return;
    const lifecycleGeneration = lifecycleBoundary.generation;
    const isCurrentLifecycle = (): boolean =>
      this.turns.get(sessionId) === lifecycleBoundary &&
      lifecycleBoundary.generation === lifecycleGeneration;
    let state: GoalState | null;
    try {
      state = await this.deps.storage.get(sessionId);
    } catch (error) {
      this.deps.logger.warn('[goal] fireTurn preflight state read failed', {
        sessionId,
        error: String(error),
      });
      const persisted = await this.blockDispatchFailure(
        sessionId,
        lifecycleBoundary,
        'turn dispatch failed: unable to read Goal state',
        isCurrentLifecycle,
      );
      if (!persisted && opts?.throwOnUnpersistedRestoreFailure) throw error;
      return;
    }
    // owner 身份拒绝 Stop / Resume 换代，generation 拒绝另一轮正常推进后的旧 fire；
    // 两者都不能只信上面读到的 active 存档快照。
    if (
      !state ||
      state.status !== 'active' ||
      !isCurrentLifecycle()
    ) return;
    // preflight 预算守卫:用户可能把 maxTurns/budgetTokens 调小到已超当前用量(updateGoal 会即时
    // 转 budgetLimited,但调度链上可能仍有在途 fireTurn / continuation timer 指向旧 active 状态)。
    // 超(新)预算就转 budgetLimited 并停,绝不越过新上限再发一轮(reviewer #354)。
    if (exceedsGoalBudget(state)) {
      const limited = await this.trackPersistence(
        lifecycleBoundary,
        this.deps.storage.update(sessionId, {
          status: 'budgetLimited',
          lastReason: 'budget limit reached',
          updatedAt: this.now(),
        }),
      );
      if (!isCurrentLifecycle()) return;
      this.stopSession(sessionId);
      if (limited) this.emit(limited);
      return;
    }
    const rejectionRetry = this.dispatchRejectionRetries.get(sessionId);
    if (
      rejectionRetry &&
      Math.max(0, this.now() - rejectionRetry.firstRejectedAt) >=
        DISPATCH_REJECTION_MAX_WINDOW_MS
    ) {
      this.deps.logger.warn('[goal] provider rejection retry window expired', {
        sessionId,
        attempts: rejectionRetry.attempts,
      });
      await this.blockDispatchFailure(
        sessionId,
        lifecycleBoundary,
        DISPATCH_REJECTION_BLOCK_REASON,
        isCurrentLifecycle,
      );
      return;
    }
    if (this.firing.has(sessionId)) return;
    // 首轮 vs 续轮由 state 派生(turnsUsed===0 = 首轮尚未真正跑完),不再由调用方指定。
    // 关键:首轮被 busy 跳过 / 被暂停后再发时,只要首轮还没跑过就仍按 first 发,否则首轮
    // 特有的"质量自检 + AskUserQuestion"约定(buildFirstTurnDirective)会丢,目标直接进
    // 续轮、永远不弹交互卡片。
    const kind: 'first' | 'continuation' = state.turnsUsed === 0 ? 'first' : 'continuation';
    if (this.isBusy(sessionId)) {
      // 会话忙 → 重排一次防抖重试,别丢这一轮(而非直接放弃)。
      // 首轮尤其关键:新建会话后 agent 可能仍在 spawn/init,isTurnRunning() 瞬时为真;旧实现
      // 直接丢弃首轮 → 目标永久卡在 active/0 轮、首轮指令从未下发(用户侧表现为"没有交互卡片、
      // 目标不动")。重试期间若真有用户 turn 抢跑,其收尾会把目标置 paused,届时重试见
      // status≠active 自然停,不会空转。
      this.deps.logger.info('[goal] session busy, retry fire soon', { sessionId, kind });
      this.scheduleContinuation(sessionId);
      return;
    }
    const firingOwner = {};
    this.firing.set(sessionId, firingOwner);
    const dispatchAbortController = new AbortController();
    this.goalDispatchAbortControllers.set(sessionId, {
      owner: firingOwner,
      controller: dispatchAbortController,
    });
    let dispatchBoundary: TurnAccumulator | undefined;
    let dispatchGeneration: number | undefined;
    const isCurrentDispatch = (): boolean =>
      dispatchBoundary != null &&
      dispatchGeneration != null &&
      this.turns.get(sessionId) === dispatchBoundary &&
      dispatchBoundary.generation === dispatchGeneration;
    let releaseAgentSwitchLock = (): void => {};
    let restoringSession = true;
    let baselineStarted = false;
    try {
      // fireTurn 每次都可能是登记 deferred intent 后的第一条直发消息。锁必须覆盖
      // apply、重新读取 live session 和 Session.send；否则并发 SET_MODEL 能在 fresh
      // session 创建后、send 前再次换 route，让本轮落到 UI 未显示的来源。
      releaseAgentSwitchLock =
        (await this.deps.acquirePendingAgentSwitch?.(sessionId)) ?? (() => {});
      if (!isCurrentLifecycle()) return;
      const session = await this.deps.ensureSession(sessionId);
      if (!isCurrentLifecycle()) return;
      if (!session) throw new GoalSessionRestoreError();
      restoringSession = false;
      // deferred switch 可能刚把 live session 换成目标引擎的新对象;本会话若有 goal
      // listener,必须迁到新 session,否则这轮 turn 的 done/error 事件进不了 finalizeTurn,
      // 目标卡死在 active(reviewer P1)。attachListener 按 session 身份判等,未换则 no-op;
      // 只对已在管(非 dormant)的 goal 重挂,不给 dormant 会话平白加 listener。
      if (this.unsubscribers.has(sessionId)) {
        this.attachListener(sessionId);
      }

      this.resetTurn(sessionId);
      dispatchBoundary = this.turns.get(sessionId);
      if (!dispatchBoundary) return;
      dispatchGeneration = dispatchBoundary.generation;
      const content =
        kind === 'first'
          ? buildFirstTurnDirective(state.objective, { maxTurns: state.maxTurns })
          : buildContinuationDirective(state.objective, state.lastReason);

      // 目标文案的落库只发生在 setGoal 创建 / 编辑时(各一次),不挂在这里 —— Fix A 后 kind
      // 由 turnsUsed 派生,'first' 可能被 busy 重试 / 暂停后重发,放这里会重复落库。
      // 这里只负责把完整 directive(含裁决约定)发给模型。
      if (this.deps.beforeDispatchUserTurn) {
        await this.deps.beforeDispatchUserTurn(sessionId);
        baselineStarted = true;
      }
      // session-agent-switch:本路径直发 session.send(不经 makerSendTransaction),
      // 交接注入自己接——切换后 goal 循环的下一轮 directive 同样要带交接上下文
      // (2026-07-20 审计)。
      const pendingHandoff = await agentHandoffPending.peek(sessionId);
      if (!isCurrentDispatch()) {
        if (baselineStarted) {
          this.deps.onUndispatchedUserTurn?.(sessionId);
          baselineStarted = false;
        }
        return;
      }
      const outgoing = pendingHandoff
        ? prependHandoffToUserMessage({ type: 'user', content }, pendingHandoff)
        : { type: 'user' as const, content };
      const result = await session.send(
        outgoing as { type: 'user'; content: string },
        {
          origin: { kind: 'goal', goalSessionId: sessionId },
          planMode: false,
          // Session.send 只在 vendor dispatch 前的最后一个同步边界调用它。不能等
          // send Promise 返回后才登记：派发调用尚未返回时用户点清除，clearGoal 必须
          // 已经知道这个 turn 属于目标模式，才能立即走 Stop 边界。
          onDispatching: () => {
            if (!isCurrentDispatch()) return;
            this.goalTurnsInFlight.add(sessionId);
            // signal 只负责取消 dispatch 前的 gate。跨过这个边界后由 coordinator Stop
            // 负责 active turn；否则快速终态的 stopSession 会把真实已派发轮次误报为
            // cancelled-before-dispatch。
            if (this.goalDispatchAbortControllers.get(sessionId)?.owner === firingOwner) {
              this.goalDispatchAbortControllers.delete(sessionId);
            }
          },
          signal: dispatchAbortController.signal,
        },
      );
      if (pendingHandoff && result.accepted) {
        agentHandoffPending.consume(sessionId);
      }
      if (!result.accepted) {
        if (baselineStarted) {
          this.deps.onUndispatchedUserTurn?.(sessionId);
          baselineStarted = false;
        }
        if (!isCurrentDispatch()) return;
        this.goalTurnsInFlight.delete(sessionId);

        if (result.reason === 'provider-rejected-before-dispatch') {
          const rejectedAt = this.now();
          const previousRetry = this.dispatchRejectionRetries.get(sessionId);
          const firstRejectedAt = previousRetry?.firstRejectedAt ?? rejectedAt;
          const attempts = (previousRetry?.attempts ?? 0) + 1;
          const elapsedMs = Math.max(0, rejectedAt - firstRejectedAt);

          if (
            attempts >= DISPATCH_REJECTION_MAX_ATTEMPTS ||
            elapsedMs >= DISPATCH_REJECTION_MAX_WINDOW_MS
          ) {
            this.deps.logger.warn('[goal] provider rejection retry limit reached', {
              sessionId,
              kind,
              attempts,
              elapsedMs,
            });
            await this.blockDispatchFailure(
              sessionId,
              dispatchBoundary,
              DISPATCH_REJECTION_BLOCK_REASON,
              isCurrentDispatch,
            );
            return;
          }

          const remainingWindowMs = DISPATCH_REJECTION_MAX_WINDOW_MS - elapsedMs;
          const retryDelayMs = Math.min(
            DISPATCH_REJECTION_BASE_DELAY_MS * (2 ** (attempts - 1)),
            DISPATCH_REJECTION_MAX_DELAY_MS,
            remainingWindowMs,
          );
          const retryNotBefore = rejectedAt + retryDelayMs;
          this.dispatchRejectionRetries.set(sessionId, {
            attempts,
            firstRejectedAt,
            retryNotBefore,
          });
          this.deps.logger.warn('[goal] provider rejected dispatch; retrying with backoff', {
            sessionId,
            kind,
            attempts,
            retryDelayMs,
          });
          this.scheduleContinuation(sessionId);
          return;
        }

        this.deps.logger.warn('[goal] send not accepted', { sessionId, kind, reason: result.reason });
        this.scheduleContinuation(sessionId);
      } else {
        if (!isCurrentDispatch()) {
          baselineStarted = false;
          return;
        }
        // Provider acceptance ends any prior confirmed-rejection retry window.
        this.dispatchRejectionRetries.delete(sessionId);
        // onDispatching 是归属登记的唯一边界。不能在 await send 后再次 add：极快的
        // turn 可能已经发出终态并同步释放归属，重新登记会把后续用户 turn 误认成 Goal。
        baselineStarted = false;
      }
    } catch (e) {
      if (baselineStarted) {
        this.deps.onUndispatchedUserTurn?.(sessionId);
        baselineStarted = false;
      }
      const failureBoundary = dispatchBoundary ?? lifecycleBoundary;
      const isCurrentFailure = (): boolean =>
        dispatchBoundary ? isCurrentDispatch() : isCurrentLifecycle();
      if (isCurrentFailure()) {
        this.goalTurnsInFlight.delete(sessionId);
      }
      this.deps.logger.warn('[goal] fireTurn send failed', { sessionId, kind, error: String(e) });
      if (!isCurrentFailure()) return;

      if ((e as { code?: unknown } | null)?.code === 'SESSION_RUNNING') {
        // dispatch 前的窄 race；现有 turn 的终态会暂停 Goal，空闲检查则负责稍后重试。
        this.scheduleContinuation(sessionId);
        return;
      }

      const errorMessage = e instanceof Error ? e.message : String(e);
      const persisted = await this.blockDispatchFailure(
        sessionId,
        failureBoundary,
        `turn dispatch failed: ${errorMessage}`,
        isCurrentFailure,
      );
      if (
        restoringSession &&
        (opts?.throwOnRestoreFailure ||
          (!persisted && opts?.throwOnUnpersistedRestoreFailure))
      ) {
        throw e instanceof GoalSessionRestoreError
          ? e
          : new GoalSessionRestoreError(e);
      }
    } finally {
      try {
        releaseAgentSwitchLock();
      } catch (error) {
        this.deps.logger.warn('[goal] failed to release agent switch lock', {
          sessionId,
          error: String(error),
        });
      }
      if (this.goalDispatchAbortControllers.get(sessionId)?.owner === firingOwner) {
        this.goalDispatchAbortControllers.delete(sessionId);
      }
      if (this.firing.get(sessionId) === firingOwner) {
        this.firing.delete(sessionId);
      }
    }
  }
}

function toPayload(state: GoalState): GoalStatusPayload {
  return {
    sessionId: state.sessionId,
    status: state.status,
    objective: state.objective,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    maxTurns: state.maxTurns,
    noProgressLimit: state.noProgressLimit,
    budgetTokens: state.budgetTokens,
    usageResetAt: state.usageResetAt,
    startedAt: state.startedAt,
    lastReason: state.lastReason,
  };
}

function extractErrorMessage(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    return String((data as { message: unknown }).message);
  }
  return String(data);
}

/** 重新导出供调用方判断终态(避免到处 import types)。 */
export { TERMINAL_GOAL_STATUSES };
