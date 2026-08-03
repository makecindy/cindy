/**
 * Session — 单次 agent 会话的上层包装。
 *
 * 职责：
 * - 统一暴露能力（capabilities）+ runtime 切换接口
 * - 把 BaseAgent 的事件流转发给订阅者
 * - 提供 UI 友好的事件订阅 API（不强迫 UI 自己消费 AsyncIterable）
 * - 管理 InteractionResolver 注入(permission / ask_user_question / plan_review 三合一)
 *
 * 不持有 LLM client、不做决策、不存任何业务记忆 —— 这些是未来 MetaAgent 的事。
 */

import { randomUUID } from 'node:crypto';

import {
  extractNonSecretErrorSignals,
  redactSensitiveText,
} from '@cindy/maker-shared/error-redaction';
import type {
  Effort,
  PermissionMode,
  AgentKind,
  UserMessage,
} from './types/common.js';
import type {
  Capabilities,
  ManualCompactResult,
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from './types/capabilities.js';
import { NotSupportedError } from './types/capabilities.js';
import type {
  AgentEvent,
  InteractionRequest,
  InteractionDecision,
  RewindCommitOptions,
  RewindCommitResult,
  UsageSnapshot,
  RewindFilesResult,
  SendOrigin,
} from './types/events.js';
import { isTerminalAgentErrorEvent } from './types/events.js';
import type { ContextUsageData } from './types/context-usage.js';
import type { AgentSessionHandle, BackgroundTaskSnapshot, SendOptions } from './agents/base-agent.js';
import type { Logger } from './interfaces/logger.js';

export type SessionStatus = 'active' | 'aborting' | 'closed' | 'error';

export interface PermissionModeState {
  mode: PermissionMode | null;
  generation: number;
}

export type SessionEventListener = (event: AgentEvent) => void;
export type SessionStatusListener = (status: SessionStatus) => void;
export type InteractionRequestListener = (req: InteractionRequest) => Promise<InteractionDecision>;

/**
 * turn 零事件看门狗阈值(ms)。turn 在跑、却连续这么久**一个事件都没有**,视为整条
 * 链路已死,中断本轮而不是永远转圈。env `XDT_SESSION_TURN_STALL_MS` 覆盖,0 关闭。
 *
 * 与 agent 层 watchdog 的分工:各 agent 内部的 upstream-idle watchdog 只盯"球在上游
 * 却不回话"(claude-code 30min / codex 30min),它们在**工具执行期间刻意不计时** ——
 * 因此工具自己 hang(MCP 卡住、SDK↔子进程 stdio 通道 wedge)时没有任何机制兜底,
 * turn 可以永久挂着。这一层就是兜那个洞:不区分球在谁手里,只看"还有没有动静"。
 *
 * 45min 刻意大于 agent 层的 30min,保证正常情况下 agent 自己先自愈、不被抢跑;
 * 只有 agent 层也失灵才轮到这里。
 *
 * 误杀防护(见 armTurnStallWatchdog):等用户回应交互(权限询问 / AskUserQuestion /
 * plan review)期间、以及有后台任务在跑期间都不计时 —— 那些场景没有事件是正常的。
 */
const DEFAULT_TURN_STALL_MS = 45 * 60_000;

/**
 * 看门狗 abort 之后复核"turn 真的停了吗"的宽限(ms)。
 *
 * 为什么必须复核:各 agent 的 abort 在中断失败时都只记日志、**不改** turn-in-flight
 * 状态(claude-code 的 `q.interrupt()` 抛错、codex 的 app-server 两次 ack 超时都是
 * 这样)。此时 handle.isTurnRunning() 恒 true,而终态 error 已经推给上层收口 ——
 * 之后每一条 send 都被 in-flight guard 拒掉,会话彻底不可用,看门狗等于"报告已恢复
 * 但什么都没恢复"(review #944 第三轮)。
 *
 * 复核发现 turn 仍在跑就关闭会话:下一次 send 由 Maker 的 lazy create 重建 handle
 * (与 handle 自然死亡后的路径一致,见 runEventLoop 尾部注释),这是唯一不依赖各 agent
 * 自己实现重建的通用出路。
 *
 * 10s 是给 abort 的正常收口留的余量:interrupt 成功后 turn 的终态事件要经 SDK drain
 * → translator → 事件流才让 isTurnRunning 翻 false,abort() resolve 的那一刻通常还没到。
 */
export const STALL_ABORT_RECOVERY_GRACE_MS = 10_000;

/**
 * 手动 abort(用户按 Stop)之后的复核宽限。
 *
 * 比看门狗那条(10s)长得多是刻意的:看门狗开火前已经确诊"整条链路零事件"，可以果断;
 * 手动 Stop 只说明用户想停，transport 很可能完全健康，只是这一次 interrupt 往返慢
 * (远端 daemon / SSH 隧道)。用 10s 判它"没生效"会把正常会话误关。60s 远超任何健康
 * 往返，又给"按了 Stop 却永远停不下来"留了有界出路(review #944 第十一轮 P1)。
 */
export const MANUAL_ABORT_RECOVERY_GRACE_MS = 60_000;

/**
 * turn 零事件看门狗的计时分片长度。额度按片累加,片尾核对真实经过时间,
 * 借此把系统挂起(合盖睡眠)的那段排除掉 —— 见 armTurnStallSlice。
 */
const TURN_STALL_SLICE_MS = 60_000;

/**
 * 一个计时分片的实际耗时超出片长这么多 → 判为进程被系统挂起过,该片不计入额度。
 * 与 maker-scheduler 的 SUSPEND_GAP_MS 同量级:远大于正常的事件循环抖动。
 */
const TURN_STALL_SUSPEND_GAP_MS = 30_000;

function parseTurnStallMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_TURN_STALL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TURN_STALL_MS;
  return Math.floor(n);
}

export interface SessionOptions {
  id: string;
  /** 与 Agent MCP context 同源的本次内存实例代号；省略时由 Session 自铸。 */
  sessionInstanceId?: string;
  agentKind: AgentKind;
  workDir: string;
  handle: AgentSessionHandle;
  capabilities: Capabilities;
  logger: Logger;
  /** Runtime permission mode used to create/resume the underlying handle. */
  permissionMode?: PermissionMode;
  /**
   * 远端 SSH 主机的 alias (来自 `@cindy/maker-remote-ssh` ConnectionPool)。
   * 非空 → 这个 session 实际跑在远端机器上, workDir 是远端机器上的路径。
   * 主进程的 send 路径用它判断 "local fs guard 应不应该跑" — 远端 workdir
   * 是不可能存在于本地 fs 的, 没必要也不该 stat。
   */
  remoteHostId?: string | null;
  /**
   * turn 零事件看门狗阈值(ms)。省略 = env / DEFAULT_TURN_STALL_MS；0 = 关闭。
   * 主要供测试注入短阈值，宿主正常不传。
   */
  turnStallMs?: number;
}

function redactEventForListeners(event: AgentEvent): AgentEvent {
  if (!event.data || typeof event.data !== 'object') return event;

  const data = event.data as Record<string, unknown>;
  const safeData = { ...data };
  let changed = false;
  if (event.type === 'error' && typeof safeData.message === 'string') {
    const signals = extractNonSecretErrorSignals(safeData.message);
    if (safeData.errorStatus == null && signals.errorStatus !== undefined) {
      safeData.errorStatus = signals.errorStatus;
      changed = true;
    }
    if (safeData.usageLimit == null && signals.usageLimit) {
      safeData.usageLimit = true;
      changed = true;
    }
  }
  const stringKeys = ['message', 'sdkError', 'summary'];
  if (event.type === 'tool_result_full' && safeData.isError === true) {
    stringKeys.push('fullText');
  }
  for (const key of stringKeys) {
    if (typeof safeData[key] === 'string') {
      const redacted = redactSensitiveText(safeData[key]);
      if (redacted !== safeData[key]) {
        safeData[key] = redacted;
        changed = true;
      }
    }
  }

  if (
    event.type === 'agent_task_update' &&
    safeData.status === 'failed' &&
    safeData.raw &&
    typeof safeData.raw === 'object'
  ) {
    safeData.raw = redactNestedStrings(safeData.raw, () => {
      changed = true;
    });
  }

  if (event.type === 'done' && safeData.raw && typeof safeData.raw === 'object') {
    const raw = { ...(safeData.raw as Record<string, unknown>) };
    if (raw.error && typeof raw.error === 'object') {
      raw.error = redactNestedStrings(raw.error, () => {
        changed = true;
      });
    }
    if (raw.status === 'failed' && Array.isArray(raw.items)) {
      raw.items = redactNestedStrings(raw.items, () => {
        changed = true;
      });
    }
    safeData.raw = raw;
  }

  return changed ? ({ ...event, data: safeData } as AgentEvent) : event;
}

function redactNestedStrings(value: unknown, onChange: () => void): unknown {
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    if (redacted !== value) onChange();
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedStrings(item, onChange));
  }
  if (!value || typeof value !== 'object') return value;

  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = redactNestedStrings(child, onChange);
  }
  return copy;
}

export interface SessionSendOptions extends SendOptions {
  /**
   * Turn reservation 建立后的原子准备钩子。
   *
   * Session 在 active/running 守卫通过并占住本轮之后、provider option preflight
   * 之前调用。仅用于让 host 临时收紧 preflight 本身依赖的 live session 状态；
   * 后续校验或派发仍可能失败，因此调用方必须在自己的终态路径恢复该状态。
   */
  afterTurnReserved?: () => void | Promise<void>;
  /**
   * Provider 启动前的安全屏障。
   *
   * Session 在 active/running 守卫通过、turn reservation 建立后调用；只有该
   * hook 成功完成，才会继续执行产品层 onAccepted 与 vendor handle.send。
   * 适合 durable queue 用 CAS 把任务从 dispatching 标成 accepted_running：
   * hook 失败时 provider/model/tool 均不会启动。
   */
  beforeProviderStart?: () => void | Promise<void>;
  /**
   * 产品层 accepted hook。
   * Session 在 active/running 守卫通过、turn reservation 建立后调用；
   * hook 完成后才启动 vendor handle。
   */
  onAccepted?: () => void | Promise<void>;
  /**
   * vendor dispatch 前最后一个同步边界。用于让 host 在底层可能产生新 turn
   * callback 之前，精确切换自己的 turn-scoped 状态。
   */
  onDispatching?: () => void;
}

/**
 * Session.send 的产品层结果。
 * accepted=true 表示 vendor handle.send 已经跨过 dispatch 边界；onAccepted 只表示
 * 产品层持久化 hook 执行过，不能单独当作 turn 已启动。
 */
export type SessionSendResult =
  | { accepted: true }
  | { accepted: false; reason: 'cancelled-before-dispatch' };

type SendReservation = {
  phase: 'accepting' | 'dispatching';
  cancelled: boolean;
  abortController: AbortController;
};

export class Session {
  readonly id: string;
  /** business id 可复用；instanceId 精确标识本次内存 Session incarnation。 */
  readonly instanceId: string;
  readonly agentKind: AgentKind;
  readonly workDir: string;
  readonly capabilities: Capabilities;
  /** 见 SessionOptions.remoteHostId。 */
  readonly remoteHostId: string | null;

  private readonly handle: AgentSessionHandle;
  private readonly logger: Logger;
  private permissionModeStateValue: PermissionModeState;
  private permissionModeChangeChain: Promise<void> = Promise.resolve();
  private permissionModeChangesInFlight = 0;
  /** User/API permission changes, serialized separately so host restores cannot deadlock. */
  private externalPermissionModeChangeChain: Promise<void> = Promise.resolve();
  private externalPermissionModeChangesInFlight = 0;
  /** Host-owned logical turn leases that outlive a vendor's transient idle edge. */
  private readonly hostTurnLeases = new Set<Promise<void>>();
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly statusListeners = new Set<SessionStatusListener>();
  private interactionListener: InteractionRequestListener | null = null;
  private status: SessionStatus = 'active';
  /**
   * 同一 Session 的并发 close 共享一次底层关闭过程。renderer 与 main 生命周期钩子可能
   * 同时请求关闭；所有调用方都必须等到 transport / 子进程真正释放后才能继续回收 worktree。
   */
  private closePromise: Promise<void> | null = null;
  /** close/detach 一进入同步入口就置位，早于底层 handle 的异步关闭完成。 */
  private terminationStarted = false;
  private eventLoopStarted = false;
  private sendReservation: SendReservation | null = null;
  /**
   * 当前进行中 turn 的发起来源(来自 send 的 opts.origin)。事件 fan-out 前打到
   * AgentEvent.turnOrigin 上,turn 终止(isTerminalTurnEvent)后清空 — 共享
   * session(心跳 + 远程控制)下区分 per-turn 归属。null = 未标记来源(默认)。
   */
  private currentTurnOrigin: SendOrigin | null = null;
  // ── turn 零事件看门狗（见 DEFAULT_TURN_STALL_MS）────────────────────────
  private readonly turnStallMs: number;
  private turnStallTimer: ReturnType<typeof setTimeout> | null = null;
  /** 还需要"清醒地"静默多久才判卡死;按分片递减(见 armTurnStallSlice)。 */
  private turnStallRemainingMs = 0;
  /** 当前分片的起始壁钟时刻;片尾据此识别系统挂起。 */
  private turnStallSliceStartedAt = 0;
  /** 正在等用户回应的交互数；>0 期间不计 stall 额度（没事件是正常的）。 */
  private pendingInteractions = 0;
  /** 最近一次 fan-out 事件的时刻，仅用于日志诊断。 */
  private lastEventAt = 0;
  /**
   * turn 代号：每次 send 建立 reservation 时 +1。看门狗的善后动作（尤其
   * recoverIfTurnStillRunning 的"关掉会话"）必须绑定到超时的那一个 turn，否则宽限期内
   * 新起的健康 turn 会被误杀 —— `isTurnRunning()` 只回答"有 turn 在跑"，不回答"是不是
   * 那一个"（review #944 第七轮 P1）。
   *
   * 只在 reservation 创建处自增就够：send 入口有 `isTurnRunning()` 守卫，卡死的 turn
   * 还在跑时新 send 会被 SESSION_RUNNING 拒掉、拿不到 reservation。换句话说代号变了
   * 就一定意味着"卡死那个 turn 已经停了、这是新活儿"。
   */
  private turnGeneration = 0;
  /** 已为哪个 turn 代号排过 abort 复核；同一 turn 上重复 abort 不重复排。 */
  private abortRecoveryScheduledFor: number | null = null;
  private lastEventType: string | null = null;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.instanceId = opts.sessionInstanceId ?? generateSessionId();
    this.agentKind = opts.agentKind;
    this.workDir = opts.workDir;
    this.handle = opts.handle;
    this.capabilities = opts.capabilities;
    this.remoteHostId = opts.remoteHostId ?? null;
    this.logger = opts.logger.child(`s:${this.id}`);
    this.permissionModeStateValue = {
      mode: opts.permissionMode ?? null,
      generation: 0,
    };
    this.turnStallMs =
      opts.turnStallMs ?? parseTurnStallMs(process.env.XDT_SESSION_TURN_STALL_MS);

    // 注入 InteractionResolver 到底层 handle, 转发到 host 维护的 listener。
    // 没接 listener 时按 kind 给出安全默认: 都视作 deny(host 必须接 listener 才能交互)。
    this.handle.setInteractionResolver(async (req) => {
      // 等用户回应期间挂起 stall 看门狗:用户可能离开电脑很久,没有事件是正常的,
      // 中断这种 turn 等于把"等你决定"误判成"卡死"(见 DEFAULT_TURN_STALL_MS)。
      this.pendingInteractions += 1;
      this.clearTurnStallWatchdog();
      try {
        if (!this.interactionListener) {
          this.logger.warn('interaction request received but no listener attached, denying', { kind: req.kind, requestId: req.requestId });
          if (req.kind === 'ask_user_question') {
            return { kind: 'ask_user_question', answers: {} };
          }
          if (req.kind === 'plan_review') {
            return { kind: 'plan_review', behavior: 'deny', reason: 'no_listener_attached', dismissed: true };
          }
          return { kind: req.kind, behavior: 'deny', reason: 'no_listener_attached' } as InteractionDecision;
        }
        return await this.interactionListener(req);
      } finally {
        this.pendingInteractions = Math.max(0, this.pendingInteractions - 1);
        this.armTurnStallWatchdog();
      }
    });
  }

  // ── 公开 API ─────────────────────────────────────────────────────────────

  /** 当前/最近一次已建立 reservation 的 turn 代号；只用于跨 await 识别是否仍是同一轮。 */
  getTurnGeneration(): number {
    return this.turnGeneration;
  }

  async send(message: UserMessage | string, opts?: SessionSendOptions): Promise<SessionSendResult> {
    const { afterTurnReserved, beforeProviderStart, onAccepted, onDispatching, ...handleOpts } = opts ?? {};
    const cancelledBeforeReservation = (): SessionSendResult | null =>
      handleOpts.signal?.aborted === true
        ? { accepted: false, reason: 'cancelled-before-dispatch' }
        : null;
    const alreadyCancelled = cancelledBeforeReservation();
    if (alreadyCancelled !== null) return alreadyCancelled;
    // A host may need to keep a logical turn exclusive while the vendor briefly
    // reports idle between a foreground result and background-task continuation.
    // Wait instead of racing that continuation with a new Desktop turn.
    while (this.hostTurnLeases.size > 0) {
      if (await this.waitForGateOrAbort(Promise.all([...this.hostTurnLeases]), handleOpts.signal)) {
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
    }
    // A user/API permission change may have been waiting for the lease above.
    // Preserve its ordering before admitting the next turn.
    while (this.externalPermissionModeChangesInFlight > 0) {
      if (await this.waitForGateOrAbort(this.externalPermissionModeChangeChain, handleOpts.signal)) {
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
    }
    // A temporary host permission lease may be restoring immediately after a
    // terminal event. Do not let the next turn reserve the session until that
    // live provider state is settled.
    while (this.permissionModeChangesInFlight > 0) {
      if (await this.waitForGateOrAbort(this.permissionModeChangeChain, handleOpts.signal)) {
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
    }
    const msg: UserMessage = typeof message === 'string'
      ? { type: 'user', content: message }
      : message;
    this.logger.debug('send', summarizeUserMessage(msg));
    this.ensureActive();
    if (this.isTurnRunning()) {
      throw this.createSessionRunningError();
    }
    const reservation: SendReservation = {
      phase: 'accepting',
      cancelled: false,
      abortController: new AbortController(),
    };
    this.sendReservation = reservation;
    // 新一轮 turn 的代号（见 turnGeneration）：看门狗的善后动作据此判断"还是不是那个
    // 卡死的 turn"，避免误杀宽限期内新起的健康 turn。
    this.turnGeneration += 1;
    const cleanupExternalAbort = this.attachExternalCancellation(reservation, handleOpts.signal);
    // originInstalled:已越过 dispatch 边界、把本次 origin 装进 currentTurnOrigin。
    // turnDispatched:handle.send 成功、本次 send 真正成为运行中的 turn。
    let originInstalled = false;
    let turnDispatched = false;
    let previousTurnOrigin: SendOrigin | null = null;
    const finishCancelledBeforeDispatch = (): SessionSendResult | null => {
      if (!reservation.cancelled && this.sendReservation === reservation) return null;
      if (this.sendReservation === reservation) this.sendReservation = null;
      return { accepted: false, reason: 'cancelled-before-dispatch' };
    };
    try {
      const cancelledBeforePreparation = finishCancelledBeforeDispatch();
      if (cancelledBeforePreparation !== null) return cancelledBeforePreparation;
      if (afterTurnReserved) await afterTurnReserved();
      const cancelledAfterReservation = finishCancelledBeforeDispatch();
      if (cancelledAfterReservation !== null) return cancelledAfterReservation;
      this.handle.validateSendOptions?.(handleOpts);
      if (beforeProviderStart) await beforeProviderStart();
      const cancelledBeforeAcceptance = finishCancelledBeforeDispatch();
      if (cancelledBeforeAcceptance !== null) return cancelledBeforeAcceptance;
      await onAccepted?.();
      this.ensureActive();
      const cancelledAfterAcceptance = finishCancelledBeforeDispatch();
      if (cancelledAfterAcceptance !== null) return cancelledAfterAcceptance;
      reservation.phase = 'dispatching';
      // 越过 dispatch 边界才记 origin — cancelled-before-dispatch 早返回不会到这,
      // 不会污染下一个无 origin 的 turn。先存下当前值,handle.send 失败时**还原**而非
      // 清 null(见下方 finally 注释)。
      //
      // 已知局限(PR #129 review Thread G,经产品确认接受):currentTurnOrigin 是单一
      // session 级槽位,无法完美区分**重叠的 turn**。窄 race:turn1 在 handle 层已 idle
      // (isTurnRunning 翻 false)但其终止 done 尚未 fan-out 时,turn2 的 send **成功**会
      // 在此覆盖槽位、且 turnDispatched=true 不触发 finally 还原 → turn1 的 done 带上
      // turn2 的 origin/null,attached IM 转播卡可能不 finalize / 误归属。触发窗口仅事件
      // 队列 drain 的 ms 级延迟,后果有界(转播 UI 边角,非数据丢失)。彻底修需要把 origin
      // 关联到具体 turn 事件而非单槽位(maker-core 热路径重构,规则 10),留作独立后续。
      previousTurnOrigin = this.currentTurnOrigin;
      this.currentTurnOrigin = handleOpts.origin ?? null;
      originInstalled = true;
      this.startEventLoopIfNeeded();
      try {
        onDispatching?.();
        await this.handle.send(msg, {
          ...handleOpts,
          signal: reservation.abortController.signal,
        });
      } catch (e) {
        if (reservation.cancelled) {
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        }
        throw e;
      }
      if (reservation.cancelled) {
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
      turnDispatched = true;
      // turn 真正开始跑 → 起 stall 看门狗。后续每个事件都会重置它，done / 终态
      // error 会清掉它（见 armTurnStallWatchdog）。
      this.armTurnStallWatchdog();
      return { accepted: true };
    } catch (e) {
      if (this.sendReservation === reservation) {
        this.sendReservation = null;
      }
      throw e;
    } finally {
      cleanupExternalAbort();
      if (this.sendReservation === reservation) {
        this.sendReservation = null;
      }
      // 装了 origin 但本次 send 没真正成为运行中的 turn(handle.send 抛错 / dispatch
      // 后被取消)→ **还原**到 dispatch 前的 origin(而非强制清 null)。
      // SESSION_RUNNING race:137 行 isTurnRunning 检查通过、但 handle.send 因底层已有
      // turn 在跑而 reject。两种子情形:
      //   - dispatch 前无 turn 在跑(previousTurnOrigin=null):还原为 null,本次 stale
      //     origin 不会污染后续事件;
      //   - dispatch 前有别的 turn 正在跑(previousTurnOrigin=它的 origin):还原后那个
      //     turn 的剩余事件(含 done)继续带正确 origin。若这里强行清 null,正在跑的
      //     turn 的 done 会丢 origin → IM 转播收不到 done → 转播卡永不 finalize、残留
      //     state 污染下一轮(见 PR #129 review)。
      if (originInstalled && !turnDispatched) {
        this.currentTurnOrigin = previousTurnOrigin;
      }
    }
  }

  async steer(message: UserMessage | string, opts?: SendOptions): Promise<void> {
    const msg: UserMessage = typeof message === 'string'
      ? { type: 'user', content: message }
      : message;
    this.logger.debug('steer', summarizeUserMessage(msg));
    this.ensureActive();
    if (!this.capabilities.sameTurnSteer.supported) {
      throw new NotSupportedError('sameTurnSteer', this.capabilities.sameTurnSteer);
    }
    if (!this.handle.isTurnRunning?.()) {
      throw new Error(`Session ${this.id} has no active turn to steer`);
    }
    this.startEventLoopIfNeeded();
    await this.handle.steer(msg, opts);
  }

  async abort(): Promise<void> {
    if (this.status === 'closed') return;
    if (this.status === 'error') return;
    this.cancelSendReservation(this.sendReservation);
    // 中断已在进行:不再计 stall 额度(下一个 turn 的 send 会重新起表)。
    this.clearTurnStallWatchdog();
    // 但**不能就这么放手**:用户按 Stop 时若 transport 已经不响应,codex 的
    // turn/interrupt 可能永久悬挂、claude 的 q.interrupt() 可能失败且不清 turn-in-flight
    // 标记。这一行刚把 Session 层唯一的复核定时器关掉,agent 层的 idle watchdog 也随
    // turn 中断一起收表 —— 没人再管的话 isTurnRunning() 恒 true,之后每一条 send 都被拒,
    // 会话永久不可用(review #944 第十一轮 P1)。
    //
    // 所以这里也排一次与 turn 绑定的复核,且**不挂在 abort 的 promise 上**(它自己就可能
    // 永不 settle,理由同 onTurnStallTimeout)。宽限比看门狗那条长得多:手动 Stop 背后
    // 没有别的兜底,而健康的 interrupt 往返远不需要这么久,宁可多等也不误关正常会话。
    this.scheduleAbortRecoveryCheck(MANUAL_ABORT_RECOVERY_GRACE_MS, 'manual-abort');
    this.setStatus('aborting');
    try {
      await this.handle.abort();
    } finally {
      this.releaseSendReservationIfObserved();
      if (this.status === 'aborting') {
        this.setStatus('active');
      }
    }
  }

  /**
   * 停止本会话内单个后台任务(run_in_background 的 Bash / 后台 subagent 等)。
   * 与 abort() 不同:不中断当前 turn,只停指定 taskId;任务已到终态时幂等成功。
   * 会话已关闭 / 出错时静默返回 —— 此时子进程已死,后台任务必然随之终止。
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    if (this.status === 'closed' || this.status === 'error') return;
    if (!this.handle.stopBackgroundTask) {
      throw new NotSupportedError('stopBackgroundTask', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.stopBackgroundTask(taskId);
  }

  /**
   * 当前仍在运行的后台任务快照。不支持的 agent / 已关闭会话 → 空数组(此时
   * 子进程不存在,后台任务必然已死,空数组即事实)。
   */
  listBackgroundTasks(): BackgroundTaskSnapshot[] {
    if (this.status === 'closed' || this.status === 'error') return [];
    return this.handle.listBackgroundTasks?.() ?? [];
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.status === 'closed') return Promise.resolve();

    this.terminationStarted = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  /**
   * Close only when no send reservation or agent turn is active. The check and
   * close reservation are synchronous, so a concurrent send either wins first
   * and keeps the session open, or observes closePromise and is rejected.
   */
  closeIfIdle(): Promise<boolean> {
    if (this.status !== 'active' || this.closePromise || this.isTurnRunning()) {
      return Promise.resolve(false);
    }
    this.terminationStarted = true;
    this.closePromise = this.performClose();
    return this.closePromise.then(() => true);
  }

  private async performClose(): Promise<void> {
    try {
      this.clearTurnStallWatchdog();
      this.cancelSendReservation(this.sendReservation);
      await this.handle.close();
    } finally {
      this.sendReservation = null;
      this.currentTurnOrigin = null;
      this.setStatus('closed');
      this.eventListeners.clear();
      this.statusListeners.clear();
      this.interactionListener = null;
    }
  }

  async detach(): Promise<void> {
    if (this.status === 'closed') return;
    this.terminationStarted = true;
    try {
      if (this.handle.detach) {
        await this.handle.detach();
      } else {
        await this.handle.close();
      }
    } finally {
      this.sendReservation = null;
      this.currentTurnOrigin = null;
      this.setStatus('closed');
      this.eventListeners.clear();
      this.statusListeners.clear();
      this.interactionListener = null;
    }
  }

  getUsageSnapshot(): UsageSnapshot {
    return this.handle.getUsageSnapshot();
  }

  async getContextUsage(): Promise<ContextUsageData> {
    this.ensureActive();
    if (!this.handle.getContextUsage) {
      throw new NotSupportedError('contextUsage', { supported: false, reason: 'not-implemented' });
    }
    return this.handle.getContextUsage();
  }

  /**
   * 当前 session 生命周期状态 ('active' / 'aborting' / 'closed' / 'error')。
   * 这是内存里的 SDK 子进程视角, 不持久化。区分:
   *   - 'active'      : 子进程存活, 可正常 send / 切配置
   *   - 'aborting'    : 正在 abort 当前 turn, 短暂瞬态
   *   - 'closed'      : 子进程已关闭, 不可用
   *   - 'error'       : 异常退出
   * 注意: 这跟 desktop DB 的 status 列 ('active'|'archived'|'deleted') 是两个独立维度,
   * 后者是产品归档语义, 跟 SDK 是否在跑无关。
   */
  getStatus(): SessionStatus {
    return this.status;
  }

  /**
   * 底层 agent handle 的会话 id —— cc = SDK session id(也是出站请求的 `x-claude-code-session-id`
   * header 值);SDK 尚未回填时为 '<pending>'。只读、不触发任何行为,供 host 把 loopback proxy
   * 看到的请求归属回本会话做 per-session 路由(见 maker-host/anthropic-compat-proxy-host.ts)。
   */
  get sdkSessionId(): string {
    return this.handle.id;
  }

  /** 当前运行时模型。底层 handle 的 getter 会随 setModel 成功更新。 */
  get model(): string {
    return this.handle.model;
  }

  /** Codex-only: 当前会话绑定的 app-server host 是否经 loopback proxy 出口。 */
  get codexProxyActive(): boolean | undefined {
    return this.handle.codexProxyActive;
  }

  /** Snapshot used by temporary host overrides to avoid undoing a newer user change. */
  get permissionModeState(): PermissionModeState {
    return { ...this.permissionModeStateValue };
  }

  /**
   * 只在本 Session 仍活跃、未开始关闭、且没有权限切换在途时返回稳定快照。
   * 权限边界读取方必须用本 getter，不能直接用 permissionModeState：底层切换
   * 完成前旧 mode 仍会保留，而收紧操作一开始就应 fail closed。
   */
  get stablePermissionModeState(): PermissionModeState | null {
    if (this.status !== 'active' || this.terminationStarted) return null;
    if (
      this.permissionModeChangesInFlight > 0 ||
      this.externalPermissionModeChangesInFlight > 0
    ) {
      return null;
    }
    return this.permissionModeState;
  }

  /**
   * Keep this Session logically occupied beyond the provider's own turn flag.
   * The caller must release the returned lease on every terminal path.
   */
  acquireTurnLease(): () => void {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.hostTurnLeases.add(gate);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.hostTurnLeases.delete(gate);
      resolveGate();
    };
  }

  // ── 运行时切换 ─────────────────────────────────────────────────────────────

  async setModel(model: string, opts?: { providerId?: string | null }): Promise<void> {
    if (!this.capabilities.switchModel.supported) {
      throw new NotSupportedError('switchModel', this.capabilities.switchModel);
    }
    if (!this.handle.setModel) {
      throw new NotSupportedError('switchModel', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setModel(model, opts);
  }

  async setEffort(effort: Effort): Promise<void> {
    if (!this.capabilities.effort.supported) {
      throw new NotSupportedError('effort', this.capabilities.effort);
    }
    if (!this.handle.setEffort) {
      throw new NotSupportedError('effort', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setEffort(effort);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.assertPermissionModeSupported(mode);
    this.externalPermissionModeChangesInFlight += 1;
    const operation = this.externalPermissionModeChangeChain.catch(() => undefined).then(async () => {
      if (this.isTurnPermissionPolicyUnsafe(mode)) {
        // Official group turns hold a host lease until background continuations
        // and the temporary safe-mode restore have both settled. Do not let an
        // external Full access / accept-edits switch weaken that active turn.
        // Host-owned temporary switches use setPermissionModeTracked and remain
        // able to restore while this operation waits, avoiding a lease deadlock.
        while (this.hostTurnLeases.size > 0) {
          await Promise.all([...this.hostTurnLeases]);
        }
      }
      await this.setPermissionModeTracked(mode);
    });
    const tracked = operation.finally(() => {
      this.externalPermissionModeChangesInFlight -= 1;
    });
    this.externalPermissionModeChangeChain = tracked.then(
      () => undefined,
      () => undefined,
    );
    await tracked;
  }

  async setPermissionModeTracked(mode: PermissionMode): Promise<PermissionModeState> {
    this.assertPermissionModeSupported(mode);
    this.permissionModeChangesInFlight += 1;
    const operation = this.permissionModeChangeChain.catch(() => undefined).then(async () => {
      await this.handle.setPermissionMode!(mode);
      this.permissionModeStateValue = {
        mode,
        generation: this.permissionModeStateValue.generation + 1,
      };
      return this.permissionModeState;
    });
    const tracked = operation.finally(() => {
      this.permissionModeChangesInFlight -= 1;
    });
    this.permissionModeChangeChain = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  async setPermissionModeIfUnchanged(
    expected: PermissionModeState,
    mode: PermissionMode,
  ): Promise<boolean> {
    this.assertPermissionModeSupported(mode);
    // An external request is newer user intent even when an unsafe target is
    // still waiting for a host turn lease. Never restore over it, and never
    // wait here: that request may need this restore path to release the lease.
    if (this.externalPermissionModeChangesInFlight > 0) return false;
    this.permissionModeChangesInFlight += 1;
    const operation = this.permissionModeChangeChain.catch(() => undefined).then(async () => {
      const current = this.permissionModeStateValue;
      if (current.mode !== expected.mode || current.generation !== expected.generation) {
        return false;
      }
      await this.handle.setPermissionMode!(mode);
      this.permissionModeStateValue = { mode, generation: current.generation + 1 };
      return true;
    });
    const tracked = operation.finally(() => {
      this.permissionModeChangesInFlight -= 1;
    });
    this.permissionModeChangeChain = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private assertPermissionModeSupported(mode: PermissionMode): void {
    if (!this.capabilities.permissionModes.some((m) => m.id === mode)) {
      throw new NotSupportedError(
        `permissionMode='${mode}'`,
        {
          supported: false,
          reason: 'sdk-missing',
          message: `Available: ${this.capabilities.permissionModes.map((m) => m.id).join(', ')}`,
        },
      );
    }
    if (!this.capabilities.setPermissionModeMidSession.supported) {
      throw new NotSupportedError('setPermissionModeMidSession', this.capabilities.setPermissionModeMidSession);
    }
    if (!this.handle.setPermissionMode) {
      throw new NotSupportedError('setPermissionMode', { supported: false, reason: 'not-implemented' });
    }
  }

  private isTurnPermissionPolicyUnsafe(mode: PermissionMode): boolean {
    return this.capabilities.turnPermissionPolicy?.unsupportedPermissionModes.includes(mode) === true;
  }

  async setFastMode(enabled: boolean): Promise<void> {
    this.ensureActive();
    if (!this.handle.setFastMode) {
      throw new NotSupportedError('fastMode', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setFastMode(enabled);
  }

  /** 运行时开关计划模式（capability 见 Capabilities.planMode）。 */
  async setPlanMode(enabled: boolean): Promise<void> {
    this.ensureActive();
    if (!this.capabilities.planMode?.supported) {
      throw new NotSupportedError('planMode', this.capabilities.planMode ?? { supported: false, reason: 'not-implemented' });
    }
    if (!this.handle.setPlanMode) {
      throw new NotSupportedError('planMode', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setPlanMode(enabled);
  }

  getPlanMode(): boolean | null {
    return this.handle.getPlanMode?.() ?? null;
  }

  /** 导出当前会话为 HTML,返回写入路径(capability 见 Capabilities.sessionHtmlExport)。 */
  async exportSessionHtml(outputPath?: string): Promise<string> {
    this.ensureActive();
    if (!this.capabilities.sessionHtmlExport?.supported) {
      throw new NotSupportedError(
        'sessionHtmlExport',
        this.capabilities.sessionHtmlExport ?? { supported: false, reason: 'not-implemented' },
      );
    }
    if (!this.handle.exportSessionHtml) {
      throw new NotSupportedError('sessionHtmlExport', { supported: false, reason: 'not-implemented' });
    }
    return this.handle.exportSessionHtml(outputPath);
  }

  /** 手动压缩会话上下文(capability 见 Capabilities.manualCompact)。 */
  async compactSession(instructions?: string): Promise<ManualCompactResult> {
    this.ensureActive();
    if (!this.capabilities.manualCompact?.supported) {
      throw new NotSupportedError(
        'manualCompact',
        this.capabilities.manualCompact ?? { supported: false, reason: 'not-implemented' },
      );
    }
    if (!this.handle.compactSession) {
      throw new NotSupportedError('manualCompact', { supported: false, reason: 'not-implemented' });
    }
    return this.handle.compactSession(instructions);
  }

  async getSessionTree(): Promise<SessionTreeSnapshot> {
    this.ensureActive();
    const status = this.capabilities.sessionTree ?? { supported: false as const, reason: 'not-implemented' as const };
    if (!status.supported) throw new NotSupportedError('sessionTree', status);
    if (!this.handle.getSessionTree) {
      throw new NotSupportedError('sessionTree', { supported: false, reason: 'not-implemented' });
    }
    return this.handle.getSessionTree();
  }

  async navigateSessionTree(
    entryId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<NavigateSessionTreeResult> {
    this.ensureActive();
    const status = this.capabilities.sessionTree ?? { supported: false as const, reason: 'not-implemented' as const };
    if (!status.supported) throw new NotSupportedError('sessionTree', status);
    if (!this.handle.navigateSessionTree) {
      throw new NotSupportedError('sessionTree', { supported: false, reason: 'not-implemented' });
    }
    if (this.isTurnRunning()) {
      const err = new Error('SESSION_RUNNING: 会话进行中，无法切换分支');
      (err as { code?: string }).code = 'SESSION_RUNNING';
      throw err;
    }
    return this.handle.navigateSessionTree(entryId, options);
  }

  getFastMode(): boolean | null {
    return this.handle.getFastMode?.() ?? null;
  }

  /**
   * 运行时合并 vendorOptions (浅合并到内部 closure)。
   * 用于 host 中途切换 session-specific 配置(典型场景:Orca 协同模式 toggle,
   * 传 { orcaRole, orcaWorkflowId, orcaLeadSessionId } 让 MCP provider 的
   * isEnabled(ctx) 在下一 turn 立即返回 true / false)。
   * - Claude Code: 即时生效(下一 turn buildMcpServers 读最新 vo)。
   * - Codex: in-place 合并后重新注册 thread context；HTTP MCP bridge 在
   *          tool-call 时恢复该 context，控制类工具可读到最新 vendorOptions。
   * 不写 DB,持久化由调用方负责(orca_workflows / sessions.orca_role 等)。
   */
  async setVendorOptions(patch: Record<string, unknown>): Promise<void> {
    this.ensureActive();
    if (!this.handle.setVendorOptions) {
      throw new NotSupportedError('vendorOptions', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setVendorOptions(patch);
  }

  /**
   * 运行时覆盖 extraDirs (附加只读引用目录)。Claude 与 Codex 都在下一 turn 生效。
   * 不写 DB —— 持久化由调用方 (main IPC 协调 local-db:sessions:update) 负责,
   * 跟 setModel/setEffort 双 IPC 协调先例一致。
   */
  async setExtraDirs(dirs: string[]): Promise<void> {
    this.ensureActive();
    if (!this.capabilities.extraDirs.supported) {
      throw new NotSupportedError('extraDirs', this.capabilities.extraDirs);
    }
    if (!this.handle.setExtraDirs) {
      throw new NotSupportedError('extraDirs', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setExtraDirs(dirs);
  }

  // ── Rewind (Stage 2 C2) ────────────────────────────────────────────────────
  // Claude 走 SDK checkpoint；Codex 走 thread/rollback 裁剪对话。
  // 业务层 (desktop agentRewind.ts) 通过这个委托对外暴露。

  /**
   * 当前是否有 turn 在跑 (rewind preview/commit 业务前置守卫用)。
   * 默认 false (handle.isTurnRunning 不实现的 agent 永远算 idle)。
   */
  isTurnRunning(): boolean {
    return (
      this.sendReservation !== null ||
      this.hostTurnLeases.size > 0 ||
      this.permissionModeChangesInFlight > 0 ||
      this.isHandleTurnRunning()
    );
  }

  getCurrentTurnId(): string | null {
    return this.handle.getCurrentTurnId?.() ?? null;
  }

  /**
   * dryRun: 问 SDK 这次 rewind 会动哪些文件。返回 RewindFilesResult 给 UI 显示 diff。
   * SDK 软拒绝 (老 session 无 checkpointing) 包成 {canRewind:false, error}, 业务可继续。
   */
  async previewRewindFiles(userUuid: string): Promise<RewindFilesResult> {
    if (!this.capabilities.rewind.supported) {
      throw new NotSupportedError('rewind', this.capabilities.rewind);
    }
    if (!this.handle.previewRewindFiles) {
      throw new NotSupportedError('previewRewindFiles', { supported: false, reason: 'not-implemented' });
    }
    this.ensureActive();
    return this.handle.previewRewindFiles(userUuid);
  }

  /**
   * 真执行 rewind: 文件回滚 + close 当前 SDK Query + 标记 pendingRewindTo。
   * 下一次 send 时 agent 内部会自动用三件套 (resume + resumeSessionAt + forkSession) 重启 SDK Query,
   * 对调用方完全透明。
   *
   * 守卫:
   * - capabilities.rewind 不支持 → NotSupportedError
   * - session 已 closed → ensureActive 抛
   * - turn 在跑 → SESSION_RUNNING (业务层应在调本方法前提示用户等结束)
   */
  async commitRewindFiles(
    userUuid: string,
    priorAssistantUuid: string,
    opts?: RewindCommitOptions,
  ): Promise<undefined | RewindCommitResult> {
    if (!this.capabilities.rewind.supported) {
      throw new NotSupportedError('rewind', this.capabilities.rewind);
    }
    if (!this.handle.commitRewindFiles) {
      throw new NotSupportedError('commitRewindFiles', { supported: false, reason: 'not-implemented' });
    }
    this.ensureActive();
    if (this.isTurnRunning()) {
      const err = new Error('SESSION_RUNNING: 会话进行中, 无法 rewind');
      (err as { code?: string }).code = 'SESSION_RUNNING';
      throw err;
    }
    return this.handle.commitRewindFiles(userUuid, priorAssistantUuid, opts);
  }

  // ── 订阅 ─────────────────────────────────────────────────────────────────

  onEvent(listener: SessionEventListener): () => void {
    this.eventListeners.add(listener);
    this.startEventLoopIfNeeded();
    return () => this.eventListeners.delete(listener);
  }

  onStatusChange(listener: SessionStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  setInteractionListener(listener: InteractionRequestListener | null): void {
    this.interactionListener = listener;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private ensureActive(): void {
    if (this.status === 'closed') {
      throw new Error(`Session ${this.id} is closed`);
    }
    if (this.closePromise) {
      throw new Error(`Session ${this.id} is closing`);
    }
    if (this.status === 'error') {
      throw new Error(`Session ${this.id} is in error state`);
    }
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((cb) => {
      try { cb(s); } catch (e) { this.logger.error('status listener threw', { error: String(e) }); }
    });
  }

  private startEventLoopIfNeeded(): void {
    if (this.eventLoopStarted) return;
    this.eventLoopStarted = true;
    void this.runEventLoop();
  }

  /**
   * 事件 fan-out 的唯一出口(真实事件与看门狗合成的事件共用)。三件事都收在这里,
   * 保证两条来路语义一致 —— origin 打标、订阅者分发、stall 看门狗记账。
   *
   * origin 处理刻意放在这里而不是只放在 runEventLoop:看门狗合成的终态 error 若不
   * 带 turnOrigin,消费方会把它当成"无来源"事件 —— goal-host 归类成 origin:'other'
   * 并像用户插话一样暂停 goal,scheduler 的 IM 转播则直接忽略,卡片永不 finalize
   * (review #944 第二轮)。
   */
  private fanOutEvent(event: AgentEvent): void {
    this.lastEventAt = Date.now();
    this.lastEventType = event.type;
    // fan-out 前打 turn origin(所有 listener 拿到同一份);事件对象由 translator
    // 每次新建、看门狗每次合成,不会串台。=== undefined 守卫:不覆盖 agent 自带的。
    if (this.currentTurnOrigin && event.turnOrigin === undefined) {
      event.turnOrigin = this.currentTurnOrigin;
    }
    const listenerEvent = redactEventForListeners(event);
    for (const listener of this.eventListeners) {
      try { listener(listenerEvent); } catch (e) { this.logger.error('event listener threw', { error: String(e) }); }
    }
    const isTerminal = event.type === 'done' || isTerminalAgentErrorEvent(event);
    // turn 真正结束后清 origin,下一轮无 origin 的 turn 不被污染。
    // 关键:**只**在 done / 终止型 error 上清,**不要**在 status(isRunning=false)
    // 上清 —— translator 收尾是先 push end-status(isRunning=false)、紧接着 push
    // done(claude translator.ts / codex 同序)。若在 end-status 上清,后随的 done
    // 就拿不到 origin,而 IM 转播(turnRunner)正是按 scheduler-origin 的 done 收口
    // 卡片;done 丢了 origin → 卡片永不 finalize,残留 ticker/state 污染下一轮转播。
    // done / 终止型 error 自身已在上面打过 origin,清在它们之后安全。
    //
    // Bridge /compact 这类 agent 内部排队 turn 的边界应在 agent 层 suppress,
    // 不应透传到 Session。凡是到达 Session 的 done / 终止型 error 都代表产品层
    // turn 已结束,必须清 origin,避免后续 standalone auto-compact 等后台 turn 继承
    // goal/scheduler origin。
    if (isTerminal) {
      this.currentTurnOrigin = null;
      // 终态之后不再计 stall 额度。
      this.clearTurnStallWatchdog();
    } else {
      this.armTurnStallWatchdog();
    }
  }

  private clearTurnStallWatchdog(): void {
    if (this.turnStallTimer) {
      clearTimeout(this.turnStallTimer);
      this.turnStallTimer = null;
    }
    this.turnStallRemainingMs = 0;
    this.turnStallSliceStartedAt = 0;
  }

  /**
   * (重新)起 turn 零事件看门狗。以下情形不起表:
   *   - 阈值被关掉(0)
   *   - 会话已不活跃(closed / error / aborting)
   *   - 没有 turn 在跑 —— 空闲会话本来就没有事件
   *   - 正在等用户回应交互 —— 权限询问 / AskUserQuestion / plan review 可能挂很久
   *   - 有后台任务在跑 —— run_in_background 的 Bash、后台 subagent 期间安静是正常的
   * 后两条是误杀防护(见 DEFAULT_TURN_STALL_MS)。
   */
  private armTurnStallWatchdog(): void {
    this.clearTurnStallWatchdog();
    if (this.turnStallMs <= 0) return;
    if (this.status !== 'active') return;
    if (this.closePromise) return;
    if (!this.isTurnRunning()) return;
    if (this.pendingInteractions > 0) return;
    if (this.hasRunningBackgroundTasks()) return;
    this.turnStallRemainingMs = this.turnStallMs;
    this.armTurnStallSlice();
  }

  /**
   * 分片计时:每片最多 TURN_STALL_SLICE_MS,片尾核对"这一片真实走了多久"。
   *
   * 不能用一个 45 分钟的长定时器直接判定 —— Electron 被系统挂起(合盖睡眠)期间没有任何
   * 事件,而定时器一旦在唤醒后到期就立刻开火:一次午休就足以让看门狗给一条完全健康的
   * turn 推终态 error 并中断它(review #944 第十二轮 P1)。
   *
   * 片尾若发现壁钟走得远超本片时长,说明进程被冻结过 —— 这段不计入额度,重新起片。
   * 只有"清醒地"连续静默满 turnStallMs 才判卡死。与 scheduler 侧
   * absorbSuspendGap / tick 的挂起处理,以及 codex(armUpstreamIdleSlice)、
   * claude-code(armUpstreamResponseIdleSlice)两个 upstream-idle 看门狗同源。
   */
  private armTurnStallSlice(): void {
    const slice = Math.min(this.turnStallRemainingMs, TURN_STALL_SLICE_MS);
    this.turnStallSliceStartedAt = Date.now();
    this.turnStallTimer = setTimeout(() => {
      this.turnStallTimer = null;
      const elapsed = Date.now() - this.turnStallSliceStartedAt;
      if (elapsed > slice + TURN_STALL_SUSPEND_GAP_MS) {
        // 系统挂起过:这一片不算数,原地重开(额度不扣)。
        this.logger.info('turn stall watchdog skipped a suspended slice', {
          sliceMs: slice,
          elapsedMs: elapsed,
        });
        // 唤醒后的状态可能已经变了(turn 结束 / 冒出交互 / 起了后台任务),走完整重判。
        this.armTurnStallWatchdog();
        return;
      }
      this.turnStallRemainingMs -= Math.max(0, elapsed);
      if (this.turnStallRemainingMs > 0) {
        this.armTurnStallSlice();
        return;
      }
      this.onTurnStallTimeout();
    }, slice);
    // 不让看门狗拖住进程退出(Electron main 常驻无感,vitest / CLI 宿主有感)。
    (this.turnStallTimer as unknown as { unref?: () => void }).unref?.();
  }

  private hasRunningBackgroundTasks(): boolean {
    try {
      return (this.handle.listBackgroundTasks?.() ?? []).length > 0;
    } catch (e) {
      // 查询失败按"没有后台任务"处理:看门狗宁可起表(仍有 45min 缓冲 + 其余排除项),
      // 也不要因为一个诊断查询抛错就永久失效。
      this.logger.warn('listBackgroundTasks threw while arming stall watchdog', { error: String(e) });
      return false;
    }
  }

  /**
   * turn 零事件超时:整条链路(上游 / 工具 / 子进程 stdio)已经没有任何动静。
   * 先合成一条终态 error 事件让所有消费方收口(renderer 停转圈、scheduler 把 run 记
   * failed、IM 转播 finalize 卡片),再中断 turn。
   *
   * 顺序与 claude-code 的 upstream-idle watchdog 一致:先推事件再中断 —— 中断本身
   * 可能只 drain 出一个空 done(会被上游当成静默收尾),不足以让消费方知道发生了什么。
   *
   * 用 abort() 而不是 close():abort 在各 agent 里都是"只 interrupt 当前 turn"的安全
   * 语义(见 claude-code handle.abort 注释),会话保持可用,用户可以直接发下一条继续。
   */
  private onTurnStallTimeout(): void {
    // 触发前复核:定时器排上队之后可能已经收到事件 / turn 已结束 / 冒出交互等待。
    if (this.status !== 'active' || this.closePromise) return;
    if (!this.isTurnRunning()) return;
    if (this.pendingInteractions > 0) return;
    if (this.hasRunningBackgroundTasks()) return;
    const now = Date.now();
    const msSinceLastEvent = this.lastEventAt > 0 ? now - this.lastEventAt : null;
    this.logger.warn('turn stall watchdog tripped — no events at all, interrupting turn', {
      turnStallMs: this.turnStallMs,
      lastEventType: this.lastEventType,
      msSinceLastEvent,
    });
    const minutes = Math.round(this.turnStallMs / 60_000);
    this.fanOutEvent({
      type: 'error',
      data: {
        // reason 是 renderer i18n 的稳定 key(ERROR_REASON_I18N_KEYS,规则 18);
        // message 仅作非 renderer 消费方(IM / orca / 日志)的英文兜底。
        message:
          `This turn produced no activity at all for ${minutes} minutes ` +
          '(upstream, tools and the agent subprocess were all silent); ' +
          'it was interrupted automatically. You can send the next message to continue.',
        isTerminal: true,
        reason: 'turn_no_event_timeout',
        turnStallMs: this.turnStallMs,
        lastEventType: this.lastEventType,
        msSinceLastEvent,
      },
      source: this.agentKind,
    } as AgentEvent);
    // 复核定时器**先于** abort 排定,且不挂在 abort 的 promise 上。
    // 曾经写在 .finally() 里,但 abort 走的正是"已经哑火"的那条链路:agent 的
    // handle.abort() 若自己也悬挂(如 turn/interrupt RPC 永不返回),promise 永不 settle
    // → finally 永不执行 → 复核永不发生 → 会话永久不可用,恰好是本看门狗要救的场景
    // (review #944 第五轮 Copilot)。recoverIfTurnStillRunning 自己会复核 isTurnRunning,
    // abort 正常生效时它是 no-op,所以无条件排定是安全的。
    // 复核由 abort() 内部统一排(见 scheduleAbortRecoveryCheck),这里只需要用看门狗
    // 自己的短宽限覆盖它:本路径已经确诊卡死,不必再等手动 Stop 那样长的时间。
    this.scheduleAbortRecoveryCheck(STALL_ABORT_RECOVERY_GRACE_MS, 'stall-watchdog');
    void this.abort().catch((e) => {
      this.logger.warn('turn stall watchdog abort failed', { error: String(e) });
    });
  }

  /**
   * 排一次"abort 到底生效了吗"的复核。中断请求本身可能永不 settle(codex 的
   * turn/interrupt 悬挂),所以定时器**不挂在 abort 的 promise 上**;也必须绑定当时的
   * turn 代号,否则宽限期内新起的健康 turn 会被误杀(见 turnGeneration)。
   * 幂等:同一 turn 上重复 abort 只保留最早排定的那次复核。
   */
  private scheduleAbortRecoveryCheck(graceMs: number, trigger: 'stall-watchdog' | 'manual-abort'): void {
    const generation = this.turnGeneration;
    if (this.abortRecoveryScheduledFor === generation) return;
    this.abortRecoveryScheduledFor = generation;
    // 宽限也要**排除系统挂起**:合盖睡眠期间 transport 一个字节都收不到,而裸定时器一旦在
    // 唤醒后到期就立刻开火 —— 一次午休就能让"给 interrupt 的 10s / 60s"变成 0s 有效时间,
    // 复核于是关掉一条其实还响应得动的会话(第十八轮 P1)。与 armTurnStallSlice、codex 的
    // armUpstreamIdleSlice、claude-code 的 armUpstreamResponseIdleSlice、scheduler 的
    // absorbSuspendGap、排队派发的 QUEUED_DISPATCH_SUSPEND_GAP_MS 同源:壁钟差 ≠ 清醒时间。
    this.armAbortRecoverySlice(generation, graceMs, graceMs, trigger);
  }

  /** 宽限的分片计时:片尾核对壁钟,发现被冻结过就把那一片作废重开(额度不扣)。 */
  private armAbortRecoverySlice(
    generation: number,
    remainingMs: number,
    graceMs: number,
    trigger: 'stall-watchdog' | 'manual-abort',
  ): void {
    const slice = Math.min(remainingMs, TURN_STALL_SLICE_MS);
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > slice + TURN_STALL_SUSPEND_GAP_MS) {
        this.logger.info('abort recovery skipped a suspended slice', {
          trigger,
          sliceMs: slice,
          elapsedMs: elapsed,
        });
        this.armAbortRecoverySlice(generation, remainingMs, graceMs, trigger);
        return;
      }
      const left = remainingMs - Math.max(0, elapsed);
      if (left > 0) {
        this.armAbortRecoverySlice(generation, left, graceMs, trigger);
        return;
      }
      // 把真正生效的宽限与触发来源带进复核:两条路径的宽限不同(手动 60s / 看门狗 10s),
      // 幂等又只保留最早排定的那一次 —— 日志里写死任一常量都会误导事故排查
      // (review #944 第十八轮 Copilot)。
      void this.recoverIfTurnStillRunning(generation, { graceMs, trigger });
    }, slice);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * abort 的兜底复核(看门狗中断与手动 abort 共用):turn 仍在跑说明 agent 层的中断没生效,
   * 会话已经不可用(isTurnRunning 恒 true → 后续 send 全被拒)。关掉它,让下一次 send 走
   * Maker 的 lazy create 重建 handle。这是所有 agent 共用的恢复出路,不需要各自实现重建。
   */
  private async recoverIfTurnStillRunning(
    stalledGeneration: number,
    ctx: { graceMs: number; trigger: 'stall-watchdog' | 'manual-abort' },
  ): Promise<void> {
    if (this.status === 'closed' || this.closePromise) return;
    // 代号变了 = 卡死那个 turn 已经停了(否则新 send 会被 SESSION_RUNNING 拒),现在跑的是
    // 新活儿。abort 生效了,不能拿"有 turn 在跑"当作"还没恢复"去关会话。
    if (this.turnGeneration !== stalledGeneration) {
      this.logger.info('abort took effect; a newer turn is running — not closing session', {
        trigger: ctx.trigger,
        stalledGeneration,
        currentGeneration: this.turnGeneration,
      });
      return;
    }
    if (!this.isTurnRunning()) return; // abort 生效了,会话仍可用,什么都不做
    this.logger.error(
      'turn still running after abort — closing session so the next send can rebuild it',
      { trigger: ctx.trigger, graceMs: ctx.graceMs },
    );
    try {
      await this.close();
    } catch (e) {
      this.logger.warn('abort recovery close failed', { trigger: ctx.trigger, error: String(e) });
    }
  }

  private async runEventLoop(): Promise<void> {
    try {
      for await (const event of this.handle.events()) {
        this.releaseSendReservationIfObserved();
        // origin 打标与终态清理都收在 fanOutEvent 里（看门狗合成的事件共用同一语义，
        // 见那里的注释）。
        this.fanOutEvent(event);
      }
    } catch (e) {
      this.logger.error('event loop crashed', { error: String(e) });
      this.sendReservation = null;
      this.currentTurnOrigin = null;
      this.clearTurnStallWatchdog();
      this.setStatus('error');
      return;
    }
    // handle.events() 自然结束 (iterator return) = 底层 handle 已死、不会再发任何事件。
    // 各 agent 走到这里的路径:
    //   - 本地 SDK 子进程退出 (CLI exit / stream closed)
    //   - claude-code 远端 daemon 突死 → U4b RemoteQuery messageQueue.end → U2 兜底
    //     set closed=true → finally `if (closed) eventQueue.end()`
    //   - handle.close() 主动关 (close 路径自己已 setStatus('closed'), 这里 idempotent no-op)
    //
    // 此前没有这条兜底, status 一直停在 'active' → Maker.activeSessions 永远不 delete
    // → 下次 maker:send 拿到老 Session → handle.send 把消息塞进死的 inputQueue →
    // 用户感知"发了没反应"。setStatus('closed') 触发 Maker 那边的 statusListener:
    // activeSessions.delete + emit 'session:closed' + lifecycleHooks.onClose → 下次
    // send 自然走 IPC lazy create-session 路径, 重建 handle / transport / 远端连接。
    //
    // 仅当当前 status 还是 'active' 时切 — 'closed' / 'error' 已经表达终态, 不覆盖。
    if (this.status === 'active') {
      this.logger.debug('event loop ended (handle dead), auto-closing session');
      this.sendReservation = null;
      this.currentTurnOrigin = null;
      this.setStatus('closed');
    }
  }

  private isHandleTurnRunning(): boolean {
    return this.handle.isTurnRunning?.() ?? false;
  }

  private releaseSendReservationIfObserved(reservation = this.sendReservation): void {
    if (!reservation || this.sendReservation !== reservation) return;
    if (reservation.phase === 'accepting') return;
    if (this.isHandleTurnRunning()) {
      this.sendReservation = null;
    }
  }

  private cancelSendReservation(reservation: SendReservation | null): void {
    if (!reservation || reservation.cancelled) return;
    reservation.cancelled = true;
    reservation.abortController.abort();
  }

  private attachExternalCancellation(reservation: SendReservation, signal?: AbortSignal): () => void {
    if (!signal) return () => undefined;
    const onAbort = () => this.cancelSendReservation(reservation);
    if (signal.aborted) {
      onAbort();
      return () => undefined;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  private async waitForGateOrAbort(gate: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await gate;
      return false;
    }
    if (signal.aborted) return true;
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([gate, aborted]);
      return signal.aborted;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private createSessionRunningError(): Error {
    const err = new Error(`SESSION_RUNNING: Session ${this.id} is already running a turn`);
    (err as { code?: string }).code = 'SESSION_RUNNING';
    return err;
  }
}

/**
 * 内部 helper：生成本地 session id（对外暴露给 host 以便落 SessionStorage）。
 */
export function generateSessionId(): string {
  return randomUUID();
}

/**
 * 把 UserMessage 摘要成日志友好的 dict —— 不打全文（可能含敏感/超长），只打长度和数量。
 */
function summarizeUserMessage(msg: UserMessage): Record<string, unknown> {
  if (typeof msg.content === 'string') {
    return {
      contentType: 'string',
      textLen: msg.content.length,
      textPreview: msg.content.slice(0, 80) + (msg.content.length > 80 ? '…' : ''),
    };
  }
  let textLen = 0;
  let imageCount = 0;
  let fileCount = 0;
  let mentionCount = 0;
  let firstTextPreview: string | undefined;
  for (const block of msg.content) {
    if (block.type === 'text') {
      textLen += block.text.length;
      if (firstTextPreview === undefined) {
        firstTextPreview = block.text.slice(0, 80) + (block.text.length > 80 ? '…' : '');
      }
    } else if (block.type === 'image') {
      imageCount += 1;
    } else if (block.type === 'file') {
      fileCount += 1;
    } else if (block.type === 'mention') {
      mentionCount += 1;
    }
  }
  return {
    contentType: 'array',
    blockCount: msg.content.length,
    textLen,
    imageCount,
    fileCount,
    mentionCount,
    textPreview: firstTextPreview,
  };
}
