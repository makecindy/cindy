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

import { buildContinuationDirective, buildFirstTurnDirective } from './directive';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton';
import { prependHandoffToUserMessage } from '../maker-ipc/agentHandoff';
import { classifyTurnUsageLimit } from './usageLimit';
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

export class GoalControllerInputError extends Error {
  readonly code = 'INVALID_PARAMS';
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
  /** 错误归类:'usage_limit' = 账号限流(→ usageLimited);否则按 abort/真错处理。 */
  errorKind?: 'usage_limit';
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
    // 账号限流 → usageLimited(可恢复、到点自动续;resetAt 由 finalizeTurn 读快照补)。
    if (outcome.errorKind === 'usage_limit') {
      return {
        status: 'usageLimited',
        lastReason: 'usage limit reached',
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
  /** 本轮是否已 finalize(去重 done / 终止 error 双触发)。 */
  finalized: boolean;
}

function freshTurn(): TurnAccumulator {
  return { text: '', sawToolUse: false, tokensThisTurn: 0, finalized: false };
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
  private readonly firing = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** goal controller 自己发起且尚未收到终止事件的 turn。用于编辑时区分 goal turn / user turn。 */
  private readonly goalTurnsInFlight = new Set<string>();
  /** (Option B)已经用 AskUserQuestion 答案改写过目标的会话 —— 每个目标只允许澄清改写一次,
   *  防首轮内模型二次提问(如工作型提问)把目标覆盖错。setGoal(新建/编辑)与 clearGoal 时重置。 */
  private readonly clarificationApplied = new Set<string>();
  /** usageLimited 到点自动续跑 timer,按 sessionId。**stopSession 不清它**(它要熬到限额重置),
   *  只在 clearGoal / resumeGoal / dispose 取消。 */
  private readonly usageResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    // 新建 / 编辑目标 → 重置"已澄清"闸门(新目标允许重新澄清改写一次)。
    this.clarificationApplied.delete(sessionId);
    const existing = await this.deps.storage.get(sessionId);
    const ts = this.now();

    if (existing) {
      const session = await this.deps.ensureSession(sessionId);
      if (!session) {
        this.deps.logger.warn('[goal] setGoal edit: no live session', { sessionId });
        return null;
      }
      if (this.isBusy(sessionId)) {
        if (!this.goalTurnsInFlight.has(sessionId)) {
          throw new GoalControllerInputError('current conversation is still running; edit the goal after it becomes idle');
        }
        // 先 stopSession(detach listener + 清 goalTurnsInFlight/turn),再 abort:否则 abort 触发的
        // 终止事件可能在 detach 前被 onEvent 消费 → 并发 finalizeTurn 把下面刚写的 active 覆盖成
        // paused(用户编辑目标后 chip 误显"暂停")。detach 在前,abort 的终止事件就不再触达裁决。
        this.stopSession(sessionId);
        await session.abort();
      } else {
        this.stopSession(sessionId);
      }
      this.cancelUsageResume(sessionId);
      const updated = await this.deps.storage.update(sessionId, {
        objective,
        status: 'active',
        noProgressStreak: 0,
        usageResetAt: null,
        lastReason: null,
        updatedAt: ts,
      });
      if (!updated) return null;
      this.resetTurn(sessionId);
      this.attachListener(sessionId);
      this.emit(updated);
      // 编辑目标 → 在对话里落一条「目标已更新」标记消息(气泡徽标),排在续轮之前。
      await this.deps.persistUserMessage?.(sessionId, objective, { goalObjective: { updated: true } });
      await this.fireTurn(sessionId);
      return updated;
    }

    const limits = input.limits ?? this.deps.getDefaults();
    // 先活化(resume)会话,再据活化后的会话定 agentKind:dormant(重启后尚未活化)会话此刻
    // getSession 为空,若直接 fallback 'claude-code' 会把 Codex 目标错存成 claude-code,后续
    // getAccountLimit 读错账号配额快照 → Codex 限流目标的 reset/auto-resume 错位(reviewer #354)。
    const ensured = await this.deps.ensureSession(sessionId);
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
    await this.deps.storage.upsert(state);
    this.resetTurn(sessionId);
    this.attachListener(sessionId);
    this.emit(state);
    // 目标创建 → 落一条目标文案作对话起点(updated:false),**只此一次**。
    // 不放进 fireTurn(Fix A 后 'first' 可能重发,会重复落库;编辑路径自己落 updated:true)。
    await this.deps.persistUserMessage?.(sessionId, objective, { goalObjective: { updated: false } });
    await this.fireTurn(sessionId);
    return state;
  }

  async updateGoal(sessionId: string, patch: GoalUpdatePatch): Promise<GoalState | null> {
    const normalized = normalizeGoalUpdatePatch(patch);
    const state = await this.deps.storage.get(sessionId);
    if (!state) return null;
    const objectiveChanged = normalized.objective != null && normalized.objective !== state.objective;
    const ts = this.now();
    const changed = await this.deps.storage.update(sessionId, {
      ...normalized,
      updatedAt: ts,
    });
    if (!changed) return null;
    // 改了目标内容 → 在对话里落一条「目标已更新」标记消息(气泡徽标),排在任何续轮之前。
    if (objectiveChanged) {
      await this.deps.persistUserMessage?.(sessionId, changed.objective, { goalObjective: { updated: true } });
    }
    let next = changed;
    if (changed.status === 'budgetLimited' && !exceedsGoalBudget(changed)) {
      const resumed = await this.deps.storage.update(sessionId, {
        status: 'active',
        lastReason: null,
        updatedAt: this.now(),
      });
      if (resumed) {
        next = resumed;
        this.resetTurn(sessionId);
        await this.deps.ensureSession(sessionId);
        this.attachListener(sessionId);
      }
    } else if (next.status === 'active' && exceedsGoalBudget(next)) {
      // 反向:把 active 目标的 maxTurns/budgetTokens 调小到已被 turnsUsed/tokensUsed 超过
      // → 立即转 budgetLimited 并停续跑。否则 row 仍 active,下一轮 fireTurn 会越过新上限再
      // 多跑一轮(预算守卫原本只在 turn 跑完后才生效;reviewer #354)。fireTurn preflight 再兜一层。
      const limited = await this.deps.storage.update(sessionId, {
        status: 'budgetLimited',
        lastReason: 'budget limit lowered below current usage',
        updatedAt: this.now(),
      });
      if (limited) {
        next = limited;
        this.stopSession(sessionId);
      }
    }
    if (
      objectiveChanged &&
      (changed.status === 'paused' || changed.status === 'blocked' || changed.status === 'usageLimited')
    ) {
      await this.resumeGoal(sessionId);
      return this.deps.storage.get(sessionId);
    }
    this.emit(next);
    if (next.status === 'active' && state.status === 'budgetLimited' && !this.isBusy(sessionId)) {
      this.scheduleContinuation(sessionId);
    }
    return next;
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
    const state = await this.deps.storage.get(sessionId);
    if (!state || state.status !== 'active') return;
    if (state.turnsUsed !== 0) return;
    // 确定性标记:只认 directive 约定形状的"目标澄清问题",否则不改写(见函数注释)。
    if (!questionsLookLikeGoalClarification(questions, state.objective)) return;
    if (next === state.objective) {
      this.clarificationApplied.add(sessionId); // 选了"保持原目标"也算已澄清,封住后续覆盖
      return;
    }
    const updated = await this.deps.storage.update(sessionId, { objective: next, updatedAt: this.now() });
    if (updated) this.emit(updated);
    this.clarificationApplied.add(sessionId);
    await this.deps.persistUserMessage?.(sessionId, next, { goalObjective: { updated: true } });
  }

  /** 清除目标(用户主动)。删行 + 停止一切续跑 + 取消 usage 自动续 + 通知 renderer 隐藏指示器。 */
  async clearGoal(sessionId: string): Promise<void> {
    this.clarificationApplied.delete(sessionId);
    this.cancelUsageResume(sessionId);
    this.stopSession(sessionId);
    await this.deps.storage.clear(sessionId);
    this.deps.emitStatus({ sessionId, goal: null });
  }

  /**
   * 暂停一个 active 目标(用户点 Pause / rewind 联动)。**保留计数**,停续跑;
   * 可经 resumeGoal 恢复。非 active(已暂停/受阻/终态)直接忽略。
   * reason 供 UI 展示(如 rewind 传 "paused: conversation rewound")。
   */
  async pauseGoal(sessionId: string, reason?: string): Promise<void> {
    const state = await this.deps.storage.get(sessionId);
    if (!state || state.status !== 'active') return;
    const updated = await this.deps.storage.update(sessionId, {
      status: 'paused',
      lastReason: reason ?? 'paused by user',
      updatedAt: this.now(),
    });
    // 停续跑(detach listener + 清 timer/firing)。在途 turn 即便后续 done 也不再触发续跑。
    this.stopSession(sessionId);
    if (updated) this.emit(updated);
  }

  /**
   * 恢复一个 paused / blocked / usageLimited 目标。**保留 turnsUsed/tokensUsed/startedAt**
   * (与 setGoal 全清零相反),重挂 listener,空闲则立即续一轮。终态(complete/budgetLimited)
   * /已 active 不处理。
   */
  async resumeGoal(sessionId: string): Promise<void> {
    const state = await this.deps.storage.get(sessionId);
    if (
      !state ||
      (state.status !== 'paused' && state.status !== 'blocked' && state.status !== 'usageLimited')
    ) {
      return;
    }
    this.cancelUsageResume(sessionId); // 早恢复 / 手动恢复 → 取消挂着的自动续 timer
    const updated = await this.deps.storage.update(sessionId, {
      status: 'active',
      noProgressStreak: 0, // 给一次干净续跑机会(原暂停可能正是空轮触顶)
      usageResetAt: null, // 恢复后清掉限额重置标记
      lastReason: null,
      updatedAt: this.now(),
    });
    if (!updated) return;
    this.resetTurn(sessionId);
    await this.deps.ensureSession(sessionId);
    this.attachListener(sessionId);
    this.emit(updated);
    if (!this.isBusy(sessionId)) {
      await this.fireTurn(sessionId);
    }
  }

  /**
   * idle 兜底(#9):会话转 idle 时由 main 的 turn-complete observer 调用。
   * 仅当该会话有 controller 挂着的 active goal(unsubscribers.has)、未在 firing、
   * 会话空闲时,走防抖续跑路径补一轮。**race-free**:scheduleContinuation 幂等
   * (清旧 timer)、stopSession 会清 timer、fireTurn 内再从 storage 重校 status——
   * 与 finalizeTurn 的 scheduleContinuation 任意交错都只会有一次有效续跑。
   * dormant(没挂 listener)的 goal 不归这里管,由 resume-on-open 处理。
   */
  async maybeContinueActiveGoal(sessionId: string): Promise<void> {
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

  /** GET_GOAL_STATUS:返回当前状态扁平 payload(无 goal 返回 null)。 */
  async getStatus(sessionId: string): Promise<GoalStatusPayload | null> {
    const state = await this.deps.storage.get(sessionId);
    return state ? toPayload(state) : null;
  }

  /**
   * resume-on-open(#review):重启后未活会话的 active 目标是 **dormant** —— resumeActiveGoals
   * 不会硬 spawn,留着 status=active 但无 listener/timer。用户**打开该会话**时(renderer
   * useGoalStatus 拉状态)调用此方法把它接着续上:active ∧ 当前未挂 listener(dormant)→
   * ensureSession 活化 + 挂 listener + 空闲则续一轮。否则(已在管 / 非 active / 活化失败)no-op。
   * 这样重开会话能让 active 目标自己跑下去,而不是卡死等用户重发 /goal。
   */
  async resumeOnOpen(sessionId: string): Promise<void> {
    if (this.unsubscribers.has(sessionId)) return; // 已在管(非 dormant)
    const state = await this.deps.storage.get(sessionId);
    if (!state || state.status !== 'active') return; // 只续 active dormant;paused/blocked 走手动 resume
    // deferred agent switch 的 commit 会关闭旧 live session。必须在 ensureSession
    // 之前执行,随后重新读取/bootstrap 的才是目标引擎;否则这一轮 directive 会继续
    // 发给 fireTurn 开始时捕获的旧 session。
    await this.deps.applyPendingAgentSwitch?.(sessionId);
    const session = await this.deps.ensureSession(sessionId);
    if (!session) return; // 活化失败(如 device-link 远程不可用)→ 留 dormant,下次打开再试
    this.resetTurn(sessionId);
    this.attachListener(sessionId);
    this.emit(state);
    if (!this.isBusy(sessionId)) {
      await this.fireTurn(sessionId);
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
    for (const state of active) {
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
      this.resetTurn(state.sessionId);
      this.attachListener(state.sessionId);
      this.emit(state);
      resumed += 1;
      if (!this.isBusy(state.sessionId)) {
        void this.fireTurn(state.sessionId);
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
    this.firing.delete(sessionId);
    this.goalTurnsInFlight.delete(sessionId);
    this.turns.delete(sessionId);
  }

  private resetTurn(sessionId: string): void {
    this.turns.set(sessionId, freshTurn());
  }

  private isBusy(sessionId: string): boolean {
    if (this.firing.has(sessionId)) return true;
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
          turn.tokensThisTurn = d.tokenUsage;
        }
        return;
      }
      case 'done': {
        // Codex 的 per-turn 真实用量在 done.data.usage(promptTokens/completionTokens,
        // 见 maker-core codex/index.ts task_complete:"永远是 per-turn 增量")。优先用它覆盖
        // status 带来的累积上下文快照,避免 Codex 目标的 token 预算随上下文增长过早触顶。
        // Claude 的 done.data 是 SDKResultMessage(usage 走 input_tokens/output_tokens),无
        // promptTokens/completionTokens → 不命中,沿用上面 status 的 per-turn tokenUsage。
        const u = (event.data as { usage?: { promptTokens?: number; completionTokens?: number } } | null)?.usage;
        if (u && (typeof u.promptTokens === 'number' || typeof u.completionTokens === 'number')) {
          turn.tokensThisTurn = Math.max(0, (u.promptTokens ?? 0) + (u.completionTokens ?? 0));
        }
        void this.finalizeTurn(sessionId, event, false);
        return;
      }
      default: {
        if (isTerminalAgentErrorEvent(event)) {
          void this.finalizeTurn(sessionId, event, true);
        }
        return;
      }
    }
  }

  private async finalizeTurn(sessionId: string, event: AgentEvent, errored: boolean): Promise<void> {
    const turn = this.turns.get(sessionId);
    if (turn?.finalized) return; // done + 终止 error 双触发去重(同步置位,后续 await 不影响去重)
    if (turn) turn.finalized = true;

    const state = await this.deps.storage.get(sessionId);
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
    const outcome: TurnOutcome = {
      origin,
      sawToolUse: turn?.sawToolUse ?? false,
      tokensThisTurn: turn?.tokensThisTurn ?? 0,
      verdict: origin === 'goal' ? parseVerdict(turn?.text ?? '') : null,
      errored,
      errorMessage,
      // 被动检测:本轮以"账号限流"型 error 收尾 → 标记,decideNextGoalState 据此置 usageLimited。
      ...(errored && classifyTurnUsageLimit(event.data) ? { errorKind: 'usage_limit' as const } : {}),
    };
    if (origin === 'goal') this.goalTurnsInFlight.delete(sessionId);

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
      const elapsedMs = Math.max(0, this.now() - state.startedAt);
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
      this.deps.emitStatus({ sessionId, goal: null });
      this.resetTurn(sessionId);
      this.stopSession(sessionId);
      return;
    }

    // 账号用量受限改判:
    //  - 被动:decision 已是 usageLimited(本轮限流型 error)→ 读快照补 resetAt。
    //  - 主动:本应续跑(shouldFire),但 getAccountLimit 显示已限流 → 改判 usageLimited,不续。
    let status = decision.status;
    let lastReason = decision.lastReason;
    let shouldFire = decision.shouldFire;
    let usageResetAt: number | null = null;
    if (status === 'usageLimited' || shouldFire) {
      const limit = this.deps.getAccountLimit
        ? await this.deps.getAccountLimit(state.agentKind).catch(() => null)
        : null;
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

    const updated = await this.deps.storage.update(sessionId, {
      status,
      lastReason,
      turnsUsed: decision.turnsUsed,
      tokensUsed: decision.tokensUsed,
      noProgressStreak: decision.noProgressStreak,
      usageResetAt: status === 'usageLimited' ? usageResetAt : null,
      ...(objectiveRewrite ? { objective: objectiveRewrite } : {}),
      updatedAt: this.now(),
    });
    if (updated) this.emit(updated);

    // 改写了目标 → 在对话里落一条「目标已更新」标记(气泡徽标),与 setGoal/updateGoal 改目标一致。
    if (objectiveRewrite) {
      await this.deps.persistUserMessage?.(sessionId, objectiveRewrite, { goalObjective: { updated: true } });
    }

    this.resetTurn(sessionId);

    if (shouldFire) {
      this.scheduleContinuation(sessionId);
    } else {
      // 停:budgetLimited(终态)/ blocked / paused / usageLimited 都 detach。
      this.stopSession(sessionId);
      // usageLimited 且知道重置时刻 → 排自动续跑(stopSession 不碰 usageResumeTimers)。
      if (status === 'usageLimited') this.scheduleUsageResume(sessionId, usageResetAt);
    }
  }

  private scheduleContinuation(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.fireTurn(sessionId);
    }, this.debounceMs);
    // Node 环境;不 block 进程退出。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(sessionId, timer);
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
      void this.autoResumeFromUsageLimit(sessionId);
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

  /** 限额重置时刻到了:若仍 usageLimited,落一条"用量已恢复"提示后 resume 续跑。 */
  private async autoResumeFromUsageLimit(sessionId: string): Promise<void> {
    this.usageResumeTimers.delete(sessionId);
    const state = await this.deps.storage.get(sessionId).catch(() => null);
    if (!state || state.status !== 'usageLimited') return; // 用户可能已 clear / 手动 resume
    if (this.deps.persistGoalNotice) {
      try {
        await this.deps.persistGoalNotice(sessionId, 'usage-resumed');
      } catch (e) {
        this.deps.logger.warn('[goal] persistGoalNotice failed', { sessionId, error: String(e) });
      }
    }
    await this.resumeGoal(sessionId);
  }

  private async fireTurn(sessionId: string): Promise<void> {
    const state = await this.deps.storage.get(sessionId);
    if (!state || state.status !== 'active') return;
    // preflight 预算守卫:用户可能把 maxTurns/budgetTokens 调小到已超当前用量(updateGoal 会即时
    // 转 budgetLimited,但调度链上可能仍有在途 fireTurn / continuation timer 指向旧 active 状态)。
    // 超(新)预算就转 budgetLimited 并停,绝不越过新上限再发一轮(reviewer #354)。
    if (exceedsGoalBudget(state)) {
      const limited = await this.deps.storage.update(sessionId, {
        status: 'budgetLimited',
        lastReason: 'budget limit reached',
        updatedAt: this.now(),
      });
      this.stopSession(sessionId);
      if (limited) this.emit(limited);
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
    // fireTurn 每次都可能是登记 deferred intent 后的第一条直发消息。apply 会关闭
    // 旧引擎并 bootstrap 目标引擎,所以必须在拿 session 引用之前执行。
    await this.deps.applyPendingAgentSwitch?.(sessionId);
    const session = await this.deps.ensureSession(sessionId);
    if (!session) {
      this.deps.logger.warn('[goal] no live session to fire (resume failed)', { sessionId, kind });
      return;
    }
    // deferred switch 可能刚把 live session 换成目标引擎的新对象;本会话若有 goal
    // listener,必须迁到新 session,否则这轮 turn 的 done/error 事件进不了 finalizeTurn,
    // 目标卡死在 active(reviewer P1)。attachListener 按 session 身份判等,未换则 no-op;
    // 只对已在管(非 dormant)的 goal 重挂,不给 dormant 会话平白加 listener。
    if (this.unsubscribers.has(sessionId)) {
      this.attachListener(sessionId);
    }

    this.resetTurn(sessionId);
    const content =
      kind === 'first'
        ? buildFirstTurnDirective(state.objective, { maxTurns: state.maxTurns })
        : buildContinuationDirective(state.objective, state.lastReason);

    this.firing.add(sessionId);
    let baselineStarted = false;
    try {
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
      const outgoing = pendingHandoff
        ? prependHandoffToUserMessage({ type: 'user', content }, pendingHandoff)
        : { type: 'user' as const, content };
      const result = await session.send(
        outgoing as { type: 'user'; content: string },
        { origin: { kind: 'goal', goalSessionId: sessionId }, planMode: false },
      );
      if (pendingHandoff && result.accepted) {
        agentHandoffPending.consume(sessionId);
      }
      if (!result.accepted) {
        if (baselineStarted) {
          this.deps.onUndispatchedUserTurn?.(sessionId);
          baselineStarted = false;
        }
        this.goalTurnsInFlight.delete(sessionId);
        this.deps.logger.warn('[goal] send not accepted', { sessionId, kind, reason: result.reason });
      } else {
        this.goalTurnsInFlight.add(sessionId);
        baselineStarted = false;
      }
    } catch (e) {
      if (baselineStarted) {
        this.deps.onUndispatchedUserTurn?.(sessionId);
        baselineStarted = false;
      }
      this.goalTurnsInFlight.delete(sessionId);
      // SESSION_RUNNING:会话已有 turn 在跑(用户抢发等);该 turn 的 done 会再触发裁决。
      this.deps.logger.warn('[goal] fireTurn send failed', { sessionId, kind, error: String(e) });
    } finally {
      this.firing.delete(sessionId);
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
