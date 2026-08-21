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

import { isUnsupportedResponsesImageErrorPayload } from '@cindy/responses-chat-bridge';
import { isPiImageInputUnsupportedError } from '../../shared/inputError.js';
import { createLogger } from '../logger.js';
import { createMessage as createDbMessage } from '../localDb/ipc/messages.js';
import { touchUserSendInDb } from '../localDb/ipc/sessions.js';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';
import type { SuppressedTurnErrorOwner } from './autoResumeBookkeeping.js';
import type {
  DesktopSessionDispatchFailure,
  HostSendFailureCode,
  HostSendOutcome,
} from '../maker-host/send-outcome.js';
import type {
  AgentInputCreateOpts,
  AgentInputDelivery,
  AgentInputMakerMessage,
  AgentInputProjection,
  AgentInputQueuedMessage,
  AgentInputRecovery,
  AgentInputSessionReferenceContext,
  AutoResumeInfo,
  RecoveryCheckpoint,
} from '../../shared/agentInputQueue.js';
import {
  buildMakerUserMessage,
  getAgentInputAttachmentBlockType,
  getAgentFacingText,
  normalizeAgentInputClearBoundaryMs,
  projectionRetryText,
  sanitizeQueuedMessageForPersistence,
  updateQueuedMessageContent,
  updateQueuedMessageText,
} from '../../shared/agentInputQueue.js';
import { CONTINUE_AFTER_ERROR_PROMPT, syntheticTriggerKind } from '../../shared/interruptedTurn.js';
import { attachSessionReferenceMetadata } from '../../shared/sessionReferenceMetadata.js';
import {
  appendRecoveryCheckpointPrompt,
  buildRecoveryCheckpoint,
  RECOVERY_CHECKPOINT_MARKER,
  type RecoveryContextSnapshot,
} from './recoveryCoordinator.js';
import {
  projectSessionQueueForInspection,
  type SessionQueueInspectionEntry,
} from './sessionQueueInspection.js';

const log = createLogger('maker-input-coordinator');
const SESSION_RUNNING_RETRY_DELAY_MS = 250;
/**
 * Codex 的 reconnect-stalled 清理要等两次 turn/interrupt ACK，每次最多 10s。
 * 自动续跑仍只允许 3 次 SESSION_RUNNING 派发尝试，但退避必须覆盖这段有界
 * cleanup 窗口；终态事件先到时 scheduleDrain 仍会立即放行，不会强制等满该间隔。
 */
const AUTO_RESUME_SESSION_RUNNING_RETRY_DELAY_MS = 10_000;
/** 同一自动续跑项撞上 host busy 时的有界派发次数，防止定时器无穷重入。 */
const MAX_AUTO_RESUME_DISPATCH_ATTEMPTS = 3;
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

type QueuedAttachment = NonNullable<AgentInputQueuedMessage['files']>[number];

function isMakerImageAttachment(file: Pick<QueuedAttachment, 'category' | 'ext'>): boolean {
  return getAgentInputAttachmentBlockType(file.category, file.ext) === 'image';
}

function attachmentSourceKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string') return `url:${record.url}`;
  if (typeof record.base64 === 'string') return `base64:${record.base64}`;
  return null;
}

function stripQueuedMessageImages(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  const remainingFiles = item.files?.filter((file) => !isMakerImageAttachment(file));
  const remainingImageSources = new Set(
    (remainingFiles ?? [])
      .filter((file) => file.category === 'image')
      .map(attachmentSourceKey)
      .filter((source): source is string => source !== null),
  );
  const chatMessage = { ...item.chatMessage };
  const remainingChatImages = chatMessage.images?.filter((image) => {
    const source = attachmentSourceKey(image);
    return source !== null && remainingImageSources.has(source);
  });
  if (remainingChatImages && remainingChatImages.length > 0) {
    chatMessage.images = remainingChatImages;
  } else {
    delete chatMessage.images;
  }

  // Renderer queue objects historically carry retryFiles as an extra presentation field even
  // though it is not part of the main-process wire contract. Strip only attachments that become
  // maker image blocks: GIF keeps category=image for preview, but is sent as a file block.
  const compatibleChatMessage = chatMessage as typeof chatMessage & {
    retryFiles?: QueuedAttachment[];
  };
  if (Array.isArray(compatibleChatMessage.retryFiles)) {
    const retryFiles = compatibleChatMessage.retryFiles.filter(
      (file) => !isMakerImageAttachment(file),
    );
    if (retryFiles.length > 0) compatibleChatMessage.retryFiles = retryFiles;
    else delete compatibleChatMessage.retryFiles;
  }

  let persistedContent = item.persistedContent;
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const remainingPersistedImages = Array.isArray(record.images)
        ? record.images.filter((image) => {
            const source = attachmentSourceKey(image);
            return source !== null && remainingImageSources.has(source);
          })
        : [];
      persistedContent = JSON.stringify({
        ...record,
        images: remainingPersistedImages,
      });
    }
  } catch {
    // Historical plain-text queue payloads contain no persisted image references.
  }

  const stripped: AgentInputQueuedMessage = {
    ...item,
    persistedContent,
    chatMessage,
  };
  if (remainingFiles && remainingFiles.length > 0) stripped.files = remainingFiles;
  else delete stripped.files;
  return stripped;
}

function hasRetryableQueuedContent(item: AgentInputQueuedMessage): boolean {
  return (
    getAgentFacingText(item).trim().length > 0 ||
    (item.files?.length ?? 0) > 0 ||
    (item.mentions?.length ?? 0) > 0 ||
    (item.sessionRefs?.length ?? 0) > 0
  );
}

export interface AgentInputSendOpts {
  messageUuid?: string;
  userName?: string;
  throwOnStartFailure?: boolean;
  signal?: AbortSignal;
  /** 自动续跑的 runtime turn 归属；只进入 AgentEvent，不写入用户可见文本。 */
  turnAttemptToken?: number;
  /**
   * scheduler 排队消息的来源标记(与 maker-core SendOrigin 的 scheduler 变体同构)。
   * drain 派发时从队列项透传:send 事务把它打到 session.send 的 origin(本轮
   * AgentEvent.turnOrigin,IM 转播识别自动 turn)并写进落库 user 消息的
   * agentMeta.origin(renderer 渲染"自动化任务"标签)。仅 scheduler 队列项携带;
   * 其它路径(用户输入 / orca)不设,行为不变。
   */
  origin?: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  /**
   * 队列项上盖的手机来源(见 AgentInputQueuedMessage.fromMobileClient)。
   * drain / steer 都在原 invoke 的 async context 之外派发,只能靠这条透传把来源带到
   * 最终 wire 消息。**由 main 构造,不是 wire 输入。**
   */
  fromMobileClient?: boolean;
  /** Main-owned clear token captured when this input became active. */
  expectedClearBoundaryMs?: number | null;
  /** Main-owned input generation captured before async preparation. */
  expectedInputGeneration?: number;
  /** Main-owned Session identity for a control-plane same-turn steer. */
  expectedTurnSession?: object;
  /** Main-owned maker-core turn generation for a control-plane same-turn steer. */
  expectedTurnGeneration?: number;
  persistUserMessage?: {
    clientId: string;
    content: string;
    sdkSessionId?: string;
    delivery: AgentInputDelivery;
    expectedClearBoundaryMs?: number | null;
    expectedInputGeneration?: number;
    /**
     * 本条是自动补发的续跑指令(见 AgentInputQueuedMessage.autoResume)。host 把它合进
     * 落库 agentMeta.autoResume:renderer 据此隐藏气泡,充值判据据此排除自动消息。
     */
    autoResume?: boolean;
    autoResumeInfo?: AutoResumeInfo;
    recoveryCheckpoint?: RecoveryCheckpoint;
    /**
     * 仅写入 user 行的 agentMeta,不传给 maker-core。Orca 等自动队列来源没有
     * 对应的 SendOrigin 变体,但仍不能被 host 当成真人输入来给 episode 充值。
     */
    origin?: AgentInputQueuedMessage['origin'];
    shouldBroadcast?: () => boolean;
    onPersisting?: () => void;
    onPersisted?: () => void | Promise<void>;
    onPersistFailed?: () => void;
  };
}

/**
 * 自动续跑的结果三态。`superseded` 与 `no-progress` 都表示"没补发"，但对用户的含义
 * 相反：前者是他自己接手了（别打扰），后者是一次没人接手的真失败（必须把横幅还给他）。
 */
export type AutoRetryOutcome = 'resumed' | 'superseded' | 'no-progress';

export type AgentInputHostSendFailureCode = HostSendFailureCode;

export type AgentInputSendResult =
  | HostSendOutcome
  | { kind: 'session-dispatch'; source: string; dispatched: true }
  | {
      kind: 'session-dispatch';
      source: string;
      dispatched: false;
      reason: DesktopSessionDispatchFailure['reason'];
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
  /** Live Session only — must not OR the desktop tracker. undefined = probe unavailable. */
  isLiveTurnRunning?: (sessionId: string) => boolean | undefined;
  /** maker-core turn 代号；steer 跨 await 后据此验证仍属于开始时的同一 vendor turn。 */
  getTurnGeneration?: (sessionId: string) => number | null;
  /** maker-core Session object identity; control-plane steer uses it to reject session reuse. */
  getTurnSessionIdentity?: (sessionId: string) => object | null;
  /**
   * Reconcile the host's live session/tracker view after an abort, a
   * maker-core NO_ACTIVE_TURN, or a drain blocked on a stale tracker while the
   * live Session is idle. The event-driven tracker can stay stale when a
   * turn dies without a terminal event, leaving the queue behind a false busy
   * boundary. Returns true only when it actually cleared that stale boundary;
   * a normal status=closed cleanup returning false must not make Codex release
   * its abort lock before the in-flight send outcome settles.
   */
  reconcileTurnIdle?: (sessionId: string) => boolean;
  hasPendingInteraction: (sessionId: string) => boolean;
  getAgentKind: (sessionId: string) => AgentInputCreateOpts['agentKind'] | null;
  getSdkSessionId: (sessionId: string) => Promise<string | undefined>;
  /** Read a bounded, durable progress snapshot before a retry is re-enqueued. */
  getRecoveryContextSnapshot?: (
    sessionId: string,
    userClientId: string,
  ) => Promise<RecoveryContextSnapshot>;
  /**
   * Durable user-row writer shared with direct maker sends.  The fallback keeps
   * the coordinator usable in narrow unit harnesses, while the registered host
   * injects its FIFO writer so steer and drain persistence share one ordering.
   */
  createUserMessage?: typeof createDbMessage;
  /** Hide a user row that was written after `/clear` won the persistence race. */
  rewindPersistedUserMessageAfterClear?: (sessionId: string, clientId: string) => Promise<void>;
  /**
   * interrupted-turn-resume:判断某条已派发 user 消息之后 agent 是否已产出内容
   * (assistant / tool_use / thinking 持久化行)。retryLastError 用它决定语义:
   *  - 有产出 → 失败的 turn 已推进过任务,重发原文会让模型"从头再来",改发
   *    调用方传入的规范化续跑指令(continueText);
   *  - 零产出 → 模型从未收到有效输入,重发原文才是正确语义(维持既有行为)。
   * 判定走 DB(代码确定性,规则 9);未注入时一律按零产出处理(向后兼容)。
   */
  hasAssistantProgressAfter?: (sessionId: string, userClientId: string) => Promise<boolean>;
  /**
   * retry-supersede:零产出重试的克隆行(supersedesUserClientId 非空)落库且 vendor
   * 派发成功后,把被取代的旧 user 行与其后的 role='error' 行软删(置 rewind_at +
   * 广播),让历史里只留重发的那一条。在派发已不可逆的边界 await 调用(与
   * onDispatchedUserTurn 同侧):派发前取消时旧 error 行还是用户唯一的重试入口,
   * 不能先藏。失败只吞错落日志,退回"显示两条"的旧观感;未注入 = 保持旧行为。
   */
  supersedeRetriedUserTurn?: (
    sessionId: string,
    args: { supersededUserClientId: string; retryUserClientId: string },
  ) => Promise<unknown>;
  getLastAssistantTranscriptUuid?: (sessionId: string) => string | undefined;
  /**
   * 一个**留下了 active-turn recovery 入口**的 terminal error 刚落地。host 据此决定
   * 要不要接管自愈、自动替用户点一次「继续」(判据与额度见
   * maker-ipc/interruptedTurnAutoResume.ts)。
   *
   * **同步返回 true = 已接管**：coordinator 于是不设 `state.error`(不弹红横幅)，改置
   * `autoResumePending` 让 renderer 在聊天流里显示低调的自愈提示；host 负责在退避后调
   * `autoRetryLastError`，并在放弃时调 `abandonAutoResume` 把错误回落出来。返回 false
   * 则完全走原有的错误呈现。
   *
   * 刻意只在 recovery 真的留下来时回调:没有 recovery 就没有可续跑的目标,
   * `retryLastError` 会 no-op。Schedule 输入同样走本入口；item 让 host 只做
   * run 结果桥接，重试状态仍由本 coordinator 独占。
   */
  onResumableTurnError?: (
    sessionId: string,
    signals: InterruptedTurnErrorSignals,
    item: AgentInputQueuedMessage,
  ) => AutoResumeInfo | null;
  /**
   * **纯判定**：这条 terminal error 有没有可能被自愈接管（`isInterruptedTurnError`）。
   * 不消耗额度、不排期、无副作用。
   *
   * 用途只有一个：terminal error 早于用户气泡持久化完成到达时，接管决策必须等到
   * `settlePendingTerminalEventAfterPersist` 才能做（那时才知道 recovery 留不留得住），
   * 但**红横幅与 error 行落库都发生在决策之前**。用这个判定把那两件事先按住，
   * 决策落定后再放行（见 `isAutoResumeDeferred`）。
   */
  isResumableTurnErrorCandidate?: (signals: InterruptedTurnErrorSignals) => boolean;
  /**
   * 一条被 `isAutoResumeDeferred` 按住的 error 最终**没能走到决策**（用户气泡持久化失败等），
   * host 必须把压住的 error 行补落，否则那次中断在历史里彻底消失（不变量 I2）。
   */
  onResumableTurnErrorDiscarded?: (
    sessionId: string,
    options: { surfaceError: boolean; owner: SuppressedTurnErrorOwner },
  ) => void;
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
    item: AgentInputQueuedMessage,
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
  beforeDispatchUserTurn?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ) => void | Promise<void>;
  /**
   * Called when a user row crossed the persistence boundary but never reached
   * vendor dispatch. `cancelled` is an explicit user lifecycle boundary;
   * `failed` means the attempted delivery itself failed and remains visible.
   */
  onUndispatchedUserTurn?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    disposition: 'cancelled' | 'failed',
  ) => void;
  /** Called immediately before the durable user-row write begins. */
  onUserMessagePersisting?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /** Called after the durable user row exists; ownership of staged attachments may be released. */
  onUserMessagePersisted?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /** Called only after the durable row also survives the current clear/rewind generation. */
  onUserMessageQueryable?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /**
   * Called when the user-row write failed. A queued turn remains retryable;
   * an accepted steer does not, because replay could duplicate model input.
   */
  onUserMessagePersistenceFailed?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts: { retainForRetry: boolean },
  ) => void;
  /**
   * The delivery pipeline rejected this item for a technical/policy reason
   * before vendor dispatch. Unlike Stop/remove/clear, this is a real failed
   * attempt rather than explicit user cancellation.
   */
  /** Technical or policy rejection before vendor dispatch. */
  onRejectedUserTurn?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  onAcceptedQueuedMessage?: (
    sessionId: string,
    item: AgentInputQueuedMessage,
  ) => void | Promise<void>;
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
   * 这个会话的失败 turn 正在重试；`source` 区分人工操作与自动续跑。
   *
   * hook-control 用它把那一轮的结果接回渠道里那条已经收口的消息(turn.reopen)。
   * 之所以要 coordinator 显式回调、而不是在发送路径上按文本认续跑指令:
   * retryLastError 只在失败 turn **已有产出**时才改发 CONTINUE_AFTER_ERROR_PROMPT,
   * 零产出(派发即失败 / 首个 API 调用就挂, 也就是上游过载最典型的形态)走的是
   * 克隆重发原文 —— 那条消息文本上与普通用户消息毫无区别, 从文本无法认出重试意图。
   * 只靠文本嗅探会让最需要回流的那类失败恰好没有信号。
   */
  onUiRetry?: (
    sessionId: string,
    clientId: string,
    source: 'manual' | 'auto',
    attemptToken?: number,
  ) => void;
  /**
   * 用户/上游用一条**新**消息接管了这个会话(enqueue 或 steer 回落为普通 turn)。
   *
   * hook-control 用它作废该会话的待续跑记账: 会话已经被别的内容推进, 再把结果接回
   * 渠道那条旧消息只会显示无关输出。判据刻意用**入口**而不是消息文本 ——
   * retryLastError 的零产出分支重发的是原文, 文本上与新消息无从区分, 而它走的是
   * pendingQueue.unshift、不经这两个用户输入入口, 于是不会自我作废。
   */
  onUserEnqueue?: (sessionId: string) => void;
  /**
   * 真人消息刚进队、尚未 drain / sendToAgent。灵动岛用它在 agent 进程拉起前
   * 就进入 running 并播开始音效,避免「任务开始」跟着 isRunning 一起晚响。
   */
  previewQueuedUserTurn?: (sessionId: string, item: AgentInputQueuedMessage) => void;
  /** 自动输入推进了会话，但不构成真人介入，也不能重置自动恢复预算。 */
  onAutomaticEnqueue?: (sessionId: string) => void;
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
   * loadClearBoundary:ensureQueueRestored 恢复快照前先水合 durable /clear 边界；
   * loadQueueSnapshot:随后读回快照。生产侧三者一起注入，任一读取失败都保持未恢复态。
   */
  persistQueueSnapshot?: (
    sessionId: string,
    items: AgentInputQueuedMessage[],
  ) => void | Promise<void>;
  loadClearBoundary?: (sessionId: string) => Promise<unknown>;
  loadQueueSnapshot?: (sessionId: string) => Promise<AgentInputQueuedMessage[]>;
  getPersistedClientIds?: (sessionId: string, clientIds: string[]) => Promise<Set<string>>;
}

interface ActiveTurn {
  item: AgentInputQueuedMessage | null;
  delivery: AgentInputDelivery;
  messageUuid: string;
  createdAt: string;
  generation: number;
  clearBoundaryMs: number | null;
  persisted: boolean;
  persisting: boolean;
  sendStarted: boolean;
  dispatchLifecycle: ActiveTurnDispatchLifecycle;
  pendingTerminalEvent: ActiveTurnTerminalEvent | null;
  /** 当前 vendor turn 由哪条 Continue 合成项发起；同轮 steer 会继承它。 */
  continuationOwnerClientId: string | null;
  controlKind?: 'compact';
}

interface PendingCompactRequest {
  createOpts: AgentInputCreateOpts;
  userName?: string;
  waitForClientIds: string[];
}

type ActiveTurnDispatchLifecycle =
  'preparing' | 'awaiting-dispatch-hooks' | 'sending' | 'dispatched';

type ActiveTurnTerminalEvent =
  | { type: 'done' }
  // signals 必须跟着一起暂存:这条 error 落库完成后才在
  // settlePendingTerminalEventAfterPersist 里结算,那时原始事件已经不在手上,
  // 少存就会让"error 早于持久化完成"的时序拿不到判据、自动续跑静默失效。
  | {
      type: 'error';
      message?: string;
      signals?: Omit<InterruptedTurnErrorSignals, 'message'>;
      /**
       * 纯判定认为它有可能被自愈接管（`isResumableTurnErrorCandidate`）。为 true 时红横幅
       * 与 error 行落库都先按住，等 `settlePendingTerminalEventAfterPersist` 做出真正决策。
       */
      resumableCandidate?: boolean;
      /**
       * 决策还没做出时用户已经自己接手（发了新消息 / 插话）→ 结算时不再接管，回落成常规
       * 错误呈现。缺了它，用户接手之后延后结算还会再接管一次，把一条隐藏续跑指令插到他
       * 那条消息前面（greptile P1）。
       */
      supersededByUser?: boolean;
    };

type AgentInputSendFailure = Extract<
  AgentInputSendResult,
  { accepted: false } | { dispatched: false }
>;

interface SessionInputState {
  pendingQueue: AgentInputQueuedMessage[];
  pendingCompacts: PendingCompactRequest[];
  steeringQueueClientIds: string[];
  /** Identity of the currently owned steer transaction for each visible clientId. */
  steeringRequestTokens: Map<string, symbol>;
  /** Direct composer steers have no pendingQueue row while delivery is still reversible. */
  directSteeringItems: AgentInputQueuedMessage[];
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
  /**
   * 中断自愈接管中（退避窗口内）时的展示信息；`null` = 未接管。
   *
   * 非 null 时 `error` 必为 null：自愈过程只在聊天流里显示低调的活动行，不弹红横幅
   * （见 `AgentInputProjection.autoResumePending`）。由 host 在终态 error 那一刻同步决定，
   * 补发成功、用户接手（`enqueue` / `clearError`）或放弃时清除 —— 因此它也是"这次自愈
   * 是否仍然有效"的唯一判据（`performRetryLastError` 的 auto 路径据此收手）。
   */
  autoResumePending: AutoResumeInfo | null;
  /** 最新自动接管 attempt；展示态落库后仍保留到 vendor accepted 或明确失败。 */
  autoResumeAttemptToken: number | null;
  recovery: AgentInputRecovery;
  drainScheduled: boolean;
  drainWakeupGeneration: number;
  /** Codex emits terminal error followed by done; queued work must not drain between the pair. */
  pendingExternalTerminalDone: boolean;
  pendingExternalTerminalDoneTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Identity of the current user-stop abort boundary. An old abort promise may
   * settle after clearSession/new turn; its cleanup must not release the newer
   * turn's boundary or clear its activeTurn.
   */
  abortBoundaryToken: symbol | null;
  /**
   * Session.abort() may settle before maker-core publishes the idle state. Keep
   * rechecking the same abort boundary until the live turn is idle or a newer
   * state invalidates it.
   */
  abortReconcileRetryTimer: ReturnType<typeof setTimeout> | null;
  sessionRunningRetryTimer: ReturnType<typeof setTimeout> | null;
  sessionRunningRetryGeneration: number | null;
  /** 当前 retry timer 绑定的队首/compact owner；队首变化时必须替换 timer policy。 */
  sessionRunningRetryOwnerKey: string | null;
  sessionRunningRetryDelayMs: number | null;
  /** 保护新 generation 的 timer 不被旧 generation 的迟到 callback 清掉。 */
  sessionRunningRetryToken: symbol | null;
  /**
   * First time we saw live-idle + tracker-busy while queued work was blocked.
   * Terminal events may still be in Session's AsyncQueue after the handle
   * flips idle; reconcile only after SESSION_RUNNING_RETRY_DELAY_MS.
   */
  staleLiveIdleSinceMs: number | null;
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
  /** Latest authoritative `/clear` token for device-link optimistic input preconditions. */
  clearBoundaryMs: number | null;
}

interface PendingAutoResumeRecovery {
  sessionId: string;
  stateRef: SessionInputState;
  recovery: Extract<AgentInputRecovery, { kind: 'active-turn' }>;
  error: string | null;
  stickyError: string | null;
  autoResumeInfo: AutoResumeInfo | null;
  attemptToken: number;
}

function createInitialInputState(
  generation = 0,
  clearBoundaryMs: number | null = null,
): SessionInputState {
  return {
    pendingQueue: [],
    pendingCompacts: [],
    steeringQueueClientIds: [],
    steeringRequestTokens: new Map(),
    directSteeringItems: [],
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
    autoResumePending: null,
    autoResumeAttemptToken: null,
    recovery: null,
    drainScheduled: false,
    drainWakeupGeneration: 0,
    pendingExternalTerminalDone: false,
    pendingExternalTerminalDoneTimer: null,
    abortBoundaryToken: null,
    abortReconcileRetryTimer: null,
    sessionRunningRetryTimer: null,
    sessionRunningRetryGeneration: null,
    sessionRunningRetryOwnerKey: null,
    sessionRunningRetryDelayMs: null,
    sessionRunningRetryToken: null,
    staleLiveIdleSinceMs: null,
    credentialSwitchWait: null,
    credentialSwitchRetryTimer: null,
    credentialSwitchRetryGeneration: null,
    recentEnqueuedClientIds: [],
    generation,
    clearBoundaryMs,
  };
}
/**
 * 首次进入 main 队列边界时冻结原始合成指令意图。IPC payload 属不可信输入，
 * 因此即使 renderer 带了同名字段也必须从当下原始 text 重新计算。
 */
function captureOriginalSyntheticTrigger(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  return {
    ...item,
    originalSyntheticTrigger: syntheticTriggerKind(item.text) ?? undefined,
  };
}

/**
 * Stamp the acceptance boundary with the controlled host's clock.  Remote
 * renderer timestamps are presentation data and may come from a device with a
 * different wall clock; they must never decide whether a crash-restored item
 * predates a host-side /clear.
 */
function stampHostAcceptedAt(
  item: AgentInputQueuedMessage,
  clearBoundaryMs: number | null,
): AgentInputQueuedMessage {
  // The restore fence is inclusive (`<=`).  If a clear and acceptance share a
  // millisecond, the acceptance must still belong to the new epoch; otherwise
  // a crash in that millisecond would silently drop the user's message.
  const minimumPostClearAt = clearBoundaryMs === null ? 0 : clearBoundaryMs + 1;
  return { ...item, hostAcceptedAtMs: Math.max(Date.now(), minimumPostClearAt) };
}

/**
 * 老崩溃快照没有 originalSyntheticTrigger；从仍保留的原始 text 补齐。新版
 * 快照则保留首次入队时冻结的值，因为正文可能已经被 Ghost rewrite。
 */
function normalizeRestoredSyntheticTrigger(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  if (item.originalSyntheticTrigger === 'continue' || item.originalSyntheticTrigger === 'generic') {
    return item;
  }
  return captureOriginalSyntheticTrigger(item);
}

type PersistAcceptedUserMessageResult = 'persisted' | 'stale' | 'failed';

function isNoActiveTurnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\[NO_ACTIVE_TURN\]|no active .*turn|has no active turn/i.test(msg);
}

function isStaleTurnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\[STALE_TURN\]/i.test(msg);
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
  return (
    typeof message === 'string' &&
    (message.startsWith('SESSION_RUNNING:') || message.startsWith('[SESSION_RUNNING]'))
  );
}

function isSessionRunningSendFailure(result: AgentInputSendFailure): boolean {
  return result.kind === 'host-send' && result.code === 'SESSION_RUNNING';
}

function isCredentialSwitchBusySendFailure(
  result: AgentInputSendFailure,
): result is Extract<AgentInputSendResult, { kind: 'host-send' }> {
  return result.kind === 'host-send' && result.code === 'CREDENTIAL_SWITCH_BUSY';
}

/**
 * 用户自己接手了（发新消息 / 插话）→ 把还没做出接管决策的那条中断标成作废。
 *
 * 只对「决策推迟」那条时序有意义（已决策的接管由 `state.autoResumePending = null` 撤销）。
 * 非候选或没有暂存事件时是 no-op。
 */
function markPendingTerminalSupersededByUser(active: ActiveTurn | null): void {
  const pending = active?.pendingTerminalEvent;
  if (pending?.type !== 'error' || pending.resumableCandidate !== true) return;
  pending.supersededByUser = true;
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

/**
 * 这条消息是自动任务(scheduler)投进来的吗。
 *
 * Scheduler prompt 属于某一轮 run。它可以复用自动续跑，但不能被当作真人介入或
 * UI Continue；确定性错误也不能留下脱离 FireContext 的人工 Retry。
 *
 * 判据抽成函数是因为它必须覆盖**所有**终态路径:派发失败、turn 终态 error、
 * 派发前会话关闭。前两轮只改了派发失败那一条,漏掉的两条照样造出重试入口
 * (review #944 第十八轮 P1)。
 */
function isSchedulerOriginItem(item: AgentInputQueuedMessage | null | undefined): boolean {
  return item?.origin?.kind === 'scheduler';
}

/** Orca and scheduler inputs are automation, not a fresh human intervention. */
function isAutomaticOriginItem(item: AgentInputQueuedMessage | null | undefined): boolean {
  const kind = item?.origin?.kind;
  return kind === 'scheduler' || kind === 'orca';
}

function isUiContinuationItem(item: AgentInputQueuedMessage): boolean {
  return !isSchedulerOriginItem(item) && item.originalSyntheticTrigger === 'continue';
}

function isActiveTurnBeforeVendorDispatch(active: ActiveTurn): boolean {
  return (
    !isActiveTurnDispatched(active) &&
    (!active.sendStarted ||
      active.persisting ||
      active.dispatchLifecycle === 'awaiting-dispatch-hooks')
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
   * Stop clears visible steer markers before the provider promise necessarily settles. Retain
   * the latest request identity until every older request with the same clientId has settled so
   * a cancelled request cannot regain ownership after a replacement request has already won.
   */
  private readonly steerRequestLineages = new Map<
    string,
    Map<string, { latestToken: symbol; unsettledTokens: Set<symbol> }>
  >();
  /**
   * One clear/stop-scoped cancellation boundary per session generation.  The
   * vendor adapters can spend time converting attachments after the final
   * synchronous fence; aborting this signal keeps that late work from reaching
   * the provider after the input epoch has been superseded.
   */
  private readonly inputBoundaryAbortControllers = new Map<
    string,
    { generation: number; controller: AbortController }
  >();
  /**
   * 队列快照恢复簿记(issue #761)。故意放在 SessionInputState **外面**:
   * clearSession 会整体重建 state,若 restored 标记跟着 state 走,清空后的
   * emit 会因"未恢复"跳过持久化,旧快照删不掉,下次打开会话又诈尸。
   */
  private readonly restoredQueueSessions = new Set<string>();
  private readonly restoreAttempted = new Set<string>();
  private readonly queueRestorePromises = new Map<string, Promise<void>>();
  private readonly lastQueueSnapshotJson = new Map<string, string>();
  /**
   * 自动重试项在真正 vendor dispatch 前仍可被 Stop / 新消息 / ghost block 丢弃。
   * 这段窗口里 `performRetryLastError` 已清掉原 recovery，按 clone clientId 暂存回滚信息，
   * 并用 stateRef 防止 clearSession 后迟到的旧结果复活新上下文。
   */
  private readonly pendingAutoResumeRecoveries = new Map<string, PendingAutoResumeRecovery>();
  /** transient busy 期间同一 auto item 已尝试过的派发次数。 */
  private readonly autoResumeDispatchAttempts = new Map<string, number>();

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
      if (state.directSteeringItems.length > 0) {
        texts.push(JSON.stringify(state.directSteeringItems));
      }
      if (state.recovery) texts.push(JSON.stringify(state.recovery));
    }
    return texts;
  }

  getProjection(sessionId: string): AgentInputProjection {
    return this.toProjection(sessionId, this.getState(sessionId));
  }

  /**
   * Main-only control snapshot. Queue mutation services need the authoritative
   * item rather than the renderer/device-link projection: projected rows omit
   * host receipts and trusted reference context that edits must either retain
   * or deliberately invalidate while rebuilding the message.
   */
  getQueueControlSnapshot(
    sessionId: string,
  ): Pick<AgentInputProjection, 'pendingQueue' | 'steeringQueueClientIds'> {
    const state = this.getState(sessionId);
    return {
      pendingQueue: [...state.pendingQueue],
      steeringQueueClientIds: [...state.steeringQueueClientIds],
    };
  }

  /** Main-only inspection view for cindy_helper; never crosses renderer/device-link IPC. */
  getQueueInspection(sessionId: string): SessionQueueInspectionEntry[] {
    const state = this.getState(sessionId);
    return this.projectQueueInspection(state);
  }

  /** Cold sessions return null for SQLite counting; live-but-unrestored sessions stay unknown. */
  getQueueInspectionIfRestored(
    sessionId: string,
  ): SessionQueueInspectionEntry[] | null | undefined {
    if (!this.isQueueRestored(sessionId)) {
      // A cold session can be counted directly from SQLite. Once live state exists, however,
      // combining it with an unread snapshot without clientIds could double-count or omit rows.
      if (this.states.has(sessionId)) {
        return undefined;
      }
      return null;
    }
    const state = this.states.get(sessionId);
    return state ? this.projectQueueInspection(state) : [];
  }

  /**
   * Capture/check the session input generation around IPC-side async
   * preparation.  clearSession replaces the state and increments this value;
   * a handler that started before that boundary must return the current
   * projection instead of committing stale input into the new queue.
   */
  getGeneration(sessionId: string): number {
    return this.getState(sessionId).generation;
  }

  /** Main-only signal for a content-bearing input transaction. */
  getInputAbortSignal(sessionId: string, generation = this.getGeneration(sessionId)): AbortSignal {
    if (!this.isGenerationCurrent(sessionId, generation)) {
      const stale = new AbortController();
      stale.abort();
      return stale.signal;
    }
    const current = this.inputBoundaryAbortControllers.get(sessionId);
    if (current && current.generation === generation && !current.controller.signal.aborted) {
      return current.controller.signal;
    }
    const controller = new AbortController();
    this.inputBoundaryAbortControllers.set(sessionId, { generation, controller });
    return controller.signal;
  }

  private abortInputBoundary(sessionId: string): void {
    const current = this.inputBoundaryAbortControllers.get(sessionId);
    if (!current) return;
    current.controller.abort();
    this.inputBoundaryAbortControllers.delete(sessionId);
  }

  isGenerationCurrent(sessionId: string, generation: number): boolean {
    return this.getState(sessionId).generation === generation;
  }

  getClearBoundaryMs(sessionId: string): number | null {
    return this.getState(sessionId).clearBoundaryMs;
  }

  /**
   * Rehydrate the authoritative clear token after a host restart.  The
   * coordinator state is intentionally in-memory, while `sessions.cleared_at`
   * survives restart; remote preconditions must compare against the latter
   * before accepting the first post-restart input.
   */
  observeClearBoundary(sessionId: string, clearedAt: unknown): void {
    const boundary = normalizeAgentInputClearBoundaryMs(clearedAt);
    if (typeof boundary !== 'number') return;
    const state = this.getState(sessionId);
    if (state.clearBoundaryMs === null || boundary > state.clearBoundaryMs) {
      state.clearBoundaryMs = boundary;
    }
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
    if (this.deps.loadClearBoundary) {
      try {
        const clearedAt = await this.deps.loadClearBoundary(sessionId);
        this.observeClearBoundary(sessionId, clearedAt);
      } catch (err) {
        log.warn('load queue clear boundary failed; will retry on next entry', {
          sessionId,
          error: errorMessage(err),
        });
        throw err;
      }
    }
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
        const currentState = this.getState(sessionId);
        if (currentState !== preState || currentState.generation !== preGeneration) {
          // Clear/stop may win while the durable de-duplication query is in
          // flight. Do not merge the stale snapshot into the new generation;
          // close the restore window and let the current in-memory state own
          // the next persisted snapshot.
          this.restoredQueueSessions.add(sessionId);
          this.queueRestorePromises.delete(sessionId);
          for (const item of items) {
            this.deps.onDiscardedQueuedMessage?.(sessionId, item);
          }
          this.maybePersistQueueSnapshot(sessionId);
          return;
        }
        for (const cid of persisted) existingIds.add(cid);
      } catch (err) {
        log.warn('getPersistedClientIds failed during restore; will retry on next entry', {
          sessionId,
          error: errorMessage(err),
        });
        throw err;
      }
    }
    // A clear boundary survives process restart while the queue snapshot is
    // only an optimization. Compare it with the host-owned acceptance receipt;
    // chatMessage.createdAt belongs to the controller and can be skewed by
    // hours across devices. An old/invalid receipt is fail-closed once a
    // boundary is known so it cannot resurrect pre-clear content after a
    // weak-network restart.
    const clearBoundaryMs = state.clearBoundaryMs;
    const staleClearItems: AgentInputQueuedMessage[] = [];
    const boundaryFilteredItems = items.filter((item) => {
      if (clearBoundaryMs === null) return true;
      const acceptedAtMs = item.hostAcceptedAtMs;
      if (
        typeof acceptedAtMs !== 'number' ||
        !Number.isFinite(acceptedAtMs) ||
        acceptedAtMs <= clearBoundaryMs
      ) {
        staleClearItems.push(item);
        return false;
      }
      return true;
    });
    if (staleClearItems.length > 0) {
      for (const item of staleClearItems) {
        this.deps.onDiscardedQueuedMessage?.(sessionId, item);
      }
      log.info('dropped pre-clear queue item(s) from crash snapshot', {
        sessionId,
        boundaryMs: clearBoundaryMs,
        dropped: staleClearItems.length,
      });
    }
    // 标记恢复完成:所有 async 工作已结束,此后 getDrainableHead 放行、
    // maybePersistQueueSnapshot 开闸。
    this.restoredQueueSessions.add(sessionId);
    // 用读回内容预热变更检测缓存:没有丢弃/去重项时(最常见:空快照 + 空队列)
    // 收口点直接跳过,避免每次打开会话都发一次冗余覆盖写/删除。只要有丢弃项就
    // 留空，让 maybePersistQueueSnapshot 把清理后的快照写回盘面。
    if (staleClearItems.length === 0) {
      this.lastQueueSnapshotJson.set(sessionId, JSON.stringify(items));
    } else {
      this.lastQueueSnapshotJson.delete(sessionId);
    }
    // scheduler 撞忙排队项不跨重启恢复(persist 侧已不再写入,这里兜老快照):
    // 静默会话的恢复队列处于 queuePausedByRestore 暂停态,自动化项等不来"用户
    // 显式输入"的放行,会永远滞留;同任务去重又会把它当在途,后续每轮 fire 都
    // 判 duplicate 顺延 —— 无人值守自动化整体停摆(PR #972 review P1)。直接
    // 丢弃并走 onDiscarded 释放回调注册表;下一轮 cron fire 按当下状态重新走
    // 排队/直发,不丢任务只丢陈旧副本。
    const restorable = boundaryFilteredItems.filter((item) => !existingIds.has(item.clientId));
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

  /** Includes the recent idempotency window used by remote weak-link retries. */
  hasKnownClientId(sessionId: string, clientId: string): boolean {
    if (!clientId) return false;
    const state = this.getState(sessionId);
    return (
      state.pendingQueue.some((item) => item.clientId === clientId) ||
      state.activeTurn?.item?.clientId === clientId ||
      state.steeringQueueClientIds.includes(clientId) ||
      state.recentEnqueuedClientIds.includes(clientId) ||
      (state.recovery?.kind === 'active-turn' && state.recovery.item.clientId === clientId)
    );
  }

  hasPendingQueueItem(sessionId: string, clientId: string): boolean {
    return this.getState(sessionId).pendingQueue.some((item) => item.clientId === clientId);
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
      state.pendingQueue.some((q) => q.clientId === clientId) ||
      state.activeTurn?.item?.clientId === clientId ||
      state.steeringQueueClientIds.includes(clientId) ||
      state.recentEnqueuedClientIds.includes(clientId)
    );
  }

  private rememberEnqueuedClientId(state: SessionInputState, clientId: string): void {
    if (!clientId) return;
    // Treat the bounded list as an MRU window. A queued item may be accepted
    // later as a same-turn steer; refreshing it here keeps the post-acceptance
    // weak-link retry window intact without growing a second dedupe mechanism.
    state.recentEnqueuedClientIds = state.recentEnqueuedClientIds.filter(
      (knownClientId) => knownClientId !== clientId,
    );
    state.recentEnqueuedClientIds.push(clientId);
    if (
      state.recentEnqueuedClientIds.length > AgentInputCoordinator.RECENT_ENQUEUED_CLIENT_IDS_LIMIT
    ) {
      state.recentEnqueuedClientIds.shift();
    }
  }

  enqueue(
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts?: {
      wasFirst?: boolean;
      sendAtMs?: number;
      resumeRestorePausedQueue?: boolean;
      onDuplicate?: () => void;
    },
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
      opts?.onDuplicate?.();
      return this.getProjection(sessionId);
    }
    item = stampHostAcceptedAt(item, state.clearBoundaryMs);
    this.rememberEnqueuedClientId(state, item.clientId);
    // 真的有一条**新**消息进队了 = 这个会话被别的内容推进(见 deps.onUserEnqueue)。
    // 必须放在幂等去重**之后**: 被去重丢弃的重传(弱网 / 移动端补发)压根没推进任何
    // 东西, 若在它上面作废记账, 一条延迟到达的旧重传就会把之后才装上的、更新的那笔
    // 待续跑记账删掉, 于是下一次显式重试跑成了却不回流。
    //
    // 续跑指令走的是另一条语义: 中断横幅「继续任务」由 renderer 直发
    // CONTINUE_AFTER_APP_EXIT_PROMPT 并经本入口入队。它不是"无关的新消息"(那会作废
    // 渠道回流的记账), 而**就是**一次续跑意图 —— 所以在这里发续跑信号并带上 clientId,
    // 让消费方按 clientId 做权威归属(见 deps.onUiRetry 的说明)。
    // (错误横幅那条走 retryLastError, 压根不经本入口。)
    const schedulerOrigin = isSchedulerOriginItem(item);
    const automaticOrigin = isAutomaticOriginItem(item);
    if (!schedulerOrigin) {
      // 自动续跑可能已经从 pendingQueue 进入 activeTurn、但仍卡在持久化或其它
      // pre-vendor await。用户此时接管不能只作废 host waiter：那会让隐藏 Continue
      // 继续派发、而新输入排在它后面。复用 Stop 的 generation 取消边界，先确认
      // 旧续跑已被 coordinator 丢弃，再发布用户接管信号。
      this.cancelPreparedAutoResume(sessionId, state);
    }
    if (isUiContinuationItem(item)) {
      // queue-head recovery 时**跳过** onUiRetry:那条消息在派发前就失败了,
      // 从未成为一个 turn,与之前失败的 hook turn 无关(与 retryLastError 对
      // queue-head 刻意不发 onUiRetry 的语义一致,见 performRetryLastError 注释)。
      // 下方 queue-head 特判分支会清 recovery 重发队首 A,合成 continue 项不入队;
      // 若在这里发 onUiRetry(无论用哪个 clientId)会让无关的排队桌面消息认领
      // 并改写旧 hook/channel 的待续跑记账。
      if (state.recovery?.kind !== 'queue-head') {
        this.deps.onUiRetry?.(sessionId, item.clientId, 'manual');
      }
    } else if (automaticOrigin && !schedulerOrigin) {
      this.deps.onAutomaticEnqueue?.(sessionId);
    } else if (!automaticOrigin) {
      this.deps.onUserEnqueue?.(sessionId);
    }
    if (!schedulerOrigin) {
      // 有用户动作入队(用户自己接手,或自愈的续跑指令本身)→ 撤掉「重新连接中」提示。
      // Scheduler 只是同一串行队列里的自动输入，不代表用户接手，不能取消正在退避的
      // 自动续跑；它会保持 FIFO，等当前恢复生命周期收口后再派发。
      state.autoResumePending = null;
      state.autoResumeAttemptToken = null;
      markPendingTerminalSupersededByUser(state.activeTurn);
    }
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
    if (!schedulerOrigin) {
      this.abandonActiveTurnRecoveryForUserAction(state);
      this.clearErrorUnlessQueueHeadBlocked(state);
    }
    // —— queue-head recovery 解锁(2026-08 事故复盘)——
    // queue-head recovery 表示队首消息从未跨过 accepted 边界(派发前失败 /
    // cancelled-before-dispatch)。getDrainableHead 见 recovery 即返回 null,
    // 队列永久静止,后续所有消息(含用户新输入)全部排队不派发。
    // 用户显式动作按 2026-07-13 口径表态(与 active-turn 对齐:「新消息 = 不重试旧消息」):
    //  - 普通新消息(composer 直发,非 scheduler/orca/自愈续跑):放弃从未 accepted
    //    的队首消息 A(摘除 + 清理回调),让 B 正常派发——无静默重发、无静默丢失;
    //  - UI 续跑(「继续」按钮,sendUiTrigger):等价 retryLastError——清 recovery
    //    重发队首 A(原样重发是既有 retryLastError 对 queue-head 的语义),合成
    //    continue 项不入队,避免 A 与 continue 双发。
    // 自动来源(scheduler / orca)不代表用户表态,维持「不清」语义。暂停队列的
    // Continue 则由 resume 原子清除与当前队首匹配的 recovery 后重发原消息。
    if (state.recovery?.kind === 'queue-head' && !automaticOrigin) {
      const abandonedClientId = state.recovery.clientId;
      if (isUiContinuationItem(item)) {
        state.error = null;
        state.stickyError = null;
        state.recovery = null;
        log.info('ui continue resets queue-head recovery; resending failed head', {
          sessionId,
          clientId: abandonedClientId,
        });
        // 手动「继续」是真人介入,与 retryLastError 同口径刷新 userSendAt(否则
        // 会话活跃信号 / 列表排序不会反映这次人工动作)。
        this.touchUserSend(sessionId, opts?.sendAtMs);
        this.emit(sessionId);
        this.scheduleDrain(sessionId, 'ui-continue-queue-head-unlock');
        return this.getProjection(sessionId);
      }
      const abandoned = state.pendingQueue.find((q) => q.clientId === abandonedClientId);
      if (abandoned) {
        state.pendingQueue = state.pendingQueue.filter((q) => q.clientId !== abandonedClientId);
        this.removePendingCompactWaitClientId(state, abandonedClientId);
        // 与 remove() 同口径:摘除消息时同步清其 edit lock,否则留下指向不存在
        // clientId 的孤儿锁,shouldQueueNewTurn 会把后续新输入误导向排队。
        state.queueEditLocks = state.queueEditLocks.filter((id) => id !== abandonedClientId);
        this.deps.onDiscardedQueuedMessage?.(sessionId, abandoned);
        // 脱敏:只记 id/布尔,不记消息文本(白名单方向,见 log-upload-and-redaction)。
        log.info('explicit user input abandoned queue-head message (never accepted)', {
          sessionId,
          clientId: abandonedClientId,
        });
      }
      state.error = null;
      state.stickyError = null;
      state.recovery = null;
    }
    // 用户点「继续任务」表达的是恢复刚才中断/失败的 turn，必须先于此前
    // 已排队的新任务执行；普通 composer / Orca / scheduler 输入仍保持 FIFO。
    // 复用 prepend helper 同时把本项加入 pending compact 的等待集合，避免
    // 已排队的 /compact 抢在续跑前执行，破坏原任务现场。
    if (isUiContinuationItem(item)) {
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
    if (!automaticOrigin) {
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
      // 只预览马上要派发的队首。排队项若也预览,删除较早项会把整份岛快照滚回去,
      // 抹掉后来的预览和期间事件。合成 Continue 同样不预览内部 prompt。
      if (!automaticOrigin && !isUiContinuationItem(item)) {
        this.deps.previewQueuedUserTurn?.(sessionId, item);
      }
      void this.drain(sessionId, 'enqueue-immediate');
    } else {
      this.emit(sessionId);
      this.scheduleDrain(sessionId, 'enqueue');
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'enqueue');
    }
    return this.getProjection(sessionId);
  }

  async compact(
    sessionId: string,
    createOpts: AgentInputCreateOpts,
    opts?: { userName?: string },
  ): Promise<AgentInputProjection> {
    const state = this.getState(sessionId);
    // 手动 /compact 是用户接管，与 composer 新消息同语义。先撤掉尚未跨过
    // vendor dispatch 的隐藏 scheduler 续跑，再让 host 终止对应 run waiter；
    // 否则 compact 自己的 text/done 可能被旧 schedule run 误收。
    this.cancelPreparedAutoResume(sessionId, state);
    this.deps.onUserEnqueue?.(sessionId);
    // 手动压缩与发送新消息一样,都是用户对失败 turn 的明确后续选择:
    // 放弃 active-turn retry,让 /compact 在真实 dispatch boundary 空闲时立即执行,
    // 仍忙时则进入 pendingCompacts。queue-head recovery 表示消息从未受理且仍在
    // 队首,不能越过它静默改变顺序,继续保留原阻塞语义。
    this.abandonActiveTurnRecoveryForUserAction(state);
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
    this.invalidateAbortBoundaryForNewTurn(state);
    const active: ActiveTurn = {
      item: null,
      delivery: 'turn',
      messageUuid: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      generation: state.generation,
      clearBoundaryMs: state.clearBoundaryMs,
      persisted: false,
      persisting: false,
      sendStarted: false,
      dispatchLifecycle: 'preparing',
      pendingTerminalEvent: null,
      continuationOwnerClientId: null,
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
          expectedClearBoundaryMs: active.clearBoundaryMs,
          expectedInputGeneration: active.generation,
        },
      );
      if (!this.isActiveTurnCurrent(sessionId, active)) return this.getProjection(sessionId);
      if (!isSendDispatched(result)) {
        if (isSessionRunningSendFailure(result)) {
          return this.deferCompactAfterSessionRunning(
            sessionId,
            active,
            request,
            reason,
            sendFailureMessage(result),
          );
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
        return this.deferCompactAfterSessionRunning(
          sessionId,
          active,
          request,
          reason,
          errorMessage(err),
        );
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

  async steer(
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts?: {
      removeFromQueue?: boolean;
      touchUserSend?: boolean;
      /** 控制面插话不允许在 turn 结束竞态下退化成下一轮普通输入。 */
      fallbackToTurn?: boolean;
      /** 控制面初检捕获的 live Session 对象，防 session id 被新实例复用。 */
      expectedTurnSession?: object;
      /** 控制面初检捕获的 maker-core turn generation。 */
      expectedTurnGeneration?: number;
    },
  ): Promise<boolean> {
    const matchesExpectedTurn = () =>
      (opts?.expectedTurnSession === undefined ||
        this.deps.getTurnSessionIdentity?.(sessionId) === opts.expectedTurnSession) &&
      (opts?.expectedTurnGeneration === undefined ||
        this.deps.getTurnGeneration?.(sessionId) === opts.expectedTurnGeneration);
    if (!matchesExpectedTurn()) return false;
    const state = this.getState(sessionId);
    // Capture the clear boundary before any screening/reference/steer await.  The
    // live state may advance when `/clear` wins the race; this turn must retain
    // the token from the moment it entered the steer transaction.
    const steerClearBoundaryMs = state.clearBoundaryMs;
    let itemAlreadyOwnedByHost = false;
    let steersStoredQueueItem = false;
    if (opts?.removeFromQueue) {
      const storedItem = state.pendingQueue.find((queued) => queued.clientId === item.clientId);
      if (storedItem) {
        steersStoredQueueItem = true;
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
        itemAlreadyOwnedByHost =
          typeof item.hostAcceptedAtMs === 'number' && Number.isFinite(item.hostAcceptedAtMs);
      }
    }
    if (state.steeringQueueClientIds.includes(item.clientId)) {
      log.info('steer ignored: duplicate in-flight clientId (control-side resend)', {
        sessionId,
        clientId: item.clientId,
      });
      return true;
    }
    if (!steersStoredQueueItem && this.isDuplicateEnqueueClientId(state, item.clientId)) {
      log.info('steer ignored: duplicate clientId (control-side resend)', {
        sessionId,
        clientId: item.clientId,
      });
      return true;
    }
    // A row already owned by the host keeps its original receipt.  A direct
    // composer steer has no host-owned row yet, so stamp it before any async
    // screening/dispatch work begins.
    if (!itemAlreadyOwnedByHost) item = stampHostAcceptedAt(item, steerClearBoundaryMs);
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

    if (!isSchedulerOriginItem(item)) {
      this.cancelPreparedAutoResume(sessionId, state);
    }

    if (!this.isTurnSteerable(sessionId, state)) {
      if (opts?.fallbackToTurn === false) return false;
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
    const steerRequestToken = this.beginSteerRequest(sessionId, item.clientId);
    const finishSteerRequest = (result: boolean): boolean => {
      this.settleSteerRequest(sessionId, item.clientId, steerRequestToken);
      return result;
    };
    // steer ack 期间原 turn 可能先收到 terminal 事件并清掉 activeTurn。owner 是本次
    // 注入开始时就已确定的 vendor-turn 身份，必须在 await 前快照，不能等 ack 后再从
    // 可能已经清空的 activeTurn 读取。
    const steerContinuationOwnerClientId = state.activeTurn?.continuationOwnerClientId ?? null;
    const steerVendorTurnGeneration = this.deps.getTurnGeneration?.(sessionId) ?? null;
    this.clearErrorUnlessQueueHeadBlocked(state, item.clientId);
    state.queuePaused = false;
    if (!state.steeringQueueClientIds.includes(item.clientId)) {
      state.steeringQueueClientIds.push(item.clientId);
    }
    state.steeringRequestTokens.set(item.clientId, steerRequestToken);
    if (!steersStoredQueueItem) {
      state.directSteeringItems = [
        ...state.directSteeringItems.filter((entry) => entry.clientId !== item.clientId),
        item,
      ];
    }
    const steerAbort = new AbortController();
    const inputBoundarySignal = this.getInputAbortSignal(sessionId, steerGeneration);
    this.registerSteerAbortController(sessionId, item.clientId, steerAbort);
    this.emit(sessionId);

    // 意识拦截钩(订阅槽①):同轮注入与普通派发同权——drain() 在派发前筛,
    // steer 直达 steerToAgent 不经 drain,这里必须补同一道筛查,否则被拦 /
    // 待改写的消息可经 ⌘+Enter 或队列行 ⬆️ 原样注入并落库(review #939 第四轮)。
    // marker 已置位,筛查期间并发 steer / drain 被挡;stop / clearSession 竞态
    // 由筛查后的 marker 复查兜底。
    if (!item.bypassGhostHooks && this.deps.screenUserMessage) {
      const verdict = await this.deps.screenUserMessage(
        sessionId,
        getAgentFacingText(item),
        item,
      );
      const cur = this.getState(sessionId);
      const ownsCurrentRequest = this.isCurrentSteerRequest(
        cur,
        item.clientId,
        steerGeneration,
        steerRequestToken,
      );
      if (
        !ownsCurrentRequest ||
        !matchesExpectedTurn()
      ) {
        // stop/close/clearSession 赢在筛查期间:steer 事务已被取消,静默放弃。
        if (
          ownsCurrentRequest &&
          this.clearSteeringMarker(cur, item.clientId, {
            generation: steerGeneration,
            token: steerRequestToken,
          })
        ) {
          this.clearDirectSteeringItem(cur, item.clientId);
          this.emit(sessionId);
        }
        this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
        return finishSteerRequest(false);
      }
      if (verdict.action === 'block') {
        // 拦截即终态:不注入、不落库,气泡由 onUserMessageBlocked 广播降级;
        // 返回 true(已处置),renderer 不再回滚重试。
        this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
        this.clearSteeringMarker(cur, item.clientId, {
          generation: steerGeneration,
          token: steerRequestToken,
        });
        if (opts?.removeFromQueue) {
          cur.pendingQueue = cur.pendingQueue.filter((q) => q.clientId !== item.clientId);
          this.removePendingCompactWaitClientId(cur, item.clientId);
          cur.queueEditLocks = cur.queueEditLocks.filter((id) => id !== item.clientId);
          if (cur.pendingQueue.length === 0) cur.queuePaused = false;
        }
        this.deps.onUserMessageBlocked?.(sessionId, item, verdict);
        this.notifyRejectedUserTurn(sessionId, item);
        this.deps.onDiscardedQueuedMessage?.(sessionId, item);
        this.emit(sessionId);
        this.scheduleDrain(sessionId, 'steer-ghost-blocked');
        // 普通 UI steer 的 true 表示“已处置”，避免 renderer 把被策略拦截的内容
        // 重新入队；控制面要求严格的 same-turn 投递结果，不能把 blocked 报成成功。
        return finishSteerRequest(opts?.fallbackToTurn === false ? false : true);
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
      if (!matchesExpectedTurn()) {
        const latest = this.getState(sessionId);
        if (
          this.clearSteeringMarker(latest, item.clientId, {
            generation: steerGeneration,
            token: steerRequestToken,
          })
        ) {
          this.clearDirectSteeringItem(latest, item.clientId);
          this.emit(sessionId);
        }
        this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
        return finishSteerRequest(false);
      }
      item.persistedContent = attachSessionReferenceMetadata(
        item.persistedContent,
        referenceContexts,
      );
      await this.deps.steerToAgent(sessionId, buildMakerUserMessage(item, referenceContexts), {
        messageUuid,
        userName: item.userName,
        signal: AbortSignal.any([inputBoundarySignal, steerAbort.signal]),
        expectedClearBoundaryMs: steerClearBoundaryMs,
        expectedInputGeneration: steerGeneration,
        ...(opts?.expectedTurnSession !== undefined
          ? { expectedTurnSession: opts.expectedTurnSession }
          : {}),
        ...(opts?.expectedTurnGeneration !== undefined
          ? { expectedTurnGeneration: opts.expectedTurnGeneration }
          : {}),
        // 同 drain:steer 投递也在入队时的 async context 之外。
        ...(item.fromMobileClient ? { fromMobileClient: true } : {}),
      });
    } catch (err) {
      const latest = this.getState(sessionId);
      if (latest.generation !== steerGeneration) {
        // clearSession owns the replacement state. The old callback may only release its own
        // controller; it must not alter the replacement generation or Stop boundary.
        this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
        log.info('ignoring stale steer completion after input generation changed', {
          sessionId,
          clientId: item.clientId,
          steerGeneration,
          currentGeneration: latest.generation,
        });
        return finishSteerRequest(false);
      }
      const markerStillPresent = this.clearSteeringMarker(latest, item.clientId, {
        generation: steerGeneration,
        token: steerRequestToken,
      });
      this.clearSteerAbortController(sessionId, item.clientId, steerAbort);

      if (isStaleTurnError(err)) {
        if (markerStillPresent) {
          this.clearDirectSteeringItem(latest, item.clientId);
          this.emit(sessionId);
        }
        return finishSteerRequest(false);
      }

      if (isNoActiveTurnError(err)) {
        if (!markerStillPresent) {
          // Stop/close owns the abort boundary after clearing this marker. Its token-guarded
          // reconciliation path is the only code allowed to release that lock.
          log.info('steer no-active-turn after marker cancelled (stop/close raced)', {
            sessionId,
            clientId: item.clientId,
          });
          this.emit(sessionId);
          return finishSteerRequest(false);
        }
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
        log.info('steer fallback to normal turn dispatch (no active turn)', {
          sessionId,
          clientId: item.clientId,
        });
        if (opts?.fallbackToTurn === false) {
          this.clearDirectSteeringItem(latest, item.clientId);
          this.emit(sessionId);
          return finishSteerRequest(false);
        }
        this.emit(sessionId);
        this.fallbackPreparedAsTurn(sessionId, item, opts?.removeFromQueue === true);
        if (opts?.touchUserSend) this.touchUserSend(sessionId);
        return finishSteerRequest(true);
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
        // 视觉 capability 拒绝发生在 Pi RPC 之前，投递结果确定为“未接收”。把原消息
        // 恢复到队首并留下 typed recovery；用户切换到视觉模型后可原样重试。与 ack
        // 超时不同，这里不暂停队列，因为不存在重复投递风险。marker 已被 Stop/clear
        // 清掉时不会进本分支，因此不会把显式丢弃的消息复活。
        if (isPiImageInputUnsupportedError(err)) {
          this.movePreparedItemToQueueFront(latest, item, true);
          this.movePendingCompactWaitClientIdToFront(latest, item.clientId);
          latest.recovery = { kind: 'queue-head', clientId: item.clientId };
          latest.queuePaused = false;
          latest.queuePausedByRestore = false;
        }
        // 投递结果不确定(ack 超时 / post-send abort,见 isSteerDeliveryUncertainError):
        // 把该消息物化到队首(composer 入口的插话不在队列里,不物化则"结果不确定"
        // 没有落点——用户按草稿重发同一段文字时模型可能双份消费,review #939 第三轮)
        // 并暂停队列,不让 turn 结束后的自动 drain 把它再派发一遍。用户确认模型
        // 已回应就删行,没回应就点「继续发送」。队列行入口 prepend 幂等,无副作用。
        else if (isSteerDeliveryUncertainError(err)) {
          this.prependQueueHeadIfMissing(latest, item);
          latest.queuePaused = true;
          // 不确定投递的保护性暂停必须由用户显式处置,不许新输入静默放行。
          latest.queuePausedByRestore = false;
        }
      } else if (
        isSteerDeliveryUncertainError(err) &&
        latest.generation === steerGeneration &&
        (steerVendorTurnGeneration === null ||
          this.deps.getTurnGeneration?.(sessionId) === steerVendorTurnGeneration) &&
        this.isLatestSteerRequest(sessionId, item.clientId, steerRequestToken)
      ) {
        // Stop/close 赢在 ack 返回前(marker 已被 stop 清):RPC 已发出,结果同样
        // 不确定,消息必须有落点(尤其 composer 入口无队列行的场景,review #939
        // 第四轮)。只有本请求仍是该 clientId 的最新身份时才物化；同 generation
        // 内的后续请求一旦取代它，迟到结果不得复活旧消息或暂停新队列。
        // generation 守卫:clearSession 是用户显式重置,不把消息塞回已清空的会话。
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
      return finishSteerRequest(false);
    }
    const accepted = this.getState(sessionId);
    const ownsCurrentSteerMarker = this.isCurrentSteerRequest(
      accepted,
      item.clientId,
      steerGeneration,
      steerRequestToken,
    );
    if (!ownsCurrentSteerMarker) {
      this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
      if (
        accepted.generation !== steerGeneration ||
        accepted.clearBoundaryMs !== steerClearBoundaryMs
      ) {
        // Provider acceptance is still irreversible, so report success instead of inviting a
        // duplicate retry. A concurrent clear owns the replacement generation and intentionally
        // prevents the accepted row from being reintroduced into cleared history.
        log.info('steer accepted after session clear; preserving cleared replacement state', {
          sessionId,
          clientId: item.clientId,
          steerGeneration,
          currentGeneration: accepted.generation,
        });
        return finishSteerRequest(true);
      }

      // Stop/close clears the visible marker and direct item before the provider promise must
      // settle. A resolved provider call has crossed the irreversible boundary nonetheless:
      // persist it and remember the clientId without rebuilding activeTurn or releasing the
      // Stop/close boundary that now owns the session lifecycle.
      this.clearDirectSteeringItem(accepted, item.clientId);
      this.rememberEnqueuedClientId(accepted, item.clientId);
      if (opts?.removeFromQueue) {
        accepted.pendingQueue = accepted.pendingQueue.filter(
          (queued) => queued.clientId !== item.clientId,
        );
        this.removePendingCompactWaitClientId(accepted, item.clientId);
        accepted.queueEditLocks = accepted.queueEditLocks.filter((id) => id !== item.clientId);
        if (accepted.pendingQueue.length === 0) accepted.queuePaused = false;
      }
      const detachedAcceptedTurn: ActiveTurn = {
        item,
        delivery: 'steer',
        messageUuid,
        createdAt,
        generation: steerGeneration,
        clearBoundaryMs: steerClearBoundaryMs,
        persisted: false,
        persisting: true,
        sendStarted: true,
        dispatchLifecycle: 'dispatched',
        pendingTerminalEvent: null,
        continuationOwnerClientId: null,
      };
      const persisted = await this.persistAcceptedUserMessage(sessionId, detachedAcceptedTurn);
      if (opts?.touchUserSend && persisted === 'persisted') this.touchUserSend(sessionId);
      log.info('steer accepted after marker cancellation; persisted without reopening boundary', {
        sessionId,
        clientId: item.clientId,
        persisted,
      });
      this.emit(sessionId);
      return finishSteerRequest(true);
    }
    this.clearDirectSteeringItem(accepted, item.clientId);
    this.clearSteerAbortController(sessionId, item.clientId, steerAbort);
    // steerToAgent has crossed the irreversible delivery boundary. Keep the
    // clientId known even if the subsequent user-row persistence or terminal
    // event fails, otherwise an ACK-loss retry can inject the same text twice.
    this.rememberEnqueuedClientId(accepted, item.clientId);
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
    this.invalidateAbortBoundaryForNewTurn(accepted);
    const sameVendorTurn =
      steerVendorTurnGeneration !== null &&
      this.deps.getTurnGeneration?.(sessionId) === steerVendorTurnGeneration;
    accepted.activeTurn = {
      item,
      delivery: 'steer',
      messageUuid,
      createdAt,
      generation: steerGeneration,
      clearBoundaryMs: steerClearBoundaryMs,
      persisted: false,
      persisting: true,
      sendStarted: true,
      dispatchLifecycle: 'dispatched',
      pendingTerminalEvent: null,
      continuationOwnerClientId: isUiContinuationItem(item)
        ? item.clientId
        : sameVendorTurn
          ? steerContinuationOwnerClientId
          : null,
    };
    this.emit(sessionId);

    const persisted = await this.persistAcceptedUserMessage(sessionId, accepted.activeTurn);
    const settled = this.getState(sessionId);
    let releasedSteerMarker = false;
    if (
      this.isCurrentSteerRequest(
        settled,
        item.clientId,
        steerGeneration,
        steerRequestToken,
      )
    ) {
      releasedSteerMarker = this.clearSteeringMarker(settled, item.clientId, {
        generation: steerGeneration,
        token: steerRequestToken,
      });
      if (releasedSteerMarker) {
        this.emit(sessionId);
      }
    }
    if (persisted !== 'persisted') {
      if (releasedSteerMarker) this.scheduleDrain(sessionId, 'steer-persistence-settled');
      // Provider 已确认接收后就是不可逆投递边界。落库失败仍保留上面的 sticky
      // error，但不能向调用方报告“未投递”诱导它用新 clientId 重发，造成模型
      // 在同一 turn 内消费两份。accepted clientId 已在 rememberEnqueuedClientId
      // 登记，原 id 的幂等重试也会直接收口。
      return finishSteerRequest(true);
    }
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
    // steer accepted/removed may change the queue head while an older
    // SESSION_RUNNING timer is still armed. Rebind its policy now even though
    // the accepted steer itself keeps the dispatch boundary busy.
    if (accepted.pendingQueue.length > 0 || accepted.pendingCompacts.length > 0) {
      this.scheduleSessionRunningRetry(sessionId, 'steer-accepted');
    } else {
      this.clearSessionRunningRetry(accepted);
    }
    this.scheduleDrain(sessionId, 'steer-accepted');
    return finishSteerRequest(true);
  }

  stop(
    sessionId: string,
    opts?: { keepQueue?: boolean; pauseQueue?: boolean },
  ): AgentInputProjection {
    const state = this.getState(sessionId);
    const preserveQueue = opts?.keepQueue === true;
    this.supersedePendingAutoResumeRecoveries(sessionId);
    this.cancelPreparedAutoResume(sessionId, state);
    this.abortInputBoundary(sessionId);
    this.abortSteerTransactions(sessionId);
    this.clearAbortReconcileRetry(state);
    // Stop 是用户显式收手:凭证切换等待随之取消(保留队列时队首仍在,恢复后会重新进入等待)。
    this.clearCredentialSwitchWait(state);
    if (!preserveQueue) {
      this.clearSessionRunningRetry(state);
      const droppedQueue = state.pendingQueue;
      state.pendingQueue = [];
      for (const item of droppedQueue) {
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
      const droppedIds = new Set(droppedQueue.map((q) => q.clientId));
      state.recentEnqueuedClientIds = state.recentEnqueuedClientIds.filter(
        (id) => !droppedIds.has(id),
      );
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
    // 用户显式 Stop 立即结束续跑行的 vendor-turn 归属。已跨过 vendor dispatch
    // 的 activeTurn 仍需保留到 abort/terminal 收口，以维持队列边界；这里只清 owner，
    // 让本次 stop projection 不再把「重新连接中」误判为仍在飞。
    if (state.activeTurn && state.activeTurn.continuationOwnerClientId !== null) {
      state.activeTurn.continuationOwnerClientId = null;
    }
    const shouldPause = Boolean(preserveQueue && opts?.pauseQueue && state.pendingQueue.length > 0);
    state.queuePaused = shouldPause;
    // Stop 出来的暂停是用户显式意图,不许后续新输入静默放行(区别于崩溃恢复暂停)。
    state.queuePausedByRestore = false;
    state.queueAbortPending = shouldPause && this.isDispatchBoundaryBusy(sessionId, state);
    const abortBoundaryToken = Symbol('agent-input-abort-boundary');
    const abortBoundaryGeneration = state.generation;
    state.abortBoundaryToken = abortBoundaryToken;
    this.clearAllSteeringMarkers(state);
    state.queueExpanded = false;
    this.emit(sessionId);

    this.deps
      .abortSession(sessionId)
      .catch((err) => {
        log.warn('abortSession failed', { sessionId, error: errorMessage(err) });
      })
      .finally(() => {
        const current = this.states.get(sessionId);
        if (
          current !== state ||
          current.generation !== abortBoundaryGeneration ||
          current.abortBoundaryToken !== abortBoundaryToken
        ) {
          // clearSession, a newer Stop, or a terminal event has superseded this
          // abort. Its late promise must not touch the current session state.
          log.info('ignoring stale abort completion', {
            sessionId,
            abortBoundaryGeneration,
            currentGeneration: current?.generation,
          });
          return;
        }
        // `Session.abort()` can settle before the vendor process has actually
        // published its idle state. Keep this boundary alive and recheck it
        // instead of relying on a terminal event that may be lost during an
        // owner switch.
        this.reconcileAbortBoundary(
          sessionId,
          state,
          abortBoundaryGeneration,
          abortBoundaryToken,
          'abort-promise',
        );
      });

    return this.getProjection(sessionId);
  }

  resume(sessionId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    const recovery = state.recovery;
    const pausedQueueHeadRecoveryClientId =
      state.queuePaused &&
      recovery?.kind === 'queue-head' &&
      state.pendingQueue[0]?.clientId === recovery.clientId
        ? recovery.clientId
        : null;
    state.queuePaused = false;
    state.queuePausedByRestore = false;
    if (pausedQueueHeadRecoveryClientId !== null) {
      state.error = null;
      state.stickyError = null;
      state.recovery = null;
      log.info('paused queue resume resets queue-head recovery', {
        sessionId,
        clientId: pausedQueueHeadRecoveryClientId,
      });
      this.touchUserSend(sessionId);
    } else {
      this.clearErrorUnlessQueueHeadBlocked(state);
    }
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'resume');
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'resume');
    return this.getProjection(sessionId);
  }

  /** 用户点「重试 / 继续任务」。行为见 performRetryLastError。 */
  async retryLastError(sessionId: string): Promise<AgentInputProjection> {
    const { projection } = await this.performRetryLastError(sessionId);
    return projection;
  }

  /**
   * main 守卫自动替用户点一次「继续」（turn 被上游打断；判据与额度见
   * maker-ipc/interruptedTurnAutoResume.ts）。
   *
   * @returns 三态，**调用方必须区分**（守卫在决策时已置 pendingResume，非 `resumed`
   * 一律要回滚 `noteResumeSendFailed`，否则该会话后续中断会一直被判成「上一次还在
   * 路上」）：
   *  - `resumed`：已补发续跑指令。
   *  - `superseded`：目标已消失（用户自己接手 / 清了会话）——他已经在处理，别再弹横幅。
   *  - `no-progress`：保留给无法构造安全重试项的异常路径（例如 image-only fallback）。
   */
  async autoRetryLastError(sessionId: string, attemptToken: number): Promise<AutoRetryOutcome> {
    const { outcome } = await this.performRetryLastError(sessionId, {
      auto: true,
      attemptToken,
    });
    return outcome;
  }

  /**
   * `opts.auto` = 由 main 守卫自动触发（turn 被上游打断），不是用户点的「继续」。
   * 三处差别，其余完全共用人工那条已验证过的路径：
   *  - 补发的续跑指令带 `autoResume`（隐藏气泡 / 「已自动继续」分隔线 / 不充值额度，
   *    见 AgentInputQueuedMessage.autoResume）。
   *  - 零产出时克隆重发用户原文，并带 `autoResume` 标记。它不会给额度守卫充值，
   *    连续失败次数仍由 host 的 `InterruptedTurnAutoResumeGuard` 负责上限；因此短暂的
   *    首次 admission / 网络失败可以自动穿过，而持续无产出时仍会在上限处停下。
   *  - 不 `touchUserSend`：那个时间戳的语义是「人最近发过消息」（会话列表 / 陈旧判定
   *    在读它），自动补发不该冒充人类动作。
   */
  private async performRetryLastError(
    sessionId: string,
    opts?: { auto?: boolean; attemptToken?: number },
  ): Promise<{ projection: AgentInputProjection; outcome: AutoRetryOutcome }> {
    const state = this.getState(sessionId);
    const recovery = state.recovery;
    if (!recovery) return { projection: this.getProjection(sessionId), outcome: 'superseded' };
    // auto 路径的第二道守卫:接管态必须**仍然**成立。
    //
    // 只看 recovery 不够 —— 用户在退避窗口里自己发了消息时 `enqueue` 清的是接管态,
    // 而 recovery 会一直留着(队列的 drain 恰恰被 recovery 自己挡住,见 getDrainableHead)。
    // 于是定时器到点仍能拿到 recovery,把一条隐藏的续跑指令插到用户那条消息**前面**,
    // 而「重新连接中」提示早就撤了,用户完全看不到这次代发(greptile P1)。
    // 接管态是唯一与用户所见一致的判据:它在 enqueue / clearError 时同步清除。
    if (
      opts?.auto &&
      (!state.autoResumePending || state.autoResumeAttemptToken !== opts.attemptToken)
    ) {
      return { projection: this.getProjection(sessionId), outcome: 'superseded' };
    }
    // active-turn recovery 的续跑判定:失败 turn 若已有 assistant 侧产出,重发
    // 原文等于让模型"从头再来"(原文可能是很久之前的初始任务指令),改发规范化
    // 续跑指令;零产出(派发即失败 / 首个 API 调用就挂)才维持克隆重发。
    // 续跑指令是共享英文常量(带 [UI_ACTION_TRIGGER] 前缀,renderer 渲染时过滤,
    // 用户只看到任务继续跑,不看到这条合成消息;2026-07-05 产品决策)。
    let continueItem: AgentInputQueuedMessage | null = null;
    let progressKnown = false;
    const previousAutoResumeInfo = opts?.auto ? state.autoResumePending : null;
    const attemptToken = opts?.auto ? (opts.attemptToken ?? null) : null;
    let continueText = CONTINUE_AFTER_ERROR_PROMPT;
    let recoveryCheckpoint: RecoveryCheckpoint | undefined;
    if (recovery.kind === 'active-turn' && this.deps.hasAssistantProgressAfter) {
      let hasProgress = false;
      try {
        hasProgress = await this.deps.hasAssistantProgressAfter(sessionId, recovery.item.clientId);
        progressKnown = true;
      } catch {
        // 自动路径无法确认进度时不重放原文；人工 Retry 保持既有兼容行为。
      }
      // await 期间 turn 事件可能已推进状态(clearError / 新 error / 并发 retry):
      // recovery 不再是同一对象时放弃本次意图,以当前 projection 为准。
      if (this.getState(sessionId).recovery !== recovery) {
        return { projection: this.getProjection(sessionId), outcome: 'superseded' };
      }
      // 接管态也要在 await **之后**再核一次。这个 await 里会读库(见 dep 实现),窗口足够
      // 长到用户在此期间关掉会话 / 自己发消息 —— 而 onSessionClosed 刻意保留 recovery
      // (它是手动重试入口),所以上面那道 recovery 检查放得过去,自动续跑会往一个已经
      // 关掉的会话补发消息、把它重新拉起来(codex P1)。teardown 会清接管态,这里据此收手。
      const latestAfterProgress = this.getState(sessionId);
      if (
        opts?.auto &&
        (!latestAfterProgress.autoResumePending ||
          latestAfterProgress.autoResumeAttemptToken !== attemptToken)
      ) {
        return { projection: this.getProjection(sessionId), outcome: 'superseded' };
      }
      if (hasProgress) {
        if (this.deps.getRecoveryContextSnapshot) {
          try {
            const snapshot = await this.deps.getRecoveryContextSnapshot(
              sessionId,
              recovery.item.clientId,
            );
            // Revalidate after the second await: the snapshot read may race
            // enqueue/clearError/session close that cancel the recovery intent.
            const stateAfterSnapshot = this.getState(sessionId);
            if (stateAfterSnapshot.recovery !== recovery) {
              return { projection: this.getProjection(sessionId), outcome: 'superseded' };
            }
            if (
              opts?.auto &&
              (!stateAfterSnapshot.autoResumePending ||
                stateAfterSnapshot.autoResumeAttemptToken !== attemptToken)
            ) {
              return { projection: this.getProjection(sessionId), outcome: 'superseded' };
            }
            recoveryCheckpoint = buildRecoveryCheckpoint(
              opts?.auto ? 'automatic' : 'manual',
              recovery.item.clientId,
              recovery.item.recoveryCheckpoint,
              snapshot,
              opts?.auto ? previousAutoResumeInfo?.attempt : undefined,
            );
            continueText = appendRecoveryCheckpointPrompt(continueText, recoveryCheckpoint);
          } catch (err) {
            // Recovery must remain available if the optional read races DB
            // shutdown. The generic continuation is the safe fallback.
            log.warn('recovery checkpoint read failed; using generic continuation', {
              sessionId,
              error: errorMessage(err),
            });
            // Revalidate after the failed await: user may have sent a new
            // message, cleared the error, or closed the session while the
            // snapshot read was failing.
            const stateAfterCatch = this.getState(sessionId);
            if (stateAfterCatch.recovery !== recovery) {
              return { projection: this.getProjection(sessionId), outcome: 'superseded' };
            }
            if (
              opts?.auto &&
              (!stateAfterCatch.autoResumePending ||
                stateAfterCatch.autoResumeAttemptToken !== attemptToken)
            ) {
              return { projection: this.getProjection(sessionId), outcome: 'superseded' };
            }
          }
        }
        const clientId = crypto.randomUUID();
        continueItem = {
          ...recovery.item,
          clientId,
          text: continueText,
          originalSyntheticTrigger: 'continue',
          persistedContent: continueText,
          autoResume: opts?.auto ? true : undefined,
          recoveryCheckpoint,
          // 人工 Retry 是新的真人介入周期，不能继承上一轮隐藏自动消息的标记；自动路径
          // 则把展示信息随消息落库，成为「已重新连接」活动行的 param 位与展开详情。
          autoResumeInfo: opts?.auto ? (previousAutoResumeInfo ?? undefined) : undefined,
          // 附件 / mention 属于原始消息,已在失败 turn 里送达过模型,续跑指令不重带。
          files: undefined,
          mentions: undefined,
          // retry-supersede 只属于零产出克隆重发。续跑分支的原消息是真实历史,
          // 不取代;展开继承的旧值若留着,落库后会把本轮"有产出失败"的 error 行
          // 一并误藏(窗口从更早的行一直铺到本条)。
          supersedesUserClientId: undefined,
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
    // queue-head recovery 表示消息从未跨过 accepted 边界，自动重发仍然可能重复一条
    // 尚未确认是否落库的输入；这条路径继续交给用户。active-turn recovery 则已经落库，
    // 零产出克隆重发是安全的，连续失败次数由 host 守卫负责止损。
    if (opts?.auto && (recovery.kind !== 'active-turn' || (!continueItem && !progressKnown))) {
      log.debug('auto retry skipped — progress state is not safe to resend', {
        sessionId,
        recoveryKind: recovery.kind,
        progressKnown,
      });
      return { projection: this.getProjection(sessionId), outcome: 'no-progress' };
    }
    const previousError = state.error;
    const previousStickyError = state.stickyError;
    let retryItem = recovery.kind === 'active-turn' ? recovery.item : null;
    if (
      !continueItem &&
      retryItem &&
      isUnsupportedResponsesImageErrorPayload(state.error ?? state.stickyError)
    ) {
      retryItem = stripQueuedMessageImages(retryItem);
      if (!hasRetryableQueuedContent(retryItem)) {
        // An image-only turn has no truthful fallback. Keep the error/recovery intact so a later
        // text message or model switch can take over instead of inventing replacement text.
        log.debug('image-only retry skipped for unsupported Chat bridge input', { sessionId });
        return { projection: this.getProjection(sessionId), outcome: 'no-progress' };
      }
    }
    state.error = null;
    state.stickyError = null;
    // 接管态在补发这一刻结束:聊天流里的「重新连接中」活动行交棒给落库的
    // autoResume 行(渲染成「已重新连接」活动行,详情同样可展开)。
    state.autoResumePending = null;
    if (!opts?.auto) state.autoResumeAttemptToken = null;
    state.recovery = null;
    if (recovery.kind === 'active-turn') {
      let item = continueItem;
      if (!item) {
        const clientId = crypto.randomUUID();
        item = {
          ...(retryItem ?? recovery.item),
          clientId,
          autoResume: opts?.auto ? true : undefined,
          autoResumeInfo: opts?.auto ? (previousAutoResumeInfo ?? undefined) : undefined,
          // 自动 clone 自身会被 renderer 隐藏，不能再软删原始可见 user 行；人工 Retry
          // 才用可见克隆取代旧行。显式覆盖也避免继承上一轮的隐藏标记。
          supersedesUserClientId: opts?.auto ? undefined : recovery.item.clientId,
          chatMessage: {
            ...(retryItem ?? recovery.item).chatMessage,
            clientId,
            createdAt: new Date().toISOString(),
          },
        };
      }
      if (opts?.auto && attemptToken !== null) {
        this.pendingAutoResumeRecoveries.set(item.clientId, {
          sessionId,
          stateRef: state,
          recovery,
          error: previousError,
          stickyError: previousStickyError,
          autoResumeInfo: previousAutoResumeInfo,
          attemptToken,
        });
      }
      state.pendingQueue.unshift(item);
      this.prependPendingCompactWaitClientId(state, item.clientId);
      // 「用户显式重试」信号 —— **只在 active-turn recovery 上发**。这一支重试的是
      // 那个真正跑起来又失败的 turn, 所以它可能正是渠道那条消息线的延续: 有产出走
      // 续跑指令、零产出走克隆重发, 但对回流而言意图相同。
      // queue-head recovery 刻意不发: 那条消息在**派发前**就失败了(它自己从未成为
      // 一个 turn), 与之前失败的 hook turn 无关。同一会话若还留着上一次渠道失败的
      // 待续跑记账, 在那上面发信号会让一条无关的排队桌面消息认领并改写那条旧消息。
      //
      // 带上这条重试消息的 clientId: 消费方(hook-control)用它做**权威归属** ——
      // 只有 clientId 对得上的那次 dispatch 才是目标续跑轮, 不再靠"首个事件"猜。
      this.deps.onUiRetry?.(
        sessionId,
        item.clientId,
        opts?.auto ? 'auto' : 'manual',
        attemptToken ?? undefined,
      );
    }
    if (!opts?.auto) this.touchUserSend(sessionId);
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'retry');
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'retry');
    return { projection: this.getProjection(sessionId), outcome: 'resumed' };
  }

  clearError(sessionId: string): AgentInputProjection {
    const state = this.getState(sessionId);
    if (state.autoResumePending) this.deps.onUserEnqueue?.(sessionId);
    this.cancelPreparedAutoResume(sessionId, state);
    const shouldDrainTail = state.recovery?.kind === 'active-turn';
    state.error = null;
    state.stickyError = null;
    // 用户显式收下了这条错误 → 自愈提示也该撤掉(退避到点后的复核会发现 recovery
    // 已清并回滚额度)。
    state.autoResumePending = null;
    state.autoResumeAttemptToken = null;
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
    state.pendingQueue = state.pendingQueue.filter((q) => q.clientId !== clientId);
    if (removed) this.deps.onDiscardedQueuedMessage?.(sessionId, removed);
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
      const refsForUpdate = requireTrustedSnapshot && sessionRefs === undefined ? [] : sessionRefs;
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
    return this.updateContentWithResult(sessionId, clientId, next).projection;
  }

  /**
   * Content replacement variant that exposes whether a pending row was
   * actually replaced.  The IPC attachment lifecycle needs this distinction:
   * an update can legitimately become a no-op when the row was dispatched,
   * removed, or rejected by a concurrent steer, and newly materialised local
   * media must then be cleaned instead of being treated as durable.
   */
  updateContentWithResult(
    sessionId: string,
    clientId: string,
    next: AgentInputQueuedMessage,
  ): { projection: AgentInputProjection; updated: boolean } {
    if (!next.text.trim() && !(next.files && next.files.length > 0)) {
      return { projection: this.getProjection(sessionId), updated: false };
    }
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) {
      return { projection: this.getProjection(sessionId), updated: false };
    }
    const index = state.pendingQueue.findIndex((entry) => entry.clientId === clientId);
    if (index < 0) return { projection: this.getProjection(sessionId), updated: false };
    const nextQueue = [...state.pendingQueue];
    nextQueue[index] = updateQueuedMessageContent(state.pendingQueue[index], next);
    state.pendingQueue = nextQueue;
    this.emit(sessionId);
    return { projection: this.getProjection(sessionId), updated: true };
  }

  /**
   * 整条排队消息原位替换(main 侧受信调用方专用；Orca lead 与会话控制面共用)。
   * 与 updateText / updateContent 的差别:替换体由调用方
   * 全量构造 —— orca 条目的 text / persistedContent / origin.displayText 之间存在
   * 派发格式耦合(formatAgentMessage / formatOrcaCommunicationMessage),必须由
   * dispatcher 侧按原格式重建,coordinator 不理解也不该理解该格式。
   * 守卫与既有编辑一致:steering 中的条目不可改;clientId 必须锚定原条目
   * (身份不变,防止入队去重窗口与崩溃快照错位)。返回是否完成替换 ——
   * false = 条目已不在 pendingQueue(已派发 / 已移除)、正在 steering 或身份不符。
   */
  replaceQueuedMessage(
    sessionId: string,
    clientId: string,
    next: AgentInputQueuedMessage,
  ): boolean {
    if (next.clientId !== clientId || next.chatMessage.clientId !== clientId) return false;
    const state = this.getState(sessionId);
    if (state.steeringQueueClientIds.includes(clientId)) return false;
    const index = state.pendingQueue.findIndex((q) => q.clientId === clientId);
    if (index < 0) return false;
    const current = state.pendingQueue[index];
    if (!current) return false;
    // The receipt is stamped by this host at first acceptance and is not part
    // of public projections. Never let an edit erase or forge the clear/restart
    // recovery boundary even if a future caller accidentally rebuilds from a
    // projected row again.
    const replacement = { ...next };
    if (current.hostAcceptedAtMs === undefined) delete replacement.hostAcceptedAtMs;
    else replacement.hostAcceptedAtMs = current.hostAcceptedAtMs;
    const nextQueue = [...state.pendingQueue];
    nextQueue[index] = replacement;
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
    // 队首变化也可能切换 SESSION_RUNNING retry policy(auto 10s ↔ 普通 250ms)。
    // 重新评估当前 busy boundary，替换仍绑定旧队首的 timer。
    this.scheduleExternalTurnRetryIfNeeded(sessionId, state, 'queue-moved');
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
    this.supersedePendingAutoResumeRecoveries(sessionId);
    const observedClearBoundaryMs = normalizeAgentInputClearBoundaryMs(clearedAt) ?? Date.now();
    const clearBoundaryMs =
      prev.clearBoundaryMs === null
        ? observedClearBoundaryMs
        : Math.max(prev.clearBoundaryMs, observedClearBoundaryMs);
    this.clearAbortReconcileRetry(prev);
    this.clearSessionRunningRetry(prev);
    this.clearCredentialSwitchWait(prev);
    this.clearPendingExternalTerminalDone(prev);
    this.abortInputBoundary(sessionId);
    this.abortSteerTransactions(sessionId);
    for (const item of prev.pendingQueue) {
      this.deps.onDiscardedQueuedMessage?.(sessionId, item);
    }
    this.cancelPreSendActiveTurn(sessionId, prev, false);
    // 显式清上下文:强制开启持久化闸门,让 emit 写出空快照(删行),
    // 即使此前该会话从未触发恢复(否则旧快照残留,下次打开会诈尸)。
    this.restoredQueueSessions.add(sessionId);
    this.states.set(sessionId, createInitialInputState(prev.generation + 1, clearBoundaryMs));
    this.emit(sessionId);
    return this.getProjection(sessionId);
  }

  /**
   * `signals` 只在 `type='error'` 时有意义：terminal error 的结构化信号（SDK error
   * tag / reason / HTTP 状态码），供 host 判断这次失败是否值得自动续跑。刻意不在
   * coordinator 里做那个判断——它是「这条错误是什么」的领域知识，属于 host 侧的
   * interruptedTurnAutoResume；coordinator 只负责回答「有没有可续跑的目标」。
   */
  onTurnEvent(
    sessionId: string,
    type: 'done' | 'error',
    message?: string,
    signals?: Omit<InterruptedTurnErrorSignals, 'message'>,
  ): void {
    const state = this.getState(sessionId);
    const active = state.activeTurn;
    state.staleLiveIdleSinceMs = null;
    this.clearAbortReconcileRetry(state);
    state.queueAbortPending = false;
    state.abortBoundaryToken = null;
    if (type === 'error') {
      if (
        active &&
        state.recovery?.kind === 'queue-head' &&
        isPiImageInputUnsupportedError(state.error)
      ) {
        // A Pi capability guard rejected a newer steer before RPC and restored it as the
        // recoverable queue head. The terminal error belongs to the original active turn: close
        // that old boundary, but do not replace the newer queue-head recovery/banner with an
        // active-turn retry. The paired done path below preserves the same recovery as well.
        state.activeTurn = null;
        state.stickyError = null;
        this.emit(sessionId);
        return;
      }
      if (active?.persisted) {
        state.activeTurn = null;
        state.stickyError = null;
        const schedulerItem = active.item && isSchedulerOriginItem(active.item);
        const resumableCandidate = this.isResumableTurnErrorCandidate(sessionId, message, signals);
        const outcome = this.setActiveTurnRecovery(state, active.item, {
          allowSchedulerAutoResume: Boolean(schedulerItem && resumableCandidate),
        });
        if (outcome === 'dropped-scheduler') {
          state.error = message ?? state.error;
          // **紧随的 done 必须被配对吃掉。**各 agent 的失败收尾都是 terminal error 后再补
          // 一个 done;普通用户项靠下方"!active && recovery.kind==='active-turn'"那道守卫
          // 挡住它,而 scheduler 项恰恰没有 recovery 可挡 —— done 会一路落到方法尾部的
          // `state.error = null`,把刚呈现的失败擦掉,还顺带按"正常完成"放行新队列工作,
          // 而 scheduler 那边这一轮明明记的是 failed(第二十一轮 P1)。
          // 复用外部 turn 失败那套配对标记:标记期间派发边界算忙(isDispatchBoundaryBusy),
          // 配对 done 到达时清标记并保留 error;个别只发 error 不发 done 的收尾由
          // markPendingExternalTerminalDone 内置的 fallback timer 兜底。
          this.markPendingExternalTerminalDone(sessionId, state);
          this.emit(sessionId);
          // 用户那条路靠 clearError / 重试按钮顺带唤醒 drain,scheduler 这条没有人点 ——
          // recovery 既然不留,队里压着的消息就得自己唤一次(等边界真空出来再跑)。
          this.scheduleDrainAfterExternalTurnSettles(sessionId, 'scheduler-prompt-terminal-error');
          return;
        }
        // recovery 留下来了 = 有可续跑的目标。**先同步问 host 要不要接管自愈**,再 emit:
        // 接管时刻意不设 state.error —— 红横幅只留给"最终没救回来",自愈过程在聊天流里
        // 用低调提示表达(autoResumePending)。两种结果都只 emit 一次,不让用户先看到一帧
        // 红横幅再被撤掉。
        const takeover =
          outcome === 'kept' && active.item
            ? this.notifyResumableTurnError(sessionId, active.item, message, signals)
            : null;
        if (takeover) {
          state.autoResumePending = takeover;
          state.autoResumeAttemptToken = takeover.sessionTotal;
        } else {
          state.error = message ?? state.error;
          // Schedule 的确定性错误或额度耗尽仍由 runner 收口，不留下脱离 run 记账的
          // 人工 Retry。只有真正被普通自动续跑接管的窗口才保留 recovery。
          if (schedulerItem) {
            state.recovery = null;
            this.markPendingExternalTerminalDone(sessionId, state);
            this.emit(sessionId);
            this.scheduleDrainAfterExternalTurnSettles(
              sessionId,
              'scheduler-prompt-terminal-error',
            );
            return;
          }
        }
        this.emit(sessionId);
        return;
      }
      if (active?.persisting) {
        // 用户气泡还在 DB 边界内。先暂存 terminal error，等持久化
        // 和 dispatch 结果共同决定它能否成为 active-turn retry。
        //
        // 接管决策要等到那时才能做（recovery 留不留得住是前提），但红横幅在这里就会发出去。
        // 所以先用纯判定问一句「这条有可能被接管吗」：有可能就**先不设 error** —— 否则接管
        // 成功时用户已经先看过一帧红横幅，违反「接管态为真时 error 必为 null」(不变量 I1,
        // greptile P1)。判定为假（认证失效、协议错等确定性失败）时照旧立刻呈现，不受影响。
        const resumableCandidate = this.isResumableTurnErrorCandidate(sessionId, message, signals);
        recordPendingTerminalEvent(active, {
          type: 'error',
          message,
          signals,
          ...(resumableCandidate ? { resumableCandidate: true } : {}),
        });
        // 候选态只压住**本次**的 message；既有 stickyError 是上一次未处置的错误，与本次无关，
        // 该继续显示。
        state.error = resumableCandidate
          ? (state.stickyError ?? state.error)
          : (state.stickyError ?? message ?? state.error);
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
    if (state.recovery?.kind === 'queue-head') {
      // A pre-accept rollback or a capability-rejected steer has already restored the failed
      // head. The latter can still have the original active turn here; its done boundary must
      // not clear the steer recovery, otherwise the next drain silently resends without Retry.
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

  /**
   * @param opts.preserveInputBoundary 为 true 时跳过 abortInputBoundary。
   * @param opts.preserveAutoResumeIntent 为 true 时保留当前自动续跑接管态。
   *   仅用于 provider rebuild 在退避 timer 触发前关闭旧 Session 的交棒窗口；
   *   active turn / steer / drain 等旧实例运行态仍照常清理。
   *   用于 rehydrate / 凭证切换 close-rebuild 窗口:abort 会取消驱动本次重建的
   *   input signal(#1930),但**其余清理必须照常**(activeTurn / steer / queue
   *   状态不能残留,否则 rebuild 失败或 close 后不 rebuild 时 coordinator
   *   残留旧状态阻塞后续发送)。
   */
  onSessionClosed(
    sessionId: string,
    opts?: { preserveInputBoundary?: boolean; preserveAutoResumeIntent?: boolean },
  ): void {
    const state = this.getState(sessionId);
    if (!opts?.preserveAutoResumeIntent) {
      this.supersedePendingAutoResumeRecoveries(sessionId);
    }
    const releasedAbortLock = state.queueAbortPending;
    this.cancelScheduledDrain(state);
    this.clearAbortReconcileRetry(state);
    this.clearSessionRunningRetry(state);
    this.clearPendingExternalTerminalDone(state);
    if (!opts?.preserveInputBoundary) this.abortInputBoundary(sessionId);
    this.abortSteerTransactions(sessionId);
    const active = state.activeTurn;
    if (active && !isActiveTurnDispatched(active)) {
      if (active.sendStarted) {
        this.recordActiveTurnClosedBeforeSendOutcome(state, active);
      } else {
        this.handleActiveTurnClosedBeforeDispatch(sessionId, state, active);
      }
      state.queueAbortPending = false;
      state.abortBoundaryToken = null;
      this.clearAllSteeringMarkers(state);
      this.emit(sessionId);
      return;
    }
    state.activeTurn = null;
    state.queueAbortPending = false;
    state.abortBoundaryToken = null;
    this.clearAllSteeringMarkers(state);
    this.emit(sessionId);
    if (releasedAbortLock) this.scheduleDrain(sessionId, 'session-closed-abort-boundary');
  }

  private projectQueueInspection(state: SessionInputState): SessionQueueInspectionEntry[] {
    const activeItem =
      state.activeTurn?.item && !isActiveTurnDispatched(state.activeTurn)
        ? state.activeTurn.item
        : null;
    return projectSessionQueueForInspection(
      state.pendingQueue,
      state.steeringQueueClientIds,
      activeItem,
      state.directSteeringItems,
    );
  }

  private isCurrentSteerRequest(
    state: SessionInputState,
    clientId: string,
    generation: number,
    token: symbol,
  ): boolean {
    return state.generation === generation && state.steeringRequestTokens.get(clientId) === token;
  }

  private clearSteeringMarker(
    state: SessionInputState,
    clientId: string,
    expected?: { generation: number; token: symbol },
  ): boolean {
    if (
      expected &&
      !this.isCurrentSteerRequest(state, clientId, expected.generation, expected.token)
    ) {
      return false;
    }
    const existed = state.steeringQueueClientIds.includes(clientId);
    state.steeringQueueClientIds = state.steeringQueueClientIds.filter((id) => id !== clientId);
    state.steeringRequestTokens.delete(clientId);
    this.clearDirectSteeringItem(state, clientId);
    return existed;
  }

  private clearDirectSteeringItem(state: SessionInputState, clientId: string): void {
    state.directSteeringItems = state.directSteeringItems.filter(
      (item) => item.clientId !== clientId,
    );
  }

  private clearAllSteeringMarkers(state: SessionInputState): void {
    state.steeringQueueClientIds = [];
    state.steeringRequestTokens.clear();
    state.directSteeringItems = [];
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
      active?.item &&
      !active.persisted &&
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
    const recovery: AgentInputRecovery =
      state.recovery?.kind === 'active-turn'
        ? { ...state.recovery, item: this.toProjectedItem(state.recovery.item) }
        : state.recovery;
    return {
      sessionId,
      pendingQueue,
      // Modern projections always carry the explicit null token for a session
      // that has never been cleared.  Only an older controlled Desktop can
      // omit the field at the wire boundary; keeping null here lets a remote
      // sender safely fence clear/send races from the very first message.
      clearBoundaryMs: state.clearBoundaryMs,
      continuationInFlightClientId:
        state.activeTurn?.item && isUiContinuationItem(state.activeTurn.item)
          ? state.activeTurn.item.clientId
          : null,
      continuationTurnClientId: state.activeTurn?.continuationOwnerClientId ?? null,
      steeringQueueClientIds: [...state.steeringQueueClientIds],
      queuePaused: state.queuePaused,
      queueExpanded: state.queueExpanded,
      queueInteractionLocks: [...state.queueInteractionLocks],
      queueEditLocks: [...state.queueEditLocks],
      queueAbortPending: state.queueAbortPending,
      error: state.error,
      recovery,
      ...(state.autoResumePending ? { autoResumePending: state.autoResumePending } : {}),
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
    delete projected.hostAcceptedAtMs;
    delete projected.trustedSessionReferenceContexts;
    delete projected.sessionReferencesRequireTrustedSnapshot;
    // Recovery hints are main-owned evidence for the next vendor turn, not
    // renderer/device-link payload. Keep the projection minimal and avoid
    // echoing transcript-derived summaries to remote controllers.
    delete projected.recoveryCheckpoint;
    if (typeof projected.text === 'string' && projected.text.includes(RECOVERY_CHECKPOINT_MARKER)) {
      projected.text = projected.text.slice(0, projected.text.indexOf(RECOVERY_CHECKPOINT_MARKER));
    }
    if (typeof projected.persistedContent === 'string' && projected.persistedContent.includes(RECOVERY_CHECKPOINT_MARKER)) {
      projected.persistedContent = projected.persistedContent.slice(0, projected.persistedContent.indexOf(RECOVERY_CHECKPOINT_MARKER));
    }
    // chatMessage.content is the outbound payload sent to remote controllers
    // (device-link); it must mirror the same strip so the checkpoint marker
    // never leaks past transport boundaries.
    if (projected.chatMessage && typeof projected.chatMessage.content === 'string' && projected.chatMessage.content.includes(RECOVERY_CHECKPOINT_MARKER)) {
      projected.chatMessage = {
        ...projected.chatMessage,
        content: projected.chatMessage.content.slice(0, projected.chatMessage.content.indexOf(RECOVERY_CHECKPOINT_MARKER)),
      };
    }
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
    try {
      return await (this.deps.resolveSessionReferences?.(item.sessionRefs) ?? []);
    } catch (error) {
      // Session links are still useful as ordinary Agent-facing text when the
      // referenced session belongs to another account, was deleted, or is
      // temporarily unavailable.  Quoted history is an optional enrichment:
      // fail closed on the history body, but do not fail the user's message.
      log.warn('session reference enrichment skipped', {
        referenceCount: item.sessionRefs.length,
        error: errorMessage(error),
      });
      return [];
    }
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

  /**
   * Live Session idle + host tracker still busy is an invariant break.
   * Reconcile the tracker so queued input can drain without a user Stop / steer.
   * Do not call this while a send is in flight, an activeTurn still owns the
   * generation, a permission card is up, or abort/steer already owns the boundary.
   * Dispatched-but-not-started turns (Pi may accept a prompt before agent_start)
   * must wait for real lifecycle events — do not synthesize done.
   */
  private tryReconcileStaleDispatchBoundary(
    sessionId: string,
    state: SessionInputState,
  ): boolean {
    if (
      state.abortBoundaryToken ||
      state.queueAbortPending ||
      state.queueInteractionLocks.length > 0 ||
      state.steeringQueueClientIds.length > 0 ||
      state.pendingExternalTerminalDone ||
      this.deps.hasPendingInteraction(sessionId) ||
      state.activeTurn !== null
    ) {
      state.staleLiveIdleSinceMs = null;
      return false;
    }
    // Missing live probe fail-closed: do not steal abort/live-turn reconcile.
    if (this.deps.isLiveTurnRunning?.(sessionId) !== false) {
      state.staleLiveIdleSinceMs = null;
      return false;
    }

    if (!this.deps.isTurnRunning(sessionId)) {
      state.staleLiveIdleSinceMs = null;
      return false;
    }

    // Handle may already be idle while status/done is still queued in Session.
    // Extra drains in this window must not confirm; wait the existing 250ms retry.
    if (state.staleLiveIdleSinceMs == null) {
      state.staleLiveIdleSinceMs = Date.now();
    }
    if (Date.now() - state.staleLiveIdleSinceMs < SESSION_RUNNING_RETRY_DELAY_MS) {
      return false;
    }

    const reconciled = this.deps.reconcileTurnIdle?.(sessionId) === true;
    if (!reconciled) return false;
    state.staleLiveIdleSinceMs = null;
    return true;
  }

  private isTurnSteerable(sessionId: string, state: SessionInputState): boolean {
    return state.activeTurn !== null || this.deps.isTurnRunning(sessionId);
  }

  /**
   * 队首为何不可派发 —— getDrainableHead 的解释版,两者共用同一份 gate 序列
   * (#2506 wake/drain 可观测性:此前 drain 被 gate 挡住时零日志,排队输入
   * 静默滞留后无从定位断点)。返回 null = 队首可派发。
   */
  private explainDrainBlockGate(sessionId: string, state: SessionInputState): string | null {
    if (this.queueRestorePromises.has(sessionId)) return 'queue-restore-in-progress';
    if (this.restoreAttempted.has(sessionId) && !this.restoredQueueSessions.has(sessionId))
      return 'queue-restore-failed';
    if (state.pendingQueue.length === 0) return 'queue-empty';
    if (state.queuePaused)
      return state.queuePausedByRestore ? 'queue-paused-by-restore' : 'queue-paused';
    if (state.queueAbortPending) return 'abort-pending';
    if (state.queueInteractionLocks.length > 0) return 'interaction-lock';
    if (state.steeringQueueClientIds.length > 0) return 'steering-in-flight';
    if (state.recovery) return 'recovery-pending';
    if (this.deps.hasPendingCredentialSwitch?.(sessionId)) return 'credential-switch-gate';
    if (this.isDispatchBoundaryBusy(sessionId, state)) return 'dispatch-boundary-busy';
    const head = state.pendingQueue[0];
    if (!head) return 'queue-empty';
    if (this.getDrainableCompact(sessionId, state)) return 'compact-first';
    if (state.queueEditLocks.includes(head.clientId)) return 'edit-lock';
    return null;
  }

  private getDrainableHead(
    sessionId: string,
    state: SessionInputState,
  ): AgentInputQueuedMessage | null {
    if (this.explainDrainBlockGate(sessionId, state) !== null) return null;
    return state.pendingQueue[0] ?? null;
  }

  private getDrainableCompact(
    sessionId: string,
    state: SessionInputState,
  ): PendingCompactRequest | null {
    if (this.queueRestorePromises.has(sessionId)) return null;
    if (this.restoreAttempted.has(sessionId) && !this.restoredQueueSessions.has(sessionId))
      return null;
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
      if (latest !== scheduledState || latest.drainWakeupGeneration !== drainWakeupGeneration)
        return;
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
      state.staleLiveIdleSinceMs = null;
      state.pendingCompacts = state.pendingCompacts.slice(1);
      await this.dispatchCompact(sessionId, compact, reason);
      return;
    }
    const head = this.getDrainableHead(sessionId, state);
    if (!head) {
      const hasRunnableWork =
        state.pendingQueue.length > 0 ||
        state.pendingCompacts.some((item) => item.waitForClientIds.length === 0);
      if (
        hasRunnableWork &&
        this.isDispatchBoundaryBusy(sessionId, state) &&
        this.tryReconcileStaleDispatchBoundary(sessionId, state)
      ) {
        this.scheduleDrain(sessionId, 'reconcile-stale-idle');
        return;
      }
      if (hasRunnableWork && state.staleLiveIdleSinceMs != null) {
        this.scheduleSessionRunningRetry(sessionId, 'stale-live-idle-confirm');
      } else if (!hasRunnableWork) {
        state.staleLiveIdleSinceMs = null;
      }
      // #2506 结果级诊断:排队输入被 gate 挡住时留痕(此前零日志,gate-clear
      // 到成功 drain 之间的静默滞留无从定位)。只记 id / 布尔 / 枚举,不记正文;
      // 空队列的例行 drain 不记,避免每次 turn-done 都产生噪音。
      // 级别按 gate 分层(Codex review):turn 运行中排队、恢复暂停、交互锁等
      // 都是**正常态**,每次 drain 尝试都会进这里 —— packaged 默认 info,记
      // info 会让普通排队持续刷日志、淹没真正的异常断点,复现期排障走 DEBUG
      // (工程规范)。只有 queue-restore-failed(快照恢复确已失败,队列滞留到
      // 人工介入,非瞬态)保留 info 常驻观测。
      const gate = this.explainDrainBlockGate(sessionId, state);
      if (gate !== null && gate !== 'queue-empty') {
        const logAt = gate === 'queue-restore-failed' ? log.info : log.debug;
        logAt('drain blocked', {
          sessionId,
          reason,
          gate,
          queueLength: state.pendingQueue.length,
          headClientId: state.pendingQueue[0]?.clientId ?? null,
          queuePaused: state.queuePaused,
          queuePausedByRestore: state.queuePausedByRestore,
          queueRestoreInProgress: this.queueRestorePromises.has(sessionId),
          recoveryKind: state.recovery?.kind ?? null,
          hasActiveTurn: state.activeTurn !== null,
          turnRunning: this.deps.isTurnRunning(sessionId),
          credentialSwitchGate: this.deps.hasPendingCredentialSwitch?.(sessionId) === true,
        });
      }
      this.scheduleExternalTurnRetryIfNeeded(sessionId, state, `drain-blocked:${reason}`);
      return;
    }
    state.staleLiveIdleSinceMs = null;
    state.pendingQueue = state.pendingQueue.slice(1);
    this.removePendingCompactWaitClientId(state, head.clientId);
    if (!state.stickyError) {
      state.error = null;
    }
    state.recovery = null;
    this.invalidateAbortBoundaryForNewTurn(state);
    const active: ActiveTurn = {
      item: head,
      delivery: 'turn',
      messageUuid: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      generation: state.generation,
      clearBoundaryMs: state.clearBoundaryMs,
      persisted: false,
      persisting: false,
      sendStarted: false,
      dispatchLifecycle: 'preparing',
      pendingTerminalEvent: null,
      continuationOwnerClientId: isUiContinuationItem(head) ? head.clientId : null,
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
        const verdict = await this.deps.screenUserMessage(
          sessionId,
          getAgentFacingText(head),
          head,
        );
        if (!this.isActiveTurnCurrent(sessionId, active)) return;
        if (verdict.action === 'block') {
          this.getState(sessionId).activeTurn = null;
          this.deps.onUserMessageBlocked?.(sessionId, head, verdict);
          this.notifyRejectedUserTurn(sessionId, head);
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
          if (!rewritten.trustedSessionReferenceContexts)
            delete head.trustedSessionReferenceContexts;
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
      head.persistedContent = attachSessionReferenceMetadata(
        head.persistedContent,
        referenceContexts,
      );
      const result = await this.deps.sendToAgent(
        sessionId,
        buildMakerUserMessage(head, referenceContexts),
        head.createOpts,
        {
          messageUuid: active.messageUuid,
          userName: head.userName,
          throwOnStartFailure: true,
          ...(head.autoResume && typeof head.autoResumeInfo?.sessionTotal === 'number'
            ? { turnAttemptToken: head.autoResumeInfo.sessionTotal }
            : {}),
          signal: this.getInputAbortSignal(sessionId, active.generation),
          expectedClearBoundaryMs: active.clearBoundaryMs,
          expectedInputGeneration: active.generation,
          ...(head.origin?.kind === 'scheduler' ? { origin: head.origin } : {}),
          // 手机来源透传到 send 事务:drain 已脱离入队时的 async context。
          ...(head.fromMobileClient ? { fromMobileClient: true } : {}),
          persistUserMessage: {
            clientId: head.clientId,
            content: head.persistedContent,
            sdkSessionId,
            delivery: active.delivery,
            expectedClearBoundaryMs: active.clearBoundaryMs,
            expectedInputGeneration: active.generation,
            // 自动续跑标记必须一路透到落库:renderer 靠 agentMeta.autoResume 隐藏气泡,
            // host 靠它跳过额度充值(见 AgentInputQueuedMessage.autoResume)。
            ...(head.autoResume ? { autoResume: true } : {}),
            ...(head.autoResumeInfo ? { autoResumeInfo: head.autoResumeInfo } : {}),
            ...(head.recoveryCheckpoint ? { recoveryCheckpoint: head.recoveryCheckpoint } : {}),
            ...(head.origin ? { origin: head.origin } : {}),
            shouldBroadcast: () => this.isTurnGenerationCurrent(sessionId, active),
            onPersisting: () => {
              this.notifyUserMessagePersisting(sessionId, head);
              if (this.isTurnGenerationCurrent(sessionId, active)) {
                active.persisting = true;
              }
            },
            onPersisted: async () => {
              // The DB row already owns any staged attachment references. This
              // callback intentionally runs before generation checks: a clear
              // or Stop may win the pre-vendor race after persistence, but it
              // must not delete media that the durable row now references.
              this.notifyUserMessagePersisted(sessionId, head);
              if (this.isTurnGenerationCurrent(sessionId, active)) {
                active.persisted = true;
                active.persisting = false;
                active.dispatchLifecycle = 'awaiting-dispatch-hooks';
                this.notifyUserMessageQueryable(sessionId, head);
                // 跨过 DB 持久化边界即刻收窄快照:此后崩溃属 interrupted-turn
                // 辖区,若等到下一次 emit(turn done)才写,长 turn 内崩溃会把
                // 已送达的消息二次恢复(issue #761)。
                this.maybePersistQueueSnapshot(sessionId);
              }
              await this.deps.beforeDispatchUserTurn?.(sessionId, head);
              if (!this.isActiveTurnCurrent(sessionId, active)) {
                throw new Error(
                  '[SEND_CANCELLED_BEFORE_DISPATCH] User turn was cancelled before vendor dispatch',
                );
              }
              // host 把排队 orca 消息的 accepted 副作用挂在这个 hook 上(置 running /
              // autoBridgePending), 必须 await 完才能放行 vendor turn —— fire-and-forget
              // 会让快 worker 在状态可见前结束 turn, 桥接被 turn-end handler 误跳过。
              await this.deps.onAcceptedQueuedMessage?.(sessionId, head);
              if (!this.isActiveTurnCurrent(sessionId, active)) {
                throw new Error(
                  '[SEND_CANCELLED_BEFORE_DISPATCH] User turn was cancelled before vendor dispatch',
                );
              }
              active.dispatchLifecycle = 'sending';
            },
            onPersistFailed: () => {
              this.notifyUserMessagePersistenceFailed(sessionId, head, {
                retainForRetry: true,
              });
            },
          },
        },
      );
      if (this.discardOnStaleActiveTurn(sessionId, active, isSendDispatched(result))) return;
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
      this.commitAutoResumeDispatch(sessionId, head);
      // retry-supersede:克隆重发行既落库又真正派发出去了,被取代的旧 user 行从此
      // 冗余,软删它(连同其后的 error 行)。落在这里而不是 onPersisted 里:落库到
      // 派发之间还夹着 beforeDispatch / onAccepted 两个 hook,期间停止或关闭会话会走
      // cancelled-before-dispatch —— 那时若已软删,历史里只剩一条从未送达模型的克隆
      // 消息,原失败的 error 行连同它上面的「重试」入口一起消失(与上面 durable-ack
      // 同一个「派发已不可逆才动持久化状态」的边界理由)。
      // await 而非 fire-and-forget:软删先落库再继续推进本 turn,把"克隆已落库、旧行
      // 还在"的窗口压到最小。软删失败(或崩在这个窗口里)只退回"显示两条"的旧观感,
      // 文本已经保存在克隆行里,用户的消息不会丢。
      if (head.supersedesUserClientId) {
        const supersededUserClientId = head.supersedesUserClientId;
        try {
          await this.deps.supersedeRetriedUserTurn?.(sessionId, {
            supersededUserClientId,
            retryUserClientId: head.clientId,
          });
        } catch (err) {
          log.warn('supersedeRetriedUserTurn failed', {
            sessionId,
            supersededUserClientId,
            retryUserClientId: head.clientId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (this.discardOnStaleActiveTurn(sessionId, active)) return;
      if (active.pendingTerminalEvent) {
        this.settlePendingTerminalEventAfterPersist(sessionId, active);
        return;
      }
      this.emit(sessionId);
    } catch (err) {
      if (this.discardOnStaleActiveTurn(sessionId, active)) return;
      // 派发 / 落库失败(含 SESSION_RUNNING 让位):暂存的 error 候选到此作废,补落它的行。
      // 放在分支之前 —— 三条出口都不会再走到接管决策。
      this.discardDeferredResumableCandidate(sessionId, active);
      const latest = this.getState(sessionId);
      if (!active.persisted) {
        if (isSessionRunningError(err)) {
          this.deferQueueHeadAfterSessionRunning(
            sessionId,
            active,
            head,
            reason,
            errorMessage(err),
          );
          return;
        }
        if (head.autoResume) {
          latest.activeTurn = null;
          this.discardAutoResumeBeforeDispatch(sessionId, head);
          this.emit(sessionId);
          this.deps.onQueueEmptied?.(sessionId);
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
        this.notifyRejectedUserTurn(sessionId, head);
        this.emit(sessionId);
        return;
      }
      latest.error = errorMessage(err);
      latest.stickyError = null;
      const piImageCapabilityRejected = isPiImageInputUnsupportedError(err);
      // 同 handleSendNotDispatched:调度来源的 prompt 不留可被人手动 Retry 的 recovery
      // (review #944 第九轮 P1;判据内建在 setActiveTurnRecovery)。
      const schedulerOrigin = this.setActiveTurnRecovery(latest, head) === 'dropped-scheduler';
      if (schedulerOrigin) {
        // 摘掉 recovery 就**必须**一并放掉 activeTurn。isDispatchBoundaryBusy 只要
        // activeTurn 非空就判忙,而这条 active-turn recovery 原本是唯一能清掉它的入口
        // (用户 Retry / clearError)—— 现在没有了,不主动清就等于把会话永久钉在"有活跃
        // turn":之后所有用户与调度消息全部积压到 coordinator 被重置
        // (review #944 第十轮 P1)。
        latest.activeTurn = null;
      } else if (piImageCapabilityRejected) {
        // Pi 图片能力拒绝发生在 vendor RPC 之前，不会再有 terminal event 来释放 activeTurn；
        // 已持久化的用户行仍保留 active-turn recovery，供用户切换到视觉模型后重试。
        latest.activeTurn = null;
      }
      this.notifyRejectedUserTurn(sessionId, head);
      this.notifyUndispatchedUserTurn(sessionId, head, 'failed');
      this.emit(sessionId);
      // 派发边界刚刚放开,队里可能还压着别的消息 —— 用户那条路靠 clearError 顺带唤醒,
      // scheduler 这条没有人点,必须自己唤一次。
      if (schedulerOrigin) this.scheduleDrain(sessionId, 'scheduler-prompt-cancelled');
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
    // 这条 turn 没派出去 → 暂存的 error 候选不会再有接管决策(settle 只挂在已派发那条路上),
    // 就地作废并让 host 补落它的行(不变量 I2)。credential-switch / SESSION_RUNNING 那两个
    // 会重试的分支同理:重试的是**新** turn,旧 error 不会再被接管。
    this.discardDeferredResumableCandidate(sessionId, active);
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
      if (item.autoResume) {
        latest.activeTurn = null;
        this.discardAutoResumeBeforeDispatch(sessionId, item);
        this.emit(sessionId);
        this.deps.onQueueEmptied?.(sessionId);
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
      const cancelledByUserBoundary =
        latest.queueAbortPending &&
        result.kind === 'session-dispatch' &&
        result.reason === 'cancelled-before-dispatch';
      if (!cancelledByUserBoundary) this.notifyRejectedUserTurn(sessionId, item);
      this.emit(sessionId);
      return;
    }

    latest.activeTurn = null;
    latest.error = message;
    latest.stickyError = null;
    // 调度来源的 prompt **不留 active-turn recovery**。它的 Retry 走的是普通用户 turn:
    // 没有 scheduler 回调、没有 run 跟踪 —— 而这条 run 此刻已经顺延或落终态了,留着就等于
    // 让一条已收口的调度 prompt 之后还能被人手动跑一次(review #944 第九轮 P1)。
    // 失败本身经 scheduler 自己的运行历史 + 通知呈现,不靠这里的重试入口。
    // 注:isPromptTracked 用的 hasQueuedItemWhere 默认不含 recovery,所以摘掉它不会影响
    // runner 的排队存活探测。
    const schedulerOrigin = this.setActiveTurnRecovery(latest, item) === 'dropped-scheduler';
    const cancelledByUserBoundary =
      latest.queueAbortPending &&
      result.kind === 'session-dispatch' &&
      result.reason === 'cancelled-before-dispatch';
    if (!cancelledByUserBoundary) this.notifyRejectedUserTurn(sessionId, item);
    this.notifyUndispatchedUserTurn(
      sessionId,
      item,
      cancelledByUserBoundary ? 'cancelled' : 'failed',
    );
    if (
      latest.queueAbortPending &&
      result.kind === 'session-dispatch' &&
      result.reason === 'cancelled-before-dispatch'
    ) {
      latest.queueAbortPending = false;
    }
    log.warn(
      schedulerOrigin
        ? 'send not dispatched after persistence; dropped scheduler prompt (no user retry)'
        : 'send not dispatched after persistence; kept active-turn recovery',
      {
        sessionId,
        clientId: item.clientId,
        ...logFields,
      },
    );
    this.emit(sessionId);
    // activeTurn 上面已置空,但队里可能还压着别的消息 —— 用户那条路靠 clearError 顺带
    // 唤醒,scheduler 这条没有 recovery、没有人点,必须自己唤一次(review #944 第十轮 P1)。
    if (schedulerOrigin) this.scheduleDrain(sessionId, 'scheduler-prompt-cancelled');
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
    if (
      this.abandonAutoResumeAfterTransientFailure(sessionId, latest, item, 'credential-switch-busy')
    ) {
      return;
    }
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
      if (
        wait.blockedBySessionIds.length > 0 &&
        !wait.blockedBySessionIds.includes(settledSessionId)
      ) {
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
    if (this.abandonAutoResumeAfterTransientFailure(sessionId, latest, item, 'session-running')) {
      return;
    }
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

  private getSessionRunningRetryPolicy(state: SessionInputState): {
    ownerKey: string | null;
    delayMs: number;
  } {
    const compact = state.pendingCompacts[0];
    if (compact && compact.waitForClientIds.length === 0) {
      return { ownerKey: 'compact', delayMs: SESSION_RUNNING_RETRY_DELAY_MS };
    }
    const head = state.pendingQueue[0];
    return {
      ownerKey: head ? `queue:${head.clientId}` : null,
      delayMs: head?.autoResume
        ? AUTO_RESUME_SESSION_RUNNING_RETRY_DELAY_MS
        : SESSION_RUNNING_RETRY_DELAY_MS,
    };
  }

  private scheduleSessionRunningRetry(sessionId: string, reason: string): void {
    const state = this.getState(sessionId);
    const policy = this.getSessionRunningRetryPolicy(state);
    if (state.sessionRunningRetryTimer) {
      if (
        state.sessionRunningRetryGeneration === state.generation &&
        state.sessionRunningRetryOwnerKey === policy.ownerKey &&
        state.sessionRunningRetryDelayMs === policy.delayMs
      ) {
        return;
      }
      this.clearSessionRunningRetry(state);
    }
    const generation = state.generation;
    const retryToken = Symbol('session-running-retry');
    state.sessionRunningRetryGeneration = generation;
    state.sessionRunningRetryOwnerKey = policy.ownerKey;
    state.sessionRunningRetryDelayMs = policy.delayMs;
    state.sessionRunningRetryToken = retryToken;
    state.sessionRunningRetryTimer = setTimeout(() => {
      const latest = this.getState(sessionId);
      if (
        latest.sessionRunningRetryToken !== retryToken ||
        latest.sessionRunningRetryGeneration !== generation
      ) {
        return;
      }
      latest.sessionRunningRetryTimer = null;
      latest.sessionRunningRetryGeneration = null;
      latest.sessionRunningRetryOwnerKey = null;
      latest.sessionRunningRetryDelayMs = null;
      latest.sessionRunningRetryToken = null;
      if (latest.generation !== generation) return;
      if (latest.pendingQueue.length === 0 && latest.pendingCompacts.length === 0) return;
      if (this.isDispatchBoundaryBusy(sessionId, latest)) {
        if (this.tryReconcileStaleDispatchBoundary(sessionId, latest)) {
          this.scheduleDrain(sessionId, 'session-running-retry-reconciled');
          return;
        }
        this.scheduleSessionRunningRetry(sessionId, reason);
        return;
      }
      this.scheduleDrain(sessionId, `session-running-retry:${reason}`);
    }, policy.delayMs);
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

  private scheduleExternalTurnRetryIfNeeded(
    sessionId: string,
    state: SessionInputState,
    reason: string,
  ): void {
    const compact = state.pendingCompacts[0];
    const head = state.pendingQueue[0];
    const hasRunnableCompact = Boolean(compact && compact.waitForClientIds.length === 0);
    const hasRunnableQueueHead = Boolean(head && !state.queueEditLocks.includes(head.clientId));
    if (!hasRunnableCompact && !hasRunnableQueueHead) return;
    if (state.activeTurn !== null) {
      // A prior busy boundary may have left a fallback timer armed while the
      // current turn is still active. Rebind it to the newly changed queue
      // head so a later lost-done fallback does not inherit the old policy.
      if (state.sessionRunningRetryTimer) {
        this.scheduleSessionRunningRetry(sessionId, reason);
      }
      return;
    }
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
    state.sessionRunningRetryOwnerKey = null;
    state.sessionRunningRetryDelayMs = null;
    state.sessionRunningRetryToken = null;
  }

  /** closed 事件可能早于 sendToAgent 返回；这里先挂起 terminal event，等真实 send outcome 决定 drain 还是 recovery。 */
  private recordActiveTurnClosedBeforeSendOutcome(
    state: SessionInputState,
    active: ActiveTurn,
  ): void {
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
      // 同 onTurnEvent / handleSendNotDispatched:scheduler 的 prompt 不留重试入口
      // (判据内建在 setActiveTurnRecovery,第十八轮 P1)。
      const schedulerOrigin = this.setActiveTurnRecovery(state, item) === 'dropped-scheduler';
      this.notifyUndispatchedUserTurn(sessionId, item, 'failed');
      log.warn(
        schedulerOrigin
          ? 'session closed before dispatch after persistence; dropped scheduler prompt (no user retry)'
          : 'session closed before dispatch after persistence; kept active-turn recovery',
        {
          sessionId,
          clientId: item.clientId,
        },
      );
      if (schedulerOrigin) this.scheduleDrain(sessionId, 'scheduler-prompt-session-closed');
      return;
    }

    if (active.persisting) {
      recordPendingTerminalEvent(active, { type: 'error', message });
      state.error = message;
      state.recovery = null;
      return;
    }

    state.activeTurn = null;
    if (item.autoResume) {
      this.discardAutoResumeBeforeDispatch(sessionId, item);
      return;
    }
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
  private cancelPreSendActiveTurn(
    sessionId: string,
    state: SessionInputState,
    preserveQueue: boolean,
  ): void {
    const active = state.activeTurn;
    if (!active || !isActiveTurnBeforeVendorDispatch(active)) return;
    this.abortInputBoundary(sessionId);
    state.generation += 1;
    state.activeTurn = null;
    const item = active.item;
    if (!item) return;
    if (active.persisted) {
      this.notifyUndispatchedUserTurn(sessionId, item, 'cancelled');
      // 第六条终态路径(本轮自查补上,不是等 reviewer 报的):用户 Stop 赢在 pre-vendor
      // await 窗口。scheduler 的 prompt 同样不留重试入口 —— runner 会按 abort 收口这一轮,
      // 克隆重跑没有 FireContext 回调也不计 run 账(判据内建在 setActiveTurnRecovery)。
      // 这里**不**补 scheduleDrain:Stop(keepQueue) 的语义就是把队列停下等用户 resume,
      // 唤醒 drain 会与用户的显式暂停相抵。
      if (preserveQueue) this.setActiveTurnRecovery(state, item);
      return;
    }
    if (!preserveQueue) {
      this.deps.onDiscardedQueuedMessage?.(sessionId, item);
      return;
    }
    if (!state.pendingQueue.some((q) => q.clientId === item.clientId)) {
      state.pendingQueue = [item, ...state.pendingQueue];
      this.prependPendingCompactWaitClientId(state, item.clientId);
    }
  }

  /** 用户动作发生时撤销尚未交给 vendor 的自动续跑项。 */
  private supersedePendingAutoResumeRecoveries(sessionId: string): void {
    for (const [clientId, pending] of this.pendingAutoResumeRecoveries) {
      if (pending.sessionId === sessionId) {
        this.pendingAutoResumeRecoveries.delete(clientId);
        this.autoResumeDispatchAttempts.delete(clientId);
      }
    }
    const state = this.states.get(sessionId);
    if (state) state.autoResumeAttemptToken = null;
  }

  /**
   * 自动续跑项在 pre-vendor 边界被丢弃时恢复原错误入口。
   * 返回 false 表示它已经被用户动作取代、会话已清空，或已跨过 dispatch 边界。
   */
  restoreAutoResumeRecovery(sessionId: string, clientId: string, attemptToken: number): boolean {
    const pending = this.pendingAutoResumeRecoveries.get(clientId);
    if (!pending) return false;
    const state = this.states.get(sessionId);
    if (
      pending.sessionId !== sessionId ||
      pending.attemptToken !== attemptToken ||
      state !== pending.stateRef ||
      state.autoResumeAttemptToken !== attemptToken
    ) {
      return false;
    }
    this.pendingAutoResumeRecoveries.delete(clientId);
    state.error = pending.error;
    state.stickyError = pending.stickyError;
    state.recovery = pending.recovery;
    state.autoResumePending = pending.autoResumeInfo;
    this.emit(sessionId);
    return true;
  }

  private discardAutoResumeBeforeDispatch(sessionId: string, item: AgentInputQueuedMessage): void {
    // This item has already left pendingQueue but never crossed vendor dispatch. Reuse the
    // existing host cleanup boundary; register owns the single recovery/finalize operation.
    this.autoResumeDispatchAttempts.delete(item.clientId);
    this.deps.onDiscardedQueuedMessage?.(sessionId, item);
  }

  /** 自动续跑项已真正进入 vendor，之后不再需要 pre-vendor 回滚信息。 */
  private commitAutoResumeDispatch(sessionId: string, item: AgentInputQueuedMessage): void {
    this.pendingAutoResumeRecoveries.delete(item.clientId);
    this.autoResumeDispatchAttempts.delete(item.clientId);
    const attemptToken = item.autoResumeInfo?.sessionTotal;
    const state = this.getState(sessionId);
    if (
      item.autoResume &&
      typeof attemptToken === 'number' &&
      state.autoResumeAttemptToken === attemptToken
    ) {
      state.autoResumeAttemptToken = null;
    }
  }

  /**
   * 记录同一自动续跑项的 transient busy 失败；达到上限时就地放弃并交回原错误。
   * 普通用户消息仍沿用原有无限等待语义，只有隐藏 auto item 需要硬边界。
   */
  private abandonAutoResumeAfterTransientFailure(
    sessionId: string,
    state: SessionInputState,
    item: AgentInputQueuedMessage,
    reason: string,
  ): boolean {
    if (!item.autoResume) return false;
    const attempts = (this.autoResumeDispatchAttempts.get(item.clientId) ?? 0) + 1;
    this.autoResumeDispatchAttempts.set(item.clientId, attempts);
    if (attempts < MAX_AUTO_RESUME_DISPATCH_ATTEMPTS) return false;

    this.autoResumeDispatchAttempts.delete(item.clientId);
    state.activeTurn = null;
    state.pendingQueue = state.pendingQueue.filter((queued) => queued.clientId !== item.clientId);
    this.removePendingCompactWaitClientId(state, item.clientId);
    this.clearCredentialSwitchWait(state);
    this.discardAutoResumeBeforeDispatch(sessionId, item);
    log.warn('auto-resume dispatch budget exhausted while provider stayed busy', {
      sessionId,
      clientId: item.clientId,
      attempts,
      reason,
    });
    this.emit(sessionId);
    this.deps.onQueueEmptied?.(sessionId);
    // Exhausting the hidden auto-resume must not strand work queued behind it.
    // The retry timer has been consumed at this boundary, so wake any FIFO
    // tail explicitly once the auto item is removed.
    if (state.pendingQueue.length > 0 || state.pendingCompacts.length > 0) {
      this.scheduleDrain(sessionId, 'auto-resume-budget-exhausted');
    }
    return true;
  }

  /**
   * 用户接管时撤销已经离队、但尚未交给 vendor 的隐藏自动续跑。
   * 持久化前走 discard 回调，持久化后走 undispatched 回调，两条既有 host 边界都会结算
   * suppressed error 与 guard pending 状态。
   */
  private cancelPreparedAutoResume(sessionId: string, state: SessionInputState): boolean {
    const queuedClientIds = state.pendingQueue
      .filter((item) => item.autoResume)
      .map((item) => item.clientId);
    this.supersedePendingAutoResumeRecoveries(sessionId);
    for (const clientId of queuedClientIds) this.remove(sessionId, clientId);

    const active = state.activeTurn;
    const item = active?.item;
    if (!active || !item?.autoResume || !isActiveTurnBeforeVendorDispatch(active)) {
      return queuedClientIds.length > 0;
    }
    const persisted = active.persisted;
    this.cancelPreSendActiveTurn(sessionId, state, false);
    this.emit(sessionId);
    this.scheduleDrain(sessionId, 'auto-resume-cancelled');
    log.info('cancelled prepared auto-resume', {
      sessionId,
      clientId: item.clientId,
      runId: item.origin?.kind === 'scheduler' ? item.origin.runId : undefined,
      persisted,
      queuedClientIds,
    });
    return true;
  }

  private fallbackPreparedAsTurn(
    sessionId: string,
    item: AgentInputQueuedMessage,
    removeFromQueue: boolean,
  ): void {
    const state = this.getState(sessionId);
    // 插话回落成普通派发 = 也是一条新用户输入。普通 composer / 队列项可能在
    // scheduler 自动续跑退避期间走到这里，必须先同步作废那一轮的 waiter，避免
    // fallback turn 的 text/done 被旧 run 消费。scheduler 自己与 UI Continue 仍保留
    // 各自的续跑归属，不按无关用户输入处理。
    if (isAutomaticOriginItem(item)) {
      if (!isSchedulerOriginItem(item)) this.deps.onAutomaticEnqueue?.(sessionId);
    } else if (!isUiContinuationItem(item)) {
      this.deps.onUserEnqueue?.(sessionId);
      this.deps.previewQueuedUserTurn?.(sessionId, item);
    }
    this.abandonActiveTurnRecoveryForUserAction(state);
    this.clearErrorUnlessQueueHeadBlocked(state, item.clientId);
    state.queuePaused = false;
    this.clearSteeringMarker(state, item.clientId);
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
    opts?: { clearActiveTurn?: boolean; preserveAbortBoundaryToken?: boolean },
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
    if (!opts?.preserveAbortBoundaryToken) {
      this.clearAbortReconcileRetry(state);
      state.abortBoundaryToken = null;
    }
    this.emit(sessionId);
    this.scheduleDrain(sessionId, reason);
  }

  /**
   * A stop abort is scoped to the turn that existed when stop was requested.
   * A non-preserving stop does not keep the abort lock, so a new enqueue may
   * start another turn before the old vendor abort promise settles. Invalidate
   * the old token at that new-turn boundary; otherwise the late abort callback
   * would pass the state/generation check and clear the replacement turn.
   */
  private invalidateAbortBoundaryForNewTurn(state: SessionInputState): void {
    this.clearAbortReconcileRetry(state);
    state.abortBoundaryToken = null;
  }

  private reconcileAbortBoundary(
    sessionId: string,
    state: SessionInputState,
    abortBoundaryGeneration: number,
    abortBoundaryToken: symbol,
    source: string,
  ): void {
    const current = this.states.get(sessionId);
    if (
      current !== state ||
      current.generation !== abortBoundaryGeneration ||
      current.abortBoundaryToken !== abortBoundaryToken
    ) {
      return;
    }

    let reconciledIdle = false;
    try {
      reconciledIdle = this.deps.reconcileTurnIdle?.(sessionId) === true;
    } catch (err) {
      // A best-effort reconciliation must never prevent the retry path from
      // keeping the boundary fail-closed.
      log.warn('reconcileTurnIdle after abort failed', {
        sessionId,
        source,
        error: errorMessage(err),
      });
    }
    if (reconciledIdle) {
      this.releaseAbortLockAndDrain(sessionId, 'abort-idle-reconciled', { clearActiveTurn: true });
      return;
    }

    let agentKind: AgentInputCreateOpts['agentKind'] | null = null;
    try {
      agentKind = this.deps.getAgentKind(sessionId);
    } catch (err) {
      log.warn('agent kind lookup failed during abort reconciliation', {
        sessionId,
        source,
        error: errorMessage(err),
      });
    }

    let liveTurnRunning = true;
    try {
      liveTurnRunning = this.deps.isTurnRunning(sessionId);
    } catch (err) {
      log.warn('live turn-state lookup failed during abort reconciliation', {
        sessionId,
        source,
        error: errorMessage(err),
      });
    }

    // Claude can release its queue lock as soon as abort settles, but keep the
    // boundary token while the live turn is still running so a delayed idle
    // reconciliation can clear stale tracker state without touching a newer
    // turn. Codex keeps queueAbortPending until idle is authoritative.
    //
    // During an owner-boundary replacement the agent kind can temporarily be
    // unknown. That is not proof that the boundary is gone: keep retrying while
    // the queue lock or live turn says work may still exist, but remain
    // fail-closed until a later reconciliation proves the Session is idle.
    const shouldRetry = current.queueAbortPending || liveTurnRunning;
    if (agentKind === 'claude-code' && (current.queueAbortPending || current.activeTurn !== null)) {
      this.releaseAbortLockAndDrain(sessionId, 'abort-promise', {
        clearActiveTurn: true,
        preserveAbortBoundaryToken: shouldRetry,
      });
    }
    if (shouldRetry) {
      this.scheduleAbortReconcileRetry(
        sessionId,
        current,
        abortBoundaryGeneration,
        abortBoundaryToken,
      );
    } else if (!current.queueAbortPending && current.activeTurn === null) {
      // Nothing remains that this stop boundary can own. Do not leave a stale
      // token behind after the one-shot Claude cleanup path has completed.
      current.abortBoundaryToken = null;
    }
  }

  private scheduleAbortReconcileRetry(
    sessionId: string,
    state: SessionInputState,
    abortBoundaryGeneration: number,
    abortBoundaryToken: symbol,
  ): void {
    if (state.abortReconcileRetryTimer) return;
    state.abortReconcileRetryTimer = setTimeout(() => {
      const current = this.states.get(sessionId);
      if (current === state) current.abortReconcileRetryTimer = null;
      if (
        current !== state ||
        current.generation !== abortBoundaryGeneration ||
        current.abortBoundaryToken !== abortBoundaryToken
      ) {
        return;
      }
      this.reconcileAbortBoundary(
        sessionId,
        current,
        abortBoundaryGeneration,
        abortBoundaryToken,
        'abort-retry',
      );
    }, SESSION_RUNNING_RETRY_DELAY_MS);
  }

  private clearAbortReconcileRetry(state: SessionInputState): void {
    if (state.abortReconcileRetryTimer) {
      clearTimeout(state.abortReconcileRetryTimer);
    }
    state.abortReconcileRetryTimer = null;
  }

  private registerSteerAbortController(
    sessionId: string,
    clientId: string,
    controller: AbortController,
  ): void {
    let byClientId = this.steerAbortControllers.get(sessionId);
    if (!byClientId) {
      byClientId = new Map<string, AbortController>();
      this.steerAbortControllers.set(sessionId, byClientId);
    }
    byClientId.set(clientId, controller);
  }

  private clearSteerAbortController(
    sessionId: string,
    clientId: string,
    expectedController?: AbortController,
  ): void {
    const byClientId = this.steerAbortControllers.get(sessionId);
    if (!byClientId) return;
    if (expectedController && byClientId.get(clientId) !== expectedController) return;
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

  private beginSteerRequest(sessionId: string, clientId: string): symbol {
    const token = Symbol('agent-input-steer-request');
    let byClientId = this.steerRequestLineages.get(sessionId);
    if (!byClientId) {
      byClientId = new Map();
      this.steerRequestLineages.set(sessionId, byClientId);
    }
    const existing = byClientId.get(clientId);
    if (existing) {
      existing.latestToken = token;
      existing.unsettledTokens.add(token);
    } else {
      byClientId.set(clientId, { latestToken: token, unsettledTokens: new Set([token]) });
    }
    return token;
  }

  private isLatestSteerRequest(sessionId: string, clientId: string, token: symbol): boolean {
    return this.steerRequestLineages.get(sessionId)?.get(clientId)?.latestToken === token;
  }

  private settleSteerRequest(sessionId: string, clientId: string, token: symbol): void {
    const byClientId = this.steerRequestLineages.get(sessionId);
    const lineage = byClientId?.get(clientId);
    if (!byClientId || !lineage) return;
    lineage.unsettledTokens.delete(token);
    // Keep latestToken as a tombstone while an older callback is still pending. Otherwise a
    // replacement that settles first would make the old request look current again.
    if (lineage.unsettledTokens.size > 0) return;
    byClientId.delete(clientId);
    if (byClientId.size === 0) this.steerRequestLineages.delete(sessionId);
  }

  private touchUserSend(sessionId: string, atMs?: number): void {
    void touchUserSendInDb(sessionId, atMs).catch((err) => {
      log.warn('touchUserSend failed', { sessionId, error: errorMessage(err) });
    });
  }

  private clearErrorUnlessQueueHeadBlocked(
    state: SessionInputState,
    explicitClientId?: string,
  ): void {
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
   * 用户后续动作放弃 active-turn 重试入口。错误的本质是
   * "上一条消息执行失败了",用户此后**主动发出的新消息**(composer 发送 / 插话
   * 回落派发)就是对"要不要重试"的表态 —— 清掉错误横幅与重试入口,让新消息正常
   * 派发,不再默默排队等一个可能没被注意到的重试按钮。失败消息已落库、仍在会话
   * 里可手动重发;「重试」按钮与新输入赛跑时后到的 retryLastError 读到
   * recovery=null 即 no-op,无双发风险。
   * 手动 compact 同样表达"先压缩而非重试上一轮":必须先清 recovery,再按真实
   * dispatch boundary 决定立即派发或排队,否则上下文耗尽后的空闲会话会被误报 busy。
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
  private abandonActiveTurnRecoveryForUserAction(state: SessionInputState): void {
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

  private movePendingCompactWaitClientIdToFront(state: SessionInputState, clientId: string): void {
    state.pendingCompacts = state.pendingCompacts.map((entry) => ({
      ...entry,
      waitForClientIds: [clientId, ...entry.waitForClientIds.filter((id) => id !== clientId)],
    }));
  }

  /**
   * **唯一的 active-turn recovery 出口。**任何终态路径想留「重试上一轮」入口都必须经这里,
   * 不要再直接写 `state.recovery = { kind: 'active-turn', ... }`。
   *
   * Schedule 的确定性失败仍不留人工 Retry（runner 已记账）；只有候选瞬时错误允许
   * 暂时保留 recovery，交给与普通聊天相同的自动续跑路径。
   *
   * @returns `kept` = 留下了;`dropped-scheduler` = 因 scheduler 来源被摘掉,此时队列少了
   * 「用户点 clearError / Retry」这个唤醒源,调用方通常要补一次 scheduleDrain(Stop 那条
   * 刻意不补,见调用处);`no-item` = 控制类 turn 本就没有可重试的消息,行为与改造前一致
   * (不留 recovery 也不唤醒)。三态刻意分开:合成布尔会让 no-item 混进需要唤醒的那一类,
   * 悄悄改掉控制类 turn 的既有行为。
   */
  private setActiveTurnRecovery(
    state: SessionInputState,
    item: AgentInputQueuedMessage | null | undefined,
    opts?: { allowSchedulerAutoResume?: boolean },
  ): 'kept' | 'dropped-scheduler' | 'no-item' {
    if (!item) {
      state.recovery = null;
      return 'no-item';
    }
    if (isSchedulerOriginItem(item) && !opts?.allowSchedulerAutoResume) {
      state.recovery = null;
      return 'dropped-scheduler';
    }
    state.recovery = { kind: 'active-turn', item };
    return 'kept';
  }

  /**
   * 问 host「这个可续跑的 turn 失败要不要由自愈接管」。
   *
   * @returns true = host 已接管(它会在退避后调 autoRetryLastError);此时调用方**不设**
   * state.error,红横幅留给最终失败。host 未注入、抛异常或拒绝接管都返回 false，退回
   * 常规错误呈现 —— 自愈是增强,不能因为它的实现问题让失败无声无息。
   */
  private notifyResumableTurnError(
    sessionId: string,
    item: AgentInputQueuedMessage,
    message?: string,
    signals?: Omit<InterruptedTurnErrorSignals, 'message'>,
  ): AutoResumeInfo | null {
    if (!this.deps.onResumableTurnError) return null;
    try {
      return (
        this.deps.onResumableTurnError(sessionId, { ...(signals ?? {}), message }, item) ?? null
      );
    } catch (err) {
      log.warn('onResumableTurnError failed', { sessionId, error: errorMessage(err) });
      return null;
    }
  }

  /**
   * host 放弃自愈（补发被抢先、派发失败、或退避窗口内目标已消失）→ 清接管态，并把当初
   * 压住的错误回落成常规呈现（横幅 + 「继续任务」）。
   *
   * `message` 省略时只清接管态：那对应「用户自己已经接手」（recovery 也已被清），此时
   * 再弹一条横幅只会打扰他。
   */
  /**
   * 自愈是否仍在接管中（退避窗口内、还没补发）。
   *
   * host 用它决定「这条 error 行要不要落库」——判据必须是 coordinator 的实时状态而不是
   * host 自己的标记：退避期间用户可能已经自己发了消息（enqueue 会清接管态），那之后新
   * turn 的失败必须照常落库，不能被上一次的接管标记连带压住。
   */
  isAutoResumePending(sessionId: string): boolean {
    return this.getState(sessionId).autoResumePending !== null;
  }

  getAutoResumeAttemptToken(sessionId: string): number | null {
    return this.getState(sessionId).autoResumeAttemptToken;
  }

  /** Exact owner for a deferred resumable terminal error, before it is decided. */
  getAutoResumeDeferredOwner(sessionId: string): SuppressedTurnErrorOwner | null {
    const active = this.getState(sessionId).activeTurn;
    if (!active?.item) return null;
    const pending = active.pendingTerminalEvent;
    if (pending?.type !== 'error' || pending.resumableCandidate !== true) {
      return null;
    }
    return { generation: active.generation, clientId: active.item.clientId };
  }

  isAutoResumeAttemptCurrent(sessionId: string, attemptToken: number): boolean {
    return this.getState(sessionId).autoResumeAttemptToken === attemptToken;
  }

  /**
   * 有一条 terminal error 正被「可能接管」按住、还没走到决策（见
   * `isResumableTurnErrorCandidate` 与 `ActiveTurnTerminalEvent.resumableCandidate`）。
   *
   * host 用它把 error 行的落库也一起推迟到决策之后：不推迟的话，「error 早于持久化完成」
   * 的时序下 error 行会先落库、接管随后成功，历史里就同时留下错误卡和重连行，
   * 而且已经落库的那条压不回去了（codex P1）。
   */
  isAutoResumeDeferred(sessionId: string): boolean {
    const pending = this.getState(sessionId).activeTurn?.pendingTerminalEvent;
    return pending?.type === 'error' && pending.resumableCandidate === true;
  }

  /** 纯判定包装：host 未注入或抛异常都返回 false（自愈是增强，坏了也不能改变错误呈现）。 */
  private isResumableTurnErrorCandidate(
    sessionId: string,
    message?: string,
    signals?: Omit<InterruptedTurnErrorSignals, 'message'>,
  ): boolean {
    if (!this.deps.isResumableTurnErrorCandidate) return false;
    try {
      return this.deps.isResumableTurnErrorCandidate({ ...(signals ?? {}), message }) === true;
    } catch (err) {
      log.warn('isResumableTurnErrorCandidate failed', { sessionId, error: errorMessage(err) });
      return false;
    }
  }

  /**
   * 这个 turn 不会再走到接管决策了（派发失败 / 落库失败 / SESSION_RUNNING 让位）→ 把按住的
   * error 候选就地作废：清标记（否则 `isAutoResumeDeferred` 会一直为真，把后续无关错误的
   * error 行也压掉）并通知 host 补落那一行（不变量 I2）。非候选或没有暂存事件时是 no-op。
   */
  /**
   * activeTurn 已被顶替（同轮 steer 被接受 / 新 turn 起来了）时的收尾。
   *
   * 这条路上的每个 `isActiveTurnCurrent` 早返都会**跳过**下方所有清理，而 host 那边 error 行
   * 早就被「可能接管」压住了 —— 不在早返之前补落，那次中断在历史里彻底消失、压住的详情
   * 也一直悬着（codex P1）。`active` 是被顶替的那个对象，它自己还拿着 pendingTerminalEvent。
   *
   * 返回 true 表示"已经不是当前 turn，调用方该早返了"。
   */
  private discardOnStaleActiveTurn(
    sessionId: string,
    active: ActiveTurn,
    dispatchAccepted = false,
  ): boolean {
    if (this.isActiveTurnCurrent(sessionId, active)) return false;
    if (active.item?.autoResume) {
      if (dispatchAccepted) {
        this.commitAutoResumeDispatch(sessionId, active.item);
      } else {
        this.discardAutoResumeBeforeDispatch(sessionId, active.item);
      }
    }
    this.discardDeferredResumableCandidate(sessionId, active, { surfaceError: false });
    return true;
  }

  private discardDeferredResumableCandidate(
    sessionId: string,
    active: ActiveTurn,
    options: { surfaceError: boolean } = { surfaceError: true },
  ): void {
    const pending = active.pendingTerminalEvent;
    if (pending?.type !== 'error' || pending.resumableCandidate !== true) return;
    const owner = active.item
      ? { generation: active.generation, clientId: active.item.clientId }
      : null;
    active.pendingTerminalEvent = null;
    if (owner) this.notifyResumableTurnErrorDiscarded(sessionId, { ...options, owner });
  }

  /** 被按住的 error 没能走到决策 → 通知 host 补落 error 行（不变量 I2）。 */
  private notifyResumableTurnErrorDiscarded(
    sessionId: string,
    options: { surfaceError: boolean; owner: SuppressedTurnErrorOwner },
  ): void {
    try {
      this.deps.onResumableTurnErrorDiscarded?.(sessionId, options);
    } catch (err) {
      log.warn('onResumableTurnErrorDiscarded failed', { sessionId, error: errorMessage(err) });
    }
  }

  abandonAutoResume(sessionId: string, message?: string, attemptToken?: number): void {
    const state = this.getState(sessionId);
    if (attemptToken !== undefined && state.autoResumeAttemptToken !== attemptToken) {
      return;
    }
    const hadPendingTakeover = state.autoResumePending !== null;
    state.autoResumePending = null;
    state.autoResumeAttemptToken = null;
    const cancelledPrepared = this.cancelPreparedAutoResume(sessionId, state);
    const surfacedMessage = Boolean(message && state.recovery);
    if (surfacedMessage) state.error = message ?? null;
    // cancelPreparedAutoResume 已为队列 / active 变化 emit；纯退避态仍需
    // 单独投影接管结束。没有任何接管状态时保持既有 no-op 语义。
    if (!cancelledPrepared && (hadPendingTakeover || surfacedMessage)) this.emit(sessionId);
  }

  private notifyUndispatchedUserTurn(
    sessionId: string,
    item: AgentInputQueuedMessage,
    disposition: 'cancelled' | 'failed',
  ): void {
    try {
      this.deps.onUndispatchedUserTurn?.(sessionId, item, disposition);
    } catch (err) {
      log.warn('onUndispatchedUserTurn failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private notifyUserMessagePersisted(sessionId: string, item: AgentInputQueuedMessage): void {
    try {
      this.deps.onUserMessagePersisted?.(sessionId, item);
    } catch (err) {
      log.warn('onUserMessagePersisted failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private notifyUserMessageQueryable(sessionId: string, item: AgentInputQueuedMessage): void {
    try {
      this.deps.onUserMessageQueryable?.(sessionId, item);
    } catch (err) {
      log.warn('onUserMessageQueryable failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private notifyUserMessagePersisting(sessionId: string, item: AgentInputQueuedMessage): void {
    try {
      this.deps.onUserMessagePersisting?.(sessionId, item);
    } catch (err) {
      log.warn('onUserMessagePersisting failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private notifyUserMessagePersistenceFailed(
    sessionId: string,
    item: AgentInputQueuedMessage,
    opts: { retainForRetry: boolean },
  ): void {
    try {
      this.deps.onUserMessagePersistenceFailed?.(sessionId, item, opts);
    } catch (err) {
      log.warn('onUserMessagePersistenceFailed failed', {
        sessionId,
        clientId: item.clientId,
        error: errorMessage(err),
      });
    }
  }

  private notifyRejectedUserTurn(sessionId: string, item: AgentInputQueuedMessage): void {
    try {
      this.deps.onRejectedUserTurn?.(sessionId, item);
    } catch (err) {
      log.warn('onRejectedUserTurn failed', {
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

  private async persistAcceptedUserMessage(
    sessionId: string,
    active: ActiveTurn,
  ): Promise<PersistAcceptedUserMessageResult> {
    const item = active.item;
    if (!item) return 'failed';
    if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
    const sdkSessionId = await this.deps.getSdkSessionId(sessionId).catch(() => undefined);
    const transcriptParentUuid = this.deps.getLastAssistantTranscriptUuid?.(sessionId);
    if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
    this.notifyUserMessagePersisting(sessionId, item);
    try {
      const createUserMessage = this.deps.createUserMessage ?? createDbMessage;
      await createUserMessage(
        sessionId,
        {
          clientId: item.clientId,
          role: 'user',
          content: item.persistedContent,
          agentMeta: {
            uuid: active.messageUuid,
            sdkSessionId,
            delivery: active.delivery,
            ...(transcriptParentUuid ? { transcriptParentUuid } : {}),
          } as never,
        },
        {
          shouldBroadcast: () => this.isTurnGenerationCurrent(sessionId, active),
          expectedClearBoundaryMs: active.clearBoundaryMs,
        },
      );
      // Persistence is the ownership boundary for staged media. Do this
      // before the generation check so a clear racing the DB write cannot
      // clean up a file that the row now references.
      this.notifyUserMessagePersisted(sessionId, item);
      const current = this.getState(sessionId);
      if (
        current.clearBoundaryMs !== active.clearBoundaryMs ||
        current.generation !== active.generation
      ) {
        try {
          await this.deps.rewindPersistedUserMessageAfterClear?.(sessionId, item.clientId);
        } catch (err) {
          // The clear generation still prevents stale in-memory state from
          // proceeding. Keep the cleanup best-effort so a transient rewind
          // failure cannot turn an accepted vendor input into a duplicate retry.
          log.warn('rewind stale user row after clear failed', {
            sessionId,
            clientId: item.clientId,
            error: errorMessage(err),
          });
        }
      }
      if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
      active.persisted = true;
      active.persisting = false;
      this.notifyUserMessageQueryable(sessionId, item);
      // 同 drain onPersisted:steer 消息落库后立即收窄快照,避免长 turn 内崩溃二次恢复。
      this.maybePersistQueueSnapshot(sessionId);
      this.settlePendingTerminalEventAfterPersist(sessionId, active);
    } catch (err) {
      this.notifyUserMessagePersistenceFailed(sessionId, item, {
        retainForRetry: false,
      });
      if (!this.isTurnGenerationCurrent(sessionId, active)) return 'stale';
      const state = this.getState(sessionId);
      state.error = `Failed to persist user message: ${errorMessage(err)}`;
      state.stickyError = state.error;
      state.recovery = null;
      active.persisting = false;
      const terminalEvent = active.pendingTerminalEvent;
      const releasedTerminalBoundary = Boolean(
        terminalEvent && this.isActiveTurnCurrent(sessionId, active),
      );
      if (releasedTerminalBoundary) {
        // 这条 error 永远走不到接管决策了(steer 消息落库失败,recovery 也已清)。它的 error 行
        // 在 host 侧被「可能接管」压住了,必须补落,否则那次中断在历史里彻底消失(I2)。
        // 横幅这里已经由 persist 失败自己占着,host 补落时不再叠加。
        this.discardDeferredResumableCandidate(sessionId, active);
        active.pendingTerminalEvent = null;
        state.activeTurn = null;
      }
      this.emit(sessionId);
      if (releasedTerminalBoundary)
        this.scheduleDrain(sessionId, 'failed-persist-after-deferred-terminal');
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
      // 第五条终态路径:终态 error 在持久化还在进行时到达 → 被暂存,落库完成后才在这里
      // 结算。Schedule 只在候选瞬时错误上短暂保留 recovery，复用普通自动续跑；
      // 确定性错误仍由 runner 收口，不留下脱离 run 记账的人工 Retry。
      // 被按住的 error 最终没能接管(recovery 没留住 / host 拒绝接管)时,统一在本方法里
      // 通知 host 补落 error 行 —— 出口有三个(dropped-scheduler、非 kept、拒绝接管),
      // 集中在这里判比让 host 在每个 null 返回点各自记得补落更难漏(不变量 I2)。
      const deferredPersistSuppressed = terminalEvent.resumableCandidate === true;
      const schedulerItem = active.item && isSchedulerOriginItem(active.item);
      const outcome = this.setActiveTurnRecovery(state, active.item, {
        allowSchedulerAutoResume: Boolean(schedulerItem && deferredPersistSuppressed),
      });
      if (outcome === 'dropped-scheduler') {
        state.error = terminalEvent.message ?? state.error;
        if (deferredPersistSuppressed) {
          this.notifyResumableTurnErrorDiscarded(sessionId, {
            surfaceError: true,
            owner: { generation: active.generation, clientId: active.item!.clientId },
          });
        }
        // 与 onTurnEvent 的 persisted 分支同款处置:没有 recovery 挡住"紧随的 done",
        // 必须用配对标记吃掉它,否则失败呈现会被 done 擦成"已完成"(第二十一轮 P1)。
        // recovery 不留 → 没有"用户点 clearError / Retry"这个唤醒源,队里压着的消息
        // 得自己唤一次(等派发边界真空出来再跑)。
        this.markPendingExternalTerminalDone(sessionId, state);
        this.emit(sessionId);
        this.scheduleDrainAfterExternalTurnSettles(sessionId, 'scheduler-prompt-terminal-error');
        return;
      }
      // 与 onTurnEvent 的 persisted 分支对称:两条留 recovery 的 error 路径都要给 host
      // 接管自愈的机会(含"接管时不设 error"这一条),否则「error 早于持久化完成」的时序
      // 下自愈会静默失效、或者先闪一帧红横幅。
      // 候选窗口里用户已经自己接手 → **不问接管**(连额度都不消耗),回落成常规错误呈现:
      // 横幅 + 「继续任务」交回用户,由他决定要不要续跑(greptile P1)。
      const deferredTakeover =
        outcome === 'kept' && active.item && terminalEvent.supersededByUser !== true
          ? this.notifyResumableTurnError(
              sessionId,
              active.item,
              terminalEvent.message,
              terminalEvent.signals,
            )
          : null;
      if (deferredTakeover) {
        state.autoResumePending = deferredTakeover;
        state.autoResumeAttemptToken = deferredTakeover.sessionTotal;
        // **必须撤掉 error**:候选判定为假时前置分支(active.persisting)照旧设过 state.error,
        // 接管后若不清,renderer 会收到同时带 error 与 autoResumePending 的投影 —— 违反
        // 「接管态为真时 error 必为 null」这条不变量(greptile P1)。候选判定为真时那里本就
        // 没设,这行是幂等的兜底。
        state.error = null;
      } else {
        state.error = terminalEvent.message ?? state.error;
        if (deferredPersistSuppressed) {
          this.notifyResumableTurnErrorDiscarded(sessionId, {
            surfaceError: terminalEvent.supersededByUser !== true,
            owner: { generation: active.generation, clientId: active.item!.clientId },
          });
        }
        if (schedulerItem) {
          state.recovery = null;
          this.markPendingExternalTerminalDone(sessionId, state);
          this.emit(sessionId);
          this.scheduleDrainAfterExternalTurnSettles(sessionId, 'scheduler-prompt-terminal-error');
          return;
        }
      }
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
