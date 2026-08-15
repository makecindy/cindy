/**
 * main/im/shared/turnRunner.ts
 * ---------------------------------------------------------------------------
 * IM 渠道无关的 agent turn 编排(原 im/feishu/runAgentTurn.ts 工厂化)。
 * Per (botContextId, userId):
 *
 *   1. find / create 渠道 session row (sessionRepo)
 *   2. ensure the in-process Maker session exists (maker.createSession reuses
 *      by id if storage row exists)
 *   3. attach event listener (per-session, once) → routes text events to
 *      the active turn's StreamingTextHandle
 *   4. attach interaction listener (per-session, once) → builds card via
 *      cardBuilders, sends via im.sendInteractiveCard, awaits via
 *      pendingInteractions, returns InteractionDecision
 *   5. push the user message via session.send
 *
 * Turn 路由：一个 in-process session 只有一条事件流。queue[0] 是已经 dispatch
 * 的 active turn；done/error 到达后 shift。
 *
 * 消息排队：turn 进行中（本 session 的本渠道 turn 未收口 / 接管模式下 desktop
 * 侧发起的 turn 正在跑）收到的新消息进 sendQueue 排队，当前 turn done/error 后
 * 按 FIFO 自动 dispatch —— 不再以 SESSION_RUNNING pre-dispatch failure 报错打回。
 * desktop 侧 turn 的 done/error 在本渠道这边没有对应 TurnState（stray event），
 * 同样被当作"session 空闲"信号触发派发。SESSION_RUNNING 竞态（pre-check 时
 * idle、send 时另一端恰好抢先开 turn）退回队首，等下一个 done 或 retry timer。
 *
 * 工厂化说明: createTurnRunner(adapter, repo, cards) 闭包持有 per-channel 的
 * sessionStates / wiringInFlight — 两个渠道接管同一个 desktop session 时各自
 * 维护自己的事件钩子状态, 互不干扰(与 desktop+feishu 并存的 multi-listener
 * 语义一致)。
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * 群里的授权卡改投宿主私聊时, 加在卡片正文顶部的说明。
 *
 * 放在这一层(desktop main)而不是 @cindy/im: 传输层没有 locale、也不该持有产品措辞。
 * 与个人 bot 其它 bot 侧文案(im/telegram/uiText.ts)同口径 —— 那一整套目前是单语中文,
 * 见该文件头部说明; 若要做多语言应连同整套一起改, 不在这一句上开特例。
 */
const GROUP_APPROVAL_OWNER_DM_NOTE =
  '🔐 群聊里的任务需要你授权。授权卡不会发到群里，在这里确认即可。';

import { eq } from 'drizzle-orm';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';
import {
  isProductTurnDoneEvent,
  isTurnContinuationBoundaryEvent,
} from '@cindy/maker-shared/turn-continuation';
import { getMaker } from '../../maker-host';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { isCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import {
  sanitizeSendOutcomeError,
  toDesktopSessionDispatchOutcome,
  type SanitizedSendOutcomeError,
} from '../../maker-host/send-outcome';
import { getDbClient } from '../../localDb/client/current';
import { sessions as sessionsTable } from '../../localDb/schema';
import { hydrateSessionProvider } from '../../maker-host/session-provider-store';
import { setSessionEffort, setSessionFastMode } from '../../maker-host/session-effort-store';
import { hasCustomProviderKey } from '../../maker-host/provider-route';
import { createLogger } from '../../logger';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { beginHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface.js';

import {
  isTerminalAgentErrorEvent,
  TurnPermissionPolicyUnsupportedError,
} from '@cindy/maker-core';
import type {
  AgentEvent,
  AgentKind,
  InteractionDecision,
  InteractionRequest,
  PermissionMode,
  PermissionModeDescriptor,
  Session as MakerSession,
  TurnPermissionPolicy,
  UserMessage,
} from '@cindy/maker-core';
import type { IMAttachment, InteractiveCardSpec, StreamingTextHandle } from '@cindy/im';

import { persistUserMessage } from '../messagePersistence';
import { bindingStore } from '../binding';
import { buildImUserMessage } from './inboundMessage';
import {
  beginTurnChangeSetAtDispatch,
  wireSessionToIpcExternal,
  takePendingInteractionsForSession,
  noteSilentStopUserSend,
  noteSilentStopSessionReset,
  onSilentStopSettled,
} from '../../maker-ipc/register';
import { clearPendingTurnChangeSets } from '../../turn-change-set/store';
import {
  beginInteractionRoute,
  type InteractionRouteLease,
} from '../../maker-ipc/interactionRouter';
import { beginGroupHistoryAccess, type GroupHistoryAccessScope } from './groupHistoryAccess';
import { agentHandoffPending } from '../../maker-ipc/agentHandoffPendingSingleton';
import { prependHandoffToUserMessage, prependNoteToWireUserMessage } from '../../maker-ipc/agentHandoff';
import { buildPlanReconcileNote, summarizeOpenPlan } from '../../maker-ipc/planReconcile';
import { listMessagesForAgentHandoff } from '../../localDb/ipc/messages';
import { enqueueDurableWrite } from '../../messagePersistBroadcaster';
import {
  cancelPending,
  registerPending,
  registerPendingExternal,
  rejectAllPending,
} from './pendingInteractions';
import { checkChannelDestructiveToolCall } from './channelToolPolicy';
import { readXdGatewayApiKey } from './apiKey';
import {
  hasAuthForImRoute,
  checkImRouteAuthDetailed,
  listProvidersForAuth,
  type ImAuthRouteStatus,
  type ImAuthCheckDeps,
} from './authCheck';
import {
  FBOT_DRAFT_TITLE,
  FBOT_TITLE_PREFIX,
  generateAndPersistFbotTitle,
  generateImSessionTitleText,
  persistGeneratedSessionTitle,
} from './fbotTitle';
import { materializeLocalMarkdownImages } from './localMarkdownImages';
import {
  createTurnActivity,
  markActivityWriting,
  pushToolStep,
  renderActivity,
  setActivityNotice,
  type TurnActivityState,
} from './turnActivity';
import { terminalErrorText, turnRetryNotice } from './turnRetryNotice';
import { createTurnPresenter, DEFAULT_PRESENTER_POLICY, type TurnPresenter } from './turnPresenter';
import {
  toCoreAgentKind,
  readPermissionMode,
  touchUserSent as repoTouchUserSent,
  updatePermissionMode,
  type ImSessionRepo,
  type ImSessionRow,
} from './sessionRepo';
import type { ImCardBuilders } from './cardBuilders';
import type { ImChannelAdapter } from './types';
import {
  changeSessionPermissionMode,
  type PermissionModeChangeResult,
} from './permissionModeControl';

const PRE_DISPATCH_ACK_CLEANUP_TIMEOUT_MS = 1500;
/** SESSION_RUNNING 竞态 / desktop turn 仍在跑时的兜底重试间隔。 */
const DISPATCH_RETRY_MS = 500;

interface TurnState {
  /** Stable identity used by the central interaction router for this turn. */
  turnId: string;
  userId: string;
  /** thread = session 模型的会话维度键(slack thread root ts);feishu undefined。 */
  scopeKey?: string;
  initialMessageText: string;
  /** First text-delta resolves this lazily (avoids creating a card for empty turns). */
  streamingHandle: StreamingTextHandle | null;
  /**
   * In-flight promise for the streaming handle creation. Singleton: when a
   * burst of deltas arrives before the channel returns the first message_id,
   * all callers await this same promise instead of each minting a new card.
   * Without it we get one card per delta — a flood of orphan cards.
   */
  streamingHandlePromise: Promise<StreamingTextHandle | null> | null;
  /**
   * 初始流式输出面创建失败(#2164)。置位后本轮不再重试 startStreamingText
   * (密集 delta 会造成 API 风暴 / 多张孤儿卡),已生成正文由 turn 收口一次性
   * 降级为普通文本发送,不再静默丢失。
   */
  streamingStartFailed: boolean;
  /**
   * 呈现大脑(正文累积 / 过程区合成), 与官方 bot 共用 im/shared/turnPresenter。
   * buffer-replace 策略: 保留个人 IM 渠道现有行为 —— isFinal 用该条全文整体替换
   * 累积缓冲, 流式增量追加。过程区时间线状态经 presenter.activity 暴露。
   */
  presenter: TurnPresenter;
  /** Managed images discovered in tool output for durable text channels. */
  mediaAbsPaths: string[];
  /** Current session root used to confine model-authored local file links. */
  workingDir: string;
  done: boolean;
  /** 过程区耗时刷新的低频 ticker(首个 tool_use 启动, 收口清除)。 */
  activityTicker: ReturnType<typeof setInterval> | null;
  outputCardMessageId: string | null;
  outputCardPrefix: string;
  onTurnComplete: (() => void) | null;
  /**
   * 渠道 message id of the user's incoming message that triggered this turn,
   * kept so we can remove the "processing" reaction once the turn finishes.
   * Null when the host didn't supply one (defensive — current paths always do).
   */
  userMessageId: string | null;
  /**
   * ack 调用返回的 pending reaction token。resolve 后拿到需要撤销的 token
   * （ack 自身失败则为 null）。各收口路径都走 cancelAckReaction，所以即使 ack
   * 在 turn 结束后才返回，也能撤掉这个 emoji。
   */
  ackReactionIdPromise: Promise<string | null> | null;
  /**
   * silent-stop done 后挂起等守卫决策的 settle 订阅退订函数(见
   * handleSilentStopDone)。非 null = 本 turn 正在等 settle / 已被自动续跑接管;
   * 真 done / error 收口与 cleanup 路径负责退订,防陈旧回调二次收口。
   */
  silentStopSettleUnsub: (() => void) | null;
  /**
   * 接管 desktop session 的 IM-owned turn 不能把 Setup interaction 错送到
   * desktop renderer。marker 严格跟本 TurnState 生命周期绑定；closed 防止
   * send 已失败/清理后迟到的 onAccepted 重新 acquire。
   */
  headlessSetupClosed: boolean;
  releaseHeadlessSetupTurn: (() => void) | null;
  /** Active central interaction route; acquired at beforeProviderStart. */
  interactionRouteLease: InteractionRouteLease | null;
  /**
   * Host turn lease held for the duration of a per-turn permission policy turn.
   * While held, session.setPermissionMode() blocks any switch into a mode the
   * agent lists as turnPermissionPolicy-unsupported (e.g. Pi Full Access),
   * closing the hot-switch bypass window. Released on every terminal / requeue /
   * cleanup path via releaseTurnInteractionRoute. Null when the turn has no policy.
   */
  hostTurnLeaseRelease: (() => void) | null;
  groupHistoryAccessRelease: (() => void) | null;
  /** Terminal classification consumed by chunked-text commitFinal. */
  terminalKind: 'done' | 'aborted' | 'error';
  terminalErrorCode: string | null;
  /** Whether a callback-bound text response has already been reserved. */
  chunkedReplyBegun: boolean;
  queueMode: 'internal' | 'external';
  terminalPromise: Promise<ImTurnTerminal>;
  resolveTerminal: ((terminal: ImTurnTerminal) => void) | null;
}

/**
 * 排队中的待 send 消息 — turn 进行中到达的渠道消息先进 SessionState.sendQueue,
 * 当前 turn done/error 后按 FIFO dispatch。turn 在 dispatch 成功前不进
 * state.queue(否则会被当成 queue[0] 抢走正在跑的 turn 的事件流)。
 */
interface QueuedSend {
  turn: TurnState;
  userMessage: UserMessage;
  rowId: string;
  text: string;
  attachments: IMAttachment[];
  /** 已给用户发过"排队中"提示 — 竞态 requeue 路径只提示一次。 */
  notified: boolean;
  queueMode: 'internal' | 'external';
  beforeProviderStart?: () => Promise<void>;
  /** Durable route side effects run only after provider acceptance, never on enqueue. */
  onRouteResolved?: (sessionId: string) => void | Promise<void>;
  turnPermissionPolicy?: TurnPermissionPolicy;
  /** 触发消息来自受保护群 —— 正文与附件不进会话存档(见 ImRunAgentTurnArgs)。 */
  protectedContent?: boolean;
  groupHistoryAccess?: GroupHistoryAccessScope;
}

type DetachDrainOutcome = 'rewire' | 'cancelled';

interface SessionState {
  /** Maker session (in-process). */
  makerSession: MakerSession;
  /** 渠道 user id of the bot's owner — kept here so listeners can address replies. */
  userId: string;
  /** 当前 session 的受管工作目录；本地生成图片仅允许从这里物化。 */
  workingDir: string;
  /** FIFO of turns. Events route to queue[0]; done/error shifts. */
  queue: TurnState[];
  /** 等待当前 turn 结束后再 send 的消息 — FIFO, 见模块头"消息排队"。 */
  sendQueue: QueuedSend[];
  /** thread = session 模型下该 session 对应的 thread root ts;feishu undefined。 */
  scopeKey?: string;
  /** SESSION_RUNNING 竞态后的兜底重试 timer — null 表示未挂。 */
  dispatchRetryTimer: ReturnType<typeof setTimeout> | null;
  /** Cleanup fns from session.onEvent / setInteractionListener. */
  unsubscribers: Array<() => void>;
  /**
   * Replacement detach waits for the current IM-owned turn to finish before
   * removing its event listener. New wiring for the same channel/session waits
   * on this promise instead of reusing the retiring state.
   */
  detachDrainPromise: Promise<DetachDrainOutcome> | null;
  resolveDetachDrain: ((outcome: DetachDrainOutcome) => void) | null;
  /**
   * true = 这个 session 是 desktop 那个 row 被本渠道接管 (C 状态);
   * false = 渠道默认 session (B' 状态)。
   * 影响 spawn 配置: attached=true 不传 vendorOptions (用 desktop 默认), 让
   * 接管期间 desktop 行为最少受影响; attached=false 走渠道 vendorOptions
   * 注入渠道专属 MCP (如 send_file_to_user)。
   */
  attached: boolean;
  /**
   * 自动任务(scheduler)在本(被接管的)session 上发起的 turn 的转播态。
   * 这类 turn 没有本渠道的 TurnState(走 stray 路径),为了让远程控制的用户在
   * thread 里看到"系统自动发了什么 + 步骤 + 结果",单独开一张卡转播。null = 当前
   * 没有进行中的自动任务转播。见 transpondScheduledEvent。
   */
  scheduledTranspond: ScheduledTranspond | null;
}

/**
 * 自动任务转播态(与用户 TurnState 完全隔离,避免回归 #118 的用户 turn 渲染)。
 * 复用 turnActivity 的纯函数 + streamingHandle 原语,但用自己的卡片与渲染。
 */
interface ScheduledTranspond {
  /** 任务展示名(来自事件 turnOrigin.scheduleName)。 */
  scheduleName: string | null;
  activity: TurnActivityState;
  activityTicker: ReturnType<typeof setInterval> | null;
  /** 自动任务这一轮 agent 的回复文本累加。 */
  buffer: string;
  streamingHandle: StreamingTextHandle | null;
  streamingHandlePromise: Promise<StreamingTextHandle> | null;
}

/**
 * 路由解析结果: 这次 turn 应该用哪个 session row, 是不是接管模式。
 *
 * 命中 binding → desktop session (attached=true);
 * 未命中 → 渠道默认 session (attached=false, B' 行为)。
 */
export interface RouteTarget {
  row: ImSessionRow;
  attached: boolean;
  /** 路由时使用的会话维度键(thread root ts)— 透传给出站回复定位 thread。 */
  scopeKey?: string;
  /** true = 这次路由新建了 session 行(thread 名片卡 / 标题生成的触发依据)。 */
  created?: boolean;
  /** true = 本次创建路径已经用同一份路由快照完成认证预检。 */
  authChecked?: boolean;
}

type DefaultRouteTargetResolution =
  | { target: RouteTarget; missingAuth?: never }
  | { target: null; missingAuth: ImAuthRouteStatus & { agentKind: AgentKind; model: string } };

export interface ImRunAgentTurnArgs {
  botContextId: string;
  userId: string;
  /** 渠道 message id of the user's incoming message — used for emoji ack. */
  userMessageId: string;
  text: string;
  attachments: IMAttachment[];
  /** thread = session 模型的会话维度键(slack);feishu 不传。 */
  scopeKey?: string;
  /**
   * 发给 agent 的正文覆盖(群上下文前缀拼装, 见 adapter.prepareAgentTurnText)。
   * 缺省 = text。落库(persistUserMessage)与标题生成恒用 text(渠道原文)。
   */
  agentText?: string;
  /**
   * 上下文附件(群历史里的图片/文件) —— 只拼进模型消息的 image/file
   * block, **不随用户消息落库、不进 transcript**。与 attachments(触发
   * 用户自己发的, 照常落库)是两条语义边界, 不可合并传参。
   */
  contextAttachments?: IMAttachment[];
  outputCardMessageId?: string;
  outputCardPrefix?: string;
  onTurnComplete?: () => void;
  /** Reports the concrete session only after the provider accepts this message. */
  onRouteResolved?: (sessionId: string) => void | Promise<void>;
  /** Keep fire-and-forget work inside the ingress account's drain boundary. */
  trackBackgroundTask?: (operation: () => Promise<void>) => void;
  /** Optional per-turn host policy (personal WeChat routes confirmations to Desktop). */
  turnPermissionPolicy?: TurnPermissionPolicy;
  /**
   * 这一轮的触发消息来自「禁止保存内容」的群。
   *
   * turn 照常跑 —— 用户 @ 机器人说的话是他此刻要说给 bot 的。但正文与附件
   * **不写进会话存档**: 群历史池已在渠道侧拦下, 存档不能成为绕过保护边界的
   * 第二条路径。缺省 = 未受保护(只有 Telegram 群会置它)。
   */
  protectedContent?: boolean;
  groupHistoryAccess?: GroupHistoryAccessScope;
}

export interface ImTurnTerminal {
  kind: 'done' | 'aborted' | 'error';
  text: string;
  completedAt: number;
  errorCode?: string;
}

export type ImTurnDispatch =
  | {
      kind: 'accepted';
      sessionId: string;
      acceptedAt: number;
      terminal: Promise<ImTurnTerminal>;
    }
  | {
      kind: 'busy' | 'rejected';
      reason: string;
    };

/** createTurnRunner 返回的编排实例 — per channel 一个。 */
export interface ImTurnRunner {
  runAgentTurn(args: ImRunAgentTurnArgs): Promise<void>;
  /**
   * Durable callers own their queue and receive an observable accepted/terminal
   * contract. Busy work is never copied into turnRunner's in-memory sendQueue.
   */
  dispatchAgentTurn(
    args: ImRunAgentTurnArgs & {
      queueMode: 'external';
      beforeProviderStart: () => Promise<void>;
    },
  ): Promise<ImTurnDispatch>;
  resolveRouteTarget(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<RouteTarget | null>;
  hasAuthForRoute(row: Pick<ImSessionRow, 'agentKind' | 'model' | 'providerId'>): Promise<boolean>;
  getAuthStatusForRoute?: (
    row: Pick<ImSessionRow, 'agentKind' | 'model' | 'providerId'>,
  ) => Promise<ImAuthRouteStatus>;
  prewireAttachedSession(botContextId: string, userId: string, scopeKey?: string): Promise<void>;
  /** 接管 detach 清理(原 detachFeishuFromSession)— binding cleanup hook 调用。 */
  detachFromSession(sessionId: string): void;
  disposeAllSessions(): Promise<void>;
  disposeOneSession(sessionId: string): Promise<void>;
  /** Get the live Maker Session for a given DB session id, or null. */
  getMakerSessionById(sessionId: string): MakerSession | null;
  /** Permission choices exposed by the session's concrete Agent implementation. */
  getPermissionModes(agentKind: AgentKind): PermissionModeDescriptor[];
  changePermissionMode(args: {
    sessionId: string;
    mode: PermissionMode;
    modes: readonly PermissionModeDescriptor[];
    confirmedFullAccess?: boolean;
  }): Promise<PermissionModeChangeResult>;
  /**
   * `!stop` 控制指令入口: 中止该路由 (bot, user[, scopeKey]) 对应 session 上
   * 正在跑的 turn, 并丢弃 sendQueue 里尚未派发的排队消息 — 不清队的话, abort
   * 触发的 done/error 会立刻把下一条排队消息派发出去, 违背"停下来等新指令"
   * 的语义。session 本身保持 active, 用户可继续发新消息。
   * 返回 stopped=false 表示该路由当前没有任何在跑/排队的任务(轻提示场景);
   * 该路径绝不新建 session 行。
   */
  stopActiveTurn(args: {
    botContextId: string;
    userId: string;
    scopeKey?: string;
  }): Promise<{ stopped: boolean; droppedQueued: number }>;
}

export interface ImTurnRunnerDeps {
  /** 锁住 session 并落实 deferred switch；IM 在刷新 live session + send 后 release。 */
  acquirePendingAgentSwitch?: (sessionId: string) => Promise<() => void>;
}

export function createTurnRunner(
  adapter: ImChannelAdapter,
  repo: ImSessionRepo,
  cards: ImCardBuilders,
  deps: ImTurnRunnerDeps = {},
): ImTurnRunner {
  const { im, output, ui, channel } = adapter;
  const richIm = output.kind === 'rich-card' ? output.im : null;
  /** 过程区耗时显示的低频刷新(5s)— 单个长工具调用期间状态行不冻结。 */
  const ACTIVITY_TICK_MS = 5_000;

  /**
   * patchMarkdownCard 的尾随节流间隔 — 对齐渠道 streamingText 的安全水位
   * (slack chat.update 1.3s / feishu patch 1.5s, 取保守值)。此前这里每个
   * delta 直接打一次 patch, 文本快答没事, 接入过程事件后会撞渠道限流。
   *
   * #1855 L1: 引用 PresenterPolicy 的单一出处 —— 与官方 turnObserver 的
   * trailing-edge 发射器同值同语义, 不再各写一个 1500 magic number。
   */
  const CARD_PATCH_THROTTLE_MS = DEFAULT_PRESENTER_POLICY.intermediateThrottleMs;

  const log = createLogger(`im:${channel}:turn`);

  const sessionStates = new Map<string /* localSessionId */, SessionState>();
  /** In-flight `ensureSessionWired` promises (keyed by sessionId). Prevents the
   *  classic race where two concurrent first-time runAgentTurn calls both miss
   *  the cache, both spawn a maker session, and the second clobbers the first
   *  in `sessionStates`. */
  const wiringInFlight = new Map<string, Promise<SessionState>>();
  /**
   * agent switch 主动 close 的旧 Session。只有对象身份和 close reason 都匹配才
   * 忽略；同一业务 sessionId 下的用户关闭或新引擎关闭必须照常清缓存。
   */
  const agentSwitchCloseSuppressed = new Map<string, { expectedSession: MakerSession }>();
  type MakerInstance = ReturnType<typeof getMaker>;
  let subscribedMaker: MakerInstance | null = null;
  let unsubscribeMakerEvents: (() => void) | null = null;

  function ensureMakerCloseSubscription(maker: MakerInstance): void {
    if (subscribedMaker === maker && unsubscribeMakerEvents) return;
    unsubscribeMakerEvents?.();
    subscribedMaker = maker;
    unsubscribeMakerEvents = maker.on((event) => {
      if (event.type !== 'session:closed') return;
      const suppression = agentSwitchCloseSuppressed.get(event.sessionId);
      if (suppression?.expectedSession === event.session && event.reason === 'agent-switch') return;
      forgetClosedSession(event.sessionId, 'maker session closed');
    });
  }

  async function resolveRouteTarget(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<RouteTarget | null> {
    const existing = await resolveExistingRouteTarget(botContextId, userId, scopeKey);
    if (existing) return existing;
    return (await createAuthenticatedDefaultRouteTarget(botContextId, userId, scopeKey)).target;
  }

  async function createAuthenticatedDefaultRouteTarget(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<DefaultRouteTargetResolution> {
    const providers = await listProvidersForAuth(authCheckDeps());
    const prepared = await repo.prepareNewSession(botContextId, userId, scopeKey, providers);
    const auth = await checkImRouteAuthDetailed(prepared, providers, authCheckDeps());
    if (!auth.ok) {
      return {
        target: null,
        missingAuth: { ...auth, agentKind: prepared.agentKind, model: prepared.model },
      };
    }
    const row = await repo.createSession(botContextId, userId, scopeKey, prepared);
    return { target: { row, attached: false, scopeKey, created: true, authChecked: true } };
  }

  async function resolveExistingRouteTarget(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<RouteTarget | null> {
    // 优先查 binding 是否命中 — bindingStore.get 走进程内 Map, 同步且 O(1)。
    // threadScoped 渠道的 binding 按 (identity, scopeKey) 维度存(多重接管)。
    const targetSessionId = bindingStore.get({
      channel,
      botContextId,
      userId,
      ...(scopeKey ? { scopeKey } : {}),
    });
    if (targetSessionId) {
      // 接管模式: 拉 desktop session 的 row 信息构造 ImSessionRow shape
      const db = getDbClient().drizzle;
      const rows = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, targetSessionId))
        .limit(1);
      const row = rows[0];
      if (row?.workingDir) {
        return {
          row: {
            id: row.id,
            agentKind: toCoreAgentKind(row.agentKind),
            workingDir: row.workingDir,
            model: row.model,
            effort: row.effort,
            permissionMode: row.permissionMode,
            fastMode: row.fastMode,
            sdkSessionId: row.sdkSessionId,
            providerId: row.providerId ?? null,
          },
          attached: true,
          scopeKey,
        };
      }
      // Binding 命中但 row 缺失 / workingDir 空 — 数据异常, fallback 到默认并清掉
      // 该 binding 避免反复异常 (FK CASCADE 应该已经处理 session 删除场景, 这里
      // 兜底处理 workingDir 缺失等怪状态)。
      log.warn(
        `binding hit but target session=...${targetSessionId.slice(-8)} missing/invalid — auto-detaching`,
      );
      void bindingStore.detach({
        channel,
        botContextId,
        userId,
        ...(scopeKey ? { scopeKey } : {}),
      });
    }
    // 未接管: 走渠道默认 session 路径(threadScoped 渠道按 scopeKey 一 thread
    // 一 session — 顶层消息的 own ts 必然查不到既有行, 自然落到新建)
    const found = await repo.findActiveSession(botContextId, userId, scopeKey);
    return found ? { row: found, attached: false, scopeKey, created: false } : null;
  }

  // ── public entry point ──────────────────────────────────────────────────────

  async function runAgentTurn(args: ImRunAgentTurnArgs): Promise<void> {
    await dispatchAgentTurnInternal({ ...args, queueMode: 'internal' });
  }

  async function dispatchAgentTurn(
    args: ImRunAgentTurnArgs & {
      queueMode: 'external';
      beforeProviderStart: () => Promise<void>;
    },
  ): Promise<ImTurnDispatch> {
    return dispatchAgentTurnInternal(args);
  }

  async function dispatchAgentTurnInternal(
    args: ImRunAgentTurnArgs & {
      queueMode: 'internal' | 'external';
      beforeProviderStart?: () => Promise<void>;
    },
  ): Promise<ImTurnDispatch> {
    const { botContextId, userId, userMessageId, text, attachments, scopeKey } = args;

    // 路由分流 — 先查 binding: 命中走 desktop session (接管模式 C),
    // 未命中走渠道默认 session (B' 行为)。这是 /ctr 接管能生效的关键入口。
    let target = await resolveExistingRouteTarget(botContextId, userId, scopeKey);
    if (!target) {
      const created = await createAuthenticatedDefaultRouteTarget(botContextId, userId, scopeKey);
      if (!created.target) {
        if (args.queueMode === 'internal') {
          await replyMissingAuth(userId, created.missingAuth, scopeKey);
        }
        return { kind: 'rejected', reason: 'missing_auth' };
      }
      target = created.target;
    }
    const row = target.row;
    if (!target.authChecked) {
      const auth = await checkImRouteAuthDetailed(row, undefined, authCheckDeps());
      if (!auth.ok) {
        if (args.queueMode === 'internal') {
          await replyMissingAuth(
            userId,
            { ...auth, agentKind: row.agentKind, model: row.model },
            scopeKey,
            target.attached,
          );
        }
        return { kind: 'rejected', reason: 'missing_auth' };
      }
    }
    // ── thread 名片卡(threadScoped 新 thread 会话)─────────────────────────
    // 在 bot 第一条回复之前发进 thread, 让用户第一眼理解"这个 thread = 一条
    // 独立会话";首条消息的 oneshot 标题生成完成后, 名片原地升级为正式标题
    // (见下方 maybeGenerateThreadSessionTitle)。失败不阻塞 turn。
    let threadHeaderCardId: string | null = null;
    const threadUiPack = adapter.ui.thread;
    if (
      richIm &&
      adapter.threadScoped &&
      threadUiPack &&
      !target.attached &&
      target.created &&
      target.scopeKey
    ) {
      try {
        const r = await richIm.sendInteractiveCard(
          userId,
          { ...threadUiPack.sessionHeaderCard, buttons: [] },
          { threadTs: target.scopeKey },
        );
        threadHeaderCardId = r.messageId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`thread header card send failed (non-fatal): ${msg}`);
      }
    }

    // Emoji ack so the user sees a "received" reaction immediately, before
    // the agent has had time to stream anything. Kick off in parallel with
    // session wiring; promise is parked on the turn so completeTurnCallback can
    // await it and remove the reaction once the turn finishes (regardless of
    // whether ack resolved before or after).
    const ackReactionIdPromise: Promise<string | null> | null = userMessageId
      ? ackProcessing(userMessageId)
      : null;

    let resolveTerminal!: (terminal: ImTurnTerminal) => void;
    const terminalPromise = new Promise<ImTurnTerminal>((resolve) => {
      resolveTerminal = resolve;
    });
    const turn: TurnState = {
      turnId: randomUUID(),
      userId,
      scopeKey: target.scopeKey,
      initialMessageText: text,
      streamingHandle: null,
      streamingHandlePromise: null,
      streamingStartFailed: false,
      presenter: createTurnPresenter({ mode: 'buffer-replace' }),
      mediaAbsPaths: [],
      workingDir: row.workingDir,
      done: false,
      activityTicker: null,
      outputCardMessageId: args.outputCardMessageId ?? null,
      outputCardPrefix: args.outputCardPrefix ?? '',
      onTurnComplete: args.onTurnComplete ?? null,
      userMessageId: userMessageId ?? null,
      ackReactionIdPromise,
      silentStopSettleUnsub: null,
      headlessSetupClosed: false,
      releaseHeadlessSetupTurn: null,
      interactionRouteLease: null,
      hostTurnLeaseRelease: null,
      groupHistoryAccessRelease: null,
      terminalKind: 'done',
      terminalErrorCode: null,
      chunkedReplyBegun: false,
      queueMode: args.queueMode,
      terminalPromise,
      resolveTerminal,
    };

    let state: SessionState;
    try {
      state = await ensureSessionWired(target, userId);
    } catch (err) {
      if (isCredentialModeSwitchBusyError(err)) {
        if (args.queueMode === 'internal') {
          await handleSessionWiringBusy(userId, turn);
        } else {
          await completeTurnCallbackAfterAck(turn);
        }
        return { kind: 'busy', reason: 'credential_mode_switch' };
      }
      throw err;
    }

    await repoTouchUserSent(row.id);

    // 接管 session 首条消息自动改 title — 对齐 desktop new maker (makerChatStore
    // 的 generateTitle 路径)。/ctr → New 创建出来的 session title 是 'FBot · New'
    // 草稿占位; 用户在渠道发出第一条文本消息时, 用消息文本调 oneshot 生成正式
    // title 'FBot · {gen}'。
    //
    // 触发条件:
    //   - target.attached: 只对接管 session 生效 (渠道默认 session 用自己的
    //     默认 title, 不参与)
    //   - text 非空: 仅附件无文本时无东西可总结, 跳过 (下一条带文本再触发)
    //   - 当前 title === FBOT_DRAFT_TITLE: title 还是草稿占位 → 这是首条消息
    //     (per-(bot,user) lock 保证不会有并发 turn, 检查 title 等价于 wasFirst)
    // 失败 swallow, 不阻塞主流程 (跟 desktop generateTitle 一致)。
    const startBackgroundTask =
      args.trackBackgroundTask ??
      ((operation: () => Promise<void>): void => {
        void operation();
      });
    // 受保护群的触发消息不能被总结成会话标题。标题是**长期记录**, 会一直挂在
    // 侧边栏上 —— 把「禁止保存内容」的正文摘要留在那里, 与把它写进 transcript
    // 是同一条边界被绕过, 而且主 turn 最终没被 provider 接受时照样会留下。
    // 宁可停在草稿标题。
    const titleFromText = args.protectedContent !== true;
    if (titleFromText && target.attached && text.trim().length > 0) {
      startBackgroundTask(() =>
        maybeGenerateFbotTitleOnFirstMessage(row.id, text, {
          botContextId,
          userId,
          scopeKey: target.scopeKey,
          workingDir: row.workingDir,
        }),
      );
    } else if (
      titleFromText &&
      text.trim().length > 0 &&
      (adapter.threadScoped
        ? target.created
        : adapter.sessions.skipOneshotTitleFor?.(userId) !== true &&
          adapter.sessions.generatedTitlePrefix !== undefined &&
          row.sdkSessionId == null)
    ) {
      // threadScoped 新 thread 会话: 用首条消息生成正式标题(渠道前缀),
      // 完成后把 thread 名片卡升级为「{正式标题}」。
      // 非 threadScoped 渠道(feishu/discord, 一 (bot,user) 一行长期复用):
      // 每条"新对话"的首条消息重新起名 —— sdkSessionId == null 即新上下文
      // (首次建行 / /new 重置后), 标题跟随当前话题而不是永远停在第一次。
      startBackgroundTask(() =>
        maybeGenerateImSessionTitle(row.id, userId, target.scopeKey, text, threadHeaderCardId),
      );
    }

    const item: QueuedSend = {
      turn,
      // contextAttachments 只进模型消息(跟在用户自己附件后面), 不进
      // item.attachments —— persistUserMessage 落库的只有触发用户发的附件。
      userMessage: buildImUserMessage(
        args.agentText ?? text,
        [...attachments, ...(args.contextAttachments ?? [])],
        target.attached,
      ),
      rowId: row.id,
      text,
      attachments,
      notified: false,
      queueMode: args.queueMode,
      ...(args.beforeProviderStart ? { beforeProviderStart: args.beforeProviderStart } : {}),
      ...(args.onRouteResolved ? { onRouteResolved: args.onRouteResolved } : {}),
      ...(args.turnPermissionPolicy ? { turnPermissionPolicy: args.turnPermissionPolicy } : {}),
      ...(args.protectedContent === true ? { protectedContent: true } : {}),
      ...(args.groupHistoryAccess ? { groupHistoryAccess: args.groupHistoryAccess } : {}),
    };

    // turn 进行中(本 session 的本渠道 turn 未收口 / sendQueue 已有人排队 /
    // 接管模式下 desktop 侧 turn 正在跑) → 入队等当前 turn 结束后按序自动 send,
    // 不再以 SESSION_RUNNING pre-dispatch failure 报错打回(对齐 desktop 排队体验)。
    if (
      state.queue.length > 0 ||
      state.sendQueue.length > 0 ||
      state.makerSession.isTurnRunning()
    ) {
      if (args.queueMode === 'external') {
        await completeTurnCallbackAfterAck(turn);
        return { kind: 'busy', reason: 'session_running' };
      }
      state.sendQueue.push(item);
      log.info(`queued message for session=${row.id.slice(-8)} position=${state.sendQueue.length}`);
      // 本渠道没有未收口的 turn(纯 desktop turn 在跑) → 派发只能靠它的 stray
      // done/error 触发;若该事件在 enqueue 前已送达(isTurnRunning 释放略晚于
      // 事件 fanout 的窄竞态)或被错过, 队列会永久卡住。挂兜底 timer 自愈 —
      // maybeDispatchNextQueued 发现仍在跑会自动续挂, 直到队列排空。
      if (state.queue.length === 0) {
        armDispatchRetry(state, userId);
      }
      await notifyQueuedPosition(userId, item, state.sendQueue.length);
      return { kind: 'busy', reason: 'queued_internally' };
    }

    const dispatch = await dispatchQueuedSend(state, userId, item);
    if (dispatch.kind !== 'accepted') return dispatch;
    return {
      kind: 'accepted',
      sessionId: row.id,
      acceptedAt: dispatch.acceptedAt,
      terminal: turn.terminalPromise,
    };
  }

  /**
   * 把一条消息真正 dispatch 给 maker session:turn 入 state.queue(事件流从此刻
   * 路由给它)、session.send(user message 落库挂在 onAccepted 钩子里)。
   *
   * user message 落库走 send 的 onAccepted 钩子而非 send 之前 — 只有消息真正
   * 通过 SESSION_RUNNING 守卫被接受后才写库。提前写的话, SESSION_RUNNING 竞态
   * requeue 时这条 user 消息已经落库, 而正在跑的那轮 assistant 输出之后才落,
   * transcript 顺序会变成"下一条 user 消息 → 上一轮 assistant 回答"。
   * persistUserMessage 内部吞错(仅 warn), 不会让 onAccepted 拒绝。
   * (同款先例: scheduler-host/runner.ts 的 onAccepted 落库。)
   *
   * SESSION_RUNNING 竞态(pre-check 时 idle, send 时另一端恰好抢先开 turn —
   * 典型: 接管模式下 desktop 排队消息和渠道排队消息在同一个 done 后争抢) →
   * 退回队首, 等下一个 done/error 或 retry timer 再派发, 不报错。
   */
  /**
   * 群护栏取缔(feishu): 渠道通过 turnPolicyOptionalForMode 声明「该权限档下
   * 强确认策略可选」时, dispatch 前按会话当前权限档决定是否真正挂策略 —
   * 返回 undefined = 不挂, maker 不再 fail-closed, 按用户显式选择直接执行。
   * 群上下文的防注入过滤与包裹独立于策略, 照常生效; 查档失败保持挂策略
   * (fail-closed 兜底)。其它渠道不实现该钩子, 行为不变。
   */
  async function resolveEffectiveTurnPolicy(
    item: QueuedSend,
  ): Promise<TurnPermissionPolicy | undefined> {
    if (!item.turnPermissionPolicy || !adapter.turnPolicyOptionalForMode) {
      return item.turnPermissionPolicy;
    }
    try {
      const row = await repo.peekSessionById(item.rowId);
      if (row && adapter.turnPolicyOptionalForMode(row.permissionMode)) {
        log.info(
          `turn policy skipped by channel (mode=${row.permissionMode}) session=${item.rowId.slice(-8)}`,
        );
        return undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`resolveEffectiveTurnPolicy peek failed (keep policy): ${msg}`);
    }
    return item.turnPermissionPolicy;
  }

  async function dispatchQueuedSend(
    state: SessionState,
    userId: string,
    item: QueuedSend,
  ): Promise<
    { kind: 'accepted'; acceptedAt: number } | { kind: 'busy' | 'rejected'; reason: string }
  > {
    const rowId = item.rowId;
    await beginChunkedReply(item.turn);
    // 过程区耗时基准取真实派发时刻 — TurnState 创建时可能还要在 sendQueue 里
    // 等上一轮跑完, 排队等待不该计入"第 N 步 · 耗时"显示
    item.turn.presenter.activity.startedAt = Date.now();
    state.queue.push(item.turn);
    log.info(
      `enqueued turn for session=${rowId.slice(-8)} queueDepth=${state.queue.length} pendingSends=${state.sendQueue.length}`,
    );
    let acceptedAt = 0;
    let turnChangeSetStarted = false;

    let releaseAgentSwitchLock = (): void => {};
    try {
      // deferred 切换会关闭旧 session。apply 成功后重新读取 maker 里的 live
      // session 并原地换绑 IM listener,确保当前这条消息发给目标引擎且队列不丢。
      if (deps.acquirePendingAgentSwitch) {
        const suppression = {
          expectedSession: state.makerSession,
        };
        agentSwitchCloseSuppressed.set(rowId, suppression);
        try {
          releaseAgentSwitchLock = await deps.acquirePendingAgentSwitch(rowId);
        } finally {
          agentSwitchCloseSuppressed.delete(rowId);
        }
        if (sessionStates.get(rowId) !== state) {
          throw new Error(`session ${rowId} closed while refreshing deferred agent switch`);
        }
        await refreshSessionAfterPendingAgentSwitch(state, rowId, userId);
      } else {
        await refreshSessionAfterPendingAgentSwitch(state, rowId, userId);
      }

      // session-agent-switch:本路径直发 session.send(不经 makerSendTransaction),
      // 交接注入自己接——切换后首条消息若来自 IM 渠道,新引擎同样需要交接上下文
      // (2026-07-20 审计)。落库(persistUserMessage)仍是渠道原文。
      const pendingHandoff = await agentHandoffPending.peek(rowId);
      const withHandoff = pendingHandoff
        ? prependHandoffToUserMessage(
            item.userMessage as Parameters<typeof prependHandoffToUserMessage>[0],
            pendingHandoff,
          )
        : item.userMessage;
      // 计划对账:IM 渠道续聊同样是"用户真的开口"的普通新轮次,与
      // makerSendTransaction 的注入同语义(未收口旧计划让 agent 顺手交代)。
      // IM 消息天然无斜杠控制/合成触发形态,来源即真人,免白名单分类;
      // 读库失败静默跳过,不挡发送。
      const planReconcileNote = await (async () => {
        try {
          // 与 register.ts 同口径:读排在持久化 FIFO 之后,不然会读到终态章/失败
          // 印记尚未落库的旧快照(review P2)。
          const rows = await enqueueDurableWrite(`plan-reconcile-read:${rowId}`, () =>
            listMessagesForAgentHandoff(rowId, 1000),
          );
          const summary = summarizeOpenPlan(rows);
          return summary ? buildPlanReconcileNote(summary) : null;
        } catch {
          return null;
        }
      })();
      const outgoingMessage = planReconcileNote
        ? prependNoteToWireUserMessage(
            withHandoff as Parameters<typeof prependNoteToWireUserMessage>[0],
            planReconcileNote,
          )
        : withHandoff;

      // 群护栏取缔(飞书): 按会话当前权限档决定是否真正挂强确认策略, 见
      // resolveEffectiveTurnPolicy。不挂时走与 DM 轮次相同的无策略路径。
      const effectiveTurnPolicy = await resolveEffectiveTurnPolicy(item);

      const sendResult = await state.makerSession.send(outgoingMessage as typeof item.userMessage, {
        planMode: false,
        ...(effectiveTurnPolicy ? { turnPermissionPolicy: effectiveTurnPolicy } : {}),
        beforeProviderStart: async () => {
          // 策略轮持一张 host turn lease:期间 setPermissionMode 切到 agent 声明为
          // turnPermissionPolicy-unsupported 的档位(如 Pi Full Access)会被阻塞到本轮
          // 终态,堵死"热切到 bypass 让 bridge 直接放行、策略连冒泡机会都没有"的绕过。
          // 两个 surface 都需要:channel 与 desktop 的策略同样必须扛住热切。
          if (effectiveTurnPolicy) {
            item.turn.hostTurnLeaseRelease = state.makerSession.acquireTurnLease();
          }
          if (item.groupHistoryAccess) {
            item.turn.groupHistoryAccessRelease = beginGroupHistoryAccess({
              sessionId: rowId,
              sessionInstanceId: state.makerSession.instanceId,
              scope: item.groupHistoryAccess,
            });
          }
          item.turn.interactionRouteLease =
            effectiveTurnPolicy?.confirmationSurface === 'desktop'
              ? beginInteractionRoute(state.makerSession, {
                  route: {
                    sessionId: rowId,
                    turnId: item.turn.turnId,
                    origin: effectiveTurnPolicy.origin,
                    interactionSurface: 'desktop',
                    ...(effectiveTurnPolicy.confirmationTimeoutMs
                      ? {
                          timeoutMs: effectiveTurnPolicy.confirmationTimeoutMs,
                        }
                      : {}),
                    ...(effectiveTurnPolicy.onInteractionStateChange
                      ? {
                          onStateChange: effectiveTurnPolicy.onInteractionStateChange,
                        }
                      : {}),
                  },
                })
              : beginInteractionRoute(state.makerSession, {
                  route: {
                    sessionId: rowId,
                    turnId: item.turn.turnId,
                    origin: effectiveTurnPolicy?.origin ?? { kind: 'im', channel },
                    interactionSurface: 'channel-card',
                    ...(effectiveTurnPolicy?.confirmationTimeoutMs
                      ? { timeoutMs: effectiveTurnPolicy.confirmationTimeoutMs }
                      : {}),
                    ...(effectiveTurnPolicy?.onInteractionStateChange
                      ? { onStateChange: effectiveTurnPolicy.onInteractionStateChange }
                      : {}),
                  },
                  handle: handleInteractionFor(
                    rowId,
                    userId,
                    state.scopeKey,
                    effectiveTurnPolicy?.confirmationTimeoutMs,
                  ),
                  // 文本渠道自己认领掉的不动卡片(它本来就没有卡);其余走
                  // dropInteractionCard —— 作废 pending 的同时把那张卡收口。
                  onCancel: (requestId, decision) =>
                    adapter.cancelTextInteraction?.(userId, requestId, decision) === true
                    || dropInteractionCard(
                      requestId,
                      'reason' in decision
                        ? decision.reason ?? 'interaction_route_released'
                        : 'interaction_route_released',
                    ),
                });
          await item.beforeProviderStart?.();
          acceptedAt = Date.now();
        },
        // B' 阶段: 把渠道用户消息也写本地 messages 表 — 跟 desktop renderer
        // 写自己 user message 等价 (renderer 走 IPC, 我们 main 端直接调函数)。
        onAccepted: async () => {
          // attached IM turn 临时替换了 desktop interaction listener，必须从真正
          // dispatch 起将 Setup 交互视为 headless。未接管的渠道 session 已由
          // vendorOptions.source 标识，不需要 marker。若本 turn 已终止，跳过迟到
          // callback 的落库等陈旧副作用。
          if (!markAttachedImTurnHeadlessDispatched(item.turn, rowId, state.attached)) return;
          // 真实用户消息 → 给 silent-stop 守卫充值自动续跑额度(renderer 发送
          // 走 createMakerSendTransaction 内部已充值;scheduler / hook 与本
          // 路径直接 session.send,必须额外调这里,否则守卫额度恒 0,首次
          // silent-stop 就落"已耗尽"误导横幅且永不自动续跑)。
          noteSilentStopUserSend(rowId);
          // 受保护群的触发消息不进会话存档 —— 正文与附件都不落。turn 照常跑,
          // agent 拿得到内容; 只是这一轮的输入不留在长期记录里。
          const persisted = item.protectedContent
            ? null
            : await persistUserMessage({
                sessionId: rowId,
                text: item.text,
                attachments: item.attachments,
              });
          await adapter.onUserMessagePersisted?.({
            sessionId: rowId,
            userMessageId: item.turn.userMessageId,
            persisted: persisted !== null,
          });
          if (persisted) {
            await beginTurnChangeSetAtDispatch(state.makerSession, persisted.clientId);
            turnChangeSetStarted = true;
          }
        },
      });
      if (pendingHandoff && sendResult.accepted) {
        agentHandoffPending.consume(rowId);
      }
      const outcome = toDesktopSessionDispatchOutcome(sendResult, {
        source: `${channel}-runner`,
        context: buildSendContext(rowId),
      });
      if (!outcome.dispatched) {
        if (turnChangeSetStarted) clearPendingTurnChangeSets(rowId);
        await handleSendPreDispatchFailure(state, userId, {
          turn: item.turn,
          source: outcome.source,
          reason: outcome.reason,
          context: outcome.context,
        });
        return { kind: 'rejected', reason: outcome.reason };
      }
      // Route side effects include the durable group cursor commit. The
      // provider has accepted this send now; invoking the callback here keeps
      // queued teardown and SESSION_RUNNING requeue paths from advancing it.
      try {
        await item.onRouteResolved?.(rowId);
      } catch (err) {
        log.warn(
          `route-resolved callback failed for session=${rowId.slice(-8)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return { kind: 'accepted', acceptedAt: acceptedAt || Date.now() };
    } catch (err) {
      if (turnChangeSetStarted) clearPendingTurnChangeSets(rowId);
      const turnPolicyFailureReason = classifyTurnPermissionPolicySendFailure(err, item, state);
      if (turnPolicyFailureReason) {
        await handleSendPreDispatchFailure(state, userId, {
          turn: item.turn,
          source: `${channel}-runner`,
          reason: turnPolicyFailureReason,
          context: buildSendContext(rowId),
        });
        return { kind: 'rejected', reason: turnPolicyFailureReason };
      }
      const normalized = normalizeSendError(err);
      if (normalized.reason === 'SESSION_RUNNING') {
        releaseTurnInteractionRoute(item.turn, 'session_running_race');
        const i = state.queue.indexOf(item.turn);
        if (i >= 0) state.queue.splice(i, 1);
        if (state.detachDrainPromise) {
          await completeTurnCallbackAfterAck(item.turn);
          if (
            item.turn.queueMode === 'internal' &&
            output.kind === 'chunked-text' &&
            item.turn.chunkedReplyBegun
          ) {
            try {
              await output.commitFinal({
                userId,
                text: ui.agent.sendInternalError('session_detaching'),
                terminal: 'error',
                threadTs: state.scopeKey,
                errorCode: 'session_detaching',
              });
            } catch {
              /* The session is already detaching; reporting remains best-effort. */
            }
          }
          finishDeferredDetachIfIdle(state);
          return { kind: 'busy', reason: 'session_detaching' };
        }
        if (item.queueMode === 'external') {
          await completeTurnCallbackAfterAck(item.turn);
          return { kind: 'busy', reason: 'session_running' };
        }
        state.sendQueue.unshift(item);
        log.info(
          `SESSION_RUNNING race for session=${rowId.slice(-8)} — requeued at head (pendingSends=${state.sendQueue.length})`,
        );
        await notifyQueuedPosition(userId, item, 1);
        armDispatchRetry(state, userId);
        return { kind: 'busy', reason: 'queued_internally' };
      }
      await handleSendPreDispatchFailure(state, userId, {
        turn: item.turn,
        source: normalized.source,
        reason: normalized.reason,
        context: buildSendContext(rowId),
        error: normalized.error,
      });
      return { kind: 'rejected', reason: normalized.reason };
    } finally {
      releaseAgentSwitchLock();
    }
  }

  function classifyTurnPermissionPolicySendFailure(
    error: unknown,
    item: QueuedSend,
    state: SessionState,
  ): string | null {
    if (!(error instanceof TurnPermissionPolicyUnsupportedError) || !item.turnPermissionPolicy) {
      return null;
    }
    const failureKind =
      state.makerSession.capabilities.turnPermissionPolicy?.supported?.supported === true
        ? 'mode'
        : 'agent';
    return `${error.code}:${failureKind}:${error.permissionMode}`;
  }

  async function beginChunkedReply(turn: TurnState): Promise<void> {
    if (
      turn.chunkedReplyBegun ||
      turn.queueMode !== 'internal' ||
      output.kind !== 'chunked-text' ||
      !output.beginReply
    ) {
      return;
    }
    turn.chunkedReplyBegun = true;
    try {
      await output.beginReply(turn.userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`chunked-text beginReply failed (active-send fallback): ${msg}`);
    }
  }

  async function refreshSessionAfterPendingAgentSwitch(
    state: SessionState,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    if (!deps.acquirePendingAgentSwitch) return;
    const previous = state.makerSession;
    const maker = getMaker();
    const [row] = await getDbClient()
      .drizzle.select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1);
    if (!row || row.status === 'archived' || row.status === 'deleted') {
      forgetClosedSession(
        sessionId,
        `session became ${row?.status ?? 'missing'} during route refresh`,
      );
      throw new Error(`session ${sessionId} is not active after deferred agent switch`);
    }
    let current = maker.getSession(sessionId);
    // apply 已提交 DB 但 bootstrap 失败时,直发路径也要像 makerSendTransaction 的
    // lazy-create 一样按最新 DB 行自愈,不能退回已关闭的 previous.send()。
    if (!current) {
      if (!row.workingDir) {
        throw new Error(`session ${sessionId} missing after deferred agent switch`);
      }
      const agentKind = toCoreAgentKind(row.agentKind);
      hydrateSessionProvider(sessionId, row.providerId ?? null);
      if (row.effort) setSessionEffort(sessionId, row.effort);
      setSessionFastMode(sessionId, !!row.fastMode);
      current = await maker.createSession({
        id: sessionId,
        agentKind,
        workingDir: row.workingDir,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        fastMode: row.fastMode,
        // 保留 DB 的 null 语义：Pi 用 null 表示清除显式 provider，不能退化为 undefined。
        providerId: row.providerId,
        resumeSessionId: row.sdkSessionId ?? undefined,
        vendorOptions: state.attached
          ? undefined
          : adapter.buildVendorOptions(userId, state.scopeKey),
      });
    }
    if (current === previous) return;

    for (const unsubscribe of state.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* closed old session listener */
      }
    }
    state.unsubscribers = [];
    state.makerSession = current;
    wireSessionToIpcExternal(current);
    state.unsubscribers.push(current.onEvent(handleEventFor(sessionId, userId)));
    sessionStates.set(sessionId, state);
  }

  /**
   * 当前 turn 收口后尝试派发下一条排队消息。空闲判定:
   *   - state.queue 空(本 session 没有未收口的本渠道 turn)
   *   - makerSession.isTurnRunning() false(接管模式下 desktop 侧也没在跑)
   * desktop 侧仍在跑时挂 retry timer 兜底 — 正常情况下它的 stray done 会先到。
   */
  function maybeDispatchNextQueued(state: SessionState, userId: string): void {
    if (state.sendQueue.length === 0) return;
    if (state.queue.length > 0) return;
    if (state.makerSession.isTurnRunning()) {
      armDispatchRetry(state, userId);
      return;
    }
    const next = state.sendQueue.shift();
    if (!next) return;
    void dispatchQueuedSend(state, userId, next).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`dispatchQueuedSend threw (queued path): ${msg}`);
    });
  }

  /** 单 timer, 不堆叠。 */
  function armDispatchRetry(state: SessionState, userId: string): void {
    if (state.dispatchRetryTimer) return;
    state.dispatchRetryTimer = setTimeout(() => {
      state.dispatchRetryTimer = null;
      maybeDispatchNextQueued(state, userId);
    }, DISPATCH_RETRY_MS);
  }

  /** 入队提示 — 每条消息只发一次(竞态 requeue 不重复提示)。失败 swallow。 */
  async function notifyQueuedPosition(
    userId: string,
    item: QueuedSend,
    position: number,
  ): Promise<void> {
    if (item.notified) return;
    item.notified = true;
    try {
      await im.sendMarkdownText(userId, ui.agent.queuedNotice(position), {
        threadTs: item.turn.scopeKey,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`queuedNotice send failed (non-fatal): ${msg}`);
    }
  }

  // ── per-session wiring (idempotent) ─────────────────────────────────────────

  async function ensureSessionWired(target: RouteTarget, userId: string): Promise<SessionState> {
    const existing = sessionStates.get(target.row.id);
    if (existing) {
      if (existing.detachDrainPromise) {
        const outcome = await existing.detachDrainPromise;
        if (outcome === 'cancelled') {
          throw new Error(`session wiring cancelled during cleanup: ${target.row.id}`);
        }
        return ensureSessionWired(target, userId);
      }
      return existing;
    }
    const inFlight = wiringInFlight.get(target.row.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        return await wireSessionInternal(target, userId);
      } finally {
        wiringInFlight.delete(target.row.id);
      }
    })();
    wiringInFlight.set(target.row.id, promise);
    return promise;
  }

  /**
   * /ctr 接管成功后立刻调一次 — 把 wireSessionInternal 从 lazy (等渠道第一条
   * 消息) 提前到 attach 完成立刻执行。两个目的:
   *   1. 立即把 setInteractionListener 切到本渠道, 后续 desktop agent 跑出来
   *      的新 interaction 直接走渠道卡片
   *   2. 立即触发 takePendingInteractionsForSession, 把 desktop 那边正在等
   *      用户答复的 pending 卡片"原地搬到渠道"(否则用户接管完不发消息就以为
   *      bot 卡了, 因为他不知道 wire 是 lazy 的)
   *
   * binding 没命中(resolveRouteTarget 走 default 分支) 时是 noop —— 这样调用方
   * 不需要自己判断 attach 是否真成功, 安全 fire-and-forget。
   */
  async function prewireAttachedSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<void> {
    const target = await resolveExistingRouteTarget(botContextId, userId, scopeKey);
    if (!target) return;
    if (!target.attached) return;
    await ensureSessionWired(target, userId);
  }

  async function replyMissingAuth(
    userId: string,
    auth: ImAuthRouteStatus & { agentKind: AgentKind; model: string },
    scopeKey?: string,
    attached = false,
  ): Promise<void> {
    log.info(
      `no auth configured for agent=${auth.agentKind} provider=${auth.providerId ?? 'default'} ` +
        `missing=${auth.missing} userId=...${userId.slice(-8)} — agent NOT invoked`,
    );
    try {
      const message = ui.agent.authMissing?.({ ...auth, attached }) ?? ui.agent.apiKeyMissing;
      await im.sendText(userId, message, { threadTs: scopeKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`apiKeyMissing send failed (non-fatal): ${msg}`);
    }
  }

  async function handleSessionWiringBusy(userId: string, turn: TurnState): Promise<void> {
    log.info(`session wiring hit credential busy for userId=...${userId.slice(-8)}`);
    await completeTurnCallbackAfterAck(turn);
    try {
      await im.sendText(userId, ui.agent.credentialBusy, { threadTs: turn.scopeKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`credentialBusy send failed (non-fatal): ${msg}`);
    }
  }

  function authCheckDeps(): ImAuthCheckDeps {
    return {
      readXdGatewayApiKey,
      hasCustomProviderKey,
      getAgentAuthState: (agentKind) => getMaker().getAgentAuthState(agentKind),
      listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
      warn: (message) => log.warn(message),
    };
  }

  async function wireSessionInternal(target: RouteTarget, userId: string): Promise<SessionState> {
    const { row, attached } = target;
    const maker = getMaker();
    ensureMakerCloseSubscription(maker);

    // Spawn 配置: attached 模式 (接管 desktop session) 不传 vendorOptions —
    // 让接管期间 SDK 实例跟 desktop 自己 spawn 时一致 (方案 A: 接管期间
    // send_file_to_user 不可用, 但 user 发文件给 agent 仍 OK 因为走 content
    // blocks 不依赖 MCP)。非 attached 模式 (渠道默认 session) 走渠道
    // vendorOptions, 保持 B' 行为不变。
    // 注: maker.createSession({id}) 是按 id 单例, 命中 activeSessions 直接复用,
    // 这里传的 vendorOptions 只在首次 spawn 时生效。
    const vendorOptions = attached
      ? undefined
      : adapter.buildVendorOptions(userId, target.scopeKey);
    // 把会话持久化的 providerId 灌进 session-provider-store —— 路由层(loopback proxy
    // routingTransform)读它决定走哪个供应商上游/钥匙。进程重启后 IM turn 首次起会话时,
    // 内存 store 是空的;不 hydrate 的话 /model 选过的供应商会丢、回落默认路由。对齐
    // renderer 开会话(register.ts)与 scheduler(runner.ts)的 hydrate 时机。
    hydrateSessionProvider(row.id, row.providerId);
    // bridge 会话态(effort / fast)同点 hydrate —— chatgpt/ / xai/ 模型经 IM 触发 turn 时,
    // compat-proxy 路由决策从这两个 store 读出闭包进订阅 handler(与 register.ts bootstrapSession 对齐)。
    if (row.effort) setSessionEffort(row.id, row.effort);
    setSessionFastMode(row.id, !!row.fastMode);
    // 接管路径: 必须传 resumeSessionId 让 Claude SDK 用 desktop 留下的 sdkSessionId
    // resume, 否则 maker.activeSessions 没该 row.id 时会 spawn 全新空会话——oneshot
    // "总结当前状态" 就变成总结空会话, agent 输出短促/无内容; 用户看到渠道卡片
    // 停在 "灵感正在路上..." 然后秒收 finalize, 像是没回应 (Bug 2)。
    // 非接管路径 (渠道默认 session) 也带上, 进程重启后能继续之前的会话。
    const makerSession = await maker.createSession({
      id: row.id,
      agentKind: row.agentKind,
      workingDir: row.workingDir,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      fastMode: row.fastMode,
      // 保留 DB 的 null 语义：Pi 用 null 表示清除显式 provider，不能退化为 undefined。
      providerId: row.providerId,
      // 行总是先由 repo 建好, maker 复用已有 row 时该 title 不会生效 —
      // 仅作防御兜底(原 feishu 实现传 '飞书会话' 字面量, 语义等价)。
      title: attached ? undefined : adapter.sessions.defaultTitle(userId),
      vendorOptions,
      resumeSessionId: row.sdkSessionId ?? undefined,
    });

    // 把 desktop 端的 IPC fan-out (broadcastToAllWindows + messagePersistBroadcaster
    // 的 assistant / tool_use / tool_result / thinking 落库 + 默认 interaction
    // listener) 装到这个 session 上 —— **接管与渠道默认 session 都要 wire**。
    // 不 wire 的话渠道默认 session 在 desktop 里只有 user + 最终回复两头、过程
    // 全空,实时也看不到(scheduler / hook-control 两条 headless 链路同款老坑,
    // 先例见 scheduler-host/runner.ts 与 hook-control/session-runner.ts)。
    // assistant 文本自此由 messagePersistBroadcaster 单点落库,本模块不再自写
    // (见 handleTurnDoneAsync)。wireSessionToIpcExternal 内部用 wiredSessionsById
    // 守重,重复调安全。下方 setInteractionListener 会把 wire 装上的 desktop
    // interaction listener 覆盖回渠道卡片版,顺序不能颠倒。
    wireSessionToIpcExternal(makerSession);

    const state: SessionState = {
      makerSession,
      userId,
      workingDir: row.workingDir,
      scopeKey: target.scopeKey,
      queue: [],
      sendQueue: [],
      dispatchRetryTimer: null,
      unsubscribers: [],
      detachDrainPromise: null,
      resolveDetachDrain: null,
      attached,
      scheduledTranspond: null,
    };
    sessionStates.set(row.id, state);

    // 注册本渠道自己的 onEvent listener — multi-listener 语义, 跟 desktop 那个
    // (如果存在) 并存。事件 fan-out 给 streamingHandle / 渠道卡片。
    state.unsubscribers.push(makerSession.onEvent(handleEventFor(row.id, userId)));

    // 接管模式: 把 desktop 那边已经在等的 InteractionRequest "原地搬到渠道"。
    // 场景: 用户在 desktop 触发了 agent → agent 发出 permission/ask/plan 卡片 →
    // desktop 卡片显示在等用户答 → 用户改用渠道 /ctr 接管。这种情况下 SDK 那侧
    // 那个 InteractionResolver Promise 还在等 desktop resolve, 而 desktop UI
    // 卡片现在被关掉(broadcast INTERACTION_DISMISSED), 渠道侧需要重新发卡片
    // 让用户能在渠道答复, 答复时直接 resolve 原 SDK Promise。
    // No-op 的常见情况: 没有 in-flight pending(idle session 接管), takePending
    // 返回空数组直接跳过。
    if (attached) {
      const taken = takePendingInteractionsForSession(row.id);
      for (const entry of taken) {
        void publishMigratedInteraction(entry, userId, row.id, target.scopeKey);
      }
      if (taken.length > 0) {
        log.info(
          `migrated ${taken.length} pending interaction(s) from desktop → ${channel} for session=${row.id.slice(-8)}`,
        );
      }
    }

    // No auto-cleanup: IM sessions stay wired for the process lifetime.
    // (Original bot did the same — turn queue handles concurrency, sessions
    // are long-lived per (bot, user) pair.)

    log.info(
      `wired session=${row.id.slice(-8)} for userId=...${userId.slice(-8)} attached=${attached}`,
    );
    return state;
  }

  /**
   * 把一条从 desktop "搬过来" 的 pending interaction 重新发成渠道卡片, 并把
   * cardActionHandler 触发回调时的 resolve 直接桥接到原 desktop pending 的
   * resolve fn (后者就是 SDK InteractionResolver 在 await 的那个 Promise 的
   * resolve, 由 installDesktopInteractionListener 给到的)。
   *
   * 跟 handleInteractionFor 走的是同一套 cardBuilders + registerPending* 逻辑,
   * 只是 register 用低级版 registerPendingExternal 注入外部 resolve 而非自创建
   * Promise —— 这样渠道 cardActionHandler 一通 lookupPending → resolvePending
   * 就直接 resolve 到 SDK 那边, 中间不用桥接转发。
   *
   * 失败处理: 卡片发不出 / register 冲突时, 必须用 entry.resolve 给一个 deny
   * (或 ask 的空 answers) 兜底 —— 否则 SDK 那个 Promise 永远等不到结果, agent
   * 整个 turn 卡死。
   */
  async function publishMigratedInteraction(
    entry: {
      requestId: string;
      request: InteractionRequest;
      resolve: (decision: InteractionDecision) => void;
    },
    userId: string,
    localSessionId: string,
    scopeKey?: string,
  ): Promise<void> {
    const { request: req, resolve } = entry;
    log.info(
      `publishMigrated kind=${req.kind} requestId=...${req.requestId.slice(-8)} session=...${localSessionId.slice(-8)}`,
    );

    if (!richIm) {
      try {
        if (adapter.handleTextInteraction) {
          resolve(await adapter.handleTextInteraction(userId, req));
        } else {
          const kind = req.kind as InteractionDecision['kind'];
          resolve(
            kind === 'ask_user_question'
              ? { kind, answers: {} }
              : { kind, behavior: 'deny', reason: 'rich_output_not_supported' },
          );
        }
      } catch (err) {
        const kind = req.kind as InteractionDecision['kind'];
        const msg = err instanceof Error ? err.message : String(err);
        resolve(
          kind === 'ask_user_question'
            ? { kind, answers: {} }
            : { kind, behavior: 'deny', reason: `text interaction failed: ${msg}` },
        );
      }
      return;
    }

    let spec: InteractiveCardSpec | null = null;
    switch (req.kind) {
      case 'permission':
        spec = cards.buildPermissionCard(req);
        break;
      case 'ask_user_question':
        spec = cards.buildAskUserCard(req);
        break;
      case 'plan_review':
        spec = cards.buildPlanReviewCard(req);
        break;
      default: {
        // exhaustive: InteractionRequest 加新 kind 时这里编译失败, 强制加分支
        const _exhaustive: never = req;
        void _exhaustive;
        return;
      }
    }
    if (!spec) {
      // ask_user_question 没问题项 — 自动空答即可
      const kind = req.kind as InteractionDecision['kind'];
      resolve(
        kind === 'ask_user_question'
          ? { kind, answers: {} }
          : { kind, behavior: 'deny', reason: 'no_card' },
      );
      return;
    }

    const migratedSourceMessageId =
      sessionStates.get(localSessionId)?.queue[0]?.userMessageId ?? undefined;
    let messageId: string;
    try {
      const result = await richIm.sendInteractiveCard(userId, spec, {
        threadTs: scopeKey,
        // **只有授权卡**转宿主私聊: 群里的授权卡消不掉且只有宿主能答。问答 / 计划审阅
        // 留在原 lane(它们在群里可见是合理的), 命令卡与会话选择卡更不能转 —— 那会让
        // 回调落到私聊锁上。
        ...(req.kind === 'permission'
          ? {
              deliverToOwnerDm: true,
              ownerDmNote: GROUP_APPROVAL_OWNER_DM_NOTE,
              // 迁移路径同样按业务 turn 取来源消息(可能没有进行中的 turn)。
              ...(migratedSourceMessageId !== undefined
                ? { ownerDmSourceMessageId: migratedSourceMessageId }
                : {}),
            }
          : {}),
      });
      messageId = result.messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`publishMigrated sendInteractiveCard failed: ${msg}`);
      const kind = req.kind as InteractionDecision['kind'];
      resolve(
        kind === 'ask_user_question'
          ? { kind, answers: {} }
          : { kind, behavior: 'deny', reason: `card send failed: ${msg}` },
      );
      return;
    }

    try {
      // 授权卡已转投 owner 私聊 — 立刻在原群/话题 lane 留指路提示
      // (与 handleInteractionFor 同款; 私聊 lane 卡片就在原地, 不需要)。
      if (
        req.kind === 'permission' &&
        userId.startsWith('g/') &&
        adapter.ui.cards.permission.dmRoutedNotice
      ) {
        try {
          const notice = adapter.ui.cards.permission.dmRoutedNotice;
          const text = typeof notice === 'function' ? notice(req.toolName) : notice;
          await im.sendText(userId, text, {
            threadTs: scopeKey,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`dm routed notice send failed (non-fatal): ${msg}`);
        }
      }
      registerPendingExternal(
        req.requestId,
        req.kind as InteractionDecision['kind'],
        messageId,
        resolve,
        (err) => {
          // reject 兜底 — registerPendingExternal 自己只在 duplicate requestId 时
          // 抛, 触发不到这条; 但留着保持类型对称。
          const kind = req.kind as InteractionDecision['kind'];
          resolve(
            kind === 'ask_user_question'
              ? { kind, answers: {} }
              : { kind, behavior: 'deny', reason: err.message },
          );
        },
        req.kind === 'permission'
          ? {
              toolName: req.toolName,
              permissionCard: { title: spec.title ?? '', body: spec.body },
            }
          : undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`publishMigrated registerPendingExternal failed: ${msg}`);
      const kind = req.kind as InteractionDecision['kind'];
      resolve(
        kind === 'ask_user_question'
          ? { kind, answers: {} }
          : { kind, behavior: 'deny', reason: `register failed: ${msg}` },
      );
    }
  }

  /**
   * 标题拼装的公共路径: 渠道自定义拼装优先(飞书话题 lane → [飞书·{群名}·
   * {话题简介}] {threadId}), 拼装不适用(飞书 DM)回落 fallbackPrefix +
   * oneshot 简介。没有渠道拼装的渠道直接走 fallbackPrefix。
   */
  async function composeOrGenerateTitle(
    sessionId: string,
    userId: string,
    scopeKey: string | undefined,
    text: string,
    fallbackPrefix: string,
  ): Promise<string | null> {
    const composeTitle = adapter.sessions.composeGeneratedTitle;
    if (!composeTitle) {
      return generateAndPersistFbotTitle(sessionId, text, fallbackPrefix);
    }
    const generated = await generateImSessionTitleText(sessionId, text);
    if (!generated) return null;
    const title = await composeTitle(userId, scopeKey, generated, sessionId);
    if (title) {
      await persistGeneratedSessionTitle(sessionId, title);
      return title;
    }
    return generateAndPersistFbotTitle(sessionId, text, fallbackPrefix);
  }

  /**
   * 接管 session 首条消息触发的 title 生成 — 仅当当前 title 还是 'FBot · New'
   * 草稿占位时执行, 否则 noop (说明已经生成过了)。
   *
   * 命名与渠道默认会话对齐: 有 composeGeneratedTitle 的渠道(feishu)走同一条
   * 拼装路径(话题 lane 与普通话题会话同名族), compose 不适用(DM)回落渠道
   * generatedTitlePrefix([飞书·DM] {简介}); 其它渠道保持 'FBot · {简介}'。
   *
   * 用 drizzle 查 title 而不是从 row 里带 — row 来自 resolveRouteTarget 早一步,
   * 几十毫秒内 title 不会变, 但显式查一次更稳 (避免读到已被并发更新的旧值, 虽然
   * messageHandler 的 per-user lock 已经避免了并发, 这里再加一道防御)。
   *
   * 失败/查不到都 swallow — title 生成是 nice-to-have, 不能阻塞主流程。
   */
  async function maybeGenerateFbotTitleOnFirstMessage(
    sessionId: string,
    text: string,
    ctx?: {
      botContextId: string;
      userId: string;
      scopeKey?: string;
      workingDir: string;
    },
  ): Promise<void> {
    try {
      const db = getDbClient().drizzle;
      const rows = await db
        .select({ title: sessionsTable.title })
        .from(sessionsTable)
        .where(eq(sessionsTable.id, sessionId))
        .limit(1);
      if (rows[0]?.title !== FBOT_DRAFT_TITLE) return;
      const configuredPrefix = adapter.sessions.generatedTitlePrefix;
      const fallbackPrefix =
        typeof configuredPrefix === 'function' ? configuredPrefix() : configuredPrefix;
      const title = ctx
        ? await composeOrGenerateTitle(
            sessionId,
            ctx.userId,
            ctx.scopeKey,
            text,
            fallbackPrefix ?? FBOT_TITLE_PREFIX,
          )
        : await generateAndPersistFbotTitle(sessionId, text);

      // thread 模型的"新建+接管": 标题生成后把锚点/root 卡也升级成正式标题
      // (此前是「新会话(刚建好)」占位), 顶层一眼能看出 thread 对应哪条会话。
      // 保留 🚪 退出按钮(updateInteractiveCard 是全量覆盖)。
      const threadUiPack = adapter.ui.thread;
      if (!richIm || !title || !adapter.threadScoped || !threadUiPack || !ctx?.scopeKey) return;
      const anchorId = bindingStore.getAttachCardMessageId({
        channel,
        botContextId: ctx.botContextId,
        userId: ctx.userId,
        scopeKey: ctx.scopeKey,
      });
      if (!anchorId) return;
      const card = threadUiPack.takeoverCard(title, path.basename(ctx.workingDir));
      await richIm.updateInteractiveCard(anchorId, {
        title: card.title,
        body: card.body,
        buttons: [
          {
            id: 'control:thread-exit',
            label: threadUiPack.btnExitTakeover,
            payload: { botAppId: ctx.botContextId },
          },
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`maybeGenerateFbotTitleOnFirstMessage failed (non-fatal): ${msg}`);
    }
  }

  /**
   * 渠道默认(非接管)会话的标题生成 — 用首条消息 oneshot 起名(渠道前缀,
   * 如 'Slack · ' / '[飞书·DM] ')。
   *   - threadScoped(slack): 新 thread 会话触发, 落库后把 thread 名片卡升级
   *     为正式标题;
   *   - 非 threadScoped(feishu/discord): 新上下文(建行 / /new 后)的首条
   *     消息触发, 只改库不发卡(这类渠道没有 thread 名片)。
   * 失败 swallow — 标题保持原样, 不阻塞主流程。
   */
  async function maybeGenerateImSessionTitle(
    sessionId: string,
    userId: string,
    scopeKey: string | undefined,
    text: string,
    headerCardId: string | null,
  ): Promise<void> {
    const threadUiPack = adapter.ui.thread;
    const configuredPrefix = adapter.sessions.generatedTitlePrefix;
    const composeTitle = adapter.sessions.composeGeneratedTitle;
    if (
      configuredPrefix === undefined &&
      !composeTitle &&
      !(adapter.threadScoped && threadUiPack)
    )
      return;
    const prefix = typeof configuredPrefix === 'function' ? configuredPrefix() : configuredPrefix;
    try {
      // 渠道自定义拼装(feishu 话题 lane → [飞书·{群名}·{简介}] {threadId 后 6 位}):
      // oneshot 只负责出「话题简介」文本, 完整标题由渠道按 lane 拼; compose
      // 不适用(feishu DM)回落渠道前缀。无 compose 的渠道直接前缀 + 简介。
      const title = await composeOrGenerateTitle(
        sessionId,
        userId,
        scopeKey,
        text,
        prefix ?? FBOT_TITLE_PREFIX,
      );
      if (!richIm || !title || !headerCardId || !threadUiPack) return;
      await richIm.updateInteractiveCard(headerCardId, {
        ...threadUiPack.sessionHeaderTitled(title),
        buttons: [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`maybeGenerateImSessionTitle failed (non-fatal): ${msg}`);
    }
  }

  /**
   * 给用户消息加一个"已收到"表情,返回 reaction token(失败/异常/渠道不支持
   * 返 null,emoji 是 nice-to-have)。caller 把 promise 挂在 TurnState 上,turn
   * 结束时 cancelAckReaction 负责把这个表情撤掉。
   */
  async function ackProcessing(messageId: string): Promise<string | null> {
    try {
      return (await im.reactToMessage?.(messageId, adapter.processingEmoji)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Turn 结束时撤掉之前 ackProcessing 加的表情。等待 ack promise(此时可能
   * 早已 resolve,也可能仍在飞行中),拿到 reaction token 后调 removeReaction。
   * 任何环节失败都吞掉，这是 ack 的清理动作，不能影响 turn 结束流程。
   */
  async function cancelAckReaction(
    turn: TurnState,
    opts: { terminal?: boolean } = {},
  ): Promise<void> {
    if (!turn.ackReactionIdPromise || !turn.userMessageId) return;
    const promise = turn.ackReactionIdPromise;
    turn.ackReactionIdPromise = null;
    try {
      const reactionId = await promise;
      if (!reactionId) return;
      // 真正跑完的 turn 可把"已收到"替换成结果表情(telegram: 👍/👎;
      // setMessageReaction 整组替换, 旧 ack 一并被顶掉)。
      const terminalEmoji =
        opts.terminal && adapter.terminalReactionEmoji
          ? adapter.terminalReactionEmoji(turn.terminalKind)
          : null;
      if (terminalEmoji) {
        // 替换成功(返回 token)即顶掉旧 ack;返回 null = 渠道本轮拒放表情
        // (如 telegram 在 turn 进行中被切到 emoji off)— 必须回落撤 ack,
        // 否则 👀 永久卡在用户消息上。
        const replaced = await im.reactToMessage?.(turn.userMessageId, terminalEmoji);
        if (replaced) return;
      }
      await im.removeMessageReaction?.(turn.userMessageId, reactionId);
    } catch {
      /* 忽略失败：表情清理是尽力而为。 */
    }
  }

  // ── event routing ───────────────────────────────────────────────────────────

  function handleEventFor(localSessionId: string, userId: string) {
    return (event: AgentEvent) => {
      const state = sessionStates.get(localSessionId);
      if (!state) return;
      const turn = state.queue[0];
      if (!turn) {
        // 自动任务(scheduler)在被接管的共享 session 上发起的 turn — 本渠道没有
        // TurnState(stray)。转播到远程控制 thread, 让用户看到"系统自动发了什么 +
        // 步骤 + 结果"。turnOrigin 由 maker Session 打标(PR1)。仅 attached(确有
        // 远程控制 thread)才转播;desktop 自己发起的 turn 无 origin, 不转播。
        if (state.attached && event.turnOrigin?.kind === 'scheduler') {
          transpondScheduledEvent(state, event);
        }
        // done / 终止型 error 同时是"session 空闲了"的信号 — 触发排队消息派发。
        // 非终止 error 表示底层仍在自动恢复，不能抢跑下一条消息（放行排队消息会让
        // 下一条撞上 SESSION_RUNNING）。
        if (isProductTurnDoneEvent(event) || isTerminalAgentErrorEvent(event)) {
          maybeDispatchNextQueued(state, userId);
          return;
        }
        // 其它 stray(idle status 等)安静忽略。
        if (event.type !== 'status' && event.type !== 'session_id') {
          log.debug(`stray event type=${event.type} (no active turn)`);
        }
        return;
      }
      switch (event.type) {
        case 'text':
          return handleTextEvent(turn, event);
        // Keep reasoning private on Feishu/Discord. Slack hook-control has an
        // explicit live-work surface and opts into the compact thinking row.
        case 'thinking':
          return;
        case 'tool_use':
          // 过程展示: 折叠进卡片顶部的滚动时间线(turnActivity.ts), 让用户在
          // 长 agentic turn 里看到"正在干什么", 而不是盯占位符干等结果。
          return handleToolUseEvent(turn, event);
        case 'tool_result_full':
          return handleToolResultFullEvent(turn, event);
        case 'done':
          // The provider may emit a claim-bearing SDK boundary before an
          // automatic continuation. Keep the same IM turn/card alive; only
          // the following unclaimed done is the product completion.
          if (isTurnContinuationBoundaryEvent(event)) return;
          // silent-stop done(上游用空内容静默收尾): 不当普通 done 收口 —
          // 守卫可能自动续跑,续跑轮事件要继续流进本 turn 的卡片,
          // 见 handleSilentStopDone。
          if ((event.data as { silentStop?: boolean } | null)?.silentStop === true) {
            return handleSilentStopDone(state, userId);
          }
          return handleTurnDoneAsync(state, userId);
        case 'error':
          // 可重试错误只是进行中状态；保持当前 turn、卡片和排队消息不动，
          // 等后续 text / done 或终止型 error 正常收口。顺带把「正在自动重试」透进
          // 过程区——Codex 的网络重连(#790)与两侧的过载自动重试都走这条，零产出时
          // 渠道那条消息本来一帧都收不到。
          if (!isTerminalAgentErrorEvent(event)) {
            return handleRetryNoticeEvent(turn, event);
          }
          return handleTurnErrorAsync(state, userId, event.data);
        case 'session_id':
          return persistSdkSessionId(localSessionId, event.data);
        // tool_result (summary) / status / thinking / etc. → not surfaced
        default:
          return;
      }
    };
  }

  /**
   * 从一段 tool_result 全文里抽出可推到 IM 聊天的 xdt-image URL。
   *
   * 跟 desktop renderer 的 extractToolResultMedia (AgentActionRow.tsx) 语义
   * 必须一致 — 包括尊重 `_xdt_render_image: false` sentinel (read_by_url
   * 读文档时注图但不希望刷屏的场景)。漏 sentinel 会导致用户让 agent "总结这篇
   * 文档" 时, IM 聊天里突然刷一堆文档插图。
   *
   * 视频(xdt_video_url(s)): IM 消息卡片对内嵌视频支持有限,且需要先把 mp4 上传
   * 到渠道 — 本期不做。检测到视频时只 warn-log,不上传也不静默丢弃,
   * 给后续接入留个明确入口。
   */
  function extractRenderableXdtImageUrls(toolResultText: string): string[] {
    if (!toolResultText || typeof toolResultText !== 'string') return [];
    if (
      !toolResultText.includes('xdt_image_url') &&
      !toolResultText.includes('xdt_video_url') &&
      !toolResultText.includes('xdt_media_produced')
    ) {
      return [];
    }
    let parsed: {
      xdt_image_url?: unknown;
      xdt_image_urls?: unknown;
      xdt_video_url?: unknown;
      xdt_video_urls?: unknown;
      xdt_media_produced?: unknown;
      _xdt_render_image?: unknown;
    };
    try {
      parsed = JSON.parse(toolResultText);
    } catch {
      return [];
    }
    if (parsed._xdt_render_image === false) return [];
    // 双协议:历史 xdt-image + 当前 cindy-media
    // art/mivo/codex 生成图的地址形态;只认老协议会让 IM 端"画了图看不到")。
    const isManagedImageUrl = (u: string): boolean =>
      u.startsWith('xdt-image://') || u.startsWith('cindy-media://');
    const urls: string[] = [];
    if (typeof parsed.xdt_image_url === 'string' && isManagedImageUrl(parsed.xdt_image_url)) {
      urls.push(parsed.xdt_image_url);
    }
    if (Array.isArray(parsed.xdt_image_urls)) {
      for (const u of parsed.xdt_image_urls) {
        if (typeof u === 'string' && isManagedImageUrl(u)) urls.push(u);
      }
    }
    // 兜底账本(xdt_media_produced,ghost_call 层在意识未声明媒体字段时注入,
    // 主机记账、意识删不掉):可能混有视频/音频/3D,IM 本期只接走图片。
    if (Array.isArray(parsed.xdt_media_produced)) {
      for (const u of parsed.xdt_media_produced) {
        if (typeof u === 'string' && isManagedImageUrl(u) && /\.(png|jpe?g|gif|webp)$/i.test(u)) {
          urls.push(u);
        }
      }
    }
    // 视频:本期不推 IM,只 warn 一下让回查容易。
    let sawVideo = false;
    if (typeof parsed.xdt_video_url === 'string') sawVideo = true;
    if (Array.isArray(parsed.xdt_video_urls) && parsed.xdt_video_urls.length > 0) {
      sawVideo = true;
    }
    if (sawVideo) {
      log.warn(`[${channel}/turn] tool_result carried xdt_video_url(s); IM 侧本期不上传视频,跳过`);
    }
    return Array.from(new Set(urls));
  }

  /**
   * tool_result_full 事件: 工具调用的完整文本结果. 我们只关心带托管图片的:
   * 抽出 URL(双协议:老 xdt-image / 新 cindy-media)→ 按协议解出 absPath →
   * 投递给 streaming handle, 让 finalize 时跟文本里的 markdown 图一起
   * upload + 拼到卡片上。
   *
   * 这是 IM 端"画了图却看不到"的修复入口 — art image_generate 工具按设计
   * 不让模型在文本里嵌 xdt-image markdown (避免 desktop 渲染重复), 所以 IM
   * 端拿不到图的唯一通路就是从这里 sidechannel 把图 URL 接走。
   */
  function handleToolResultFullEvent(turn: TurnState, event: AgentEvent): void {
    const data = event.data as { fullText?: unknown } | null;
    if (!data || typeof data.fullText !== 'string') return;
    const urls = extractRenderableXdtImageUrls(data.fullText);
    if (urls.length === 0) return;
    // streamingHandle 可能还没 spawn (e.g. 工具调用先于任何 text delta) — 触发
    // 一下 ensureStreamingHandle 让 card 先建出来, 再投递。投递接口本身是
    // O(1) 同步 push, 不阻塞事件循环。
    void ensureStreamingHandle(turn).then((handle) => {
      if (!handle?.addExtraImageAbsPath) return; // patchedCardHandle 不实现这个能力 / 创建失败(null)
      for (const url of urls) {
        try {
          const { absPath } = url.startsWith('cindy-media://')
            ? resolveCindyMediaUrl(url)
            : resolveXdtImageUrl(url);
          handle.addExtraImageAbsPath(absPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[${channel}/turn] resolve managed image failed for ${url}: ${msg}`);
        }
      }
    });
  }

  /**
   * What's currently shown in the streaming card.
   *
   * 流式期间 = 过程区(tool_use 时间线) + 正文;turn.done 后过程区移除, 最终
   * 消息只留干净正文(error 收口不置 done — 保留过程区, 用户能看到死在哪步)。
   * 纯文本快答没有 tool_use, renderActivity 返回空串, 视图与旧行为逐字一致。
   */
  function composeStreamingView(turn: TurnState): string {
    const rawBody = turn.outputCardPrefix
      ? turn.outputCardPrefix + turn.presenter.wholeText()
      : turn.presenter.wholeText();
    // External-channel safeguard: maker-core normally strips these tokens,
    // while this boundary also protects old continuations and future adapters.
    const body = stripInternalWebCitations(rawBody);
    if (turn.done) return body;
    // 过程区在上、正文在下的合成骨架与官方 bot 共用(presenter.composeRunning →
    // composeProgressView); 纯文本快答无 tool_use 时过程区为空, 视图与旧行为逐字一致。
    return turn.presenter.composeRunning(body);
  }

  /** tool_use → 过程区时间线推进 + 卡片刷新(渠道 handle 自带节流兜底)。 */
  function handleToolUseEvent(turn: TurnState, event: AgentEvent): void {
    if (!turn.presenter.applyToolUse(event)) return;
    ensureActivityTicker(turn);
    void ensureStreamingHandle(turn).then((h) => h?.replace(composeStreamingView(turn)));
  }

  /**
   * 非终止 error → 过程区状态行 + 卡片刷新。turn 不收口。
   *
   * 只对已有本地化契约的自动重试出提示(见 turnRetryNotice.ts): 其它非终止
   * error 的 message 是内部英文串, 没有对应中文表达, 保持既有静默。
   *
   * **要惰性建卡**(与 ensureActivityTicker「ticker 不该是创建卡片的理由」相反):
   * 过载重投只在本 turn 零产出时发生(maker-core 的 currentTurnProducedOutput
   * 守卫), 那时卡片一定还没建 —— 只刷已有 handle 等于什么都不显示, 用户发完消息
   * 后除了一个 👀 表情什么反馈都没有。这张卡不会变成垃圾: 重试成功后正文继续落在
   * 同一张卡上, 重试耗尽时 handleTurnErrorAsync 会把它 finalize 成失败说明。
   */
  function handleRetryNoticeEvent(turn: TurnState, event: AgentEvent): void {
    if (!turn.presenter.applyRetryNotice(event)) return;
    ensureActivityTicker(turn);
    void ensureStreamingHandle(turn).then((h) => h?.replace(composeStreamingView(turn)));
  }

  function ensureActivityTicker(turn: TurnState): void {
    if (turn.activityTicker || turn.done) return;
    turn.activityTicker = setInterval(() => {
      if (turn.done) {
        clearActivityTicker(turn);
        return;
      }
      // 只刷已存在的 handle — ticker 不该是创建卡片的理由
      turn.streamingHandle?.replace(composeStreamingView(turn));
    }, ACTIVITY_TICK_MS);
  }

  function clearActivityTicker(turn: TurnState): void {
    if (turn.activityTicker) {
      clearInterval(turn.activityTicker);
      turn.activityTicker = null;
    }
  }

  // ── 自动任务转播 ─────────────────────────────────────────────────────────────
  // 把 scheduler 在被接管 session 上发起的 turn 转播到远程控制 thread。与上面的
  // 用户 turn 渲染完全隔离(独立卡 / 独立 buffer / 独立 ticker),不碰
  // composeStreamingView,避免回归 #118。

  /** 转播卡正文:运行中 = 头 + 步骤时间线 + 正文;收口 = 头 + 正文(去步骤)。 */
  function composeTranspondView(t: ScheduledTranspond, final: boolean): string {
    const header = ui.agent.scheduledTaskHeader(t.scheduleName);
    if (final) {
      return t.buffer ? `${header}\n\n${t.buffer}` : header;
    }
    const act = renderActivity(t.activity, Date.now());
    const parts = [header];
    if (act) parts.push(act);
    if (t.buffer) parts.push(t.buffer);
    // 头与(步骤/正文)之间空行分隔;步骤紧跟头。
    return parts.length === 1 ? header : `${parts[0]}\n${parts.slice(1).join('\n\n')}`;
  }

  function ensureTranspondHandle(
    state: SessionState,
    t: ScheduledTranspond,
  ): Promise<StreamingTextHandle> {
    if (t.streamingHandle) return Promise.resolve(t.streamingHandle);
    if (t.streamingHandlePromise) return t.streamingHandlePromise;
    if (!richIm) return Promise.reject(new Error('rich output is not available'));
    t.streamingHandlePromise = (async () => {
      const handle = await richIm.startStreamingText(state.userId, undefined, {
        threadTs: state.scopeKey,
      });
      t.streamingHandle = handle;
      return handle;
    })();
    return t.streamingHandlePromise;
  }

  function clearTranspondTicker(t: ScheduledTranspond): void {
    if (t.activityTicker) {
      clearInterval(t.activityTicker);
      t.activityTicker = null;
    }
  }

  function refreshTranspondCard(state: SessionState): void {
    const t = state.scheduledTranspond;
    if (!t) return;
    void ensureTranspondHandle(state, t).then((h) => h.replace(composeTranspondView(t, false)));
  }

  /** 处理一条 scheduler-origin stray 事件,转播到远程控制 thread。 */
  function transpondScheduledEvent(state: SessionState, event: AgentEvent): void {
    // Durable text channels need an inbound context token to address replies.
    // A desktop-originated scheduler turn has no such token, so it cannot be
    // safely mirrored and must never fall through to rich-card primitives.
    if (output.kind === 'chunked-text') return;
    // Lifecycle status is not user-facing scheduler content. In particular,
    // the claim-bearing status(false) paired with an SDK boundary must not
    // create or close a projection card.
    if (event.type === 'status') return;
    if (event.type === 'done' && isTurnContinuationBoundaryEvent(event)) return;
    // 首条事件惰性建转播态(避免给空 turn 开卡)。
    if (!state.scheduledTranspond) {
      const origin = event.turnOrigin;
      state.scheduledTranspond = {
        scheduleName: origin?.kind === 'scheduler' ? (origin.scheduleName ?? null) : null,
        activity: createTurnActivity(Date.now()),
        activityTicker: null,
        buffer: '',
        streamingHandle: null,
        streamingHandlePromise: null,
      };
    }
    const t = state.scheduledTranspond;
    switch (event.type) {
      case 'text': {
        const data = event.data as { text?: string; isFinal?: boolean } | null;
        if (!data || typeof data.text !== 'string') return;
        if (data.isFinal) t.buffer = data.text;
        else t.buffer += data.text;
        markActivityWriting(t.activity);
        refreshTranspondCard(state);
        return;
      }
      case 'tool_use': {
        const data = event.data as {
          toolName?: unknown;
          toolUseId?: unknown;
          input?: unknown;
        } | null;
        if (!data || typeof data.toolName !== 'string') return;
        pushToolStep(
          t.activity,
          data.toolName,
          data.input,
          typeof data.toolUseId === 'string' ? data.toolUseId : undefined,
        );
        // 低频 ticker 刷新耗时(只刷已存在的卡)。
        if (!t.activityTicker) {
          t.activityTicker = setInterval(() => {
            t.streamingHandle?.replace(composeTranspondView(t, false));
          }, ACTIVITY_TICK_MS);
        }
        refreshTranspondCard(state);
        return;
      }
      case 'done':
        return void finalizeTranspond(state, null);
      case 'error':
        // 只在**终止型** error 上收口。可重试 error(willRetry / isTerminal=false)turn
        // 仍在继续(与 session.ts origin 清除、scheduler-host runner 的口径一致),此时
        // 收口会过早关卡 + 清空 scheduledTranspond → 重试产出的 text/done 又惰性开第二张
        // 卡。非终止 error 当进行中处理,不转播(后随事件继续刷,最终由 done/终止 error 收口)。
        if (isTerminalAgentErrorEvent(event)) {
          // 过载类终态换成本地化可操作说明(与用户 turn 的 handleTurnErrorAsync 共用
          // 同一 helper): 定时任务的卡片刚显示过「正在自动重试（N/M）」, 重试耗尽时
          // 再回落成上游英文原文, 等于把内部实现细节丢给渠道用户(review #844 codex P1)。
          return void finalizeTranspond(state, terminalErrorText(event.data));
        }
        // 自动重试中: 在过程区留一行, 但**只刷已存在的**转播卡。与用户 turn 的
        // 取舍不同 —— 转播是自动任务的旁路展示, 没有人在等它; 为一条重试提示开卡,
        // 万一那轮重试成功后 agent 零输出收口, thread 里就多出一张只有标题的卡。
        {
          const notice = turnRetryNotice(event.data);
          if (notice !== null && setActivityNotice(t.activity, notice)) {
            t.streamingHandle?.replace(composeTranspondView(t, false));
          }
        }
        return;
      default:
        return; // thinking / tool_result / status 等不转播
    }
  }

  async function finalizeTranspond(state: SessionState, errMsg: string | null): Promise<void> {
    const t = state.scheduledTranspond;
    if (!t) return;
    state.scheduledTranspond = null; // 防重入(下一条 stray 不会再命中)
    clearTranspondTicker(t);
    // 防御性复位: composeTranspondView(final=true) 本身只取 header + 正文, 不含过程区,
    // 所以这行不是收口正确性的依赖; 留着是为了让这块转播态在收口后不残留瞬态字段
    // (万一将来 final 视图改成包含过程区)。真正必须显式清的是 handleTurnErrorAsync ——
    // 它不置 turn.done, composeStreamingView 会把 activity 一起写进正文。
    setActivityNotice(t.activity, null);
    // 没产出任何内容(无文本无步骤)且无错 → 不留空卡。
    if (!t.streamingHandle && t.buffer.length === 0 && t.activity.totalSteps === 0 && !errMsg) {
      return;
    }
    try {
      const handle = await ensureTranspondHandle(state, t);
      const base = composeTranspondView(t, true);
      const body = errMsg ? `${base}\n\n${ui.agent.runtimeError(errMsg)}` : base;
      await handle.finalize(body);
    } catch (err) {
      log.warn(
        `transpond finalize failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Mark only attached IM-owned turns. Channel-native sessions already carry
   * vendorOptions.source and are independently classified as headless.
   *
   * false means the turn reached a terminal cleanup before this callback
   * arrived; callers must skip the rest of that stale onAccepted callback.
   */
  function markAttachedImTurnHeadlessDispatched(
    turn: TurnState,
    sessionId: string,
    attached: boolean,
  ): boolean {
    if (!attached) return true;
    if (turn.headlessSetupClosed) return false;
    turn.releaseHeadlessSetupTurn ??= beginHeadlessGhostSetupTurn(sessionId);
    return true;
  }

  function releaseAttachedImTurnHeadless(turn: TurnState): void {
    if (turn.headlessSetupClosed) return;
    turn.headlessSetupClosed = true;
    const release = turn.releaseHeadlessSetupTurn;
    turn.releaseHeadlessSetupTurn = null;
    release?.();
  }

  function releaseTurnInteractionRoute(turn: TurnState, reason: string): void {
    const releaseGroupHistoryAccess = turn.groupHistoryAccessRelease;
    turn.groupHistoryAccessRelease = null;
    releaseGroupHistoryAccess?.();
    const lease = turn.interactionRouteLease;
    turn.interactionRouteLease = null;
    lease?.release(reason);
    // Release the host turn lease on the same terminal / requeue / cleanup paths
    // so an unsupported permission-mode switch can proceed once the policy turn ends.
    const releaseHostLease = turn.hostTurnLeaseRelease;
    turn.hostTurnLeaseRelease = null;
    releaseHostLease?.();
  }

  /**
   * 交互被作废(turn 收口 / session 清理 / 抢跑)时把它的卡片一起收口。
   *
   * 只删 pending 不动卡片, 卡片就会带着可点按钮留在会话里, 而它背后的交互已经
   * 没了 —— 用户点下去不会有任何反应, 也没有任何提示。群里的授权卡转投宿主私聊
   * 后这条路径尤其致命: 群里那轮已经收口, 私聊里的卡片却看不出任何变化。
   */
  function dropInteractionCard(requestId: string, reason: string): boolean {
    const cancelled = cancelPending(requestId, reason);
    // 返回值是 router 的契约: true = 渠道侧已收口这次交互, router 不再自行 cancel。
    // 丢掉它会让同一个 requestId 被取消两次(第二次落到 SDK 的默认拒绝路径)。
    if (!cancelled) return false;
    const notice = adapter.interactionExpiredNotice;
    if (!notice || !richIm) return true;
    void richIm
      .updateInteractiveCard(cancelled.messageId, cards.buildResolvedCard(notice))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`dropped interaction card cleanup failed (non-fatal): ${msg}`);
      });
    return true;
  }

  function settleTurnTerminal(turn: TurnState): void {
    const resolve = turn.resolveTerminal;
    if (!resolve) return;
    turn.resolveTerminal = null;
    resolve({
      kind: turn.terminalKind,
      text: turn.presenter.wholeText(),
      completedAt: Date.now(),
      ...(turn.terminalErrorCode ? { errorCode: turn.terminalErrorCode } : {}),
    });
  }

  function completeTurnCallback(turn: TurnState): void {
    releaseTurnInteractionRoute(turn, 'turn_terminal');
    releaseAttachedImTurnHeadless(turn);
    // terminal done/error 的普通收口路径。撤 ack 是不等待的尽力清理，
    // 失败由 cancelAckReaction 内部吞掉；pre-dispatch failure 需要更严格
    // 顺序，走 completeTurnCallbackAfterAck(不带 terminal — 没跑过的 turn
    // 不放结果表情)。
    void cancelAckReaction(turn, { terminal: true });
    invokeTurnCompleteCallback(turn);
  }

  function invokeTurnCompleteCallback(turn: TurnState): void {
    if (!turn.onTurnComplete) return;
    const cb = turn.onTurnComplete;
    turn.onTurnComplete = null;
    try {
      cb();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`onTurnComplete threw (non-fatal): ${msg}`);
    }
  }

  async function completeTurnCallbackAfterAck(turn: TurnState): Promise<void> {
    releaseTurnInteractionRoute(turn, 'turn_not_dispatched');
    releaseAttachedImTurnHeadless(turn);
    await waitForAckCleanupBounded(cancelAckReaction(turn));
    invokeTurnCompleteCallback(turn);
  }

  async function waitForAckCleanupBounded(cleanup: Promise<void>): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, PRE_DISPATCH_ACK_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function handleSendPreDispatchFailure(
    state: SessionState,
    userId: string,
    failure: {
      turn: TurnState;
      source: string;
      reason: string;
      context: string;
      error?: SanitizedSendOutcomeError;
    },
  ): Promise<void> {
    log.error(`${channel} session send failed before dispatch`, {
      kind: 'session-dispatch',
      source: failure.source,
      owner: `${channel}-im`,
      entrypoint: `${channel}.runAgentTurn`,
      sessionId: hashLogSessionId(state.makerSession.id),
      agentKind: state.makerSession.agentKind,
      action: 'send-user-message',
      reason: failure.reason,
      context: failure.context,
      ...(failure.error ? { error: failure.error } : {}),
    });
    // send 没跨过 dispatch 边界时，只清掉本次失败的 turn。queue[0] 可能是已经
    // dispatch 的上一轮 active turn，它仍要继续接收后续 text/done/error。
    const index = state.queue.indexOf(failure.turn);
    if (index >= 0) {
      state.queue.splice(index, 1);
    }
    // pre-dispatch failure 按「有界等待撤 ack → 回调 → 通知」收口。渠道 reaction
    // 接口异常挂起时不能卡住 per-user 串行锁，所以这里等到超时就继续失败提示。
    await completeTurnCallbackAfterAck(failure.turn);
    if (failure.turn.queueMode === 'internal') {
      try {
        // 群轮次强确认策略与不支持档互斥(maker fail-closed 拒绝;「完全访问」
        // 已由渠道设置显式放行, 实际只剩 acceptEdits)— 给用户能看懂的说法并
        // 指路 /permission + 私聊修复卡, 而不是裸抛策略错误码。
        const policyUnsupported = failure.reason.startsWith('TURN_PERMISSION_POLICY_UNSUPPORTED');
        const rejectedMode = failure.reason.split(':')[2] ?? '';
        const unsupportedCopy = adapter.ui.error?.permissionModeUnsupported;
        const message =
          policyUnsupported && unsupportedCopy
            ? typeof unsupportedCopy === 'function'
              ? unsupportedCopy(rejectedMode)
              : unsupportedCopy
            : `❌ 启动 agent 失败：${failure.reason}`;
        if (
          output.kind === 'chunked-text' &&
          failure.turn.chunkedReplyBegun
        ) {
          await output.commitFinal({
            userId,
            text: message,
            terminal: 'error',
            threadTs: state.scopeKey,
            errorCode: failure.reason,
          });
        } else {
          await im.sendText(userId, message, {
            threadTs: state.scopeKey,
          });
        }
        // 群会话「完全访问」档被强确认策略拒绝: 报错文案之外, 再给 owner
        // 私聊发一张一键修复卡(切回 auto)。只对提供 permissionModeFix 文案
        // 的渠道(飞书)与群 lane 生效 — 私聊不挂群策略, 防御性跳过; 卡片
        // 发送失败不阻塞收口(用户仍可 /permission 手动切)。
        if (
          policyUnsupported &&
          adapter.ui.cards.permissionModeFix &&
          output.kind === 'rich-card' &&
          userId.startsWith('g/')
        ) {
          try {
            // 动态 import: 保持 turnRunner 静态依赖链不因修复卡拖进 controlProjects
            // (列表扫描是重模块, 单测 harness 不 mock 它)。
            const [{ readSessionTitle }] = await Promise.all([import('./controlProjects')]);
            let sessionTitle = '';
            try {
              sessionTitle = (await readSessionTitle(state.makerSession.id)) ?? '';
            } catch {
              /* title 查不到就省略, 卡片 body 回落 sessionId 尾号 */
            }
            const fixSpec = cards.buildPermissionModeFixCard({
              sessionId: state.makerSession.id,
              agentKind: state.makerSession.agentKind,
              sessionTitle: sessionTitle || state.makerSession.id.slice(-8),
            });
            await output.im.sendInteractiveCard(userId, fixSpec, { deliverToOwnerDm: true });
            log.info(
              `permissionModeFix card sent to owner DM for session=...${state.makerSession.id.slice(-8)}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`permissionModeFix card send failed (non-fatal): ${msg}`);
          }
        }
      } catch {
        /* 忽略失败：派发失败提示不能再阻塞收口。 */
      }
    }
    if (finishDeferredDetachIfIdle(state)) return;
    // 一条 pre-dispatch failure 不能卡死后面的排队消息 — 继续放行。
    maybeDispatchNextQueued(state, userId);
  }

  function buildSendContext(sessionId: string): string {
    return [
      `${channel}.runAgentTurn`,
      `sessionId=${hashLogSessionId(sessionId)}`,
      'action=send-user-message',
    ].join(' ');
  }

  function hashLogSessionId(sessionId: string): string {
    return `session:${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
  }

  function normalizeSendError(err: unknown): {
    source: string;
    reason: string;
    error: SanitizedSendOutcomeError;
  } {
    const error = sanitizeSendOutcomeError(err);
    if (isSessionRunningError(err, error)) {
      return {
        source: 'session-state',
        reason: 'SESSION_RUNNING',
        error,
      };
    }
    return {
      source: 'session.send',
      reason: error.safeMessage ?? error.errorName ?? error.errorKind ?? 'unknown',
      error,
    };
  }

  function isSessionRunningError(err: unknown, error: SanitizedSendOutcomeError): boolean {
    if (error.errorCode === 'SESSION_RUNNING') return true;
    return err instanceof Error && err.message.startsWith('SESSION_RUNNING:');
  }

  function patchedCardHandle(messageId: string): StreamingTextHandle {
    if (!richIm) throw new Error('rich output is not available');
    let closed = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPatchAt = 0;
    const flush = (): void => {
      timer = null;
      lastPatchAt = Date.now();
      void richIm.patchMarkdownCard(messageId, buffer);
    };
    const schedule = (): void => {
      if (closed || timer) return;
      const wait = Math.max(0, CARD_PATCH_THROTTLE_MS - (Date.now() - lastPatchAt));
      timer = setTimeout(flush, wait);
    };
    const cancel = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return {
      messageId,
      append(delta: string): void {
        if (closed) return;
        buffer += delta;
        schedule();
      },
      replace(fullText: string): void {
        if (closed) return;
        buffer = fullText;
        schedule();
      },
      async finalize(finalText: string): Promise<void> {
        if (closed) return;
        closed = true;
        cancel();
        buffer = finalText;
        await richIm.patchMarkdownCard(messageId, finalText);
      },
      close(): void {
        closed = true;
        cancel();
      },
    };
  }

  function handleTextEvent(turn: TurnState, event: AgentEvent): void {
    // 正文累积(isFinal 用该条全文整体替换缓冲 / 增量追加)与 markActivityWriting
    // 都在 presenter 的 buffer-replace 策略里。也立刻 replace 卡片 —— SDK 在某些
    // 场景(短回复 / reasoning models / oneshot summary)只发 isFinal=true 不走
    // deltas, 这时卡片会一直停在 "灵感正在路上..." placeholder 直到 done; done 之间
    // 几秒延迟里用户看着像 stuck。replace 一次保证用户即时看到回复内容。
    if (!turn.presenter.applyText(event)) return;
    void ensureStreamingHandle(turn).then((h) => h?.replace(composeStreamingView(turn)));
  }

  function ensureStreamingHandle(turn: TurnState): Promise<StreamingTextHandle | null> {
    if (turn.streamingHandle) return Promise.resolve(turn.streamingHandle);
    // 初始创建已失败:resolve null(#2164)。不复用 rejected promise 也不再重试 ——
    // 密集 delta 下重试会造成 API 风暴 / 多张孤儿卡;正文由 turn 收口统一降级。
    if (turn.streamingStartFailed) return Promise.resolve(null);
    if (turn.streamingHandlePromise) return turn.streamingHandlePromise;
    // Singleton: subsequent concurrent callers await the same promise rather
    // than each calling startStreamingText (which would mint a new card per
    // call and produce a flood of orphan messages).
    // 创建失败集中在此捕获并 resolve null(#2164):调用点全部是 fire-and-forget
    // 的 .then(...),各自补 rejection handler 必然遗漏;失败留下脱敏日志与
    // streamingStartFailed 标记,已生成正文由收口分支一次性降级发送。
    turn.streamingHandlePromise = (async () => {
      try {
        const handle =
          output.kind === 'chunked-text'
            ? chunkedTextHandle(turn)
            : turn.outputCardMessageId
              ? patchedCardHandle(turn.outputCardMessageId)
              : await output.im.startStreamingText(turn.userId, undefined, {
                  threadTs: turn.scopeKey,
                });
        turn.streamingHandle = handle;
        return handle;
      } catch (err) {
        turn.streamingStartFailed = true;
        // 只记渠道 / 阶段 / 错误摘要,不记 token、消息正文与完整用户标识。
        log.warn(
          `[${channel}/turn] initial streaming output start failed (phase=initial_stream_start): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    })();
    return turn.streamingHandlePromise;
  }

  function chunkedTextHandle(turn: TurnState): StreamingTextHandle {
    let closed = false;
    return {
      messageId: `chunked:${turn.turnId}`,
      append() {
        // TurnState.buffer is the source of truth; chunked channels do not stream.
      },
      replace() {
        // Best-effort progress remains in memory until terminal commit.
      },
      async finalize(finalText: string) {
        if (closed) return;
        closed = true;
        if (output.kind === 'chunked-text') {
          await output.commitFinal({
            userId: turn.userId,
            text: finalText,
            terminal: turn.terminalKind,
            threadTs: turn.scopeKey,
            ...(turn.mediaAbsPaths.length > 0 ? { mediaAbsPaths: turn.mediaAbsPaths } : {}),
            allowedFileRoots: [turn.workingDir],
            ...(turn.terminalErrorCode ? { errorCode: turn.terminalErrorCode } : {}),
          });
        }
      },
      addExtraImageAbsPath(absPath: string) {
        if (!turn.mediaAbsPaths.includes(absPath)) turn.mediaAbsPaths.push(absPath);
      },
      close() {
        closed = true;
      },
    };
  }

  /**
   * silent-stop done: translator 判定上游用空内容 assistant 消息把"干到一半"的
   * turn 静默收尾(done.data.silentStop=true)。wire 进 desktop 管线后,
   * register.ts 的 silent-stop 守卫会在 ~1.5s 内做决策:
   *   - resume: 以用户身份补发「继续」开新 SDK turn。本渠道**不 shift 队列**,
   *     续跑轮的 text / tool_use 继续路由到 queue[0] 的同一张卡片接着流式,
   *     最终的真 done 走 handleTurnDoneAsync 正常收口 —— 否则续跑输出会变成
   *     stray,IM 用户永远看不到后半段;
   *   - skip / exhausted / send-failed: 不续跑,经 onSilentStopSettled 通知,
   *     此时才把这轮按 done 收口(与 hook-control/session-runner.ts 的
   *     settle 语义对齐)。
   * 重复的 silentStop done(守卫 pendingResume 去重后仍会 settle)不重复订阅。
   */
  function handleSilentStopDone(state: SessionState, userId: string): void {
    const turn = state.queue[0];
    if (!turn) return;
    if (turn.silentStopSettleUnsub) return;
    const unsub = onSilentStopSettled(state.makerSession.id, () => {
      turn.silentStopSettleUnsub = null;
      unsub();
      // 防御: 收口路径都会先退订,回调能跑理应意味着 turn 仍是 queue[0];
      // 若未来有人加了新的出队路径破坏该不变量,这里宁可不动也不错收别人的 turn。
      if (state.queue[0] !== turn) return;
      void handleTurnDoneAsync(state, userId);
    });
    turn.silentStopSettleUnsub = unsub;
  }

  /** 真 done / error 收口前清掉挂着的 silent-stop settle 订阅(幂等)。 */
  function clearSilentStopSettleWait(turn: TurnState): void {
    if (turn.silentStopSettleUnsub) {
      turn.silentStopSettleUnsub();
      turn.silentStopSettleUnsub = null;
    }
  }

  async function handleTurnDoneAsync(state: SessionState, userId: string): Promise<void> {
    const turn = state.queue.shift();
    if (!turn) return;
    clearSilentStopSettleWait(turn);
    turn.done = true;
    clearActivityTicker(turn);
    completeTurnCallback(turn);
    // 这里**不需要**清 activity.notice: turn.done 已置, composeStreamingView 对
    // done 的 turn 直接返回正文、整段跳过过程区, 所以"正在自动重试"不可能漏进
    // finalize 的卡片(该不变量由 turnRunnerSendOutcome 的
    // "clears the retry notice when the retried turn succeeds with no output" 锁住)。
    // 错误路径不同: handleTurnErrorAsync 不置 turn.done, 那里必须显式清。
    // assistant 回复落库不在这里做 — 所有 IM session(接管与渠道默认)都已
    // wireSessionToIpcExternal,由 messagePersistBroadcaster 单点落库(含
    // tool_use / tool_result / thinking 过程消息,desktop 重开历史能完整回放)。
    // 这里再写一份会产生重复记录。
    await materializeTurnLocalImages(state, turn);
    if (!turn.streamingHandle && turn.streamingHandlePromise) {
      try {
        await turn.streamingHandlePromise;
      } catch {
        // The terminal branch below handles the missing output surface.
      }
    }
    if (turn.streamingHandle) {
      try {
        const finalView = composeStreamingView(turn) || '_(空回复)_';
        await turn.streamingHandle.finalize(finalView);
      } catch (err) {
        if (output.kind === 'chunked-text') {
          turn.terminalKind = 'error';
          turn.terminalErrorCode = 'terminal_output_commit_failed';
        }
        log.warn(
          `streamingHandle.finalize failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (turn.presenter.wholeText().length === 0) {
      // No streamed text at all — send a one-shot text so the user knows the
      // turn ended. (Rare; normally agents emit at least one text block.)
      try {
        if (output.kind === 'chunked-text') {
          await output.commitFinal({
            userId,
            text: '✅ (本轮无文本输出)',
            terminal: turn.terminalKind,
            threadTs: state.scopeKey,
            ...(turn.mediaAbsPaths.length > 0 ? { mediaAbsPaths: turn.mediaAbsPaths } : {}),
          });
        } else {
          await output.im.sendText(userId, '✅ (本轮无文本输出)', {
            threadTs: state.scopeKey,
          });
        }
      } catch {
        /* swallow */
      }
    } else {
      // 初始流式输出面创建失败但正文已生成(#2164):此前两条分支都不命中,
      // 已持久化的助手回复在渠道侧静默消失。收口时一次性降级为普通文本发送
      // (turn.done 已置,composeStreamingView 只含干净正文;长度限制由渠道发送
      // 实现兑现)。发送失败只记脱敏日志,不阻塞 settle / 队列放行。
      try {
        const fallbackText = composeStreamingView(turn);
        if (output.kind === 'chunked-text') {
          await output.commitFinal({
            userId,
            text: fallbackText,
            terminal: turn.terminalKind,
            threadTs: state.scopeKey,
            ...(turn.mediaAbsPaths.length > 0 ? { mediaAbsPaths: turn.mediaAbsPaths } : {}),
          });
        } else {
          await output.im.sendText(userId, fallbackText, { threadTs: state.scopeKey });
        }
        log.info(`[${channel}/turn] streaming surface unavailable — final text delivered via plain send`);
      } catch (err) {
        log.warn(
          `[${channel}/turn] plain-text fallback send failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    settleTurnTerminal(turn);
    log.info(
      `turn done for session=...${(state.makerSession.id ?? '').slice(-8)}, queueDepth=${state.queue.length}`,
    );
    if (finishDeferredDetachIfIdle(state)) return;
    // 收口完成(最终卡片已 finalize)后再派发下一条排队消息 — IM 时间线保持
    // "上一轮输出 → 下一条开始流式"的自然顺序。
    maybeDispatchNextQueued(state, userId);
  }

  async function handleTurnErrorAsync(
    state: SessionState,
    userId: string,
    errData: unknown,
  ): Promise<void> {
    const turn = state.queue.shift();
    const rawMsg =
      errData && typeof errData === 'object' && 'message' in errData
        ? String((errData as { message: unknown }).message)
        : String(errData);
    log.error(`turn error: ${rawMsg}`);
    // 过载类终态(Codex 重试耗尽 / Claude 529 最终失败)换成可操作的本地化说明。
    // 不换的话渠道用户会在重试进度之后突然收到 `Selected model is at capacity...`
    // 或内部英文 SDK 串——从本地化文案回归英文实现细节(review #844 codex P1)。
    // hook runner 与调度转播共用同一个 helper，三条渠道链路口径一致；上游原文留在
    // 本地日志。
    const msg = terminalErrorText(errData);
    if (turn) clearSilentStopSettleWait(turn);
    if (turn) clearActivityTicker(turn);
    if (turn) {
      turn.terminalKind = 'error';
      turn.terminalErrorCode = 'agent_turn_error';
    }
    if (turn) completeTurnCallback(turn);
    // 清掉"正在自动重试"这类瞬态说明：重试耗尽后走到这里时它还挂在 activity 上，
    // 而下面 composeStreamingView 会把它一起写进 finalize 的正文——最终卡片会在
    // 失败说明的正上方永久显示"仍在重试"（review #844 codex P1）。
    if (turn) setActivityNotice(turn.presenter.activity, null);
    if (turn) await materializeTurnLocalImages(state, turn);
    // 建卡请求可能还在飞: 过载重试提示会惰性建一张进度卡(handleRetryNoticeEvent),
    // 而终态错误可能恰好在 startStreamingText 回来之前到达。此时 streamingHandle
    // 还是 null → 走下面"另发一条错误消息"的分支并把 turn 出队, 随后那个 promise
    // resolve, 又去 replace 一张已经没人收口的孤儿卡, 渠道里就出现重复/残留输出
    // (review #844 codex P1)。done 路径早就在这里 await 了同一个 promise, 错误路径
    // 照抄同款同步。
    if (turn && !turn.streamingHandle && turn.streamingHandlePromise) {
      try {
        await turn.streamingHandlePromise;
      } catch {
        // 建卡失败 → 下面按"没有输出面"处理(另发一条消息)。
      }
    }
    if (turn?.streamingHandle) {
      try {
        const view = composeStreamingView(turn);
        const body = view ? `${view}\n\n❌ 错误：${msg}` : `❌ 错误：${msg}`;
        await turn.streamingHandle.finalize(body);
      } catch {
        /* swallow */
      }
    } else {
      try {
        if (output.kind === 'chunked-text') {
          await output.commitFinal({
            userId,
            text: `❌ 错误：${msg}`,
            terminal: 'error',
            threadTs: state.scopeKey,
            errorCode: turn?.terminalErrorCode ?? 'agent_turn_error',
            ...(turn && turn.mediaAbsPaths.length > 0 ? { mediaAbsPaths: turn.mediaAbsPaths } : {}),
          });
        } else {
          await output.im.sendText(userId, `❌ 错误：${msg}`, {
            threadTs: state.scopeKey,
          });
        }
      } catch {
        /* swallow */
      }
    }
    if (turn) settleTurnTerminal(turn);
    if (finishDeferredDetachIfIdle(state)) return;
    // error 收口同样要继续放行排队消息 — 一条失败不能卡死后面的队列。
    maybeDispatchNextQueued(state, userId);
  }

  async function materializeTurnLocalImages(state: SessionState, turn: TurnState): Promise<void> {
    if (output.kind !== 'chunked-text' || !turn.presenter.wholeText().includes('![')) return;
    try {
      const materialized = await materializeLocalMarkdownImages({
        text: turn.presenter.wholeText(),
        workingDir: state.workingDir,
        sessionId: state.makerSession.id,
        maxImages: 4,
        existingAbsPaths: [...turn.mediaAbsPaths],
      });
      turn.presenter.replaceBody(materialized.text);
      for (const absPath of materialized.absPaths) {
        if (!turn.mediaAbsPaths.includes(absPath)) turn.mediaAbsPaths.push(absPath);
      }
    } catch (err) {
      log.warn(
        `local markdown image materialization failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function persistSdkSessionId(localSessionId: string, data: unknown): Promise<void> {
    const sdkSessionId =
      data && typeof data === 'object' && 'sdkSessionId' in data
        ? String((data as { sdkSessionId: unknown }).sdkSessionId)
        : data && typeof data === 'string'
          ? data
          : '';
    if (!sdkSessionId) return;
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessionsTable)
        .set({ sdkSessionId, updatedAt: Date.now() })
        .where(eq(sessionsTable.id, localSessionId));
    } catch (err) {
      log.warn(
        `persistSdkSessionId failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── interaction handling ────────────────────────────────────────────────────

  function handleInteractionFor(
    localSessionId: string,
    userId: string,
    scopeKey?: string,
    confirmationTimeoutMs?: number,
  ) {
    return async (req: InteractionRequest): Promise<InteractionDecision> => {
      log.info(
        `interaction request kind=${req.kind} requestId=...${req.requestId.slice(-8)} session=...${localSessionId.slice(-8)}`,
      );

      if (output.kind === 'chunked-text') {
        if (adapter.handleTextInteraction) {
          if (req.kind === 'permission') {
            const guard = checkChannelDestructiveToolCall(req.toolName, req.input);
            if (guard.destructive) {
              log.warn(`destructive tool blocked: ${req.toolName} (${guard.reason})`);
              return {
                kind: 'permission',
                behavior: 'deny',
                reason: `[destructiveGuard] ${guard.reason}`,
              };
            }
          }
          return adapter.handleTextInteraction(userId, req, {
            ...(confirmationTimeoutMs ? { timeoutMs: confirmationTimeoutMs } : {}),
          });
        }
        if (req.kind === 'ask_user_question') {
          return { kind: 'ask_user_question', answers: {} };
        }
        if (req.kind === 'plan_review') {
          return {
            kind: 'plan_review',
            behavior: 'deny',
            reason: 'desktop_confirmation_not_installed',
            dismissed: true,
          };
        }
        return {
          kind: 'permission',
          behavior: 'deny',
          reason: 'desktop_confirmation_not_installed',
        };
      }

      // ── destructive guard ────────────────────────────────────────────────
      // 即使 permissionMode='auto' 让 SDK classifier 放行了一些工具,我们仍要
      // 兜底拦掉删除类操作 —— 老系统 denyDestructive 行为对齐
      // (apps/desktop/src/main/destructiveGuard.ts)。
      // 命中规则: 工具名含 delete/remove/unlink/rmdir/trash/erase, 或
      // Bash/PowerShell 命令含 rm/del/Remove-Item/find -delete/git clean -f 等。
      // 模型收到 deny 后通常会改用 AskUserQuestion 跟用户沟通。
      if (req.kind === 'permission') {
        const guard = checkChannelDestructiveToolCall(req.toolName, req.input);
        if (guard.destructive) {
          log.warn(`destructive tool blocked: ${req.toolName} (${guard.reason})`);
          return {
            kind: 'permission',
            behavior: 'deny',
            reason: `[destructiveGuard] ${guard.reason}`,
          };
        }
      }

      let spec: InteractiveCardSpec | null = null;
      let denyReason: string | null = null;
      switch (req.kind) {
        case 'permission':
          spec = cards.buildPermissionCard(req);
          break;
        case 'ask_user_question':
          spec = cards.buildAskUserCard(req);
          if (!spec) {
            // No questions — auto-respond with empty answers.
            return { kind: 'ask_user_question', answers: {} };
          }
          break;
        case 'plan_review':
          spec = cards.buildPlanReviewCard(req);
          break;
        default:
          denyReason = `unknown interaction kind`;
      }

      if (denyReason || !spec) {
        const kind = req.kind as InteractionDecision['kind'];
        if (kind === 'ask_user_question') {
          return { kind, answers: {} };
        }
        return { kind, behavior: 'deny', reason: denyReason ?? 'no_card' };
      }

      // Finalize any in-flight streaming card BEFORE sending the interaction
      // card, so the agent's post-decision text creates a NEW card *below* the
      // (eventually resolved) interaction card — not into the pre-existing card
      // that sits above it. Without this, the user sees the conclusion stream
      // into a card chronologically older than the "✅ 已选择" patch.
      // 深链身份必须在 finalizeActiveStream **之后**照样可用: 它取自本 turn 的
      // userMessageId(业务事实), 与流式 handle 生命周期无关 —— 传输层猜不出这个。
      const ownerDmSourceMessageId =
        sessionStates.get(localSessionId)?.queue[0]?.userMessageId ?? undefined;
      await finalizeActiveStream(localSessionId);

      let messageId: string;
      try {
        const result = await output.im.sendInteractiveCard(userId, spec, {
          threadTs: scopeKey,
          // 同上: 只有 permission 卡转宿主私聊
          ...(req.kind === 'permission'
            ? {
                deliverToOwnerDm: true,
                ownerDmNote: GROUP_APPROVAL_OWNER_DM_NOTE,
                ...(ownerDmSourceMessageId !== undefined ? { ownerDmSourceMessageId } : {}),
              }
            : {}),
        });
        messageId = result.messageId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`sendInteractiveCard failed: ${msg}`);
        const kind = req.kind as InteractionDecision['kind'];
        if (kind === 'ask_user_question') {
          return { kind, answers: {} };
        }
        return { kind, behavior: 'deny', reason: `card send failed: ${msg}` };
      }

      try {
        // 授权卡已转投 owner 私聊 — 立刻在原群/话题 lane 留一句指路(不能等
        // registerPending: 它要等用户点完卡才返回, 那提示就变成"事后"的了)。
        // 私聊 lane 的卡片就落在当前会话里, 不需要指路。
        if (
          req.kind === 'permission' &&
          userId.startsWith('g/') &&
          adapter.ui.cards.permission.dmRoutedNotice
        ) {
          try {
            const notice = adapter.ui.cards.permission.dmRoutedNotice;
            const text = typeof notice === 'function' ? notice(req.toolName) : notice;
            await im.sendText(userId, text, {
              threadTs: scopeKey,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`dm routed notice send failed (non-fatal): ${msg}`);
          }
        }
        const decision = await registerPending(
          req.requestId,
          req.kind as InteractionDecision['kind'],
          messageId,
          // Stash toolName for permission requests so cardActionHandler can
          // build permissionUpdates when the user picks 'allow:always'.
          // permissionCard 留着收口时恢复原始正文(工具名 + 参数预览)。
          req.kind === 'permission'
            ? {
                toolName: req.toolName,
                permissionCard: { title: spec.title ?? '', body: spec.body },
              }
            : undefined,
        );
        return decision;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`pending interaction failed: ${msg}`);
        const kind = req.kind as InteractionDecision['kind'];
        if (kind === 'ask_user_question') {
          return { kind, answers: {} };
        }
        return { kind, behavior: 'deny', reason: `pending failed: ${msg}` };
      }
    };
  }

  /**
   * Finalize the current turn's streaming card (if any) and detach it from the
   * turn, so the next text event creates a fresh card. Called right before
   * sending an interaction card so the post-decision reply lands chronologically
   * after the user's selection patch — not in a card that pre-dates the ask.
   *
   * No-op when there's no active streaming handle (typical when the agent goes
   * straight to ask_user_question without emitting prior text).
   */
  async function finalizeActiveStream(localSessionId: string): Promise<void> {
    const state = sessionStates.get(localSessionId);
    const turn = state?.queue[0];
    if (!turn?.streamingHandle) return;
    const view = composeStreamingView(turn);
    if (view.length > 0) {
      try {
        await turn.streamingHandle.finalize(view);
      } catch (err) {
        log.warn(
          `finalizeActiveStream: finalize failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Empty card was minted but never written to — close it without a final
      // patch (avoids leaving an "(空回复)" placeholder above the ask card).
      turn.streamingHandle.close();
    }
    turn.streamingHandle = null;
    turn.streamingHandlePromise = null;
    turn.presenter.replaceBody('');
  }

  // ── cleanup (binding detach / dispose) ──────────────────────────────────────

  /**
   * 丢弃排队中尚未 dispatch 的消息 + 清掉兜底 timer — detach / dispose 路径共用。
   * 被丢弃消息的 ack 表情顺手撤掉(否则永远挂在用户消息上)。
   */
  function clearPendingSends(state: SessionState): void {
    if (state.dispatchRetryTimer) {
      clearTimeout(state.dispatchRetryTimer);
      state.dispatchRetryTimer = null;
    }
    if (state.sendQueue.length === 0) return;
    const dropped = state.sendQueue.splice(0, state.sendQueue.length);
    log.warn(`dropping ${dropped.length} queued message(s) on cleanup/detach`);
    for (const item of dropped) {
      releaseAttachedImTurnHeadless(item.turn);
      void cancelAckReaction(item.turn);
    }
  }

  /** detach / dispose 路径: 清掉 in-flight turn 的过程区 ticker 与 silent-stop
   *  settle 订阅, 防定时器 / 陈旧回调泄漏。 */
  function clearQueuedTurnTimers(state: SessionState): void {
    for (const turn of state.queue) {
      releaseAttachedImTurnHeadless(turn);
      clearActivityTicker(turn);
      clearSilentStopSettleWait(turn);
    }
    if (state.scheduledTranspond) clearTranspondTicker(state.scheduledTranspond);
  }

  /**
   * 接管 detach 路径专用清理: 取消本渠道的 onEvent listener + 还原 desktop 版
   * interaction listener + 从 sessionStates 删除。被接管的 maker session 实例
   * 本身不动 (desktop 那边可能还在用它), 只是本渠道这边的 hook 撤掉。
   *
   * 调用方: 组合根的 binding cleanup hook, 在 binding 变更后调一次。
   * 仅对 attached=true 的 sessionStates entry 生效, 其他情况 noop。
   */
  function detachFromSession(sessionId: string): void {
    const state = sessionStates.get(sessionId);
    if (!state?.attached) return;
    if (state.queue.length > 0) {
      clearPendingSends(state);
      if (!state.detachDrainPromise) {
        state.detachDrainPromise = new Promise<DetachDrainOutcome>((resolve) => {
          state.resolveDetachDrain = resolve;
        });
      }
      log.info(
        `deferring ${channel} detach until active turn drains session=${sessionId.slice(-8)}`,
      );
      return;
    }
    detachSessionStateNow(sessionId, state);
  }

  function finishDeferredDetachIfIdle(state: SessionState): boolean {
    if (!state.detachDrainPromise || state.queue.length > 0) return false;
    detachSessionStateNow(state.makerSession.id, state);
    return true;
  }

  function detachSessionStateNow(sessionId: string, state: SessionState): void {
    sessionStates.delete(sessionId);
    cleanupSessionState(state);
    settleDetachDrain(state, 'rewire');
    log.info(`detached ${channel} hook from session=${sessionId.slice(-8)}`);
  }

  function settleDetachDrain(state: SessionState, outcome: DetachDrainOutcome): void {
    const resolveDetachDrain = state.resolveDetachDrain;
    state.detachDrainPromise = null;
    state.resolveDetachDrain = null;
    resolveDetachDrain?.(outcome);
  }

  function disposeAllSessions(): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const [, state] of sessionStates) {
      // `queue` only contains turns dispatched by this IM orchestrator. An
      // attached desktop-originated turn may make isTurnRunning() true while
      // queue stays empty; logout must not abort that desktop-owned work.
      const hasImTurnInFlight = state.queue.length > 0;
      cleanupSessionState(state);
      settleDetachDrain(state, 'cancelled');
      if (hasImTurnInFlight) {
        aborts.push(
          state.makerSession.abort().catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`disposeAllSessions abort failed (non-fatal): ${msg}`);
          }),
        );
      }
    }
    sessionStates.clear();
    unsubscribeMakerEvents?.();
    unsubscribeMakerEvents = null;
    subscribedMaker = null;
    rejectAllPending('session disposed');
    return Promise.all(aborts).then(() => undefined);
  }

  function getMakerSessionById(sessionId: string): MakerSession | null {
    return sessionStates.get(sessionId)?.makerSession ?? null;
  }

  async function stopActiveTurn(args: {
    botContextId: string;
    userId: string;
    scopeKey?: string;
  }): Promise<{ stopped: boolean; droppedQueued: number }> {
    const { botContextId, userId, scopeKey } = args;
    // 只解析既有路由 — !stop 不该为不存在的会话新建 session 行。
    const target = await resolveExistingRouteTarget(botContextId, userId, scopeKey);
    const state = target ? sessionStates.get(target.row.id) : undefined;
    if (!state) return { stopped: false, droppedQueued: 0 };
    const running =
      state.queue.length > 0 || state.sendQueue.length > 0 || state.makerSession.isTurnRunning();
    if (!running) return { stopped: false, droppedQueued: 0 };
    const droppedQueued = state.sendQueue.length;
    // 先清排队再 abort — abort 触发的 done/error 会走 maybeDispatchNextQueued,
    // 队列不清空的话下一条排队消息会在中止后立刻自动派发。
    clearPendingSends(state);
    // 重置 silent-stop 守卫(与 desktop ABORT_SESSION handler 同源): turn 若正
    // 挂在 silentStop 的 1.5s 决策窗里, abort 对早已收尾的 SDK turn 是 no-op、
    // 不产生任何事件,不重置的话守卫照样自动续跑,用户喊停后 agent 原地复活。
    // 重置后守卫判 superseded → settle('skip') → 挂起 turn 经现有订阅按 done 收口。
    noteSilentStopSessionReset(state.makerSession.id);
    if (state.queue[0]) state.queue[0].terminalKind = 'aborted';
    await state.makerSession.abort();
    log.info(
      `!stop aborted turn for session=...${state.makerSession.id.slice(-8)} droppedQueued=${droppedQueued}`,
    );
    return { stopped: true, droppedQueued };
  }

  /**
   * Dispose one session by id (used by `/new` slash command — wipes the
   * in-process Maker session so the next message creates a fresh SDK
   * conversation thread). Idempotent.
   */
  async function disposeOneSession(sessionId: string): Promise<void> {
    const state = sessionStates.get(sessionId);
    if (!state) return;
    sessionStates.delete(sessionId);
    cleanupSessionState(state);
    settleDetachDrain(state, 'cancelled');
    try {
      await state.makerSession.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`disposeOneSession close failed (non-fatal): ${msg}`);
    }
  }

  function forgetClosedSession(sessionId: string, reason: string): void {
    const state = sessionStates.get(sessionId);
    if (!state) return;
    sessionStates.delete(sessionId);
    cleanupSessionState(state);
    settleDetachDrain(state, 'cancelled');
    log.info(`forgot cached ${channel} session=${sessionId.slice(-8)} after ${reason}`);
  }

  function cleanupSessionState(state: SessionState): void {
    clearPendingSends(state);
    clearQueuedTurnTimers(state);
    for (const u of state.unsubscribers) {
      try {
        u();
      } catch {
        /* swallow */
      }
    }
    for (const turn of state.queue) {
      releaseTurnInteractionRoute(turn, 'session_cleanup');
      turn.terminalKind = 'aborted';
      turn.terminalErrorCode ??= 'session_cleanup';
      settleTurnTerminal(turn);
    }
  }

  return {
    runAgentTurn,
    dispatchAgentTurn,
    resolveRouteTarget,
    hasAuthForRoute: (row) => hasAuthForImRoute(row, undefined, authCheckDeps()),
    getAuthStatusForRoute: (row) => checkImRouteAuthDetailed(row, undefined, authCheckDeps()),
    prewireAttachedSession,
    detachFromSession,
    disposeAllSessions,
    disposeOneSession,
    getMakerSessionById,
    getPermissionModes: (agentKind) => getMaker().getCapabilities(agentKind).permissionModes,
    changePermissionMode: (args) =>
      changeSessionPermissionMode({
        ...args,
        readPreviousMode: () => readPermissionMode(args.sessionId),
        getLiveSession: () => getMakerSessionById(args.sessionId),
        persist: (mode) => updatePermissionMode(args.sessionId, mode),
      }),
    stopActiveTurn,
  };
}
