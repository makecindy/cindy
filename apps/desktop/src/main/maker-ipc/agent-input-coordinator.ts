/**
 * AgentInputCoordinator — main 侧排队输入事务协调器。
 *
 * 为什么需要它：
 * renderer 可以渲染队列，但不能做事务 owner。一条用户输入会跨过四个状态 owner：
 * 队列 projection、可见气泡、SQLite message row、maker-core dispatch 边界。
 * 插话 rollout 反复回归的原因，是 renderer 乐观推进了其中一个 owner，而 main /
 * maker-core 还没真正派发这条输入。这个 coordinator 把状态迁移显式化，并让所有
 * dispatch 前失败都走可回滚路径。
 *
 * 状态迁移表：
 *
 * path   | queue                         | bubble / DB
 * -------|-------------------------------|----------------------------------------------
 * send   | enqueue 后由 main drain 队首    | onAccepted 只落库；send 返回 accepted=true 后才算已派发
 * steer  | marker 阻塞 drain              | maker.steer 接受后落库，失败则保留/回退队列态
 * stop   | 保留并暂停 pending rows         | 不新建 DB row；只在 abort 边界释放 drain
 * close  | abort in-flight steer markers  | 不新建 DB row；closing 释放 abort lock 后再 drain
 * retry  | typed recovery，不重发文本      | 重新 drain 队首或 clone accepted turn
 * remove | 只允许 pending rows             | 不删 DB；未接受 row 从未持久化
 * edit   | 只允许 pending rows             | 接受前更新队列快照
 *
 * renderer 仍负责准备可序列化的附件 / mention 数据，因为输入 UI 属于 renderer。
 * 它只提交 intent payload；排序、投递模式、回滚和持久化由本模块决定。
 */

import { createLogger } from '../logger.js';
import { createMessage as createDbMessage } from '../localDb/ipc/messages.js';
import { touchUserSendInDb } from '../localDb/ipc/sessions.js';
import type { HostSendFailureCode, HostSendOutcome } from '../maker-host/send-outcome.js';
import type {
  AgentInputCreateOpts,
  AgentInputDelivery,
  AgentInputMakerMessage,
  AgentInputProjection,
  AgentInputQueuedMessage,
  AgentInputRecovery,
  AgentInputSessionReferenceContext,
} from '../../shared/agentInputQueue.js';
import {
  buildMakerUserMessage,
  getAgentFacingText,
  projectionRetryText,
  sanitizeQueuedMessageForPersistence,
  updateQueuedMessageContent,
  updateQueuedMessageText,
} from '../../shared/agentInputQueue.js';
import {
  CONTINUE_AFTER_ERROR_PROMPT,
  syntheticTriggerKind,
} from '../../shared/interruptedTurn.js';
import { attachSessionReferenceMetadata } from '../../shared/sessionReferenceMetadata.js';

const log = createLogger('maker-input-coordinator');
const SESSION_RUNNING_RETRY_DELAY_MS = 250;
/**
 * 凭证切换等待的兜底重试间隔。与 SESSION_RUNNING(本会话 µs 级竞态,250ms 静默重试)
 * 不同:挡路的是**其它会话**的长任务,主唤醒靠 onExternalTurnSettled(挡路会话 turn
 * done/error/closed 三处接线),这个定时器只兜事件丢失的底;每次重试要走一遍
 * lazy-create bootstrap(getHost 仲裁 + busy 早失败),挡路任务跑几十分钟时 2s 档
 * 会白做几百次,取 10s(事件路径正常时用户等待时长由事件决定,感知不到兜底)。
 */
const CREDENTIAL_SWITCH_RETRY_DELAY_MS = 10_000;
const TERMINAL_DONE_FALLBACK_DELAY_MS = 250;
const REWIND_BOUNDARY_POLL_INTERVAL_MS = 100;

export interface AgentInputSendOpts {
  messageUuid?: string;
  userName?: string;
  throwOnStartFailure?: boolean;
  signal?: AbortSignal;
  /**
   * scheduler 排队消息的来源标记(与 maker-core SendOrigin 的 scheduler 变体同构)。
   * drain 派发时从队列项透传:send 事务把它打到 session.send 的 origin(本轮
   * AgentEvent.turnOrigin,IM 转播识别自动 turn)并写进落库 user 消息的
   * agentMeta.origin(renderer 渲染"自动化任务"标签)。仅 scheduler 队列项携带;
   * 其它路径(用户输入 / orca)不设,行为不变。
   */
  origin?: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  persistUserMessage?: {
    clientId: string;
    content: string;
    sdkSessionId?: string;
    delivery: AgentInputDelivery;
    shouldBroadcast?: () => boolean;
    onPersisting?: () => void;
    onPersisted?: () => void | Promise<void>;
  };
}

export type AgentInputHostSendFailureCode = HostSendFailureCode;

export type AgentInputSendResult =
  | HostSendOutcome
  | { kind: 'session-dispatch'; source: string; dispatched: true }
  | {
      kind: 'session-dispatch';
      source: string;
      dispatched: false;
      reason: 'cancelled-before-dispatch';
      message: string;
      context: string;
    };

export interface AgentInputCoordinatorDeps {
  sendToAgent: (
    sessionId: string,
    message: AgentInputMakerMessage,
    createOpts: AgentInputCreateOpts,
    sendOpts: AgentInputSendOpts,
  ) => Promise<AgentInputSendResult>;
  steerToAgent: (
    sessionId: string,
    message: AgentInputMakerMessage,
    sendOpts: AgentInputSendOpts,
  ) => Promise<void>;
  abortSession: (sessionId: string) => Promise<void>;
  isTurnRunning: (sessionId: string) => boolean;
  /**
   * steer 收到 maker-core 权威的 NO_ACTIVE_TURN 后回调 host 校准 busy 视图。
   * isTurnRunning 的事件驱动 tracker 可能 stale 为 true (turn 异常死亡没发
   * terminal event), 此时 fallback 转普通派发后 drain 会被假忙永久挡住,
   * 插话点击表现为"毫无反应"。host 实现应自行复核后再清 tracker。
   */
  reconcileTurnIdle?: (sessionId: string) => void;
  hasPendingInteraction: (sessionId: string) => boolean;
  getAgentKind: (sessionId: string) => 'claude-code' | 'codex' | null;
  getSdkSessionId: (sessionId: string) => Promise<string | undefined>;
  /**
   * interrupted-turn-resume:判断某条已派发 user 消息之后 agent 是否已产出内容
   * (assistant / tool_use / thinking 持久化行)。retryLastError 用它决定语义:
   *  - 有产出 → 失败的 turn 已推进过任务,重发原文会让模型"从头再来",改发
   *    调用方传入的规范化续跑指令(continueText);
   *  - 零产出 → 模型从未收到有效输入,重发原文才是正确语义(维持既有行为)。
   * 判定走 DB(代码确定性,规则 9);未注入时一律按零产出处理(向后兼容)。
   */
  hasAssistantProgressAfter?: (sessionId: string, userClientId: string) => Promise<boolean>;
  getLastAssistantTranscriptUuid?: (sessionId: string) => string | undefined;
  /** 在 vendor dispatch 前读取用户选中的本地/在线会话引用。 */
  resolveSessionReferences?: (
    refs: AgentInputQueuedMessage['sessionRefs'],
  ) => Promise<AgentInputSessionReferenceContext[]>;
  emitProjection: (projection: AgentInputProjection) => void;
  /**
   * 意识拦截钩(订阅槽①,will-user-message):派发与落库**之前**问一遍已装
   * 钩子意识。三种结果:allow 原样派发;block 丢弃该排队项(不入库、不起
   * turn)并回调 onUserMessageBlocked;rewrite 用 text 替换正文后照常派发并
   * 回调 onUserMessageRewritten。实现方必须自行收敛异常(fail-open),本
   * 协调器不为它包错误处理。item.bypassGhostHooks 为真时跳过(用户强行放行)。
   */
  screenUserMessage?: (
    sessionId: string,
    agentFacingText: string,
  ) => Promise<
    | { action: 'allow' }
    | { action: 'block'; ghostId: string; ghostName: string; reason: string }
    | { action: 'rewrite'; ghostId: string; ghostName: string; text: string }
  >;
  /** 拦截命中回调:host 据此广播 renderer 把乐观气泡原地降级为被拦态。 */
  onUserMessageBlocked?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    verdict: { ghostId: string; ghostName: string; reason: string },
  ) => void;
  /** 改写命中回调:host 据此广播 renderer 把气泡正文换成改写版并留痕署名。
   *  originalText = 改写前的用户原文(留痕可查)。 */
  onUserMessageRewritten?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    info: { ghostId: string; ghostName: string; text: string; originalText: string },
  ) => void;
  /** Awaited after the user message is persisted but before vendor dispatch starts. */
  beforeDispatchUserTurn?: (sessionId: string, item: AgentInputQueuedMessage) => void | Promise<void>;
  /**
   * Called when a user row crossed the persistence boundary but never reached
   * vendor dispatch. Hosts use this to discard turn-start side effects that
   * would otherwise be consumed by a later retry/turn.
   */
  onUndispatchedUserTurn?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  onAcceptedQueuedMessage?: (sessionId: string, item: AgentInputQueuedMessage) => void | Promise<void>;
  /**
   * Awaited only after vendor dispatch is irreversible (`accepted=true`).
   * Hosts use this for side effects that must not run on cancelled-before-dispatch
   * (e.g. durable-acking an interrupted turn once Continue has really started).
   */
  onDispatchedUserTurn?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    preVendorDispatchAt: number,
  ) => void | Promise<void>;
  noteSessionClearBoundary?: (sessionId: string, clearedAt: string | number) => void;
  /**
   * 队列项未派发即被丢弃(stop 清队列 / 手动 remove / clearSession)时回调。
   * host 用它释放按 clientId 暂存的 accepted 副作用(如 orca 排队消息的回调表),
   * 否则被丢弃项的暂存条目会永久泄漏。
   */
  onDiscardedQueuedMessage?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /**
   * 派发失败后队列可能已空(项目已从队列移除但未被放回时)回调。
   * host 用它触发 notifyQueueEmptied, 让 AgentIsland 中因队列非空而延迟的完成事件得到补发。
   * Thread 3 fix: drain/dispatchCompact 失败路径在 item 未回退到队列时调用。
   */
  onQueueEmptied?: (sessionId: string) => void;
  /**
   * 该会话是否有「turn 结束后生效」的凭证切换 pending(PendingCredentialSwitchService)。
   * pending 存在期间不派发新 turn —— 否则排队消息会抢在旧凭证形态上跑掉;apply 完成
   * 后 host 调 wakeSession 恢复派发。
   */
  hasPendingCredentialSwitch?: (sessionId: string) => boolean;
  /**
   * 排队输入崩溃恢复(issue #761)。persistQueueSnapshot:队列内容变化时覆盖写
   * 快照(items 为空 = 删行),实现方自行 fire-and-forget + 保序,绝不阻塞派发;
   * loadQueueSnapshot:ensureQueueRestored 懒恢复时读回。两者要么都注入要么都不注入。
   */
  persistQueueSnapshot?: (sessionId: string, items: AgentInputQueuedMessage[]) => void | Promise<void>;
  loadQueueSnapshot?: (sessionId: string) => Promise<AgentInputQueuedMessage[]>;
  getPersistedClientIds?: (sessionId: string, clientIds: string[]) => Promise<Set<string>>;
}

interface ActiveTurn {
  item: AgentInputQueuedMessage | null;
  delivery: AgentInputDelivery;
  messageUuid: string;
  createdAt: string;
  generation: number;
  persisted: boolean;
  persisting: boolean;
  sendStarted: boolean;
  dispatchLifecycle: ActiveTurnDispatchLifecycle;
  pendingTerminalEvent: ActiveTurnTerminalEvent | null;
  controlKind?: 'compact';
}

interface PendingCompactRequest {
  createOpts: AgentInputCreateOpts;
  userName?: string;
  waitForClientIds: string[];
}

type ActiveTurnDispatchLifecycle = 'preparing' | 'awaiting-dispatch-hooks' | 'sending' | 'dispatched';

type ActiveTurnTerminalEvent =
  | { type: 'done' }
  | { type: 'error'; message?: string };

type AgentInputSendFailure = Extract<AgentInputSendResult, { accepted: false } | { dispatched: false }>;

interface SessionInputState {
  pendingQueue: AgentInputQueuedMessage[];
  pendingCompacts: PendingCompactRequest[];
  steeringQueueClientIds: string[];
  queuePaused: boolean;
  /**
   * 当前 queuePaused 是否来自崩溃快照恢复(restoreQueueSnapshot 的静默会话分支),
   * 而非用户显式 Stop / steer 不确定投递。区分的意义:恢复暂停只是"重启后不自动
   * 替用户发送"的保护,用户在会话里的任何显式输入(composer 发送 / 中断横幅
   * 「继续任务」等,均经 INPUT_ENQUEUE 携带 resumeRestorePausedQueue)即视为
   * 放行;而用户显式 Stop 出来的暂停必须保持,不许新输入静默释放旧队列。
   */
  queuePausedByRestore: boolean;
  queueExpanded: boolean;
  queueInteractionLocks: string[];
  /** Interaction locks that must survive a later user Stop. */
  interactionLocksPreservedOnStop: string[];
  queueEditLocks: string[];
  queueAbortPending: boolean;
  activeTurn: ActiveTurn | null;
  error: string | null;
  stickyError: string | null;
  recovery: AgentInputRecovery;
  drainScheduled: boolean;
  drainWakeupGeneration: number;
  /** Codex emits terminal error followed by done; queued work must not drain between the pair. */
  pendingExternalTerminalDone: boolean;
  pendingExternalTerminalDoneTimer: ReturnType<typeof setTimeout> | null;
  sessionRunningRetryTimer: ReturnType<typeof setTimeout> | null;
  sessionRunningRetryGeneration: number | null;
  /**
   * 发送撞上 CREDENTIAL_SWITCH_BUSY 后的可见等待态:队首保留,挡路会话 turn 结束
   * (onExternalTurnSettled)或兜底定时器触发自动重发。clientId 绑定等待中的那条
   * 消息 —— 队列可拖拽重排,等待态必须跟消息走而不是跟"队首"这个位置走。null = 无等待。
   */
  credentialSwitchWait: { clientId: string; blockedBySessionIds: string[] } | null;
  credentialSwitchRetryTimer: ReturnType<typeof setTimeout> | null;
  credentialSwitchRetryGeneration: number | null;
  /**
   * 近期已受理的 enqueue clientId 环形窗口(容量小、常驻内存)。用于控制端弱网
   * 重发的幂等判定:同 clientId 的重复投递即使原 turn 已极快结束(不在队列 /
   * activeTurn 里)也能被识破,不再二次入队。
   */
  recentEnqueuedClientIds: string[];
  generation: number;
}

function createInitialInputState(generation = 0): SessionInputState {
  return {
    pendingQueue: [],
    pendingCompacts: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queuePausedByRestore: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    interactionLocksPreservedOnStop: [],
    queueEditLocks: [],
    queueAbortPending: false,
    activeTurn: null,
    error: null,
    stickyError: null,
    recovery: null,
    drainScheduled: false,
    drainWakeupGeneration: 0,
    pendingExternalTerminalDone: false,
    pendingExternalTerminalDoneTimer: null,
    sessionRunningRetryTimer: null,
    sessionRunningRetryGeneration: null,
    credentialSwitchWait: null,
    credentialSwitchRetryTimer: null,
    credentialSwitchRetryGeneration: null,
    recentEnqueuedClientIds: [],
    generation,
  };
}

/**
 * 首次进入 main 队列边界时冻结原始合成指令意图。IPC payload 属不可信输入，
 * 因此即使 renderer 带了同名字段也必须从当下原始 text 重新计算。
 */
function captureOriginalSyntheticTrigger(
  item: AgentInputQueuedMessage,
): AgentInputQueuedMessage {
  return {
    ...item,
    originalSyntheticTrigger: syntheticTriggerKind(item.text) ?? undefined,
  };
}

/**
 * 老崩溃快照没有 originalSyntheticTrigger；从仍保留的原始 text 补齐。新版
 * 快照则保留首次入队时冻结的值，因为正文可能已经被 Ghost rewrite。
 */
function normalizeRestoredSyntheticTrigger(
  item: AgentInputQueuedMessage,
): AgentInputQueuedMessage {
  if (
    item.originalSyntheticTrigger === 'continue' ||
    item.originalSyntheticTrigger === 'generic'
  ) {
    return item;
  }
  return captureOriginalSyntheticTrigger(item);
}

type PersistAcceptedUserMessageResult = 'persisted' | 'stale' | 'failed';

function isNoActiveTurnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\[NO_ACTIVE_TURN\]|no active .*turn|has no active turn/i.test(msg);
}

/**
 * steer 投递结果不确定(maker-core 的两类特征串):ack 超时 'did not acknowledge
 * within',或 Stop/close 赢在 ack 返回前的 post-send abort 'delivery uncertain'。
 * turn/steer 是 content-bearing RPC,请求发出后无法撤回——这两类失败下消息都可能
 * 已被迟到注入当前 turn。这类失败不能让该消息处于可重发状态(自动 drain 或用户
 * 按草稿重发都会让模型消费两次),必须物化进暂停队列交用户处置。
 */
function isSteerDeliveryUncertainError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /did not acknowledge within|delivery uncertain/i.test(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSessionRunningError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SESSION_RUNNING') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string'
    && (message.startsWith('SESSION_RUNNING:') || message.startsWith('[SESSION_RUNNING]'));
}

function isSessionRunningSendFailure(result: AgentInputSendFailure): boolean {
  return result.kind === 'host-send' && result.code === 'SESSION_RUNNING';
}

function isCredentialSwitchBusySendFailure(
  result: AgentInputSendFailure,
): result is Extract<AgentInputSendResult, { kind: 'host-send' }> {
  return result.kind === 'host-send' && result.code === 'CREDENTIAL_SWITCH_BUSY';
}

function recordPendingTerminalEvent(active: ActiveTurn, event: ActiveTurnTerminalEvent): void {
  if (event.type === 'error') {
    active.pendingTerminalEvent = event;
    return;
  }
  if (!active.pendingTerminalEvent) {
    active.pendingTerminalEvent = event;
  }
}

function isActiveTurnDispatched(active: ActiveTurn): boolean {
  return active.dispatchLifecycle === 'dispatched';
}

function isActiveTurnBeforeVendorDispatch(active: ActiveTurn): boolean {
  return (
    !isActiveTurnDispatched(active) &&
    (!active.sendStarted || active.dispatchLifecycle === 'awaiting-dispatch-hooks')
  );
}

function isSendDispatched(
  result: AgentInputSendResult,
): result is Extract<AgentInputSendResult, { kind: 'session-dispatch'; dispatched: true }> {
  return result.kind === 'session-dispatch' && result.dispatched;
}

function sendFailureMessage(result: AgentInputSendFailure): string {
  if (result.kind === 'host-send') return `${result.code}: ${result.message}`;
  return `${result.reason}: ${result.message}`;
}

function sendFailureLogFields(result: AgentInputSendFailure): Record<string, unknown> {
  if (result.kind === 'host-send') {
    return {
      kind: result.kind,
      code: result.code,
      message: result.message,
    };
  }
  return {
    kind: result.kind,
    source: result.source,
    reason: result.reason,
    context: result.context,
    message: result.message,
  };
}

export class AgentInputCoordinator {
  private readonly states = new Map<string, SessionInputState>();
  private readonly steerAbortControllers = new Map<string, Map<string, AbortController>>();
  /**
   * 队列快照恢复簿记(issue #761)。故意放在 SessionInputState **外面**:
   * clearSession 会整体重建 state,若 restored 标记跟着 state 走,清空后的
   * emit 会因"未恢复"跳过持久化,旧快照删不掉,下次打开会话又诈尸。
   */
  private readonly restoredQueueSessions = new Set<string>();
  private readonly restoreAttempted = new Set<string>();
  private readonly queueRestorePromises = new Map<string, Promise<void>>();
  private readonly lastQueueSnapshotJson = new Map<string, string>();

  constructor(private readonly deps: AgentInputCoordinatorDeps) {}

  /**
   * 媒体回收器活引用取证(recycler.ts 的内存队列暂存区):序列化所有会话在
   * 内存中的排队/在途消息(pendingQueue + activeTurn 消息体 + recovery 项),
   * 供回收器按文本抽取 cindy-media 指纹当活引用——这些消息尚未(或可能不会)
   * 落库,其附件 blob 合法地处于零引用状态,清理时必须豁免。
   */
  collectQueuedPayloadTexts(): string[] {
    const texts: string[] = [];
    for (const state of this.states.values()) {
      if (state.pendingQueue.length > 0) texts.push(JSON.stringify(state.pendingQueue));
      if (state.activeTurn?.item) texts.push(JSON.stringify(state.activeTurn.item));
      if (state.recovery) texts.push(JSON.stringify(state.recovery));
    }
    return texts;
  }

  getProjection(sessionId: string): AgentInputProjection {
    return this.toProjection(sessionId, this.getState(sessionId));
  }

  /**
   * 懒恢复崩溃前持久化的排队输入(issue #761)。IPC 入口(getProjection /
   * enqueue / steer / compact)在处理前调用;并发调用共享同一 promise,
   * 已恢复(或未注入恢复 dep)时同步返回。
   *
   * 读失败(db 未就绪等)不标记 restored:下次入口重试;期间持久化收口点
   * 保持关闭,避免空内存态把尚未读回的快照覆盖删除。
   */
  ensureQueueRestored(sessionId: string): Promise<void> {
    if (this.restoredQueueSessions.has(sessionId)) return Promise.resolve();
    if (!this.deps.loadQueueSnapshot) {
      this.restoredQueueSessions.add(sessionId);
      return Promise.resolve();
    }
    this.restoreAttempted.add(sessionId);
    const existing = this.queueRestorePromises.get(sessionId);
    if (existing) return existing;
    const promise = this.restoreQueueSnapshot(sessionId).finally(() => {
      this.queueRestorePromises.delete(sessionId);
    });
    this.queueRestorePromises.set(sessionId, promise);
    return promise;
  }

  private async restoreQueueSnapshot(sessionId: string): Promise<void> {
    const preState = this.getState(sessionId);
    const preGeneration = preState.generation;
    let items: AgentInputQueuedMessage[];
    try {
      items = (await this.deps.loadQueueSnapshot!(sessionId)).map(
        normalizeRestoredSyntheticTrigger,
      );
    } catch (err) {
      log.warn('load queue snapshot failed; will retry on next entry', {
        sessionId,
        error: errorMessage(err),
      });
      throw err;
    }
    const state = this.getState(sessionId);
    if (state !== preState || state.generation !== preGeneration) {
      // 恢复窗口内撞上 clearSession / stop:用户已显式重置会话,丢弃恢复项,
      // 并同步一次收口点让内存态(通常为空)覆盖掉旧快照。
      this.restoredQueueSessions.add(sessionId);
      this.queueRestorePromises.delete(sessionId);
      this.maybePersistQueueSnapshot(sessionId);
      return;
    }
    // 去重:内存态 + DB 已落库的消息。DB 查询覆盖"消息已被 agent 接受落库但删快照
    // 写尚未提交"的崩溃窗口——该 clientId 已属 interrupted-turn 辖区,不应二次恢复。
    const existingIds = new Set(state.pendingQueue.map((q) => q.clientId));
    if (state.activeTurn?.item) existingIds.add(state.activeTurn.item.clientId);
    if (this.deps.getPersistedClientIds && items.length > 0) {
      try {
        const persisted = await this.deps.getPersistedClientIds(
          sessionId,
          items.map((i) => i.clientId),
        );
        for (const cid of persisted) existingIds.add(cid);
      } catch (err) {
        log.warn('getPersistedClientIds failed during restore; will retry on next entry', {
          sessionId,
          error: errorMessage(err),
        });
        throw err;
      }
    }
    // 标记恢复完成:所有 async 工作已结束,此后 getDrainableHead 放行、
    // maybePersistQueueSnapshot 开闸。
    this.restoredQueueSessions.add(sessionId);
    // 用读回内容预热变更检测缓存:内存态与 DB 一致时(最常见:空快照 + 空队列)
    // 收口点直接跳过,避免每次打开会话都发一次冗余覆盖写/删除。
    this.lastQueueSnapshotJson.set(sessionId, JSON.stringify(items));
    // scheduler 撞忙排队项不跨重启恢复(persist 侧已不再写入,这里兜老快照):
    // 静默会话的恢复队列处于 queuePausedByRestore 暂停态,自动化项等不来"用户
    // 显式输入"的放行,会永远滞留;同任务去重又会把它当在途,后续每轮 fire 都
    // 判 duplicate 顺延 —— 无人值守自动化整体停摆(PR #972 review P1)。直接
    // 丢弃并走 onDiscarded 释放回调注册表;下一轮 cron fire 按当下状态重新走
    // 排队/直发,不丢任务只丢陈旧副本。
    const restorable = items.filter((item) => !existingIds.has(item.clientId));
    const staleSchedulerItems = restorable.filter((item) => item.origin?.kind === 'scheduler');
    const restored = restorable.filter((item) => item.origin?.kind !== 'scheduler');
    if (staleSchedulerItems.length > 0) {
      for (const item of staleSchedulerItems) {
        this.deps.onDiscardedQueuedMessage?.(sessionId, item);
      }
      log.info('dropped stale scheduler heartbeat item(s) from crash snapshot', {
        sessionId,
        dropped: staleSchedulerItems.length,
      });
    }
    if (restored.length === 0) {
      // 快照为空 / 全部与内存态重复:同步一次收口点,让内存态成为权威快照。
      this.queueRestorePromises.delete(sessionId);
      this.maybePersistQueueSnapshot(sessionId);
      return;
    }
    // 静默会话(无排队、无在飞 turn)恢复为**暂停中的队列**:重启后不自动替用户
    // 发送,由既有 paused 横幅的「继续」按钮显式放行,或用户的下一次显式输入
    // (composer 发送 / 中断横幅「继续任务」,见 enqueue 的 resumeRestorePausedQueue)
    // 自动放行。会话已在忙(恢复窗口期间新输入已开跑)时不强行暂停,恢复项按
    // 正常 FIFO 跟在当前工作后面。
    const wasQuiet =
      state.pendingQueue.length === 0 &&
      state.activeTurn === null &&
      state.steeringQueueClientIds.length === 0 &&
      !this.deps.isTurnRunning(sessionId);
    state.pendingQueue = [...restored, ...state.pendingQueue];
    if (wasQuiet) {
      state.queuePaused = true;
      state.queuePausedByRestore = true;
    }
    log.info('restored queued input from crash snapshot', {
      sessionId,
      restored: restored.length,
      paused: state.queuePaused,
    });
    // 清除 in-flight 标记 BEFORE scheduleDrain:drain 的微任务检查
    // queueRestorePromises,必须在此之前清掉否则 getDrainableHead 永远返回 null。
    this.queueRestorePromises.delete(sessionId);
    this.emit(sessionId);
    if (!state.queuePaused) this.scheduleDrain(sessionId, 'queue-snapshot-restored');
  }

  shouldQueueNewTurn(sessionId: string): boolean {
    // 未恢复的会话可能有崩溃前的排队快照:强制入队直到恢复完成,防止新消息跳过旧排队。
    if (this.deps.loadQueueSnapshot && !this.restoredQueueSessions.has(sessionId)) return true;
    const state = this.getState(sessionId);
    return (
      state.pendingQueue.length > 0 ||
      state.pendingCompacts.length > 0 ||
      state.queuePaused ||
      state.queueInteractionLocks.length > 0 ||
      state.queueEditLocks.length > 0 ||
      state.recovery !== null ||
      this.deps.hasPendingCredentialSwitch?.(sessionId) === true ||
      this.isDispatchBoundaryBusy(sessionId, state)
    );
  }

  hasPendingQueuedWork(sessionId: string): boolean {
    const state = this.getState(sessionId);
    return state.pendingQueue.length > 0 || state.pendingCompacts.length > 0;
  }

  /**
   * 队列中是否存在满足条件的消息。scheduler 撞忙排队用它做两件事,两者对
   * active-turn recovery 项的取向**相反**,故用 includeRecovery 显式区分:
   *  - 同任务去重(includeRecovery=true):active-turn recovery 的消息已持久化、
   *    用户 Retry 后仍会执行,视为"该任务已有一条在途",不再重复入队;
   *  - 派发等待的存活探测(includeRecovery=false):项一旦转入 active-turn
   *    recovery,后续 Retry 走"克隆已受理 turn"路径,**不会**再经过
   *    onAcceptedQueuedMessage,排队方注册的 accepted/rollback 回调永远不可能
   *    到来 —— 对等待方而言等价于已丢弃,必须判"不存活"让 run 以失败收口,
   *    否则永久挂 running(PR #972 review P1)。
   * queue-head recovery 的项仍在 pendingQueue 里(重派发走完整 accept 链路),
   * 两种取向都由 pendingQueue 扫描覆盖。
   * ⚠️ 调用方若关心崩溃恢复快照里的项,需先 await ensureQueueRestored 且以
   * isQueueRestored 确认成功 —— 本方法只看内存态(scheduler 桥已内置该顺序)。
   */
  hasQueuedItemWhere(
    sessionId: string,
    predicate: (item: AgentInputQueuedMessage) => boolean,
    opts?: { includeRecovery?: boolean },
  ): boolean {
    const state = this.getState(sessionId);
    if (state.pendingQueue.some(predicate)) return true;
    const activeItem = state.activeTurn?.item;
    if (activeItem && predicate(activeItem)) return true;
    if (!opts?.includeRecovery) return false;
    const recovery = state.recovery;
    return recovery?.kind === 'active-turn' ? predicate(recovery.item) : false;
  }

  /**
   * 崩溃恢复快照是否已成功读回(无快照配置视为已恢复)。ensureQueueRestored
   * 读快照失败时**内部吞错**并保持未恢复态(下次入口重试),调用方无法从
   * await 结果区分成败 —— scheduler 桥的持久化去重必须以本方法确认恢复完成,
   * 未完成时顺延本次 fire,否则内存查重会漏掉快照里的同任务项,恢复后双份
   * 派发(PR #972 review P1)。
   */
  isQueueRestored(sessionId: string): boolean {
    return !this.deps.loadQueueSnapshot || this.restoredQueueSessions.has(sessionId);
  }

  /**
   * 队列是否处于暂停态(用户 Stop / 崩溃恢复暂停)。暂停队列的 getDrainableHead
   * 恒返 null,只有用户显式输入(resumeRestorePausedQueue)或点「继续」才解除 ——
   * scheduler 撞忙排队入队前必须查它:塞进暂停队列的心跳永不派发,accepted
   * 等不来、存活探测又看到项还在,run 会永久挂 running(PR #972 review)。
   */
  isQueuePaused(sessionId: string): boolean {
    return this.getState(sessionId).queuePaused;
  }

  /**
   * Rewind owns the whole active input boundary, including vendor turns and
   * unresolved interactions that can still resume the current turn.
   */
  hasActiveTurnForRewind(sessionId: string): boolean {
    return this.isDispatchBoundaryBusy(sessionId, this.getState(sessionId));
  }

  /** Wait until Stop has closed every input path that can mutate the old history. */
  async waitForRewindBoundaryIdle(
    sessionId: string,
    timeoutMs: number,
    pollIntervalMs = REWIND_BOUNDARY_POLL_INTERVAL_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.hasActiveTurnForRewind(sessionId)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(Math.max(1, pollIntervalMs), remainingMs)),
      );
    }
    return true;
  }

  /**
   * A timed-out rewind keeps its input lock until the old boundary really
   * settles. Poll slowly after the user-facing deadline to avoid a hot timer
   * while still recovering automatically from a delayed vendor terminal event.
   */
  async releaseRewindLockWhenIdle(sessionId: string, lockId: string): Promise<void> {
    await this.waitForRewindBoundaryIdle(sessionId, Number.POSITIVE_INFINITY, 1_000);
    this.pausePendingQueueForRewind(sessionId);
    this.setInteractionLock(sessionId, lockId, false);
  }

  /** Preserve queued input but keep it paused while rewind changes history. */
  pausePendingQueueForRewind(sessionId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    state.queuePaused = state.pendingQueue.length > 0 || state.pendingCompacts.length > 0;
    state.queuePausedByRestore = false;
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  /** 近期已受理 clientId 窗口容量:覆盖控制端秒级重发窗口即可,防无界增长。 */
  private static readonly RECENT_ENQUEUED_CLIENT_IDS_LIMIT = 32;

  private isDuplicateEnqueueClientId(state: SessionInputState, clientId: string): boolean {
    if (!clientId) return false;
    return (
      state.pendingQueue.some((q) => q.clientId === clientId)
      || state.activeTurn?.item?.clientId === clientId
      || state.steeringQueueClientIds.includes(clientId)
      || state.recentEnqueuedClientIds.includes(clientId)
    );
  }

  private rememberEnqueuedClientId(state: SessionInputState, clientId: string): void {
    if (!clientId) return;
    state.recentEnqueuedClientIds.push(clientId);
    if (state.recentEnqueuedClientIds.length > AgentInputCoordinator.RECENT_ENQUEUED_CLIENT_IDS_LIMIT) {
      state.recentEnqueuedClientIds.shift();
    }
  }

  enqueue(
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts?: { wasFirst?: boolean; sendAtMs?: number; resumeRestorePausedQueue?: boolean },
  ): AgentInputProjection {
    const state = this.getState(sessionId);
    item = captureOriginalSyntheticTrigger(item);
    // 幂等去重(弱网重发防线,PR #881):同 clientId 重复投递说明是控制端(手机
    // 断连自动重试 / 用户对 ack 丢失的消息重发)在补发同一条消息,不是新消息。
    // 直接返回当前 projection、不再入队——否则同一条消息双入队、agent 跑两轮。
    // clientId 由发送端每次编排新消息时重新生成,正常路径不会相撞;覆盖三处
    // 在途位置(队列 / activeTurn / steering)加近期已受理环形窗口(原 turn
    // 极快结束的补发窗口)。
    if (this.isDuplicateEnqueueClientId(state, item.clientId)) {
      log.info('enqueue ignored: duplicate clientId (control-side resend)', {
        sessionId,
        clientId: item.clientId,
      });
      return this.getProjection(sessionId);
    }
    this.rememberEnqueuedClientId(state, item.clientId);
    // 崩溃恢复暂停队列的死锁解除(2026-07-14):恢复暂停只防"重启后自动替用户
    // 发送",用户显式输入(composer 发送 / 中断横幅「继续任务」,均经 INPUT_ENQUEUE
    // 携带本 flag)即视为放行——否则「继续任务」只是往暂停队列再塞一条,永远
    // 派发不出去,会话直到重启都处于"全部排队"死锁。用户显式 Stop 的暂停
    // (queuePausedByRestore=false)不受影响;Orca 等 main 侧自动投递不带本 flag。
    if (opts?.resumeRestorePausedQueue && state.queuePaused && state.queuePausedByRestore) {
      state.queuePaused = false;
      state.queuePausedByRestore = false;
      log.info('crash-restored paused queue released by explicit user input', {
        sessionId,
        clientId: item.clientId,
      });
    }
    this.abandonActiveTurnRecoveryForNewInput(state);
    this.clearErrorUnlessQueueHeadBlocked(state);
    // 用户点「继续任务」表达的是恢复刚才中断/失败的 turn，必须先于此前
    // 已排队的新任务执行；普通 composer / Orca / scheduler 输入仍保持 FIFO。
    // 复用 prepend helper 同时把本项加入 pending compact 的等待集合，避免
    // 已排队的 /compact 抢在续跑前执行，破坏原任务现场。
    if (item.originalSyntheticTrigger === 'continue') {
      this.prependQueueHeadIfMissing(state, item);
      // 与 move() 对称：插队后原 credential-switch 等待目标不再是队首时，
      // 必须清掉 wait，否则横幅/取消仍绑定旧 clientId，会误删错误排队项。
      if (
        state.credentialSwitchWait &&
        state.pendingQueue[0]?.clientId !== state.credentialSwitchWait.clientId
      ) {
        this.clearCredentialSwitchWait(state);
      }
    } else {
      state.pendingQueue.push(item);
    }
    // scheduler 撞忙排队不算"用户活跃":userSendAt 是 B1 活跃礼让的判据,自动化
    // 入队若 bump 它,接下来 10 分钟内同会话其它心跳会被误当"用户正在远程控制"
    // 而静默顺延(PR #972 review P2)。侧栏排序的 bump 语义保留在派发时刻 ——
    // runner 的 accepted 回调按直发路径同款调 touchUserSendInDb(ctx.firedAt)。
    if (item.origin?.kind !== 'scheduler') {
      this.touchUserSend(sessionId, opts?.sendAtMs);
    }
    // 视觉连续性: 当这条入队后立即可派发(agent 空闲、队列此前为空、无暂停/锁/恢复
    // 阻塞)时, 跳过中间态 emit 并同步进入 drain —— drain 的同步前半段会先把队首
    // slice 掉并置 activeTurn, 然后才 await sendToAgent。于是 renderer 通过 emit 和
    // 本次 RPC 返回值收到的第一个 projection 就是"已离队、turn 开始"态, 不会先看到
    // 一帧 pendingQueue=[item] 的队列灰字再消失(空闲发送闪烁的根因)。drain 内部
    // 仍有 getDrainableHead 幂等校验, 不会与既有 wake 点重复派发。agent 忙 / 队列
    // 已有积压时走 else, 维持原排队语义(emit 中间态 + 异步 drain)。
    if (this.getDrainableHead(sessionId, state) === item) {
      void this.drain(sessionId, 'enqueue-immediate');
    } else {
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'enqueue');
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'enqueue');
    }
    return this.getProjection(sessionId);
  }

  async compact(sessionId: string, createOpts: AgentInputCreateOpts, opts?: { userName?: string }): Promise<AgentInputProjection> {
    const state = this.getState(sessionId);
    if (state.recovery) {
      log.info('compact ignored while dispatch boundary is busy', { sessionId });
      state.error = 'Cannot compact while the session is busy';
      this.emit(sessionId);
      return this.getProjection(sessionId);
    }
    this.clearErrorUnlessQueueHeadBlocked(state);

    const request: PendingCompactRequest = {
      createOpts,
      userName: opts?.userName,
      waitForClientIds: state.pendingQueue.map((item) => item.clientId),
    };

    if (
      this.isDispatchBoundaryBusy(sessionId, state) ||
      // pending 凭证切换期间不立即派发 /compact(会打到旧凭证形态的会话上);
      // 排队后由 apply 完成的 wakeSession → getDrainableCompact 门放行。
      this.deps.hasPendingCredentialSwitch?.(sessionId) === true ||
      state.pendingQueue.length > 0 ||
      state.pendingCompacts.length > 0 ||
      state.queuePaused ||
      state.queueInteractionLocks.length > 0 ||
      state.steeringQueueClientIds.length > 0 ||
      state.queueAbortPending
    ) {
      state.pendingCompacts.push(request);
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'compact-queued');
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'compact-queued');
      return this.getProjection(sessionId);
    }

    return this.dispatchCompact(sessionId, request, 'compact-immediate');
  }

  private async dispatchCompact(
    sessionId: string,
    request: PendingCompactRequest,
    reason: string,
  ): Promise<AgentInputProjection> {
    const state = this.getState(sessionId);
    const active: ActiveTurn = {
      item: null,
      delivery: 'turn',
      messageUuid: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      generation: state.generation,
      persisted: false,
      persisting: false,
      sendStarted: false,
      dispatchLifecycle: 'preparing',
      pendingTerminalEvent: null,
      controlKind: 'compact',
    };
    state.activeTurn = active;
    this.emit(sessionId);

    try {
      active.sendStarted = true;
      active.dispatchLifecycle = 'sending';
      const result = await this.deps.sendToAgent(
        sessionId,
        { type: 'user', content: '/compact' },
        request.createOpts,
        {
          messageUuid: active.messageUuid,
          userName: request.userName,
          throwOnStartFailure: true,
        },
      );
      if (!this.isActiveTurnCurrent(sessionId, active)) return this.getProjection(sessionId);
      if (!isSendDispatched(result)) {
        if (isSessionRunningSendFailure(result)) {
          return this.deferCompactAfterSessionRunning(sessionId, active, request, reason, sendFailureMessage(result));
        }
        const latest = this.getState(sessionId);
        latest.activeTurn = null;
        latest.error = sendFailureMessage(result);
        latest.stickyError = null;
        latest.recovery = null;
        log.warn('compact not dispatched', {
          sessionId,
          reason,
          ...sendFailureLogFields(result),
        });
        this.emit(sessionId);
        this.deps.onQueueEmptied?.(sessionId);
        this.scheduleDrain(sessionId, 'compact-not-dispatched');
        return this.getProjection(sessionId);
      }
      active.dispatchLifecycle = 'dispatched';
      if (active.pendingTerminalEvent) {
        this.settlePendingTerminalEventAfterPersist(sessionId, active);
        return this.getProjection(sessionId);
      }
      this.emit(sessionId);
      return this.getProjection(sessionId);
    } catch (err) {
      if (!this.isActiveTurnCurrent(sessionId, active)) return this.getProjection(sessionId);
      if (isSessionRunningError(err)) {
        return this.deferCompactAfterSessionRunning(sessionId, active, request, reason, errorMessage(err));
      }
      const latest = this.getState(sessionId);
      latest.activeTurn = null;
      latest.error = errorMessage(err);
      latest.stickyError = null;
      latest.recovery = null;
      log.warn('compact dispatch failed', {
        sessionId,
        reason,
        error: latest.error,
      });
      this.emit(sessionId);
      this.deps.onQueueEmptied?.(sessionId);
      this.scheduleDrain(sessionId, 'compact-dispatch-failed');
      return this.getProjection(sessionId);
    }
  }

  async steer(sessionId: string, item: AgentInputQueuedMessage, opts?: { removeFromQueue?: boolean; touchUserSend?: boolean }): Promise<boolean> {
    const state = this.getState(sessionId);
    if (opts?.removeFromQueue) {
      const storedItem = state.pendingQueue.find((queued) => queued.clientId === item.clientId);
      if (storedItem) {
        // Renderer projections intentionally omit trusted reference bodies. The main-owned
        // queue row is authoritative for identity/text. A restored device-link row can retain
        // only the fail-closed marker, though; in that case the validated inbound snapshot is
        // safe to reattach when it still describes the same queued references/text.
        const incomingContexts = item.trustedSessionReferenceContexts;
        const storedRefs = storedItem.sessionRefs ?? [];
        const incomingRefs = item.sessionRefs ?? [];
        const sameRefs =
          storedRefs.length === incomingRefs.length &&
          storedRefs.every((ref, index) => {
            const incoming = incomingRefs[index];
            return (
              incoming !== undefined &&
              ref.sessionId === incoming.sessionId &&
              ref.messageClientId === incoming.messageClientId &&
              ref.deviceId === incoming.deviceId
            );
          });
        const canRestoreSnapshot =
          storedItem.sessionReferencesRequireTrustedSnapshot === true &&
          incomingContexts !== undefined &&
          incomingContexts.length > 0 &&
          sameRefs &&
          storedItem.text === item.text;
        item = canRestoreSnapshot
          ? { ...storedItem, trustedSessionReferenceContexts: incomingContexts }
          : storedItem;
      }
    }
    if (
      state.steeringQueueClientIds.length > 0 ||
      state.queueAbortPending ||
      state.queueInteractionLocks.length > 0
    ) {
      // 同会话同一时刻只允许一个 steer 事务；输入锁 / Stop 边界也必须挡住
      // steer，否则 rewind 等待收尾时仍可能把新内容注入即将废弃的旧 turn。
      log.warn('steer rejected: session input boundary is locked', {
        sessionId,
        clientId: item.clientId,
        inFlightClientIds: [...state.steeringQueueClientIds],
        queueAbortPending: state.queueAbortPending,
        interactionLockIds: [...state.queueInteractionLocks],
      });
      return false;
    }

    if (!this.isTurnSteerable(sessionId, state)) {
      this.fallbackPreparedAsTurn(sessionId, item, opts?.removeFromQueue === true);
      if (opts?.touchUserSend) this.touchUserSend(sessionId);
      return true;
    }

    // 插话统一为同轮注入(2026-07-12 产品决策):Claude 与 Codex 都走
    // steerToAgent 把消息注入正在跑的 turn,不打断当前工作。需要打断的用户
    // 自己点 Stop。(历史:PR #394 曾把 Claude 改成 abort+新 turn,现回退。)
    const messageUuid = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const steerGeneration = state.generation;
    this.clearErrorUnlessQueueHeadBlocked(state, item.clientId);
    state.queuePaused = false;
    if (!state.steeringQueueClientIds.includes(item.clientId)) {
      state.steeringQueueClientIds.push(item.clientId);
    }
    const steerAbort = new AbortController();
    this.registerSteerAbortController(sessionId, item.clientId, steerAbort);
    this.emit(sessionId);

    // 意识拦截钩(订阅槽①):同轮注入与普通派发同权——drain() 在派发前筛,
    // steer 直达 steerToAgent 不经 drain,这里必须补同一道筛查,否则被拦 /
    // 待改写的消息可经 ⌘+Enter 或队列行 ⬆️ 原样注入并落库(review #939 第四轮)。
    // marker 已置位,筛查期间并发 steer / drain 被挡;stop / clearSession 竞态
    // 由筛查后的 marker 复查兜底。
    if (!item.bypassGhostHooks && this.deps.screenUserMessage) {
      const verdict = await this.deps.screenUserMessage(sessionId, getAgentFacingText(item));
      const cur = this.getState(sessionId);
      if (!cur.steeringQueueClientIds.includes(item.clientId)) {
        // stop/close/clearSession 赢在筛查期间:steer 事务已被取消,静默放弃。
        this.clearSteerAbortController(sessionId, item.clientId);
        return false;
      }
      if (verdict.action === 'block') {
        // 拦截即终态:不注入、不落库,气泡由 onUserMessageBlocked 广播降级;
        // 返回 true(已处置),renderer 不再回滚重试。
        this.clearSteerAbortController(sessionId, item.clientId);
        cur.steeringQueueClientIds = cur.steeringQueueClientIds.filter((id) => id !== item.clientId);
        if (opts?.removeFromQueue) {
          cur.pendingQueue = cur.pendingQueue.filter((q) => q.clientId !== item.clientId);
          this.removePendingCompactWaitClientId(cur, item.clientId);
          cur.queueEditLocks = cur.queueEditLocks.filter((id) => id !== item.clientId);
          if (cur.pendingQueue.length === 0) cur.queuePaused = false;
        }
        this.deps.onUserMessageBlocked?.(sessionId, item, verdict);
        this.deps.onDiscardedQueuedMessage?.(sessionId, item);
        this.emit(sessionId);
        this.scheduleDrain(sessionId, 'steer-ghost-blocked');
        return true;
      }
      if (verdict.action === 'rewrite') {
        // 与 drain 的 rewrite 同构:JSON-aware 只换 text 字段并保留附件信封；
        // 整体改写后旧 Composer reference offsets 已失效，必须同步清掉。
        const originalText = item.text;
        const rewritten = updateQueuedMessageText(item, verdict.text);
        Object.assign(item, rewritten);
        if (!rewritten.sessionRefs) delete item.sessionRefs;
        if (!rewritten.trustedSessionReferenceContexts) delete item.trustedSessionReferenceContexts;
        if (!rewritten.sessionReferencesRequireTrustedSnapshot) {
          delete item.sessionReferencesRequireTrustedSnapshot;
        }
        delete item.agentReferences;
        this.deps.onUserMessageRewritten?.(sessionId, item, {
          ghostId: verdict.ghostId,
          ghostName: verdict.ghostName,
          text: verdict.text,
          originalText,
        });
      }
    }

    try {
      const referenceContexts = await this.resolveReferenceContexts(item);
      item.persistedContent = attachSessionReferenceMetadata(item.persistedContent, referenceContexts);
      await this.deps.steerToAgent(
        sessionId,
        buildMakerUserMessage(item, referenceContexts),
        { messageUuid, userName: item.userName, signal: steerAbort.signal },
      );
    } catch (err) {
      this.clearSteerAbortController(sessionId, item.clientId);
      const latest = this.getState(sessionId);
      const markerStillPresent = latest.steeringQueueClientIds.includes(item.clientId);
      latest.steeringQueueClientIds = latest.steeringQueueClientIds.filter((id) => id !== item.clientId);

      if (isNoActiveTurnError(err)) {
        // maker-core 权威判定无活跃 turn — 先让 host 校准可能 stale 的 busy
        // tracker, 否则下面 fallback / drain 仍会被假忙挡住 (见 deps 注释)。
        this.deps.reconcileTurnIdle?.(sessionId);
        // 已派发的 activeTurn + 权威无活跃 turn ⇒ 那一轮其实已结束但 done
        // 事件丢失 (zombie turn)。合成 done 边界收掉它, 否则 fallback drain 会
        // 被这个尸体 activeTurn 永久挡住。pre-dispatch (send 还在飞) 的
        // activeTurn 不能动 — 那是合法的并发窗口, NO_ACTIVE_TURN 属预期。
        // persisting 的 defer 语义由 onTurnEvent 自身处理。
        if (latest.activeTurn && isActiveTurnDispatched(latest.activeTurn)) {
          log.warn('steer no-active-turn with dispatched activeTurn; synthesizing turn-done', {
            sessionId,
            staleClientId: latest.activeTurn.item?.clientId,
          });
          this.onTurnEvent(sessionId, 'done');
        }
        if (!markerStillPresent) {
          log.info('steer no-active-turn after marker cancelled (stop/close raced)', {
            sessionId,
            clientId: item.clientId,
          });
          this.releaseAbortLockAndDrain(sessionId, 'steer-no-active-cancelled');
          this.emit(sessionId);
          return false;
        }
        log.info('steer fallback to normal turn dispatch (no active turn)', {
          sessionId,
          clientId: item.clientId,
        });
        this.emit(sessionId);
        this.fallbackPreparedAsTurn(sessionId, item, opts?.removeFromQueue === true);
        if (opts?.touchUserSend) this.touchUserSend(sessionId);
        return true;
      }

      log.warn('steer hard failure', {
        sessionId,
        clientId: item.clientId,
        markerStillPresent,
        error: errorMessage(err),
      });
      if (markerStillPresent) {
        latest.error = errorMessage(err);
        latest.recovery = null;
        // 投递结果不确定(ack 超时 / post-send abort,见 isSteerDeliveryUncertainError):
        // 把该消息物化到队首(composer 入口的插话不在队列里,不物化则"结果不确定"
        // 没有落点——用户按草稿重发同一段文字时模型可能双份消费,review #939 第三轮)
        // 并暂停队列,不让 turn 结束后的自动 drain 把它再派发一遍。用户确认模型
        // 已回应就删行,没回应就点「继续发送」。队列行入口 prepend 幂等,无副作用。
        if (isSteerDeliveryUncertainError(err)) {
          this.prependQueueHeadIfMissing(latest, item);
          latest.queuePaused = true;
          // 不确定投递的保护性暂停必须由用户显式处置,不许新输入静默放行。
          latest.queuePausedByRestore = false;
        }
      } else if (
        isSteerDeliveryUncertainError(err) &&
        latest.generation === steerGeneration
      ) {
        // Stop/close 赢在 ack 返回前(marker 已被 stop 清):RPC 已发出,结果同样
        // 不确定,消息必须有落点(尤其 composer 入口无队列行的场景,review #939
        // 第四轮)。物化进暂停队列交用户处置。generation 守卫:clearSession 是
        // 用户显式重置,不把消息塞回已清空的会话。
        this.prependQueueHeadIfMissing(latest, item);
        latest.queuePaused = true;
        // 同上:不确定投递的保护性暂停,不许新输入静默放行。
        latest.queuePausedByRestore = false;
        log.warn('steer delivery uncertain after stop/close; materialized into paused queue', {
          sessionId,
          clientId: item.clientId,
        });
      }
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'steer-hard-failure');
      return false;
    }
    this.clearSteerAbortController(sessionId, item.clientId);

    const accepted = this.getState(sessionId);
    if (!accepted.steeringQueueClientIds.includes(item.clientId)) {
      log.warn('steer accepted by agent but marker already cancelled (stop/close raced); dropping', {
        sessionId,
        clientId: item.clientId,
      });
      this.emit(sessionId);
      return false;
    }
    accepted.steeringQueueClientIds = accepted.steeringQueueClientIds.filter((id) => id !== item.clientId);
    if (opts?.removeFromQueue) {
      accepted.pendingQueue = accepted.pendingQueue.filter((q) => q.clientId !== item.clientId);
      this.removePendingCompactWaitClientId(accepted, item.clientId);
      accepted.queueEditLocks = accepted.queueEditLocks.filter((id) => id !== item.clientId);
      if (accepted.pendingQueue.length === 0) accepted.queuePaused = false;
    }
    // 乱序窗口快照:turn 在 ack 等待期间以 terminal error 终结时,onTurnEvent
    // 已建立的失败状态(error / recovery = 旧 turn 的 Retry 入口)会被下面的
    // accepted 清理吞掉;合成收口分支需要回放它(review #939 第三轮)。
    const priorError = accepted.error;
    const priorStickyError = accepted.stickyError;
    const priorRecovery = accepted.recovery;
    accepted.error = null;
    accepted.stickyError = null;
    accepted.recovery = null;
    accepted.activeTurn = {
      item,
      delivery: 'steer',
      messageUuid,
      createdAt,
      generation: accepted.generation,
      persisted: false,
      persisting: true,
      sendStarted: true,
      dispatchLifecycle: 'dispatched',
      pendingTerminalEvent: null,
    };
    this.emit(sessionId);

    const persisted = await this.persistAcceptedUserMessage(sessionId, accepted.activeTurn);
    if (persisted !== 'persisted') return false;
    if (opts?.touchUserSend) this.touchUserSend(sessionId);
    // 已投递收口(review #939 第二轮 P1):steer ack 可能与 turn 终态乱序——
    // maker-core 对"server 已接受注入但本地 turn 已终结"按已投递成功返回
    // (消息已进 rollout,fallback 重发会让模型消费两次)。这种情况下这个
    // steer activeTurn 永远等不到属于自己的终态事件,这里自查 host busy 视图,
    // turn 已终结则立即合成收口,防队列冻结。终态事件晚于本判断到达时,
    // onTurnEvent 的常规收口路径兜底(两条路互补)。
    const latest = this.getState(sessionId);
    if (
      latest.activeTurn?.item?.clientId === item.clientId &&
      latest.activeTurn.delivery === 'steer' &&
      !this.deps.isTurnRunning(sessionId)
    ) {
      log.info('steer accepted but turn already settled; synthesizing closure', {
        sessionId,
        clientId: item.clientId,
      });
      latest.activeTurn = null;
      // turn 以 terminal error 终结的乱序窗口:回放被 accepted 清掉的失败状态,
      // 保住失败 turn 的 Retry / 错误入口,并让 recovery 挡住队尾 drain——不能
      // 像成功结束一样放行(review #939 第三轮)。done 终结时快照为空,干净收口。
      if (priorError || priorRecovery) {
        latest.error = priorError;
        latest.stickyError = priorStickyError;
        latest.recovery = priorRecovery;
      }
      this.emit(sessionId);
    }
    this.scheduleDrain(sessionId, 'steer-accepted');
    return true;
  }

  stop(sessionId: string, opts?: { keepQueue?: boolean; pauseQueue?: boolean }): AgentInputProjection {
    const state = this.getState(sessionId);
    const preserveQueue = opts?.keepQueue === true;
    this.abortSteerTransactions(sessionId);
    // Stop 是用户显式收手:凭证切换等待随之取消(保留队列时队首仍在,恢复后会重新进入等待)。
    this.clearCredentialSwitchWait(state);
    if (!preserveQueue) {
      this.clearSessionRunningRetry(state);
      for (const item of state.pendingQueue) {
        if (item.origin?.kind === 'orca') {
          log.warn('dropping queued Orca message on stop', {
            sessionId,
            clientId: item.clientId,
            senderLabel: item.origin.senderLabel,
          });
        }
        this.deps.onDiscardedQueuedMessage?.(sessionId, item);
      }
      // 整批丢弃的排队消息同样从未派发:从弱网重发幂等窗口遗忘,允许再次入队。
      const droppedIds = new Set(state.pendingQueue.map((q) => q.clientId));
      state.recentEnqueuedClientIds = state.recentEnqueuedClientIds.filter((id) => !droppedIds.has(id));
      state.pendingQueue = [];
      state.pendingCompacts = [];
      state.queueInteractionLocks = state.queueInteractionLocks.filter((lockId) =>
        state.interactionLocksPreservedOnStop.includes(lockId),
      );
      state.queueEditLocks = [];
    } else {
      const queuedIds = new Set(state.pendingQueue.map((q) => q.clientId));
      state.queueEditLocks = state.queueEditLocks.filter((id) => queuedIds.has(id));
    }
    state.error = null;
    state.stickyError = null;
    state.recovery = null;
    this.cancelPreSendActiveTurn(sessionId, state, preserveQueue);
    const shouldPause = Boolean(preserveQueue && opts?.pauseQueue && state.pendingQueue.length > 0);
    state.queuePaused = shouldPause;
    // Stop 出来的暂停是用户显式意图,不许后续新输入静默放行(区别于崩溃恢复暂停)。
    state.queuePausedByRestore = false;
    state.queueAbortPending = shouldPause && this.isDispatchBoundaryBusy(sessionId, state);
    state.steeringQueueClientIds = [];
    state.queueExpanded = false;
    this.emit(sessionId);

    this.deps.abortSession(sessionId)
      .catch((err) => {
        log.warn('abortSession failed', { sessionId, error: errorMessage(err) });
      })
      .finally(() => {
        if (this.deps.getAgentKind(sessionId) === 'codex') return;
        this.releaseAbortLockAndDrain(sessionId, 'abort-promise', { clearActiveTurn: true });
      });

    return this.getProjection(sessionId);
  }

  resume(sessionId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    state.queuePaused = false;
    state.queuePausedByRestore = false;
    this.clearErrorUnlessQueueHeadBlocked(state);
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'resume');
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'resume');
    return this.getProjection(sessionId);
  }

  async retryLastError(sessionId: string): Promise<AgentInputProjection> {
    const state = this.getState(sessionId);
    const recovery = state.recovery;
    if (!recovery) return this.getProjection(sessionId);
    // active-turn recovery 的续跑判定:失败 turn 若已有 assistant 侧产出,重发
    // 原文等于让模型"从头再来"(原文可能是很久之前的初始任务指令),改发规范化
    // 续跑指令;零产出(派发即失败 / 首个 API 调用就挂)才维持克隆重发。
    // 续跑指令是共享英文常量(带 [UI_ACTION_TRIGGER] 前缀,renderer 渲染时过滤,
    // 用户只看到任务继续跑,不看到这条合成消息;2026-07-05 产品决策)。
    let continueItem: AgentInputQueuedMessage | null = null;
    const continueText = CONTINUE_AFTER_ERROR_PROMPT;
    if (recovery.kind === 'active-turn' && this.deps.hasAssistantProgressAfter) {
      let hasProgress = false;
      try {
        hasProgress = await this.deps.hasAssistantProgressAfter(sessionId, recovery.item.clientId);
      } catch {
        // 判定失败按零产出处理 —— 回退重发原文,语义与未注入 dep 一致。
      }
      // await 期间 turn 事件可能已推进状态(clearError / 新 error / 并发 retry):
      // recovery 不再是同一对象时放弃本次意图,以当前 projection 为准。
      if (this.getState(sessionId).recovery !== recovery) return this.getProjection(sessionId);
      if (hasProgress) {
        const clientId = crypto.randomUUID();
        continueItem = {
          ...recovery.item,
          clientId,
          text: continueText,
          originalSyntheticTrigger: 'continue',
          persistedContent: continueText,
          // 附件 / mention 属于原始消息,已在失败 turn 里送达过模型,续跑指令不重带。
          files: undefined,
          mentions: undefined,
          // 合成续跑指令显式普通执行:原消息若带 planMode=true,原样克隆会把隐藏
          // 指令路由进计划模式而不是立刻续跑(review P2)。与 sendUiTrigger 的
          // 合成 UI 动作同语义 —— planMode 强制 false。
          createOpts: { ...recovery.item.createOpts, planMode: false },
          chatMessage: {
            clientId,
            role: 'user',
            content: continueText,
            createdAt: new Date().toISOString(),
          },
        };
      }
    }
    state.error = null;
    state.stickyError = null;
    state.recovery = null;
    if (recovery.kind === 'active-turn') {
      let item = continueItem;
      if (!item) {
        const clientId = crypto.randomUUID();
        item = {
          ...recovery.item,
          clientId,
          chatMessage: {
            ...recovery.item.chatMessage,
            clientId,
            createdAt: new Date().toISOString(),
          },
        };
      }
      state.pendingQueue.unshift(item);
      this.prependPendingCompactWaitClientId(state, item.clientId);
    }
    this.touchUserSend(sessionId);
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'retry');
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'retry');
    return this.getProjection(sessionId);
  }

  clearError(sessionId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    const shouldDrainTail = state.recovery?.kind === 'active-turn';
    state.error = null;
    state.stickyError = null;
    if (state.recovery?.kind !== 'queue-head') {
      state.recovery = null;
    }
    this.emit(sessionId);
    if (shouldDrainTail) this.scheduleDrain(sessionId, 'clear-active-turn-error');
    return this.getProjection(sessionId);
  }

  remove(sessionId: string, clientId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return this.getProjection(sessionId);
    const before = state.pendingQueue.length;
    const removed = state.pendingQueue.find((q) => q.clientId === clientId);
    if (removed) this.deps.onDiscardedQueuedMessage?.(sessionId, removed);
    state.pendingQueue = state.pendingQueue.filter((q) => q.clientId !== clientId);
    // 显式移除的消息从未派发:该 clientId 允许被合法地重新入队(重排/再发都是
    // 既有产品流),必须从弱网重发幂等窗口里遗忘,否则再入队会被误吞。
    if (removed) {
      state.recentEnqueuedClientIds = state.recentEnqueuedClientIds.filter((id) => id !== clientId);
    }
    if (removed) this.removePendingCompactWaitClientId(state, removed.clientId);
    state.queueEditLocks = state.queueEditLocks.filter((id) => id !== clientId);
    if (state.recovery?.kind === 'queue-head' && state.recovery.clientId === clientId) {
      state.error = null;
      state.recovery = null;
    }
    if (state.pendingQueue.length === 0) state.queuePaused = false;
    // 等待中的那条消息被用户删掉(不论其当前位置)→ 取消本轮凭证切换等待(等待态
    // 的"取消"入口);队列清空同理。其余删除不影响等待:等待态按 clientId 绑定消息,
    // 不绑定"队首"位置。后续 drain 会为新队首重新判定 —— 仍撞 busy 就重建等待。
    if (
      state.pendingQueue.length === 0 ||
      (state.credentialSwitchWait && removed?.clientId === state.credentialSwitchWait.clientId)
    ) {
      this.clearCredentialSwitchWait(state);
    }
    this.emit(sessionId);
    if (state.pendingQueue.length !== before) this.scheduleDrain(sessionId, 'remove');
    return this.getProjection(sessionId);
  }

  updateText(
    sessionId: string,
    clientId: string,
    newText: string,
    sessionRefs?: AgentInputQueuedMessage['sessionRefs'],
    trustedSessionReferenceContexts?: AgentInputSessionReferenceContext[],
    requireTrustedSnapshot = false,
  ): AgentInputProjection {
    const trimmed = newText.trim();
    if (!trimmed) return this.getProjection(sessionId);
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return this.getProjection(sessionId);
    state.pendingQueue = state.pendingQueue.map((entry) => {
      if (entry.clientId !== clientId) return entry;
      // Device-link callers from before the structured refs argument may omit
      // sessionRefs. When a trusted snapshot is required, treating undefined
      // as "no refs" is fail-closed; otherwise updateQueuedMessageText would
      // re-parse remote text and resolve links in the target device's DB.
      const refsForUpdate = requireTrustedSnapshot && sessionRefs === undefined
        ? []
        : sessionRefs;
      const updated = updateQueuedMessageText(entry, newText, refsForUpdate);
      if (requireTrustedSnapshot && updated.sessionRefs && updated.sessionRefs.length > 0) {
        updated.sessionReferencesRequireTrustedSnapshot = true;
        if (trustedSessionReferenceContexts) {
          updated.trustedSessionReferenceContexts = trustedSessionReferenceContexts;
        }
      } else if (requireTrustedSnapshot) {
        delete updated.sessionReferencesRequireTrustedSnapshot;
        delete updated.trustedSessionReferenceContexts;
      }
      return updated;
    });
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  /**
   * 整条内容替换(文本 + 附件 + mentions),排队消息「复用 composer 编辑」的保存入口。
   * 与 updateText 同一套守卫:steering 中的条目不可改;内容合并规则(clientId/createdAt/
   * origin/createOpts 锚定原条目)收敛在 updateQueuedMessageContent。空内容(无文本且无
   * 附件)拒绝——与 enqueue 的最低要求一致,防止编辑出一条发不出去的空消息。
   */
  updateContent(
    sessionId: string,
    clientId: string,
    next: AgentInputQueuedMessage,
  ): AgentInputProjection {
    if (!next.text.trim() && !(next.files && next.files.length > 0)) {
      return this.getProjection(sessionId);
    }
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return this.getProjection(sessionId);
    state.pendingQueue = state.pendingQueue.map((entry) =>
      entry.clientId === clientId ? updateQueuedMessageContent(entry, next) : entry,
    );
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  /**
   * 整条排队消息原位替换(main 侧受信调用方专用;当前唯一消费者是 Orca lead 的
   * 「修改排队消息」工具)。与 updateText / updateContent 的差别:替换体由调用方
   * 全量构造 —— orca 条目的 text / persistedContent / origin.displayText 之间存在
   * 派发格式耦合(formatAgentMessage / formatOrcaCommunicationMessage),必须由
   * dispatcher 侧按原格式重建,coordinator 不理解也不该理解该格式。
   * 守卫与既有编辑一致:steering 中的条目不可改;clientId 必须锚定原条目
   * (身份不变,防止入队去重窗口与崩溃快照错位)。返回是否完成替换 ——
   * false = 条目已不在 pendingQueue(已派发 / 已移除)、正在 steering 或身份不符。
   */
  replaceQueuedMessage(sessionId: string, clientId: string, next: AgentInputQueuedMessage): boolean {
    if (next.clientId !== clientId || next.chatMessage.clientId !== clientId) return false;
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return false;
    const index = state.pendingQueue.findIndex((q) => q.clientId === clientId);
    if (index < 0) return false;
    const nextQueue = [...state.pendingQueue];
    nextQueue[index] = next;
    state.pendingQueue = nextQueue;
    this.emit(sessionId);
    return true;
  }

  move(sessionId: string, clientId: string, targetIndex: number): AgentInputProjection {
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return this.getProjection(sessionId);
    const fromIndex = state.pendingQueue.findIndex((q) => q.clientId === clientId);
    if (fromIndex < 0) return this.getProjection(sessionId);
    const next = [...state.pendingQueue];
    const [entry] = next.splice(fromIndex, 1);
    if (!entry) return this.getProjection(sessionId);
    let insertIndex = Math.max(0, Math.min(targetIndex, state.pendingQueue.length));
    if (fromIndex < insertIndex) insertIndex -= 1;
    if (fromIndex === insertIndex) return this.getProjection(sessionId);
    next.splice(insertIndex, 0, entry);
    state.pendingQueue = next;
    // 拖拽重排后等待中的消息不再是队首 → 等待态失效(横幅/自动重发都以队首为目标)。
    // 清掉并重新 drain:新队首仍撞 busy 会带自己的 clientId 重建等待,不撞则直接派发。
    if (
      state.credentialSwitchWait &&
      state.pendingQueue[0]?.clientId !== state.credentialSwitchWait.clientId
    ) {
      this.clearCredentialSwitchWait(state);
      this.scheduleDrain(sessionId, 'credential-switch-wait-displaced');
    }
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  setExpanded(sessionId: string, expanded: boolean): AgentInputProjection {
    const state = this.getState(sessionId);
    state.queueExpanded = expanded;
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  setInteractionLock(
    sessionId: string,
    lockId: string,
    locked: boolean,
    opts?: { preserveOnStop?: boolean },
  ): AgentInputProjection {
    const state = this.getState(sessionId);
    state.queueInteractionLocks = toggleList(state.queueInteractionLocks, lockId, locked);
    if (!locked) {
      state.interactionLocksPreservedOnStop = state.interactionLocksPreservedOnStop.filter(
        (id) => id !== lockId,
      );
    } else if (opts?.preserveOnStop) {
      state.interactionLocksPreservedOnStop = toggleList(
        state.interactionLocksPreservedOnStop,
        lockId,
        true,
      );
    }
    this.emit(sessionId);
    if (!locked) {
      this.scheduleDrain(sessionId, 'interaction-unlock');
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'interaction-unlock');
    }
    return this.getProjection(sessionId);
  }

  /**
   * agent 交互被 resolve 且**不会带外启动后续 turn** 时(目前只有 plan_review
   * 的取消/系统 dismissal),由 register 的 resolvePendingInteraction 收口调用。
   * hasPendingInteraction 是 getDrainableHead 的 busy 门之一:这类 turn 间 resolve
   * 没有后续 done wake,这里是唯一能重新评估队列可 drain 性的时机,否则排队消息
   * 会卡到下一次无关用户操作。
   * 注意**不能**对批准/反馈也调用:它们的带外后续 turn(runPlanReviewFlow 的
   * handle.send)在 resolve 瞬间尚未 registered,isTurnRunning 仍为假,此时 drain
   * 会让排队消息与之相撞——过滤责任在 register 调用点(与 agent 分支保持镜像)。
   */
  onInteractionResolved(sessionId: string): void {
    const state = this.getState(sessionId);
    this.scheduleDrain(sessionId, 'interaction-resolved');
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'interaction-resolved');
  }

  setEditLock(sessionId: string, clientId: string, locked: boolean): AgentInputProjection {
    const state = this.getState(sessionId);
    state.queueEditLocks = toggleList(state.queueEditLocks, clientId, locked);
    this.emit(sessionId);
    if (!locked) {
      this.scheduleDrain(sessionId, 'edit-unlock');
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'edit-unlock');
    }
    return this.getProjection(sessionId);
  }

  clearSession(sessionId: string, clearedAt: string | number = Date.now()): AgentInputProjection {
    this.deps.noteSessionClearBoundary?.(sessionId, clearedAt);
    const prev = this.getState(sessionId);
    this.clearSessionRunningRetry(prev);
    this.clearCredentialSwitchWait(prev);
    this.clearPendingExternalTerminalDone(prev);
    this.abortSteerTransactions(sessionId);
    for (const item of prev.pendingQueue) {
      this.deps.onDiscardedQueuedMessage?.(sessionId, item);
    }
    // 显式清上下文:强制开启持久化闸门,让 emit 写出空快照(删行),
    // 即使此前该会话从未触发恢复(否则旧快照残留,下次打开会诈尸)。
    this.restoredQueueSessions.add(sessionId);
    this.states.set(sessionId, createInitialInputState(prev.generation + 1));
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  onTurnEvent(sessionId: string, type: 'done' | 'error', message?: string): void {
    const state = this.getState(sessionId);
    const active = state.activeTurn;
    state.queueAbortPending = false;
    if (type === 'error') {
      if (active?.persisted) {
        state.activeTurn = null;
        state.error = message ?? state.error;
        state.stickyError = null;
        state.recovery = active.item ? { kind: 'active-turn', item: active.item } : null;
        this.emit(sessionId);
        return;
      }
      if (active?.persisting) {
        // 用户气泡还在 DB 边界内。先暂存 terminal error，等持久化
        // 和 dispatch 结果共同决定它能否成为 active-turn retry。
        recordPendingTerminalEvent(active, { type: 'error', message });
        state.error = state.stickyError ?? message ?? state.error;
        state.recovery = null;
        this.emit(sessionId);
        return;
      }
      if (active && isActiveTurnDispatched(active)) {
        state.activeTurn = null;
        state.error = state.stickyError ?? message ?? state.error;
        state.stickyError = state.error;
        state.recovery = null;
        this.emit(sessionId);
        this.scheduleDrain(sessionId, 'terminal-error-after-unpersisted-dispatch');
        return;
      }
      if (active) {
        // 未持久化的 active 还没有跨过产品层 accepted hook；此时到达的
        // terminal error 只能是上一轮迟到事件，不能接管当前 drain。
        this.emit(sessionId);
        return;
      }
      state.error = message ?? state.error;
      // 外部发起的 turn(scheduler/goal 直调 Session.send, active=null)失败时,
      // codex 与 claude-code 的失败收尾都是 terminal error → 紧随的 done 连发
      // (claude 的 is_error 收尾已对齐 codex 序列)。打上 pending 标记, 让配对的
      // done 走上方 pendingExternalTerminalDone 分支(清标记、保留 state.error)——
      // 否则 done 落到本方法尾部 `state.error = null` 的 projection, 会在 renderer
      // 处理 done 事件前把 makerChatStore.error 清掉, 失败的自动化 turn 又被通知
      // 成"已完成"。claude 个别只发 error 不发 done 的收尾(empty-response / event
      // loop crash)由 markPendingExternalTerminalDone 内置的 fallback timer 兜底清。
      this.markPendingExternalTerminalDone(sessionId, state);
      this.emit(sessionId);
      this.scheduleDrainAfterExternalTurnSettles(sessionId, 'terminal-error-without-active-turn');
      return;
    }
    if (state.pendingExternalTerminalDone) {
      this.clearPendingExternalTerminalDone(state);
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'terminal-error-paired-done');
      return;
    }
    if (active?.persisting) {
      // done 早于 DB 写入完成时不能先释放 drain，否则后续队列会越过一个
      // 还没确定是否可恢复的已派发输入。
      recordPendingTerminalEvent(active, { type: 'done' });
      this.emit(sessionId);
      return;
    }
    if (active && !active.persisted && !isActiveTurnDispatched(active)) {
      // 与 error 分支的迟到事件守卫对称: preparing / sending 且未跨过持久化边界的
      // active 收不到属于自己的 done —— vendor turn 尚未放行, 这只能是上一轮的
      // 迟到终态(典型: 插话打断后旧 turn 的 error→done 尾巴落进 drain 的
      // pre-dispatch 异步窗口)。此前这里落到下方无条件 `state.activeTurn = null`,
      // 而 drain 已把 item 从 pendingQueue 切走, 清掉 activeTurn 会让 drain 的
      // isActiveTurnCurrent 校验静默 return —— 这条输入就此蒸发(无日志、无落库、
      // 无 Retry 入口, 2026-07-03 插话丢消息实锤)。忽略之, 后续状态由 in-flight
      // send 的真实 outcome 驱动。
      log.warn('stray turn-done ignored for pre-dispatch active turn', {
        sessionId,
        clientId: active.item?.clientId,
        controlKind: active.controlKind,
        dispatchLifecycle: active.dispatchLifecycle,
      });
      this.emit(sessionId);
      return;
    }
    state.activeTurn = null;
    // 同轮注入的 steer 在飞期间,老 turn 的 done 可能先到(注入前 turn 恰好收尾)。
    // marker 属于 steer 事务而不是老 turn,必须留到 steer() 自己 resolve/reject
    // 或 Stop/close 取消,这里不动 steeringQueueClientIds。
    if (!active && state.recovery?.kind === 'queue-head') {
      // A pre-accept rollback has already restored the failed head. A late
      // done/closed-style wake from the old turn must not clear that recovery,
      // otherwise the next drain tick would silently resend it without Retry.
      this.emit(sessionId);
      return;
    }
    if (!active && state.recovery?.kind === 'active-turn') {
      // 终止型 error 已经把已接受 turn 收口到可恢复状态；Codex 失败路径可能
      // 随后再补一个 done，用来收尾 UI，而不是覆盖刚建立的 Retry 入口。
      this.emit(sessionId);
      return;
    }
    if (state.stickyError) {
      state.error = state.stickyError;
      state.recovery = null;
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'turn-done-after-sticky-error');
      return;
    }
    state.error = null;
    state.recovery = null;
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'turn-done');
  }

  onSessionClosed(sessionId: string): void {
    const state = this.getState(sessionId);
    const releasedAbortLock = state.queueAbortPending;
    this.cancelScheduledDrain(state);
    this.clearSessionRunningRetry(state);
    this.clearPendingExternalTerminalDone(state);
    this.abortSteerTransactions(sessionId);
    const active = state.activeTurn;
    if (active && !isActiveTurnDispatched(active)) {
      if (active.sendStarted) {
        this.recordActiveTurnClosedBeforeSendOutcome(state, active);
      } else {
        this.handleActiveTurnClosedBeforeDispatch(sessionId, state, active);
      }
      state.queueAbortPending = false;
      state.steeringQueueClientIds = [];
      this.emit(sessionId);
      return;
    }
    state.activeTurn = null;
    state.queueAbortPending = false;
    state.steeringQueueClientIds = [];
    this.emit(sessionId);
    if (releasedAbortLock) this.scheduleDrain(sessionId, 'session-closed-abort-boundary');
  }

  private getState(sessionId: string): SessionInputState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createInitialInputState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  private emit(sessionId: string): void {
    this.deps.emitProjection(this.getProjection(sessionId));
    // 崩溃恢复快照的统一收口点:所有队列状态迁移最终都会 emit,在这里做
    // 内容变更检测后异步覆盖写,单点保证内存态与快照不漂移(issue #761)。
    this.maybePersistQueueSnapshot(sessionId);
  }

  /**
   * 计算应持久化的快照内容:pendingQueue + 已离队但尚未跨过 DB 持久化边界的
   * activeTurn.item。后者覆盖"drain 已把队首切走、agent 还没接受"的窗口 ——
   * 只有一条排队消息时它几乎立刻进入该窗口,不含它则单条排队必丢。已持久化
   * (persisted=true)的 active item 不再进快照:它已落 messages 表,重启后属于
   * interrupted-turn 提示的辖区,重复恢复会造成二次发送。
   */
  private computeQueueSnapshotItems(state: SessionInputState): AgentInputQueuedMessage[] {
    const active = state.activeTurn;
    const activeItem =
      active?.item && !active.persisted &&
      !state.pendingQueue.some((q) => q.clientId === active.item?.clientId)
        ? [active.item]
        : [];
    // scheduler 撞忙排队项不进崩溃快照:runner 的 run 在重启时会被 sweep 标
    // interrupted,恢复出的副本没有等待方;心跳 prompt 每轮 fire 重新生成,
    // 陈旧副本无价值,恢复它只会造成"暂停队列里的僵尸自动化"(restore 侧
    // 有对老快照的同款过滤,见 restoreQueueSnapshot)。
    return [...activeItem, ...state.pendingQueue]
      .filter((item) => item.origin?.kind !== 'scheduler')
      .map(sanitizeQueuedMessageForPersistence);
  }

  private maybePersistQueueSnapshot(sessionId: string): void {
    if (!this.deps.persistQueueSnapshot) return;
    // 未恢复前不写:此时内存态还是空壳,覆盖写会把崩溃前的快照静默删掉。
    if (!this.restoredQueueSessions.has(sessionId)) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    const items = this.computeQueueSnapshotItems(state);
    const json = JSON.stringify(items);
    if (this.lastQueueSnapshotJson.get(sessionId) === json) return;
    this.lastQueueSnapshotJson.set(sessionId, json);
    const result = this.deps.persistQueueSnapshot(sessionId, items);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        if (this.lastQueueSnapshotJson.get(sessionId) === json) {
          this.lastQueueSnapshotJson.delete(sessionId);
        }
      });
    }
  }

  private toProjection(sessionId: string, state: SessionInputState): AgentInputProjection {
    const pendingQueue = state.pendingQueue.map((item) => this.toProjectedItem(item));
    const recovery: AgentInputRecovery = state.recovery?.kind === 'active-turn'
      ? { ...state.recovery, item: this.toProjectedItem(state.recovery.item) }
      : state.recovery;
    return {
      sessionId,
      pendingQueue,
      continuationInFlightClientId:
        state.activeTurn?.item?.originalSyntheticTrigger === 'continue'
          ? state.activeTurn.item.clientId
          : null,
      steeringQueueClientIds: [...state.steeringQueueClientIds],
      queuePaused: state.queuePaused,
      queueExpanded: state.queueExpanded,
      queueInteractionLocks: [...state.queueInteractionLocks],
      queueEditLocks: [...state.queueEditLocks],
      queueAbortPending: state.queueAbortPending,
      error: state.error,
      recovery,
      errorRetryText: projectionRetryText(state.pendingQueue, state.recovery),
      credentialSwitchWait: state.credentialSwitchWait
        ? {
            clientId: state.credentialSwitchWait.clientId,
            blockedBySessionIds: [...state.credentialSwitchWait.blockedBySessionIds],
          }
        : null,
    };
  }

  /** Renderer projection may carry routing hints, but never quoted history bodies. */
  private toProjectedItem(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
    const projected = { ...item };
    delete projected.trustedSessionReferenceContexts;
    delete projected.sessionReferencesRequireTrustedSnapshot;
    return projected;
  }

  /** Resolve local refs normally, but never reinterpret a controller-owned remote ref. */
  private async resolveReferenceContexts(
    item: AgentInputQueuedMessage,
  ): Promise<AgentInputSessionReferenceContext[]> {
    if (!item.sessionRefs || item.sessionRefs.length === 0) return [];
    if (item.trustedSessionReferenceContexts) return item.trustedSessionReferenceContexts;
    if (item.sessionReferencesRequireTrustedSnapshot) {
      throw new Error('Remote session reference snapshot is missing; edit and resend the message.');
    }
    return this.deps.resolveSessionReferences?.(item.sessionRefs) ?? [];
  }

  private isDispatchBoundaryBusy(sessionId: string, state: SessionInputState): boolean {
    return (
      state.activeTurn !== null ||
      state.pendingExternalTerminalDone ||
      this.deps.isTurnRunning(sessionId) ||
      this.deps.hasPendingInteraction(sessionId) ||
      state.queueAbortPending ||
      state.steeringQueueClientIds.length > 0
    );
  }

  private isTurnSteerable(sessionId: string, state: SessionInputState): boolean {
    return state.activeTurn !== null || this.deps.isTurnRunning(sessionId);
  }

  private getDrainableHead(sessionId: string, state: SessionInputState): AgentInputQueuedMessage | null {
    if (this.queueRestorePromises.has(sessionId)) return null;
    if (this.restoreAttempted.has(sessionId) && !this.restoredQueueSessions.has(sessionId)) return null;
    if (state.pendingQueue.length === 0) return null;
    if (state.queuePaused) return null;
    if (state.queueAbortPending) return null;
    if (state.queueInteractionLocks.length > 0) return null;
    if (state.steeringQueueClientIds.length > 0) return null;
    if (state.recovery) return null;
    if (this.deps.hasPendingCredentialSwitch?.(sessionId)) return null;
    if (this.isDispatchBoundaryBusy(sessionId, state)) return null;
    const head = state.pendingQueue[0];
    if (!head) return null;
    if (this.getDrainableCompact(sessionId, state)) return null;
    if (state.queueEditLocks.includes(head.clientId)) return null;
    return head;
  }

  private getDrainableCompact(sessionId: string, state: SessionInputState): PendingCompactRequest | null {
    if (this.queueRestorePromises.has(sessionId)) return null;
    if (this.restoreAttempted.has(sessionId) && !this.restoredQueueSessions.has(sessionId)) return null;
    const first = state.pendingCompacts[0];
    if (!first) return null;
    if (first.waitForClientIds.length > 0) return null;
    if (state.queuePaused) return null;
    if (state.queueAbortPending) return null;
    if (state.queueInteractionLocks.length > 0) return null;
    if (state.steeringQueueClientIds.length > 0) return null;
    if (state.recovery) return null;
    if (this.deps.hasPendingCredentialSwitch?.(sessionId)) return null;
    if (this.isDispatchBoundaryBusy(sessionId, state)) return null;
    return first;
  }

  private scheduleDrain(sessionId: string, reason: string): void {
    const state = this.getState(sessionId);
    if (state.drainScheduled) return;
    state.drainScheduled = true;
    const scheduledState = state;
    const drainWakeupGeneration = state.drainWakeupGeneration;
    queueMicrotask(() => {
      const latest = this.getState(sessionId);
      if (latest !== scheduledState || latest.drainWakeupGeneration !== drainWakeupGeneration) return;
      latest.drainScheduled = false;
      void this.drain(sessionId, reason);
    });
  }

  private cancelScheduledDrain(state: SessionInputState): void {
    if (!state.drainScheduled) return;
    state.drainScheduled = false;
    state.drainWakeupGeneration += 1;
  }

  private async drain(sessionId: string, reason: string): Promise<void> {
    const state = this.getState(sessionId);
    const compact = this.getDrainableCompact(sessionId, state);
    if (compact) {
      state.pendingCompacts = state.pendingCompacts.slice(1);
      await this.dispatchCompact(sessionId, compact, reason);
      return;
    }
    const head = this.getDrainableHead(sessionId, state);
    if (!head) {
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, `drain-blocked:${reason}`);
      return;
    }
    state.pendingQueue = state.pendingQueue.slice(1);
    this.removePendingCompactWaitClientId(state, head.clientId);
    if (!state.stickyError) {
      state.error = null;
    }
    state.recovery = null;
    const active: ActiveTurn = {
      item: head,
      delivery: 'turn',
      messageUuid: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      generation: state.generation,
      persisted: false,
      persisting: false,
      sendStarted: false,
      dispatchLifecycle: 'preparing',
      pendingTerminalEvent: null,
    };
    state.activeTurn = active;
    this.emit(sessionId);

    try {
      // 意识拦截钩(订阅槽①):落库/派发之前问一遍——block 即丢弃本项
      // (不入库不起 turn),通知宿主降级气泡,继续放行后续排队消息;
      // rewrite 用新正文替换 head(送 agent / 落库 / 显示都用它),通知宿主
      // 留痕署名后照常派发。activeTurn 已置位,并发 drain 被挡住,询问期间
      // 不会抢发下一条。
      if (!head.bypassGhostHooks && this.deps.screenUserMessage) {
        const verdict = await this.deps.screenUserMessage(sessionId, getAgentFacingText(head));
        if (!this.isActiveTurnCurrent(sessionId, active)) return;
        if (verdict.action === 'block') {
          this.getState(sessionId).activeTurn = null;
          this.deps.onUserMessageBlocked?.(sessionId, head, verdict);
          this.deps.onDiscardedQueuedMessage?.(sessionId, head);
          this.emit(sessionId);
          this.scheduleDrain(sessionId, 'ghost-hook-blocked');
          return;
        }
        if (verdict.action === 'rewrite') {
          // head 已从 pendingQueue 取出,原地改正文安全:buildMakerUserMessage
          // 读 head.text(送 agent)、persistUserMessage.content 读
          // head.persistedContent(落库)。persistedContent 是 stringifyUserContent
          // 的 JSON 信封(可能携带图片/文件引用与引用块)——必须走 JSON-aware
          // 的 updateQueuedMessageText 只换其中 text 字段;整体覆写会把带附件
          // 消息的落库内容毁成纯文本(重开会话后附件 chip / 引用全部丢失)。
          const originalText = head.text;
          const rewritten = updateQueuedMessageText(head, verdict.text);
          Object.assign(head, rewritten);
          if (!rewritten.sessionRefs) delete head.sessionRefs;
          if (!rewritten.trustedSessionReferenceContexts) delete head.trustedSessionReferenceContexts;
          if (!rewritten.sessionReferencesRequireTrustedSnapshot) {
            delete head.sessionReferencesRequireTrustedSnapshot;
          }
          delete head.agentReferences;
          this.deps.onUserMessageRewritten?.(sessionId, head, {
            ghostId: verdict.ghostId,
            ghostName: verdict.ghostName,
            text: verdict.text,
            originalText,
          });
        }
      }
      const sdkSessionId = await this.deps.getSdkSessionId(sessionId).catch(() => undefined);
      if (!this.isActiveTurnCurrent(sessionId, active)) return;
      active.sendStarted = true;
      active.dispatchLifecycle = 'sending';
      // Freeze side-effect timestamps before entering vendor code. A dispatch
      // may synchronously emit the new turn's started marker before it returns;
      // post-dispatch acknowledgements must remain older than that marker.
      const preVendorDispatchAt = Math.max(0, Date.now() - 1);
      const referenceContexts = await this.resolveReferenceContexts(head);
      head.persistedContent = attachSessionReferenceMetadata(head.persistedContent, referenceContexts);
      const result = await this.deps.sendToAgent(
        sessionId,
        buildMakerUserMessage(head, referenceContexts),
        head.createOpts,
        {
          messageUuid: active.messageUuid,
          userName: head.userName,
          throwOnStartFailure: true,
          ...(head.origin?.kind === 'scheduler' ? { origin: head.origin } : {}),
          persistUserMessage: {
            clientId: head.clientId,
            content: head.persistedContent,
            sdkSessionId,
            delivery: active.delivery,
            shouldBroadcast: () => this.isTurnGenerationCurrent(sessionId, active),
            onPersisting: () => {
              if (this.isTurnGenerationCurrent(sessionId, active)) {
                active.persisting = true;
              }
            },
            onPersisted: async () => {
              if (this.isTurnGenerationCurrent(sessionId, active)) {
                active.persisted = true;
                active.persisting = false;
                active.dispatchLifecycle = 'awaiting-dispatch-hooks';
                // 跨过 DB 持久化边界即刻收窄快照:此后崩溃属 interrupted-turn
                // 辖区,若等到下一次 emit(turn done)才写,长 turn 内崩溃会把
                // 已送达的消息二次恢复(issue #761)。
                this.maybePersistQueueSnapshot(sessionId);
              }
              await this.deps.beforeDispatchUserTurn?.(sessionId, head);
              if (!this.isActiveTurnCurrent(sessionId, active)) {
                throw new Error('[SEND_CANCELLED_BEFORE_DISPATCH] User turn was cancelled before vendor dispatch');
              }
              // host 把排队 orca 消息的 accepted 副作用挂在这个 hook 上(置 running /
              // autoBridgePending), 必须 await 完才能放行 vendor turn —— fire-and-forget
              // 会让快 worker 在状态可见前结束 turn, 桥接被 turn-end handler 误跳过。
              await this.deps.onAcceptedQueuedMessage?.(sessionId, head);
              if (!this.isActiveTurnCurrent(sessionId, active)) {
                throw new Error('[SEND_CANCELLED_BEFORE_DISPATCH] User turn was cancelled before vendor dispatch');
              }
              active.dispatchLifecycle = 'sending';
            },
          },
        },
      );
      if (!this.isActiveTurnCurrent(sessionId, active)) return;
      active.persisting = false;
      if (!isSendDispatched(result)) {
        this.handleSendNotDispatched(sessionId, active, head, result);
        return;
      }
      active.dispatchLifecycle = 'dispatched';
      // 派发成功 = 凭证切换等待(若有)结束。
      this.clearCredentialSwitchWait(this.getState(sessionId));
      // vendor dispatch 已不可逆：此时再 durable-ack 旧中断。onAccepted 仍可能
      // cancelled-before-dispatch，过早 ack 会在无新 started 时抹掉中断提示。
      try {
        await this.deps.onDispatchedUserTurn?.(sessionId, head, preVendorDispatchAt);
      } catch (err) {
        log.warn('onDispatchedUserTurn failed', {
          sessionId,
          clientId: head.clientId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!this.isActiveTurnCurrent(sessionId, active)) return;
      if (active.pendingTerminalEvent) {
        this.settlePendingTerminalEventAfterPersist(sessionId, active);
        return;
      }
      this.emit(sessionId);
    } catch (err) {
      if (!this.isActiveTurnCurrent(sessionId, active)) return;
      const latest = this.getState(sessionId);
      if (!active.persisted) {
        if (isSessionRunningError(err)) {
          this.deferQueueHeadAfterSessionRunning(sessionId, active, head, reason, errorMessage(err));
          return;
        }
        latest.activeTurn = null;
        this.prependQueueHeadIfMissing(latest, head);
        this.clearCredentialSwitchWait(latest);
        latest.error = errorMessage(err);
        latest.stickyError = null;
        latest.recovery = { kind: 'queue-head', clientId: head.clientId };
        log.warn('pre-accept send failed; restored queue head', {
          sessionId,
          clientId: head.clientId,
          reason,
          error: latest.error,
        });
        this.emit(sessionId);
        return;
      }
      latest.error = errorMessage(err);
      latest.stickyError = null;
      latest.recovery = { kind: 'active-turn', item: head };
      this.notifyUndispatchedUserTurn(sessionId, head);
      this.emit(sessionId);
      // Thread 3 fix: item was removed from the queue by drain but not put back
      // (persisted path). If no other work is pending, any deferred completion must
      // be replayed now; otherwise Agent Island stays in "running" indefinitely.
      this.deps.onQueueEmptied?.(sessionId);
    }
  }

  private handleSendNotDispatched(
    sessionId: string,
    active: ActiveTurn,
    item: AgentInputQueuedMessage,
    result: AgentInputSendFailure,
  ): void {
    if (!this.isActiveTurnCurrent(sessionId, active)) return;
    const latest = this.getState(sessionId);
    const message = sendFailureMessage(result);
    const logFields = sendFailureLogFields(result);

    if (!active.persisted) {
      if (isSessionRunningSendFailure(result)) {
        this.deferQueueHeadAfterSessionRunning(sessionId, active, item, 'not-dispatched', message);
        return;
      }
      if (isCredentialSwitchBusySendFailure(result)) {
        this.deferQueueHeadForCredentialSwitch(sessionId, active, item, result);
        return;
      }
      latest.activeTurn = null;
      if (!latest.pendingQueue.some((q) => q.clientId === item.clientId)) {
        latest.pendingQueue = [item, ...latest.pendingQueue];
        this.prependPendingCompactWaitClientId(latest, item.clientId);
      }
      this.clearCredentialSwitchWait(latest);
      latest.error = message;
      latest.stickyError = null;
      latest.recovery = { kind: 'queue-head', clientId: item.clientId };
      log.warn('send not dispatched; restored queue head', {
        sessionId,
        clientId: item.clientId,
        ...logFields,
      });
      this.emit(sessionId);
      return;
    }

    latest.activeTurn = null;
    latest.error = message;
    latest.stickyError = null;
    latest.recovery = { kind: 'active-turn', item };
    this.notifyUndispatchedUserTurn(sessionId, item);
    if (latest.queueAbortPending && result.kind === 'session-dispatch' && result.reason === 'cancelled-before-dispatch') {
      latest.queueAbortPending = false;
    }
    log.warn('send not dispatched after persistence; kept active-turn recovery', {
      sessionId,
      clientId: item.clientId,
      ...logFields,
    });
    this.emit(sessionId);
    // Thread 3 fix: item was removed from the queue by drain but not put back
    // (persisted path). If no other work is pending, any deferred completion must
    // be replayed now; otherwise Agent Island stays in "running" indefinitely.
    this.deps.onQueueEmptied?.(sessionId);
  }

  private deferCompactAfterSessionRunning(
    sessionId: string,
    active: ActiveTurn,
    request: PendingCompactRequest,
    reason: string,
    error: string,
  ): AgentInputProjection {
    const latest = this.getState(sessionId);
    if (!this.isActiveTurnCurrent(sessionId, active)) return this.getProjection(sessionId);
    latest.activeTurn = null;
    if (!latest.pendingCompacts.includes(request)) {
      latest.pendingCompacts = [request, ...latest.pendingCompacts];
    }
    latest.error = null;
    latest.stickyError = null;
    latest.recovery = null;
    log.info('compact hit SESSION_RUNNING race; requeued until active turn finishes', {
      sessionId,
      reason,
      error,
    });
    this.emit(sessionId);
    this.scheduleSessionRunningRetry(sessionId, `compact:${reason}`);
    return this.getProjection(sessionId);
  }

  /**
   * 发送撞上 CREDENTIAL_SWITCH_BUSY:共享 codex 进程要切凭证形态,但其它本地会话
   * 在忙。与 2026-07-03 的「可见错误 + 手动 Retry」不同,这里进入**可见等待态**:
   * 队首保留、credentialSwitchWait 进 projection(renderer 显示"等待其它任务结束后
   * 自动发送"),挡路会话 turn 结束(onExternalTurnSettled)或兜底定时器自动重发。
   * 07-03 反对的是"看不见的假死",不是自动化本身 —— 等待必须可见、可取消(用户可
   * 从队列里删掉这条消息)。
   */
  private deferQueueHeadForCredentialSwitch(
    sessionId: string,
    active: ActiveTurn,
    item: AgentInputQueuedMessage,
    result: Extract<AgentInputSendResult, { kind: 'host-send' }>,
  ): void {
    const latest = this.getState(sessionId);
    if (!this.isActiveTurnCurrent(sessionId, active)) return;
    latest.activeTurn = null;
    this.prependQueueHeadIfMissing(latest, item);
    latest.error = null;
    latest.stickyError = null;
    latest.recovery = null;
    latest.credentialSwitchWait = {
      clientId: item.clientId,
      blockedBySessionIds: [...(result.busySessionIds ?? [])],
    };
    log.info('send hit credential switch busy; waiting for blocking sessions', {
      sessionId,
      clientId: item.clientId,
      blockedBySessionIds: latest.credentialSwitchWait.blockedBySessionIds,
      message: result.message,
    });
    this.emit(sessionId);
    this.scheduleCredentialSwitchRetry(sessionId);
  }

  /**
   * 任意会话 turn 结束 / 会话关闭时由 host 调用:唤醒被它挡住的凭证切换等待者。
   * 挡路列表为空(错误未带 ids)的等待者也一并唤醒 —— 宁可多试一次,不可漏醒。
   */
  onExternalTurnSettled(settledSessionId: string): void {
    for (const [sessionId, state] of this.states) {
      if (sessionId === settledSessionId) continue;
      const wait = state.credentialSwitchWait;
      if (!wait) continue;
      if (wait.blockedBySessionIds.length > 0 && !wait.blockedBySessionIds.includes(settledSessionId)) {
        continue;
      }
      this.scheduleDrain(sessionId, 'credential-switch-blocker-settled');
    }
  }

  /** host 侧异步边界(pending 凭证切换 apply 完成等)后恢复该会话的队列派发。 */
  wakeSession(sessionId: string, reason: string): void {
    this.scheduleDrain(sessionId, reason);
  }

  private scheduleCredentialSwitchRetry(sessionId: string): void {
    const state = this.getState(sessionId);
    if (state.credentialSwitchRetryTimer) {
      if (state.credentialSwitchRetryGeneration === state.generation) return;
      this.clearCredentialSwitchRetry(state);
    }
    const generation = state.generation;
    state.credentialSwitchRetryGeneration = generation;
    state.credentialSwitchRetryTimer = setTimeout(() => {
      const latest = this.getState(sessionId);
      latest.credentialSwitchRetryTimer = null;
      latest.credentialSwitchRetryGeneration = null;
      if (latest.generation !== generation) return;
      if (!latest.credentialSwitchWait) return;
      if (latest.pendingQueue.length === 0) {
        this.clearCredentialSwitchWait(latest);
        this.emit(sessionId);
        return;
      }
      this.scheduleDrain(sessionId, 'credential-switch-retry');
      this.scheduleCredentialSwitchRetry(sessionId);
    }, CREDENTIAL_SWITCH_RETRY_DELAY_MS);
  }

  private clearCredentialSwitchRetry(state: SessionInputState): void {
    if (state.credentialSwitchRetryTimer) {
      clearTimeout(state.credentialSwitchRetryTimer);
    }
    state.credentialSwitchRetryTimer = null;
    state.credentialSwitchRetryGeneration = null;
  }

  private clearCredentialSwitchWait(state: SessionInputState): void {
    state.credentialSwitchWait = null;
    this.clearCredentialSwitchRetry(state);
  }

  private deferQueueHeadAfterSessionRunning(
    sessionId: string,
    active: ActiveTurn,
    item: AgentInputQueuedMessage,
    reason: string,
    error: string,
  ): void {
    const latest = this.getState(sessionId);
    if (!this.isActiveTurnCurrent(sessionId, active)) return;
    latest.activeTurn = null;
    this.prependQueueHeadIfMissing(latest, item);
    latest.error = null;
    latest.stickyError = null;
    latest.recovery = null;
    log.info('send hit SESSION_RUNNING race; restored queue head until active turn finishes', {
      sessionId,
      clientId: item.clientId,
      reason,
      error,
    });
    this.emit(sessionId);
    this.scheduleSessionRunningRetry(sessionId, `send:${reason}`);
  }

  private prependQueueHeadIfMissing(state: SessionInputState, item: AgentInputQueuedMessage): void {
    if (state.pendingQueue.some((q) => q.clientId === item.clientId)) return;
    state.pendingQueue = [item, ...state.pendingQueue];
    this.prependPendingCompactWaitClientId(state, item.clientId);
  }

  private scheduleSessionRunningRetry(sessionId: string, reason: string): void {
    const state = this.getState(sessionId);
    if (state.sessionRunningRetryTimer) {
      if (state.sessionRunningRetryGeneration === state.generation) return;
      this.clearSessionRunningRetry(state);
    }
    const generation = state.generation;
    state.sessionRunningRetryGeneration = generation;
    state.sessionRunningRetryTimer = setTimeout(() => {
      const latest = this.getState(sessionId);
      latest.sessionRunningRetryTimer = null;
      latest.sessionRunningRetryGeneration = null;
      if (latest.generation !== generation) return;
      if (latest.pendingQueue.length === 0 && latest.pendingCompacts.length === 0) return;
      if (this.isDispatchBoundaryBusy(sessionId, latest)) {
        this.scheduleSessionRunningRetry(sessionId, reason);
        return;
      }
      this.scheduleDrain(sessionId, `session-running-retry:${reason}`);
    }, SESSION_RUNNING_RETRY_DELAY_MS);
  }

  private markPendingExternalTerminalDone(sessionId: string, state: SessionInputState): void {
    state.pendingExternalTerminalDone = true;
    if (state.pendingExternalTerminalDoneTimer) return;
    const generation = state.generation;
    state.pendingExternalTerminalDoneTimer = setTimeout(() => {
      const latest = this.getState(sessionId);
      latest.pendingExternalTerminalDoneTimer = null;
      if (latest.generation !== generation) return;
      if (!latest.pendingExternalTerminalDone) return;
      latest.pendingExternalTerminalDone = false;
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'terminal-error-done-fallback');
    }, TERMINAL_DONE_FALLBACK_DELAY_MS);
  }

  private clearPendingExternalTerminalDone(state: SessionInputState): void {
    if (state.pendingExternalTerminalDoneTimer) {
      clearTimeout(state.pendingExternalTerminalDoneTimer);
    }
    state.pendingExternalTerminalDone = false;
    state.pendingExternalTerminalDoneTimer = null;
  }

  private scheduleDrainAfterExternalTurnSettles(sessionId: string, reason: string): void {
    const state = this.getState(sessionId);
    if (state.pendingQueue.length === 0 && state.pendingCompacts.length === 0) return;
    this.scheduleDrain(sessionId, reason);
    this.scheduleSessionRunningRetry(sessionId, reason);
  }

  private scheduleExternalTurnRetryIfNeeded(sessionId: string, state: SessionInputState, reason: string): void {
    const compact = state.pendingCompacts[0];
    const head = state.pendingQueue[0];
    const hasRunnableCompact = Boolean(compact && compact.waitForClientIds.length === 0);
    const hasRunnableQueueHead = Boolean(head && !state.queueEditLocks.includes(head.clientId));
    if (!hasRunnableCompact && !hasRunnableQueueHead) return;
    if (state.activeTurn !== null) return;
    if (state.recovery !== null) return;
    if (state.queuePaused || state.queueAbortPending) return;
    if (state.queueInteractionLocks.length > 0 || state.steeringQueueClientIds.length > 0) return;
    if (!this.deps.isTurnRunning(sessionId)) return;
    this.scheduleSessionRunningRetry(sessionId, reason);
  }

  private clearSessionRunningRetry(state: SessionInputState): void {
    if (state.sessionRunningRetryTimer) {
      clearTimeout(state.sessionRunningRetryTimer);
    }
    state.sessionRunningRetryTimer = null;
    state.sessionRunningRetryGeneration = null;
  }

  /** closed 事件可能早于 sendToAgent 返回；这里先挂起 terminal event，等真实 send outcome 决定 drain 还是 recovery。 */
  private recordActiveTurnClosedBeforeSendOutcome(state: SessionInputState, active: ActiveTurn): void {
    recordPendingTerminalEvent(active, { type: 'done' });
    state.error = null;
    state.stickyError = null;
    state.recovery = null;
  }

  private handleActiveTurnClosedBeforeDispatch(
    sessionId: string,
    state: SessionInputState,
    active: ActiveTurn,
  ): void {
    const message = 'Session closed before dispatch completed';
    if (!active.item) {
      state.activeTurn = null;
      state.error = message;
      state.stickyError = null;
      state.recovery = null;
      log.warn('control turn closed before dispatch completed', {
        sessionId,
        controlKind: active.controlKind,
      });
      return;
    }
    const item = active.item;
    if (active.persisted) {
      state.activeTurn = null;
      state.error = message;
      state.stickyError = null;
      state.recovery = { kind: 'active-turn', item };
      this.notifyUndispatchedUserTurn(sessionId, item);
      log.warn('session closed before dispatch after persistence; kept active-turn recovery', {
        sessionId,
        clientId: item.clientId,
      });
      return;
    }

    if (active.persisting) {
      recordPendingTerminalEvent(active, { type: 'error', message });
      state.error = message;
      state.recovery = null;
      return;
    }

    state.activeTurn = null;
    if (!state.pendingQueue.some((q) => q.clientId === item.clientId)) {
      state.pendingQueue = [item, ...state.pendingQueue];
      this.prependPendingCompactWaitClientId(state, item.clientId);
    }
    state.error = message;
    state.stickyError = null;
    state.recovery = { kind: 'queue-head', clientId: item.clientId };
  }

  // Stop 可能赢在 getSdkSessionId 或 beforeDispatchUserTurn 等 pre-vendor
  // await 窗口；此时 maker-core reservation 还没创建，只能由 coordinator
  // 自己失效这一轮 drain。
  private cancelPreSendActiveTurn(sessionId: string, state: SessionInputState, preserveQueue: boolean): void {
    const active = state.activeTurn;
    if (!active || !isActiveTurnBeforeVendorDispatch(active)) return;
    state.generation += 1;
    state.activeTurn = null;
    const item = active.item;
    if (!item) return;
    if (active.persisted) {
      this.notifyUndispatchedUserTurn(sessionId, item);
      if (preserveQueue) {
        state.recovery = { kind: 'active-turn', item };
      }
      return;
    }
    if (!preserveQueue) return;
    if (!state.pendingQueue.some((q) => q.clientId === item.clientId)) {
      state.pendingQueue = [item, ...state.pendingQueue];
      this.prependPendingCompactWaitClientId(state, item.clientId);
    }
  }

  private fallbackPreparedAsTurn(sessionId: string, item: AgentInputQueuedMessage, removeFromQueue: boolean): void {
    const state = this.getState(sessionId);
    // 插话回落成普通派发 = 也是一条新用户输入,同 enqueue 放弃 active-turn 重试。
    this.abandonActiveTurnRecoveryForNewInput(state);
    this.clearErrorUnlessQueueHeadBlocked(state, item.clientId);
    state.queuePaused = false;
    state.steeringQueueClientIds = state.steeringQueueClientIds.filter((id) => id !== item.clientId);
    state.queueEditLocks = state.queueEditLocks.filter((id) => id !== item.clientId);
    this.movePreparedItemToQueueFront(state, item, removeFromQueue);
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'steer-fallback');
  }

  private movePreparedItemToQueueFront(
    state: SessionInputState,
    item: AgentInputQueuedMessage,
    removeFromQueue: boolean,
  ): void {
    const existingIndex = state.pendingQueue.findIndex((q) => q.clientId === item.clientId);
    if (existingIndex >= 0) {
      // `item` may carry a trusted snapshot restored by steer(). Keep that
      // prepared value when materializing the fallback turn; otherwise the
      // marker-only queue row would be re-used and the next drain would fail
      // closed because its snapshot is missing.
      state.pendingQueue.splice(existingIndex, 1);
      state.pendingQueue.unshift(item);
    } else if (!removeFromQueue) {
      state.pendingQueue.push(item);
    } else {
      state.pendingQueue.unshift(item);
    }
  }

  private releaseAbortLockAndDrain(
    sessionId: string,
    reason: string,
    opts?: { clearActiveTurn?: boolean },
  ): void {
    const state = this.getState(sessionId);
    if (opts?.clearActiveTurn) {
      // Claude's abort promise is a real drain boundary. Codex is not: its
      // interrupt RPC can resolve before the active turn is actually closed,
      // so stop() only requests this path for non-Codex agents.
      state.activeTurn = null;
    }
    if (!state.queueAbortPending && !opts?.clearActiveTurn) return;
    state.queueAbortPending = false;
    this.emit(sessionId);
    this.scheduleDrain(sessionId, reason);
  }

  private registerSteerAbortController(sessionId: string, clientId: string, controller: AbortController): void {
    let byClientId = this.steerAbortControllers.get(sessionId);
    if (!byClientId) {
      byClientId = new Map<string, AbortController>();
      this.steerAbortControllers.set(sessionId, byClientId);
    }
    byClientId.set(clientId, controller);
  }

  private clearSteerAbortController(sessionId: string, clientId: string): void {
    const byClientId = this.steerAbortControllers.get(sessionId);
    if (!byClientId) return;
    byClientId.delete(clientId);
    if (byClientId.size === 0) this.steerAbortControllers.delete(sessionId);
  }

  private abortSteerTransactions(sessionId: string): void {
    const byClientId = this.steerAbortControllers.get(sessionId);
    if (!byClientId) return;
    // Stop/close are pre-accept boundaries for 插话. The marker is only UI
    // state; aborting the controller is the part that prevents maker-core from
    // injecting the message after the user has already stopped the task.
    for (const controller of byClientId.values()) controller.abort();
    this.steerAbortControllers.delete(sessionId);
  }

  private touchUserSend(sessionId: string, atMs?: number): void {
    void touchUserSendInDb(sessionId, atMs).catch((err) => {
      log.warn('touchUserSend failed', { sessionId, error: errorMessage(err) });
    });
  }

  private clearErrorUnlessQueueHeadBlocked(state: SessionInputState, explicitClientId?: string): void {
    if (state.recovery?.kind === 'queue-head' && state.recovery.clientId !== explicitClientId) {
      return;
    }
    if (state.recovery?.kind === 'active-turn') {
      return;
    }
    state.error = null;
    state.stickyError = null;
    state.recovery = null;
  }

  /**
   * 新用户输入放弃 active-turn 重试入口(2026-07-13 Lizi 拍板)。错误的本质是
   * "上一条消息执行失败了",用户此后**主动发出的新消息**(composer 发送 / 插话
   * 回落派发)就是对"要不要重试"的表态 —— 清掉错误横幅与重试入口,让新消息正常
   * 派发,不再默默排队等一个可能没被注意到的重试按钮。失败消息已落库、仍在会话
   * 里可手动重发;「重试」按钮与新输入赛跑时后到的 retryLastError 读到
   * recovery=null 即 no-op,无双发风险。
   *
   * 边界(刻意不收进来的入口):
   * - resume(继续队列)**不**放弃:Stop 中断留下的 recovery 可能是"已落库但从未
   *   派发"的消息,继续队列直接跳过它等于静默丢失,必须由用户显式点重试/删除;
   * - queue-head recovery 不在此列:失败消息还躺在队首,自动清等于静默重发。
   *
   * 覆盖范围说明:active-turn recovery 有三个来源 —— 终态错误、Stop 赢在
   * pre-send 窗口、持久化后派发失败。后两类的消息同样"已落库但从未派发",
   * 新输入把它们一并放弃(消息留在会话里,不再自动重发)。与 resume 的区别:
   * resume 只是"放行队列"的机械操作,用户未必意识到有一条没发出去;而打字发
   * 新消息是对会话现状的明确表态,三类来源一视同仁(2026-07-13 拍板口径
   * "上一条消息失败了 → 新消息 = 不重试",Stop/派发失败同属"没执行成功")。
   */
  private abandonActiveTurnRecoveryForNewInput(state: SessionInputState): void {
    if (state.recovery?.kind !== 'active-turn') return;
    state.error = null;
    state.stickyError = null;
    state.recovery = null;
  }

  private removePendingCompactWaitClientId(state: SessionInputState, clientId: string): void {
    state.pendingCompacts = state.pendingCompacts.map((entry) => ({
      ...entry,
      waitForClientIds: entry.waitForClientIds.filter((id) => id !== clientId),
    }));
  }

  private prependPendingCompactWaitClientId(state: SessionInputState, clientId: string): void {
    state.pendingCompacts = state.pendingCompacts.map((entry) => ({
      ...entry,
      waitForClientIds: entry.waitForClientIds.includes(clientId)
        ? entry.waitForClientIds
        : [clientId, ...entry.waitForClientIds],
    }));
  }

  private notifyUndispatchedUserTurn(sessionId: string, item: AgentInputQueuedMessage): void {
    try {
      this.deps.onUndispatchedUserTurn?.(sessionId, item);
    } catch (err) {
      log.warn('onUndispatchedUserTurn failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private isTurnGenerationCurrent(sessionId: string, active: ActiveTurn): boolean {
    return this.getState(sessionId).generation === active.generation;
  }

  private isActiveTurnCurrent(sessionId: string, active: ActiveTurn): boolean {
    const state = this.getState(sessionId);
    return state.generation === active.generation && state.activeTurn === active;
  }

  private async persistAcceptedUserMessage(sessionId: string, active: ActiveTurn): Promise<PersistAcceptedUserMessageResult> {
    const item = active.item;
    if (!item) return 'failed';
    if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
    const sdkSessionId = await this.deps.getSdkSessionId(sessionId).catch(() => undefined);
    const transcriptParentUuid = this.deps.getLastAssistantTranscriptUuid?.(sessionId);
    if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
    try {
      await createDbMessage(sessionId, {
        clientId: item.clientId,
        role: 'user',
        content: item.persistedContent,
        agentMeta: {
          uuid: active.messageUuid,
          sdkSessionId,
          delivery: active.delivery,
          ...(transcriptParentUuid ? { transcriptParentUuid } : {}),
        } as never,
      }, {
        shouldBroadcast: () => this.isTurnGenerationCurrent(sessionId, active),
      });
      if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
      active.persisted = true;
      active.persisting = false;
      // 同 drain onPersisted:steer 消息落库后立即收窄快照,避免长 turn 内崩溃二次恢复。
      this.maybePersistQueueSnapshot(sessionId);
      this.settlePendingTerminalEventAfterPersist(sessionId, active);
    } catch (err) {
      if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
      const state = this.getState(sessionId);
      state.error = `Failed to persist user message: ${errorMessage(err)}`;
      state.stickyError = state.error;
      state.recovery = null;
      active.persisting = false;
      const terminalEvent = active.pendingTerminalEvent;
      const releasedTerminalBoundary = Boolean(terminalEvent && this.isActiveTurnCurrent(sessionId, active));
      if (releasedTerminalBoundary) {
        active.pendingTerminalEvent = null;
        state.activeTurn = null;
      }
      this.emit(sessionId);
      if (releasedTerminalBoundary) this.scheduleDrain(sessionId, 'failed-persist-after-deferred-terminal');
      log.error('persist accepted user message failed', {
        sessionId,
        clientId: item.clientId,
        delivery: active.delivery,
        error: errorMessage(err),
      });
      return 'failed';
    }
    return 'persisted';
  }

  private settlePendingTerminalEventAfterPersist(sessionId: string, active: ActiveTurn): void {
    const terminalEvent = active.pendingTerminalEvent;
    if (!terminalEvent || !this.isActiveTurnCurrent(sessionId, active)) return;
    active.pendingTerminalEvent = null;
    const state = this.getState(sessionId);
    state.activeTurn = null;
    state.stickyError = null;
    if (terminalEvent.type === 'error') {
      state.error = terminalEvent.message ?? state.error;
      state.recovery = active.item ? { kind: 'active-turn', item: active.item } : null;
      this.emit(sessionId);
      return;
    }
    state.error = null;
    state.recovery = null;
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'persisted-after-deferred-done');
  }
}

function toggleList(list: string[], value: string, enabled: boolean): string[] {
  if (!value) return list;
  const has = list.includes(value);
  if (enabled) return has ? list : [...list, value];
  return has ? list.filter((item) => item !== value) : list;
}
