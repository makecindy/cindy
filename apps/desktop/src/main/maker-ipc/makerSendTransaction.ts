import type {
  AgentKind,
  SessionSendOptions,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';

import {
  createHostSendFailure,
  type DesktopMakerSendResult,
  toCompatibleMakerSendResult,
  toDesktopSessionDispatchOutcome,
} from '../maker-host/send-outcome.js';
import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  prependHandoffToUserMessage,
  prependNoteToWireUserMessage,
  type HandoffWireMessage,
} from './agentHandoff.js';
import { buildMobileClientPromptNote } from './mobileClientPromptNote.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

type CreateOpts = MakerSessionCreateOpts;

type IpcUserMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

type MakerSendOptions = {
  messageUuid?: string;
  userName?: string;
  throwOnStartFailure?: boolean;
  /**
   * Direct Continue fallback only: acknowledge the interrupted marker on the
   * executor after vendor dispatch is irreversible. The executor must own the
   * timestamp so device-link controller/controlled clock skew cannot corrupt
   * active_turn_started_at > last_turn_ended_at ordering.
   */
  ackInterruptedTurnOnDispatch?: boolean;
  signal?: AbortSignal;
  /**
   * scheduler 排队消息的来源标记(coordinator drain 透传,见 AgentInputSendOpts.origin)。
   * 打到 sess.send 的 origin(本轮 turnOrigin)并合进落库 user 消息 agentMeta.origin。
   */
  origin?: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  /**
   * 手机来源(coordinator 从队列项透传;**main 构造,不是 wire 输入**——直连 maker:send
   * 的客户端 sendOpts 在 sessionSendHandler 边界被剥掉,见那里的说明)。
   *
   * 必须认这一条:手机会话页所有发送都走 input:enqueue / input:steer,drain 派发时
   * 入队时的 async context 早已结束,只靠 isMobileClientInvoke() 实际读不到来源。
   */
  fromMobileClient?: boolean;
  persistUserMessage?: {
    clientId?: unknown;
    content?: unknown;
    sdkSessionId?: unknown;
    delivery?: unknown;
    shouldBroadcast?: unknown;
    onPersisting?: unknown;
    onPersisted?: unknown;
    /**
     * 自动续跑标记(coordinator drain 透传,见 AgentInputQueuedMessage.autoResume)。
     * 合进落库 user 消息的 agentMeta.autoResume:renderer 据此隐藏气泡并渲染
     * 「已自动继续」,host 的 createDbMessage 据此跳过自动续跑额度充值。
     */
    autoResume?: unknown;
    /** 本次自动续跑的展示信息(合进 agentMeta.autoResumeInfo,供活动行 param 位与展开详情)。 */
    autoResumeInfo?: unknown;
  };
};

export interface MakerSendTransactionSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  remoteHostId: string | null;
  /** Error sessions stay registered while their underlying handle cleanup is retried. */
  getStatus?(): 'active' | 'aborting' | 'closed' | 'error';
  isTurnRunning(): boolean;
  send(message: UserMessage | string, opts?: SessionSendOptions): Promise<SessionSendResult>;
}

export interface MakerSendTransactionLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface MakerSendTransactionDeps {
  getSession(sessionId: string): MakerSendTransactionSession | undefined | null;
  closeSession(sessionId: string): Promise<void>;
  getSessionMeta(sessionId: string): Promise<{ title?: string } | null>;
  ensureRemoteReadyForSessionStart(params: {
    session?: { agentKind: AgentKind; remoteHostId: string | null } | null;
    createOpts?: unknown;
  }): Promise<void>;
  checkWorkDirExists(
    sessionId: string,
    workingDir: string | undefined | null,
    agentKind: AgentKind | undefined,
    remoteHostId?: string | null,
    opts?: { suppressMissingBroadcast?: boolean },
  ): Promise<boolean>;
  /**
   * 读 DB 里既有会话的权威 working_dir(行不存在 → null)。lazy-create /
   * rehydrate 在 caller 传入的 workingDir 校验失败时用它兜底——输入队列崩溃
   * 快照等缓存的 createOpts 可能内嵌已被启动 sweep 改写掉的老路径。
   */
  readSessionWorkingDirFromDb(sessionId: string): Promise<string | null>;
  isOrcaMcpHydrated(sessionId: string): boolean;
  buildCreateOptsWithStderr(opts: CreateOpts): CreateOpts;
  synthesizeOrcaVendorOptionsFromDb(sessionId: string, opts: CreateOpts): Promise<boolean>;
  readSessionExtraDirsFromDb(sessionId: string): Promise<string[]>;
  withRehydrateCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  bootstrapSession(opts: CreateOpts): Promise<{
    session: MakerSendTransactionSession;
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }>;
  markOrcaRoleIfNeeded(sessionId: string, role: 'lead' | 'worker' | null | undefined): Promise<void>;
  broadcastSessionCreated(sessionId: string): void;
  prepareSendUserMessage(
    sessionId: string,
    message: unknown,
  ): Promise<IpcUserMessage>;
  /**
   * Direct device-link sends may carry OSS attachment references that need to
   * become local paths before normalization. Keep this after the transaction's
   * session/workdir preflight so rejected sends do not materialize local copies.
   */
  materializeDirectSendOssAttachments?: (
    sessionId: string,
    message: unknown,
    sendOpts: unknown,
  ) => Promise<{
    message: unknown;
    sendOpts: unknown;
    cleanupAfterAcceptance?: () => void;
    cleanupBeforeAcceptance?: () => void | Promise<void>;
  }>;
  createDbMessage(
    sessionId: string,
    message: {
      clientId: string;
      role: 'user';
      content: unknown;
      agentMeta: Record<string, unknown>;
      createdAt?: number;
    },
    opts?: { shouldBroadcast?: () => boolean },
  ): Promise<unknown>;
  /** 把 Pi 原生 user entry id 补到已落库的 Cindy user 行，供会话树恢复附件。 */
  linkPiUserEntry?(
    sessionId: string,
    clientId: string,
    piEntryId: string,
  ): Promise<boolean | void>;
  beforeDispatchDirectUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedDirectUserTurn?: (sessionId: string) => void;
  ackInterruptedTurnDispatched?: (sessionId: string, endedAt: number) => void | Promise<void>;
  previewUserPrompt?(
    session: { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
    content: unknown,
    options: { source: string; clientId?: string },
  ): void;
  dispatchUserPromptPreview?(sessionId: string, clientId: string | undefined): void;
  commitUserPromptPreview?(sessionId: string, clientId: string | undefined): void;
  rollbackUserPromptPreview?(sessionId: string, clientId: string | undefined, source: string): void;
  isSessionRunningError(err: unknown): boolean;
  /**
   * session-agent-switch:lazy-create 前用 DB 行(真源)校正 createOpts。
   * 切换后 renderer/队列里可能残留旧 agentKind / 旧 resumeSessionId 的 createOpts,
   * 用它 spawn 会把消息发回旧引擎且丢交接注入;此钩子读 sessions 行,发现漂移时
   * 原地覆写 agentKind/model/resumeSessionId/providerId。undefined = 不校正(测试用)。
   */
  reconcileCreateOptsWithDb?(sessionId: string, createOpts: CreateOpts): Promise<void>;
  /**
   * session-agent-switch:turn 运行中登记的切换意图在**发送时刻**执行(先于
   * getSession——apply 会 close 旧引擎,随后本事务按 DB 新值 lazy-create 新引擎,
   * 交接注入走下面的 pending handoff 通道)。apply 内部自查 turn 空闲,仍在跑则
   * 保留意图本次不动。undefined = 不启用(测试最小 harness)。
   */
  applyPendingAgentSwitch?(sessionId: string): Promise<void>;
  /**
   * session-agent-switch:pending 交接读取(agentHandoff 注册表)。命中时把交接
   * 文本前置进 wire payload(不影响 persistUserMessage 落库显示内容),并在
   * dispatch 跨过不可逆边界(accepted)后 consume;未 accepted / 抛错保留 pending。
   */
  peekPendingHandoff?(sessionId: string): Promise<string | null>;
  consumePendingHandoff?(sessionId: string): void;
  /**
   * 本次调用是否来自手机控制端(缺省 = 否)。**纯体验分流,不是安全判据。**
   *
   * 注入而非直接 import `isMobileControllerInvoke`,是为了可单测(同
   * newMakerWorktreePreferenceHandler 把 isDeviceLinkInvoke 做成 deps 的写法)。
   *
   * ⚠️ 判据里的平台值是**对端设备在 hello 帧自报**的(经 presence 广播进本机缓存),
   * 本仓没有服务端校验 —— 一台改过的同账号已配对设备可以声称自己是手机。它的唯一
   * 后果是多追加一段体验说明,所以够用;但不得据它放行权限或跳过任何校验。
   * 完整可信度说明见 device-link/invoke-context.ts。
   */
  isMobileClientInvoke?(): boolean;
  log: MakerSendTransactionLog;
}

export interface MakerSendTransaction {
  sendToAgentAccepted(
    sessionId: unknown,
    message: unknown,
    createOpts?: unknown,
    sendOpts?: unknown,
  ): Promise<DesktopMakerSendResult>;
}

type ResolveSessionResult =
  | { kind: 'session'; session: MakerSendTransactionSession }
  | { kind: 'failure'; result: DesktopMakerSendResult };

function readPersistUserMessageOption(sendOpts: MakerSendOptions): {
  clientId: string;
  content: unknown;
  sdkSessionId?: string;
  delivery?: 'turn' | 'steer';
  autoResume?: boolean;
  autoResumeInfo?: Record<string, unknown>;
  shouldBroadcast?: () => boolean;
  onPersisting?: () => void;
  onPersisted?: () => void | Promise<void>;
} | null {
  const persist = sendOpts.persistUserMessage;
  if (!persist || typeof persist.clientId !== 'string') return null;
  return {
    clientId: persist.clientId,
    content: persist.content,
    ...(typeof persist.sdkSessionId === 'string' ? { sdkSessionId: persist.sdkSessionId } : {}),
    ...(persist.autoResume === true ? { autoResume: true as const } : {}),
    ...(persist.autoResumeInfo && typeof persist.autoResumeInfo === 'object'
      ? { autoResumeInfo: persist.autoResumeInfo as Record<string, unknown> }
      : {}),
    ...(persist.delivery === 'turn' || persist.delivery === 'steer' ? { delivery: persist.delivery } : {}),
    ...(typeof persist.shouldBroadcast === 'function'
      ? { shouldBroadcast: persist.shouldBroadcast as () => boolean }
      : {}),
    ...(typeof persist.onPersisting === 'function'
      ? { onPersisting: persist.onPersisting as () => void }
      : {}),
    ...(typeof persist.onPersisted === 'function'
      ? { onPersisted: persist.onPersisted as () => void | Promise<void> }
      : {}),
  };
}

function containsManagedAttachment(value: unknown): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      return containsManagedAttachment(JSON.parse(trimmed) as unknown);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const block = item as Record<string, unknown>;
      return block.type === 'image' || block.type === 'file' || containsManagedAttachment(block.content);
    });
  }
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (Array.isArray(record.images) && record.images.length > 0)
    || (Array.isArray(record.files) && record.files.length > 0)
    || containsManagedAttachment(record.content);
}

/**
 * 普通 maker:send 的产品事务。
 *
 * 保持老链路 lazy-create 语义：第一次发送时才 spawn SDK；调用方可带 createOpts，
 * 让事务在内存里找不到 session 时创建或恢复会话。
 *
 * 事务契约：只有返回 accepted=true 才表示 vendor dispatch 已跨过不可逆边界。
 * lazy-create 失败、cwd 缺失、附件归一化失败、throwOnStartFailure 下的 vendor
 * turn/start 失败、或输入队列关闭，都必须在 accepted=true 前拒绝或返回
 * accepted=false，让调用方按未派发状态回滚。不要新增“先 emit error 再静默
 * return”的路径，除非同步更新 queue / bubble / DB / dispatch 状态协议。
 */
export function createMakerSendTransaction(deps: MakerSendTransactionDeps): MakerSendTransaction {
  async function loadExtraDirsIfNeeded(sessionId: string, opts: CreateOpts, source: 'lazy-create' | 'active-orca-rehydrate'): Promise<void> {
    if (opts.extraDirs !== undefined) return;
    try {
      const row = await deps.readSessionExtraDirsFromDb(sessionId);
      if (row.length > 0) opts.extraDirs = row;
    } catch (err) {
      deps.log.warn(`${source}: read extra_dirs from DB failed (non-fatal)`, {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * workDir 校验 + DB 权威值兜底。caller 传入的 createOpts.workingDir 可能是
   * 缓存的陈旧值(典型:输入队列崩溃快照在启动 sweep 改写 DB 之前入的库,
   * 回放时仍内嵌老路径,2026-07-20 实报)——校验失败时读 DB 行的 working_dir
   * 重试,通过则就地采纳进 createOpts(后续 bootstrap 用新 cwd spawn)。
   * 存在兜底候选时首检静默,避免"先弹错误横幅再静默成功"的假错误。
   */
  async function ensureWorkDirWithDbFallback(
    sessionId: string,
    createOpts: CreateOpts,
  ): Promise<boolean> {
    const dbDir = await deps.readSessionWorkingDirFromDb(sessionId).catch(() => null);
    const fallbackDir = dbDir && dbDir !== createOpts.workingDir ? dbDir : null;
    const ok = fallbackDir
      ? await deps.checkWorkDirExists(
          sessionId,
          createOpts.workingDir,
          createOpts.agentKind,
          createOpts.remoteHostId,
          { suppressMissingBroadcast: true },
        )
      : await deps.checkWorkDirExists(
          sessionId,
          createOpts.workingDir,
          createOpts.agentKind,
          createOpts.remoteHostId,
        );
    if (ok) return true;
    if (!fallbackDir) return false;
    const okDb = await deps.checkWorkDirExists(
      sessionId,
      fallbackDir,
      createOpts.agentKind,
      createOpts.remoteHostId,
    );
    if (!okDb) return false;
    deps.log.info('send: adopted DB working_dir over stale caller createOpts', {
      sessionId,
      staleWorkingDir: createOpts.workingDir,
      workingDir: fallbackDir,
    });
    createOpts.workingDir = fallbackDir;
    return true;
  }

  async function rehydrateActiveOrcaSession(
    sessionId: string,
    createOpts: CreateOpts,
  ): Promise<ResolveSessionResult> {
    const okRehydrate = await ensureWorkDirWithDbFallback(sessionId, createOpts);
    if (!okRehydrate) {
      return {
        kind: 'failure',
        result: toCompatibleMakerSendResult(
          createHostSendFailure('WORKDIR_MISSING', `working directory is missing for session ${sessionId}`),
        ),
      };
    }
    await loadExtraDirsIfNeeded(sessionId, createOpts, 'active-orca-rehydrate');
    try {
      const session = await deps.withRehydrateCloseSuppressed(sessionId, async () => {
        await deps.closeSession(sessionId);
        // close 后重新 bootstrap，避免旧 SDK handle 缺 Orca MCP vendorOptions。
        const { session: newSess, didInjectOrcaInstructions, didInjectProjectContext } = await deps.bootstrapSession(createOpts);
        await deps.markOrcaRoleIfNeeded(newSess.id, createOpts.orcaRole);
        deps.log.info('send: rehydrate active Orca session with MCP vendorOptions', {
          sessionId,
          agentKind: createOpts.agentKind,
          usedOrcaInstructions: didInjectOrcaInstructions,
          usedProjectContext: didInjectProjectContext,
          extraDirsCount: createOpts.extraDirs?.length ?? 0,
        });
        return newSess;
      });
      return { kind: 'session', session };
    } catch (err) {
      if (isCredentialModeSwitchBusyError(err)) {
        // 不映射成 SESSION_RUNNING:那会命中输入协调器的静默无限重试(250ms 一次),
        // 用户看到消息永远排队(2026-07-03 实报)。CREDENTIAL_SWITCH_BUSY 由协调器
        // 转成**可见等待态**(队首保留 + 挡路会话 turn 结束自动重发,可从队列删除
        // 取消);busySessionIds 供事件驱动唤醒与 renderer 展示挡路会话。
        return {
          kind: 'failure',
          result: toCompatibleMakerSendResult(
            createHostSendFailure('CREDENTIAL_SWITCH_BUSY', err.message, {
              busySessionIds: err.sessionIds,
            }),
          ),
        };
      }
      return {
        kind: 'failure',
        result: toCompatibleMakerSendResult(
          createHostSendFailure('REHYDRATE_FAILED', err instanceof Error ? err.message : 'rehydrate failed'),
        ),
      };
    }
  }

  async function lazyCreateSession(
    sessionId: string,
    createOpts: CreateOpts,
  ): Promise<ResolveSessionResult> {
    const okLazy = await ensureWorkDirWithDbFallback(sessionId, createOpts);
    if (!okLazy) {
      return {
        kind: 'failure',
        result: toCompatibleMakerSendResult(
          createHostSendFailure('WORKDIR_MISSING', `working directory is missing for session ${sessionId}`),
        ),
      };
    }
    await deps.synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
    await loadExtraDirsIfNeeded(sessionId, createOpts, 'lazy-create');
    try {
      const { session: lazySess, didInjectOrcaInstructions, didInjectProjectContext } = await deps.bootstrapSession(createOpts);
      await deps.markOrcaRoleIfNeeded(lazySess.id, createOpts.orcaRole);
      deps.broadcastSessionCreated(lazySess.id);
      deps.log.info('send: lazy create-session', {
        sessionId,
        agentKind: createOpts.agentKind,
        model: createOpts.model,
        fastMode: createOpts.fastMode ?? 'default',
        usedOrcaInstructions: didInjectOrcaInstructions,
        usedProjectContext: didInjectProjectContext,
        extraDirsCount: createOpts.extraDirs?.length ?? 0,
      });
      return { kind: 'session', session: lazySess };
    } catch (err) {
      if (isCredentialModeSwitchBusyError(err)) {
        // 不映射成 SESSION_RUNNING:那会命中输入协调器的静默无限重试(250ms 一次),
        // 用户看到消息永远排队(2026-07-03 实报)。CREDENTIAL_SWITCH_BUSY 由协调器
        // 转成**可见等待态**(队首保留 + 挡路会话 turn 结束自动重发,可从队列删除
        // 取消);busySessionIds 供事件驱动唤醒与 renderer 展示挡路会话。
        return {
          kind: 'failure',
          result: toCompatibleMakerSendResult(
            createHostSendFailure('CREDENTIAL_SWITCH_BUSY', err.message, {
              busySessionIds: err.sessionIds,
            }),
          ),
        };
      }
      return {
        kind: 'failure',
        result: toCompatibleMakerSendResult(
          createHostSendFailure('LAZY_CREATE_FAILED', err instanceof Error ? err.message : 'lazy create failed'),
        ),
      };
    }
  }

  return {
    async sendToAgentAccepted(sessionId, message, createOpts, sendOpts): Promise<DesktopMakerSendResult> {
      if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
      // session-agent-switch:pending 切换在发送时刻生效(用户语义:「消息真正发出
      // 去时才切」)。必须在 getSession 之前——apply 会 close 旧引擎的 live session,
      // 让下方走 lazy-create 按 DB 新值 spawn 新引擎。
      await deps.applyPendingAgentSwitch?.(sessionId);
      let sess = deps.getSession(sessionId);
      // Maker keeps a failed Session registered until its real handle cleanup
      // succeeds. It is not a reusable send target: route it through the
      // existing lazy bootstrap path so Maker.createSession() can retry close
      // and rebuild the handle before dispatching the message.
      if (sess?.getStatus?.() === 'error') {
        deps.log.info('send: error session requires recovery before dispatch', { sessionId });
        sess = undefined;
      }
      if (sess?.isTurnRunning()) {
        throwIpcError('SESSION_RUNNING', `Session ${sessionId} is already running a turn`);
      }
      await deps.ensureRemoteReadyForSessionStart({ session: sess, createOpts });

      if (sess) {
        const ok = await deps.checkWorkDirExists(sessionId, sess.workDir, sess.agentKind, sess.remoteHostId);
        if (!ok) {
          return toCompatibleMakerSendResult(
            createHostSendFailure('WORKDIR_MISSING', `working directory is missing for session ${sessionId}`),
          );
        }
        if (!deps.isOrcaMcpHydrated(sessionId) && createOpts) {
          const co = deps.buildCreateOptsWithStderr({ ...(createOpts as CreateOpts), id: sessionId });
          const shouldHydrateOrcaMcp = await deps.synthesizeOrcaVendorOptionsFromDb(sessionId, co);
          if (shouldHydrateOrcaMcp) {
            if (sess.isTurnRunning()) {
              // 仍交给下方统一 running guard 抛 SESSION_RUNNING，避免重复分支。
              deps.log.warn('send: active Orca session needs MCP rehydrate but turn is running', { sessionId });
            } else {
              const rehydrated = await rehydrateActiveOrcaSession(sessionId, co);
              if (rehydrated.kind === 'failure') return rehydrated.result;
              sess = rehydrated.session;
            }
          }
        }
      }

      if (!sess) {
        if (!createOpts) throwIpcError('NOT_FOUND', `Session ${sessionId} not found and no createOpts provided`);
        const co = deps.buildCreateOptsWithStderr({ ...(createOpts as CreateOpts), id: sessionId });
        await deps.reconcileCreateOptsWithDb?.(sessionId, co);
        const lazy = await lazyCreateSession(sessionId, co);
        if (lazy.kind === 'failure') return lazy.result;
        sess = lazy.session;
      }

      if (sess.isTurnRunning()) {
        throwIpcError('SESSION_RUNNING', `Session ${sessionId} is already running a turn`);
      }
      const requestedSendOpts = (sendOpts ?? {}) as MakerSendOptions;
      if (
        requestedSendOpts.ackInterruptedTurnOnDispatch !== undefined &&
        typeof requestedSendOpts.ackInterruptedTurnOnDispatch !== 'boolean'
      ) {
        throwIpcError('INVALID_PARAMS', 'ackInterruptedTurnOnDispatch must be a boolean');
      }
      let outgoingMessage = message;
      let outgoingSendOpts = sendOpts;
      let cleanupAfterAcceptance: (() => void) | undefined;
      let cleanupBeforeAcceptance: (() => void | Promise<void>) | undefined;
      let sendAccepted = false;
      if (deps.materializeDirectSendOssAttachments) {
        const materialized = await deps.materializeDirectSendOssAttachments(
          sessionId,
          outgoingMessage,
          outgoingSendOpts,
        );
        outgoingMessage = materialized.message;
        outgoingSendOpts = materialized.sendOpts;
        cleanupAfterAcceptance = materialized.cleanupAfterAcceptance;
        cleanupBeforeAcceptance = materialized.cleanupBeforeAcceptance;
      }
      const cleanupBeforeAcceptanceIfNeeded = async (): Promise<void> => {
        if (!cleanupBeforeAcceptance) return;
        try {
          await cleanupBeforeAcceptance();
        } catch (err) {
          deps.log.warn('send: direct OSS materialization cleanup failed', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };
      let normalized: IpcUserMessage;
      try {
        normalized = await deps.prepareSendUserMessage(sessionId, outgoingMessage);
      } catch (err) {
        await cleanupBeforeAcceptanceIfNeeded();
        throw err;
      }
      // session-agent-switch:切换后的首条消息把交接前缀拼进 wire payload。
      // 落库/显示内容(persistUserMessage.content)不含交接段——display 与 sent 分离。
      const pendingHandoff = (await deps.peekPendingHandoff?.(sessionId)) ?? null;
      const withHandoff = pendingHandoff
        ? prependHandoffToUserMessage(normalized as HandoffWireMessage, pendingHandoff)
        : normalized;
      const so = (outgoingSendOpts ?? {}) as MakerSendOptions;
      // 手机客户端说明:同样只进 wire payload,落库/显示内容(persistUserMessage.content)
      // 不含它。位置在交接段**之前** —— 交接正文自带「以下是用户的新消息」结束标记,
      // 排在它后面会让说明插到那句话之后(顺序推导同 agentHandoff.composeForkOriginHandoff:
      // 元信息在前、交接正文在后、由交接自带的标记统一收尾)。
      // 两个来源:直连 maker:send 走 async context(deps 注入);排队 / 插入路径走
      // coordinator 从队列项透传的 so.fromMobileClient(drain 时 context 已结束)。
      const mobileClientNote = deps.isMobileClientInvoke?.() === true || so.fromMobileClient === true
        ? buildMobileClientPromptNote()
        : null;
      const outgoing = mobileClientNote
        ? prependNoteToWireUserMessage(withHandoff as HandoffWireMessage, mobileClientNote)
        : withHandoff;
      const meta = await deps.getSessionMeta(sessionId).catch(() => null);
      const persistUserMessage = readPersistUserMessageOption(so);
      const directPreDispatchHook = persistUserMessage ? null : deps.beforeDispatchDirectUserTurn;
      let directPreDispatchHookStarted = false;
      let userPromptPreviewSessionId: string | null = null;
      let userPromptPreviewClientId: string | null = null;
      try {
        if (directPreDispatchHook) {
          await directPreDispatchHook(sessionId);
          directPreDispatchHookStarted = true;
        }
        // Capture on the executor immediately before vendor code. sess.send may
        // synchronously publish the continuation's new started marker before it
        // resolves, so the old-turn ack must use this strictly earlier value.
        const interruptedAckAt = so.ackInterruptedTurnOnDispatch
          ? Math.max(0, Date.now() - 1)
          : null;
        const sendResult = await sess.send(outgoing as never, {
          logTitle: meta?.title,
          messageUuid: so.messageUuid,
          userName: so.userName,
          throwOnStartFailure: so.throwOnStartFailure,
          signal: so.signal,
          // scheduler 排队消息:origin 打到本轮 turnOrigin(IM 转播识别自动 turn),
          // 与 runner 直发路径的 session.send({ origin }) 语义对齐。
          ...(so.origin ? { origin: so.origin } : {}),
          // 本条消息的计划意图快照(点击发送/入队瞬间的勾选,排队行透传)。对已
          // 存活会话是权威——排队期间用户改勾选不影响已排队行,反向也不误消耗
          // (语义见 maker-core SendOptions.planMode;undefined = 旧的消耗武装态)。
          ...(typeof (createOpts as { planMode?: unknown } | undefined)?.planMode === 'boolean'
            ? { planMode: (createOpts as { planMode: boolean }).planMode }
            : {}),
          ...(sess.agentKind === 'pi'
            && persistUserMessage
            && containsManagedAttachment(persistUserMessage.content)
            && deps.linkPiUserEntry
            ? {
                onTranscriptUserEntry: async (piEntryId: string) => {
                  try {
                    const linked = await deps.linkPiUserEntry?.(
                      sessionId,
                      persistUserMessage.clientId,
                      piEntryId,
                    );
                    if (linked === false) {
                      deps.log.warn('send: Pi transcript entry target row missing', {
                        sessionId,
                        clientId: persistUserMessage.clientId,
                        piEntryId,
                      });
                    }
                  } catch (err) {
                    // provider 已接受 prompt；关联补丁失败只能降级为 legacy 恢复，不能
                    // 把发送结果翻成 rejected，避免 UI 重发同一条消息。
                    deps.log.warn('send: Pi transcript entry link failed (non-fatal)', {
                      sessionId,
                      clientId: persistUserMessage.clientId,
                      piEntryId,
                      err: err instanceof Error ? err.message : String(err),
                    });
                  }
                },
              }
            : {}),
          onAccepted: persistUserMessage
            ? async () => {
                persistUserMessage.onPersisting?.();
                deps.previewUserPrompt?.(sess, persistUserMessage.content, {
                  source: 'maker_send:onPersisting',
                  clientId: persistUserMessage.clientId,
                });
                userPromptPreviewSessionId = sessionId;
                userPromptPreviewClientId = persistUserMessage.clientId;
                await deps.createDbMessage(sessionId, {
                  clientId: persistUserMessage.clientId,
                  role: 'user',
                  content: persistUserMessage.content,
                  agentMeta: {
                    uuid: so.messageUuid,
                    sdkSessionId: persistUserMessage.sdkSessionId,
                    ...(persistUserMessage.delivery ? { delivery: persistUserMessage.delivery } : {}),
                    // 自动补发的续跑指令:renderer 隐藏气泡 + 渲染「已重新连接」活动行,
                    // 同时也是 host 跳过额度充值的判据(见 register 的 createDbMessage)。
                    ...(persistUserMessage.autoResume ? { autoResume: true } : {}),
                    ...(persistUserMessage.autoResumeInfo
                      ? { autoResumeInfo: persistUserMessage.autoResumeInfo }
                      : {}),
                    // scheduler 排队消息:与 runner 直发路径落库的 agentMeta.origin
                    // 对齐,renderer 据此渲染"由自动化任务发送"标签。
                    ...(so.origin ? { origin: so.origin } : {}),
                  },
                }, persistUserMessage.shouldBroadcast
                  ? { shouldBroadcast: persistUserMessage.shouldBroadcast }
                  : undefined);
                // onPersisted 里可能挂着排队 orca 消息的 accepted 副作用(置 running /
                // autoBridgePending), 必须 await 完再放行 turn(同直发路径语义)。
                await persistUserMessage.onPersisted?.();
              }
            : undefined,
          onDispatching: () => {
            if (userPromptPreviewSessionId) {
              deps.dispatchUserPromptPreview?.(
                userPromptPreviewSessionId,
                userPromptPreviewClientId ?? undefined,
              );
            }
          },
        });
        sendAccepted = sendResult.accepted;
        if (sendAccepted) cleanupAfterAcceptance?.();
        else await cleanupBeforeAcceptanceIfNeeded();
        if (sendResult.accepted && interruptedAckAt !== null) {
          try {
            await deps.ackInterruptedTurnDispatched?.(sessionId, interruptedAckAt);
          } catch (err) {
            // Dispatch is irreversible; marker persistence remains best-effort
            // and cannot turn an accepted send into a renderer-visible failure.
            deps.log.warn('send: interrupted-turn dispatch ack failed', {
              sessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (pendingHandoff && sendResult.accepted) {
          // 只有跨过不可逆 dispatch 边界才消费;未派发保留 pending 下次重试。
          deps.consumePendingHandoff?.(sessionId);
        }
        if (userPromptPreviewSessionId && userPromptPreviewClientId) {
          if (sendResult.accepted) {
            deps.commitUserPromptPreview?.(userPromptPreviewSessionId, userPromptPreviewClientId);
          } else {
            deps.rollbackUserPromptPreview?.(
              userPromptPreviewSessionId,
              userPromptPreviewClientId,
              'maker_send:not-dispatched',
            );
          }
        }
        if (directPreDispatchHookStarted && !sendResult.accepted) {
          deps.onUndispatchedDirectUserTurn?.(sessionId);
        }
        return toCompatibleMakerSendResult(
          toDesktopSessionDispatchOutcome(sendResult, {
            source: 'maker-ipc',
            context: `SEND/${sessionId}/send`,
          }),
        );
      } catch (err) {
        if (!sendAccepted) await cleanupBeforeAcceptanceIfNeeded();
        if (userPromptPreviewSessionId && userPromptPreviewClientId) {
          deps.rollbackUserPromptPreview?.(
            userPromptPreviewSessionId,
            userPromptPreviewClientId,
            'maker_send:failed-before-dispatch',
          );
        }
        if (directPreDispatchHookStarted) {
          deps.onUndispatchedDirectUserTurn?.(sessionId);
        }
        if (deps.isSessionRunningError(err)) {
          throwIpcError('SESSION_RUNNING', `Session ${sessionId} is already running a turn`);
        }
        throw err;
      }
    },
  };
}
