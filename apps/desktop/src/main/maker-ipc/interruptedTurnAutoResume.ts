/**
 * interrupted-turn 自动续跑 —— 「上游把一个已经干到一半的 turn 打断了」这类
 * terminal error 的识别与重连决策。
 *
 * **与 silentStopAutoResume 的分工**：那份管「上游用空内容 assistant 消息**静默**
 * 收尾」（SDK 判 turn 正常结束，`is_error=false`，translator 打 silentStop 标记）；
 * 本份管「同一种物理故障但 SDK 报成了错误」（`is_error=true`，terminal error 落
 * 到 coordinator 的 active-turn recovery）。两者的自愈动作相同（往后追一句续跑，
 * 不重放已完成工作），但入口与**额度模型**刻意不同：
 *  - 入口不同：silent-stop 走 done.data.silentStop；本份走 coordinator 的终态
 *    error 分支（`onTurnEvent(type='error')` 的 `active.persisted` 路径）。
 *  - 额度模型不同：silent-stop 是「每条真实人话买 N 个自动 turn」；本份是
 *    **连续失败计数**（见下方 `INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS`）。
 *
 * **与 maker-core overload-error 的分工**：那份是「上游明确说自己没容量」，
 * Codex 侧据此**重投同一份 turnParams**（安全前提是本 turn 零产出）。本份相反，
 * 专治**已经有产出**的 turn 被打断——那种情况重投会重复已产生的副作用（已写的
 * 文件、已跑的命令、已 push 的提交），只能续跑。
 *
 * 实测来源（2026-07-30）：Claude Code SDK 在 SSE 流被中途切断时报
 * `terminal_reason: 'api_error'` + `sdkError: 'server_error'` + 文案
 * `API Error: Connection closed mid-response.`，全程**没有**发过 `api_retry`
 * （即 SDK 自己不重试这一形态），turn 直接判死，用户只能手点 banner 的「继续」。
 * 社区同型：anthropics/claude-code#38905（SSE 静默中断）。
 */

import { hasUserVisibleText } from '../../shared/visibleText.js';

import {
  isNetworkishErrorMessage,
  isOverloadErrorMessage,
  UPSTREAM_OVERLOAD_REASON,
} from '@cindy/maker-core';

/** 判定输入。字段全部可选：不同 agent / 不同失败路径能提供的信号不一样。 */
export interface InterruptedTurnErrorSignals {
  /** terminal error 的展示文案（可能已被 redact）。 */
  message?: string;
  /** SDK 侧的错误 tag（claude-code 的 `SDKAssistantMessageError`，如 `server_error`）。 */
  sdkError?: string;
  /** translator 给出的稳定 reason key（如 `empty-response` / `turn-failed`）。 */
  reason?: string;
  /** 从错误里抽出的 HTTP 状态码。 */
  errorStatus?: number;
}

/**
 * 流被中途截断的文案形态。**只作组合判据的最后一层**，不单独使用。
 *
 * 为什么不能只靠它：这些字符串是 Claude Code CLI 内部的英文文案，不是稳定协议
 * 字段（仓库里 grep 不到，SDK 是 bundled），上游改一个词就会静默失效。所以
 * `isInterruptedTurnError` 先用结构化信号收紧到「无 reason、无状态码、SDK tag 是
 * server_error」，文本只负责最后一步区分。
 */
const STREAM_TRUNCATION_PATTERN =
  /connection closed mid-response|response above may be incomplete|stream (?:closed|ended|interrupted) (?:unexpectedly|mid-response)/i;

/**
 * SSE 流被中途切断（Claude Code 形态）。三层收紧后才看文案：
 *  - 没有 HTTP 状态码：上游给了状态码说明它**应答过**，不是流被切断。
 *  - SDK tag 必须是 `server_error`：把 `authentication_failed` / `rate_limit` /
 *    `billing_error` / `invalid_request` 这些确定性失败挡在外面。
 *  - 文案命中截断形态。
 */
function isStreamTruncationError(signals: InterruptedTurnErrorSignals): boolean {
  if (signals.errorStatus !== undefined && signals.errorStatus !== null) return false;
  if (signals.sdkError !== 'server_error') return false;
  const message = signals.message;
  if (typeof message !== 'string' || message.length === 0) return false;
  return STREAM_TRUNCATION_PATTERN.test(message);
}

/**
 * 这个 terminal error 是否是「连不上 / 没容量」，可以安全地自动续跑。
 *
 * **白名单制，不是黑名单。** ErrorBanner 那份 `hideRetry` 是黑名单（列出不可重试
 * 的错误），适合人工重试：漏一条只是多给一个按钮，用户自己判断。自动重试反过来
 * ——黑名单漏一条就会对认证失效、协议错这类确定性失败反复重试、反复烧额度，而
 * 白名单漏一条只是少一次自愈。风险不对称，所以这里只认识别得了的形态。
 *
 * 先过 reason 门（带稳定 reason 的都是 translator 已归类的错误：`empty-response`
 * 零产出无可续、`turn-failed` 连错误详情都没有、`silent-stop-exhausted` 是另一套
 * 自愈的耗尽信号），然后认三类：
 *
 *  1. **SSE 流被切断**（`isStreamTruncationError`）——最初的实测形态。
 *  2. **网络到不了上游**（`isNetworkishErrorMessage`：502/503/504、errno、
 *     `fetch failed`、`socket hang up`、`Request timed out` …）。它们同样是"连不上"
 *     而不是"请求有问题"，续跑一次就能过去，用户实际遇到的多半是这一类。
 *  3. **上游没容量**（`isOverloadErrorMessage`：Anthropic 529 / `overloaded_error`、
 *     Codex `Selected model is at capacity`）。**Codex 侧这类必然带
 *     `reason: 'upstream-overload'`**（translator 对每条容量错误都盖这个 key，renderer
 *     隔着 IPC 只能靠它本地化文案），所以 reason 门必须给它开例外 —— 否则第 3 类对 Codex
 *     恒为死代码，本份声称要接的「容量 + 已有产出」那一格永远走不到（codex review P1）。
 *
 * **第 3 类与 #844 的分工靠「本 turn 有没有产出」自动划清，两者互斥、不会叠加重试**：
 * 容量拒绝发生在 admission 阶段（模型一个字都没写）时，Codex 侧会重投同一份
 * turnParams —— 那条路更精确，而本份要求「已有 assistant 产出」（见
 * performRetryLastError 的 auto 分支），天然不会介入；反过来「已经干了一半才被拒」
 * 是 #844 主动交回用户的情形（重投会重复已产生的副作用），正是本份该接的。
 *
 * 认这三类刻意**不**要求 `server_error` tag、也**允许**带状态码——502 / 529 本身就带
 * 状态码，网络 errno 也没有 SDK tag。收紧只对第 1 类成立。
 */
export function isInterruptedTurnError(signals: InterruptedTurnErrorSignals): boolean {
  const reason = typeof signals.reason === 'string' ? signals.reason : '';
  // 例外先行：`upstream-overload` 是**已归类为可重试**的 reason，它本身就是比文案更可靠的
  // 权威判据（结构化优先于文案，与 overload-error.ts 的论证同源），直接放行、不再看文案。
  if (reason === UPSTREAM_OVERLOAD_REASON || reason === 'codex_reconnect_stalled') return true;
  if (reason.length > 0) return false;
  if (isStreamTruncationError(signals)) return true;
  const message = signals.message;
  if (typeof message !== 'string' || message.length === 0) return false;
  if (isNetworkishErrorMessage(message)) return true;
  return isOverloadErrorMessage(message, signals.errorStatus ?? undefined);
}

/**
 * 这条即将落库的 user 消息是不是**自动补发**的续跑指令。
 *
 * 唯一判据是 `agentMeta.autoResume`（coordinator → makerSendTransaction 一路透传，
 * 见 AgentInputQueuedMessage.autoResume）。**刻意不看正文**：续跑指令的文本是共享
 * 常量，用户完全可以手动发一条一模一样的内容，按文本判会把人类动作误判成自动动作。
 *
 * 用途是在「人工介入 → 重置连续失败计数」时排除自动补发的那条消息：不排除就等于
 * 自己给自己重置，连续 N 次失败后停下等人这条保证会失效。抽成纯函数是为了让这个
 * 判据只有一份、且能被单测锁住——它长在 register 的巨型 wiring 里时既测不到也容易
 * 被改坏。
 */
export function isAutoResumeUserMessage(agentMeta: unknown): boolean {
  if (!agentMeta || typeof agentMeta !== 'object') return false;
  return (agentMeta as { autoResume?: unknown }).autoResume === true;
}

/**
 * 这个 agent 事件算不算「模型有实质产出」——即连续失败计数该不该归零、上一次重连该不该
 * 判成成功的唯一证据。
 *
 * 只认两种：**用户看得见的** assistant 文本、工具调用。看不见的一律排除：translator 在若干
 * 路径上会推 `text: ''`（流式兜底、空 assistant 消息），而两侧 translator 转发的 text block /
 * delta 内容是任意的，纯空白（`'\n'`、`' '`）与零宽字符（U+200B/200C/200D、U+FEFF …）同样会
 * 原样透出（`claude-code/translator.ts` 与 `codex/translator.ts` 的 text 分支）。把它们算成产出
 * 的话，一个用户什么都没看到的重连会既绕过连续失败上限（这类 delta 可以让计数永远停在 1/5），
 * 又在历史里错误显示「已重新连接」（greptile / codex 连报四轮 P1/P2）。
 * thinking / status / 我们自己补发的续跑指令同理都不算。
 *
 * 「看得见」的判定收敛在 `shared/visibleText.ts` 一处，renderer 的折叠边界
 * （`makerChatStore.isSubstantiveChatRow`）用的是**同一个函数** —— 两边各写一份就会分叉，
 * 而分叉的表现是静默的（main 认为还在同一段、UI 却把卡片拆成多行）。
 *
 * 真实产出里夹着的空白 delta 不受影响：紧随其后的那个 delta 带可见字符，那时才记产出，
 * 而"下一次失败之前有没有产出"这个判据不在乎它发生在哪一拍。
 *
 * 抽成纯函数是为了能被单测锁住 —— 它原本长在 register 的巨型 wiring 里，测不到。
 */
export function isSubstantiveProgressEvent(event: {
  type?: string;
  data?: unknown;
}): boolean {
  if (event.type === 'tool_use') return true;
  if (event.type !== 'text') return false;
  return hasUserVisibleText((event.data as { text?: unknown } | null | undefined)?.text);
}

/**
 * 一次中断事件里最多连续自动重连几次。
 *
 * 额度模型是**连续失败计数**，不是「每条人话买 N 次」：
 *  - 连续 5 次重连都没能让模型产出任何东西 → 判定真的连不上，停下等人。
 *  - 中间只要有一次**模型有实质产出**（assistant 文本 / 工具调用），计数归零，
 *    后面又可以再来 5 次。
 *  - **会话累计不设上限**：只要任务还在推进，就可以一直自愈；累计次数只用于展示
 *    （让用户看出这个会话的网络有多糟），不做限制。
 *
 * 为什么这样比「按人话充值」对：判据落在「是否在推进」而不是「人说了几句话」。长
 * 任务跑一小时不说话时不该被扣光额度；而真正连不上时，5 次退避（约 3+6+12+20+20
 * ≈ 61 秒）已经足够穿过瞬时抖动，再试下去只是烧钱。
 */
export const INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS = 5;

/** 首次续跑前的退避基数。 */
const RESUME_BACKOFF_BASE_MS = 3_000;
/** 单次退避上限。 */
const RESUME_BACKOFF_MAX_MS = 20_000;
/** jitter 幅度（±25%），打散同一台机器上多会话同时被打断后的锁步重试。 */
const RESUME_BACKOFF_JITTER_RATIO = 0.25;

/**
 * 第 `attempt` 次自动续跑前该等多久（attempt 从 1 起）。
 *
 * 与 maker-core 的 `overloadRetryDelayMs` 同形（指数 + 对称 jitter + 封顶在 jitter
 * 之后），但**不复用**它：那份的常量是按「容量拒绝、额度照扣」调的（2s 起、封顶
 * 30s、4 次），本份要穿过网络抖动、节奏不同。刻意不为了共享代码把两组语义不同的
 * 常量捆在一起。
 *
 * 退避本身就是两次重连的间隔保证，所以这里**不再另设 min-interval**——那会把
 * 「连续重试 5 次」直接掐死在第 2 次。
 *
 * `random` 可注入，让单测能断言确定的边界值。
 */
export function interruptedTurnResumeDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(RESUME_BACKOFF_BASE_MS * 2 ** exponent, RESUME_BACKOFF_MAX_MS);
  const factor = 1 + (random() * 2 - 1) * RESUME_BACKOFF_JITTER_RATIO;
  return Math.min(Math.round(base * factor), RESUME_BACKOFF_MAX_MS);
}

/**
 * 授予一次重连时回传的进度信息。全部会一路透到 UI：进行中态显示
 * 「重新连接中 attempt/maxAttempts」，展开详情显示原因 + 本轮次数 + 会话累计。
 */
export interface InterruptedTurnResumeProgress {
  /** 本轮连续第几次重连（从 1 起）。 */
  attempt: number;
  /** 本轮上限（= INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS，随记录落库以免改常量后旧记录失真）。 */
  maxAttempts: number;
  /** 本会话累计自动重连次数（只增，不设上限，仅用于展示）。 */
  sessionTotal: number;
}

export type InterruptedTurnResumeDecision =
  | ({ action: 'resume'; delayMs: number } & InterruptedTurnResumeProgress)
  | { action: 'exhausted'; consecutiveAttempts: number }
  | { action: 'skip'; why: 'disabled' | 'superseded' | 'pending' };

interface GuardLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

interface SessionGuardState {
  /** 本轮连续重连次数（模型有产出 / 人工介入即归零）。 */
  consecutiveAttempts: number;
  /** 会话累计自动重连次数（只增，仅展示）。 */
  sessionTotalResumes: number;
  lastTurnStartAt: number;
  lastUserSendAt: number;
  pendingResume: boolean;
  exhaustedWarned: boolean;
}

export interface InterruptedTurnAutoResumeGuardDeps {
  /** kill switch（interrupted-turn-auto-resume-store，默认开启）。 */
  isEnabled: () => boolean;
  log: GuardLogger;
  /** 可注入时钟，单测用；默认 Date.now。 */
  now?: () => number;
  /** 可注入随机源，单测用；默认 Math.random（只用于退避 jitter）。 */
  random?: () => number;
}

/**
 * 中断自动续跑的决策器。
 *
 * 与 `SilentStopAutoResumeGuard` 保持相似形状（pendingResume 去重、陈旧保护、
 * 可注入依赖）好让两处一起读，但额度语义完全不同：这里是**连续失败计数 + 有进展
 * 就重置**，会话累计不限（见 `INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS`）。
 *
 * 纯内存状态（app 重启即复位），无 IO；全部依赖可注入，便于单测。
 */
export class InterruptedTurnAutoResumeGuard {
  private readonly sessions = new Map<string, SessionGuardState>();

  constructor(private readonly deps: InterruptedTurnAutoResumeGuardDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private state(sessionId: string): SessionGuardState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        consecutiveAttempts: 0,
        sessionTotalResumes: 0,
        lastTurnStartAt: 0,
        lastUserSendAt: 0,
        pendingResume: false,
        exhaustedWarned: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * 模型产出了实质内容（assistant 文本 / 工具调用）→ 连续失败计数归零。
   *
   * 这是整个额度模型的核心：**判据是「是否在推进」**。调用点必须只覆盖真实产出，
   * 不能把 thinking / 空消息 / 我们自己补发的续跑指令算进去，否则计数永不累积、
   * 「连不上就停下」这条保证会失效。
   *
   * 热路径友好：O(1)、无 IO、无日志（每条 assistant 消息与每次工具调用都会调）。
   */
  noteProgress(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.consecutiveAttempts === 0) return;
    s.consecutiveAttempts = 0;
    s.exhaustedWarned = false;
  }

  /**
   * 真实用户消息发出 → 连续失败计数归零（人工介入是新起点）。
   * 自动补发的续跑指令**绝不能**调用本方法（调用方靠 `isAutoResumeUserMessage`
   * 排除），否则等于自己给自己重置，连续失败上限就形同虚设。
   */
  noteUserSend(sessionId: string): void {
    const s = this.state(sessionId);
    s.consecutiveAttempts = 0;
    s.exhaustedWarned = false;
    s.lastUserSendAt = this.now();
  }

  /** 新 turn 开始。清 pendingResume，记录时间做陈旧判定。 */
  noteTurnStarted(sessionId: string): void {
    const s = this.state(sessionId);
    s.lastTurnStartAt = this.now();
    s.pendingResume = false;
  }

  /**
   * 自动续跑投递失败时清 pending，避免卡死后续决策。
   * 计数不回退（安全方向：宁可少试一次，不可无限试）。
   */
  noteResumeSendFailed(sessionId: string): void {
    this.state(sessionId).pendingResume = false;
  }

  /**
   * 会话被重置（/clear）或中止（abort）时调用。清 pendingResume 并记录时刻，使
   * 退避窗口内已排期的续跑判为 superseded，不往清空 / 已喊停的会话里注入消息。
   * 连续计数一并归零：那是上一段上下文的账。
   */
  noteSessionReset(sessionId: string): void {
    const s = this.state(sessionId);
    s.pendingResume = false;
    s.consecutiveAttempts = 0;
    s.exhaustedWarned = false;
    s.lastUserSendAt = this.now();
  }

  /**
   * 对一次「turn 被打断」做决策。`erroredAt` 是该 terminal error 的观察时刻，用于
   * 陈旧判定（其后用户已发消息 / 新 turn 已开始 → superseded）。
   *
   * 返回 resume 时已内部累加计数并置 pendingResume，调用方负责在 `delayMs` 后实际
   * 补发，并在补发前**再复核一次**会话状态（退避窗口内用户介入的概率不低）。
   */
  onInterruptedTurn(sessionId: string, erroredAt: number): InterruptedTurnResumeDecision {
    const s = this.state(sessionId);
    if (!this.deps.isEnabled()) {
      this.deps.log.debug('interrupted-turn auto-resume disabled by kill switch', { sessionId });
      return { action: 'skip', why: 'disabled' };
    }
    if (s.pendingResume) {
      this.deps.log.debug('interrupted-turn duplicate error while resume pending', { sessionId });
      return { action: 'skip', why: 'pending' };
    }
    if (s.lastUserSendAt > erroredAt || s.lastTurnStartAt > erroredAt) {
      this.deps.log.debug('interrupted-turn resume superseded by newer activity', {
        sessionId,
        erroredAt,
        lastUserSendAt: s.lastUserSendAt,
        lastTurnStartAt: s.lastTurnStartAt,
      });
      return { action: 'skip', why: 'superseded' };
    }
    if (s.consecutiveAttempts >= INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS) {
      if (!s.exhaustedWarned) {
        s.exhaustedWarned = true;
        this.deps.log.warn(
          'interrupted-turn auto-resume exhausted — no model output across consecutive attempts',
          { sessionId, consecutiveAttempts: s.consecutiveAttempts },
        );
      }
      return { action: 'exhausted', consecutiveAttempts: s.consecutiveAttempts };
    }
    s.consecutiveAttempts += 1;
    s.sessionTotalResumes += 1;
    s.pendingResume = true;
    const attempt = s.consecutiveAttempts;
    const delayMs = interruptedTurnResumeDelayMs(attempt, this.deps.random);
    this.deps.log.debug('interrupted-turn auto-resume granted', {
      sessionId,
      attempt,
      maxAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
      sessionTotal: s.sessionTotalResumes,
      delayMs,
    });
    return {
      action: 'resume',
      attempt,
      maxAttempts: INTERRUPTED_TURN_MAX_CONSECUTIVE_ATTEMPTS,
      sessionTotal: s.sessionTotalResumes,
      delayMs,
    };
  }
}
