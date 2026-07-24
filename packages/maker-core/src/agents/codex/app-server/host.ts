/**
 * AppServerHost — 共享 codex app-server 子进程, N session 通过 thread_id 多路复用。
 *
 * 路线 A 设计 (对齐 OpenAI 官方):
 *   - 1 个 CodexAgent 实例只 spawn 1 个 codex app-server 子进程
 *   - 每个 maker session 对应 server 端一个 thread, 通过 thread/start 创建拿 thread_id
 *   - 入站 notification 按 params.threadId 路由到对应 session 的 handlers
 *
 * Lifecycle (用户明确要求, 比 refcount 模型更简单):
 *   - 懒启动: 第一个 acquire/subscribeThread 触发 spawn + initialize
 *   - server 一旦起来, 跟 CodexAgent (= app 进程) 同生命周期, **不随 session 数升降**
 *   - session.close → subscription.release(): 仅从路由表删掉 + 不再收 notification
 *     server 端 thread state 仍在内存中 (server 自己 GC, 我们不主动 thread/unsubscribe — Phase 2 再优化)
 *   - app.before-quit → 上层显式调 host.shutdown() (Windows 子进程不会随父进程死)
 *
 * 真值参考:
 *   - codex-rs/app-server-client/README.md (shared in-process facade 思路)
 *   - codex-rs/app-server/src/thread_state.rs (server 端 HashMap<thread_id, ThreadState>)
 *
 * 性能纪律 (plan 强制):
 *   - 全异步 IO, 主线程不阻塞
 *   - notification 路由 O(1) (Map lookup + 函数调用)
 *   - notification buffer 防 thread/start response 与 thread/started 通知的固有竞争
 */

import { randomUUID } from 'node:crypto';

import type { Logger } from '../../../interfaces/logger.js';
import { AppServerClient } from './client.js';
import type { Transport } from './transport.js';
import {
  Method,
  type ClientInfo,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type ErrorNotification,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type McpServerElicitationRequestParams,
  type McpServerElicitationRequestResponse,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type ServerRequestResolvedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputResponse,
  type InitializeCapabilities,
  type InitializeResponse,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ItemUpdatedNotification,
  type JsonRpcId,
  type ThreadStartedNotification,
  type ThreadTokenUsageUpdatedNotification,
  type TurnPlanUpdatedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningSummaryPartAddedNotification,
  type ReasoningTextDeltaNotification,
  type AccountRateLimitsUpdatedNotification,
  type ThreadStatusChangedNotification,
  type ThreadSettingsUpdatedNotification,
  type ItemGuardianApprovalReviewStartedNotification,
  type ItemGuardianApprovalReviewCompletedNotification,
  type GuardianWarningNotification,
} from './protocol.js';

/**
 * 我们订阅的 notification 方法集 — 这之外的 (大部分 delta + plan/diff/hook/etc.)
 * 在 initialize 时通过 optOutNotificationMethods 告诉 server 别推, 省 IPC 带宽。
 *
 * agentMessage 文本流我们仍走 item/updated 全量字段算 diff (省一类 delta);
 * reasoning summary 流必须订阅 delta — claude code 等价体验需要逐字出 thinking 文本,
 * item/completed 给的是终态全文 (用来校准), 中间过程靠 delta 才能动起来。
 */
const SUBSCRIBED_METHODS = [
  'thread/started',
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated', // Codex usage 走单独通知 (不在 turn/completed 上), 必订
  'item/started',
  'item/updated',
  'item/completed',
  'turn/plan/updated',             // Codex update_plan snapshots
  'item/reasoning/summaryTextDelta', // 流式 reasoning 文本增量 (OpenAI summary)
  'item/reasoning/summaryPartAdded', // summary 分段标记 (插 \n\n 分隔用)
  'item/reasoning/textDelta',        // raw inner reasoning 增量 (开源模型才发, OpenAI 通常空)
  'account/rateLimits/updated',      // 账号配额变化 (无 threadId, 走全局 fan-out 路径)
  'thread/status/changed',           // 线程级 active_flags (waiting on approval / user input) — turn lifecycle 部分我们自己拼
  'thread/settings/updated',         // 中途 thread/settings/update 后 server 回带的权威设置快照 (serviceTier / model / effort)
  'serverRequest/resolved',          // 原生 requestUserInput / approval 请求被 server 端自动清理
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'guardianWarning',
  'error',
] as const;

const NOTIFICATIONS_TO_OPT_OUT = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  // 后续要做实时 patch / plan 流时再去掉:
  'turn/diff/updated',
];

/** thread/started 之外的 notification 都直接 params.threadId; thread/started 走 params.thread.id。 */
function extractThreadId(method: string, params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  if (method === 'thread/started') {
    const t = (params as { thread?: { id?: unknown } }).thread;
    return typeof t?.id === 'string' ? t.id : null;
  }
  const tid = (params as { threadId?: unknown }).threadId;
  return typeof tid === 'string' ? tid : null;
}

export interface ThreadEventHandlers {
  threadStarted?: (params: ThreadStartedNotification['params']) => void;
  turnStarted?: (params: TurnStartedNotification['params']) => void;
  turnCompleted?: (params: TurnCompletedNotification['params']) => void;
  /** 每次 turn 都会推一次 (turn 完成前), 与 turn/completed 在同 turnId 下成对出现。 */
  tokenUsageUpdated?: (params: ThreadTokenUsageUpdatedNotification['params']) => void;
  itemStarted?: (params: ItemStartedNotification['params']) => void;
  itemUpdated?: (params: ItemUpdatedNotification['params']) => void;
  itemCompleted?: (params: ItemCompletedNotification['params']) => void;
  /** Codex native update_plan snapshots. */
  turnPlanUpdated?: (params: TurnPlanUpdatedNotification['params']) => void;
  /** OpenAI reasoning summary 单段内的文本增量 (按 summaryIndex 区分段)。 */
  reasoningSummaryTextDelta?: (params: ReasoningSummaryTextDeltaNotification['params']) => void;
  /** reasoning summary 新开一段, 后续 summaryTextDelta 用新的 summaryIndex。 */
  reasoningSummaryPartAdded?: (params: ReasoningSummaryPartAddedNotification['params']) => void;
  /** raw inner reasoning 增量 (OpenAI 通常不发, 开源模型才发)。 */
  reasoningTextDelta?: (params: ReasoningTextDeltaNotification['params']) => void;
  /**
   * 账号配额变化 (5h / weekly 滚动窗口 + credits + reachedType)。
   * 账号级数据, host 内部缓存最近 snapshot, 给所有 active subscriber 各调一次;
   * 新 subscribe 时也立即重放最近一次 (防止打开新 session 时 chip 显示空)。
   */
  accountRateLimitsUpdated?: (params: AccountRateLimitsUpdatedNotification['params']) => void;
  /**
   * 线程级粗粒度状态机 (Idle / NotLoaded / SystemError / Active{flags})。
   * 我们只在意 Active.activeFlags 的两类等待标志, 用来 emit "Waiting on approval/input..." status。
   * Idle/SystemError 由 turn/completed + error notification 主导, 不在这里重复处理。
   */
  threadStatusChanged?: (params: ThreadStatusChangedNotification['params']) => void;
  /**
   * 中途 thread/settings/update 后 server 回带的权威设置快照 (serviceTier / model /
   * effort 等)。用来把本地 mutable 三态对齐 server 真相 (例如模型不支持 fast 时
   * server 会把 serviceTier 降级)。
   */
  threadSettingsUpdated?: (params: ThreadSettingsUpdatedNotification['params']) => void;
  serverRequestResolved?: (params: ServerRequestResolvedNotification['params']) => void;
  /** Codex built-in Guardian auto-review lifecycle (Auto permission mode). */
  autoApprovalReviewStarted?: (params: ItemGuardianApprovalReviewStartedNotification) => void;
  autoApprovalReviewCompleted?: (params: ItemGuardianApprovalReviewCompletedNotification) => void;
  guardianWarning?: (params: GuardianWarningNotification) => void;
  error?: (params: ErrorNotification['params']) => void;

  // ── ServerRequest (Phase 2 approval) ─────────────────────────────────────
  // server → client 的 request, 必须返回 response (否则 server 卡 turn)。
  // Host 按 params.threadId 路由, 找不到 subscriber 默认 decline (安全兜底)。
  /** server 要求审批 shell 命令执行。 */
  commandExecutionApproval?: (
    params: CommandExecutionRequestApprovalParams,
  ) => Promise<CommandExecutionRequestApprovalResponse>;
  /** server 要求审批文件改动。 */
  fileChangeApproval?: (
    params: FileChangeRequestApprovalParams,
  ) => Promise<FileChangeRequestApprovalResponse>;
  mcpServerElicitation?: (
    params: McpServerElicitationRequestParams,
  ) => Promise<McpServerElicitationRequestResponse>;
  /** server 要求审批 MCP 工具等权限请求 (item/permissions/requestApproval)。 */
  permissionsApproval?: (
    params: PermissionsRequestApprovalParams,
  ) => Promise<PermissionsRequestApprovalResponse>;
  /** EXPERIMENTAL: model/native tool asks the client to collect user input. */
  requestUserInput?: (
    params: ToolRequestUserInputParams,
    meta: ServerRequestMeta,
  ) => Promise<ToolRequestUserInputResponse>;
  /** EXPERIMENTAL: app-server dynamic tool call. */
  dynamicToolCall?: (
    params: DynamicToolCallParams,
    meta: ServerRequestMeta,
  ) => Promise<DynamicToolCallResponse>;
}

export interface ServerRequestMeta {
  requestId: JsonRpcId;
}

export interface ThreadSubscription {
  /** 幂等; 调用后不再收到 notification + 触发 refcount 递减 (可能触发 idle 关停)。 */
  release(): void;
}

export interface AppServerHostOptions {
  /**
   * Transport 工厂; host 每次 bootstrap (含 transport-error 后的重连) 都调一次。
   * 本地 codex 用 `createStdioTransport({binaryPath, cwd, env, extraArgs})`,
   * 远端 codex 用 `createSshDaemonTransport({remoteHost, ...})` (P2)。
   */
  createTransport: () => Transport;
  logger: Logger;
  /** initialize 时上报的客户端身份 (走 server 日志 / thread metadata)。 */
  clientInfo: ClientInfo;
  /**
   * notification 到达时若没找到 subscriber 的缓存窗口 (默认 5000ms)。
   * 解决 thread/started 比 subscribeThread() 早到的固有竞争。
   */
  notificationBufferTtlMs?: number;
  /**
   * 关联中的 JSON-RPC response 明确返回 cloudRequirements Auth/relogin 时调用一次
   * (单次 latch 在 client 内)。stderr 始终只作为诊断日志。
   */
  onAuthInvalidated?: (reason: string) => void;
  /**
   * Host 创建时冻结的事实:该 app-server 的 model_provider.base_url 是否走
   * 本机 codex proxy。session 级 prompt gate 只读这个值,不再 live 读取全局状态。
   */
  codexProxyActive?: boolean;
  /**
   * Host 创建时冻结的事实:spawn args 里定义的 OpenAI 身份 provider id(仅
   * oauth-bearer spawn 存在)。thread/start|resume 据此对订阅直连会话开远端压缩。
   */
  remoteCompactionProviderId?: string;
}

interface BufferedNotification {
  method: string;
  params: unknown;
  ts: number;
}

export class AppServerHost {
  private readonly connectionId = randomUUID();
  private readonly logger: Logger;
  private readonly bufferTtlMs: number;

  private client: AppServerClient | null = null;
  /** 同次 ensureStarted 并发调用共享一个 init Promise (避免重复 spawn)。 */
  private startPromise: Promise<InitializeResponse> | null = null;

  private readonly subscribers = new Map<string, ThreadEventHandlers>();
  /** 找不到 subscriber 时按 threadId 暂存的 notification, drain on subscribe。 */
  private readonly buffered = new Map<string, BufferedNotification[]>();
  /**
   * 账号配额最近一次 snapshot, 给新 subscribeThread 立即重放 — 用户打开新 codex
   * session 时不必等下次 turn 完成才看到 chip 数据。整个 host 生命周期共享一份 (账号级)。
   */
  private lastAccountRateLimits: AccountRateLimitsUpdatedNotification['params'] | null = null;

  private shuttingDown = false;
  private retired = false;

  constructor(private readonly opts: AppServerHostOptions) {
    if (typeof opts.createTransport !== 'function') {
      throw new Error('AppServerHost: createTransport factory is required');
    }
    this.logger = opts.logger.child('codex-app-server-host');
    this.bufferTtlMs = opts.notificationBufferTtlMs ?? 5_000;
  }

  isCodexProxyActive(): boolean {
    return this.opts.codexProxyActive === true;
  }

  /** oauth spawn 定义的 OpenAI 身份 provider id;非 oauth spawn / 未下发 → null。 */
  getRemoteCompactionProviderId(): string | null {
    return this.opts.remoteCompactionProviderId ?? null;
  }

  getConnectionId(): string {
    return this.connectionId;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 幂等 + 并发安全。第一次调用 spawn + initialize, 后续直接返回缓存的
   * InitializeResponse (或共享同一个 in-flight Promise)。
   */
  ensureStarted(capabilities?: InitializeCapabilities): Promise<InitializeResponse> {
    if (this.retired) {
      return Promise.reject(new Error('AppServerHost: cannot ensureStarted() after retirement'));
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error('AppServerHost: cannot ensureStarted() during shutdown'));
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.bootstrap(capabilities).catch((err) => {
      // bootstrap 失败 → 清掉 startPromise 让下次调用能重试
      this.startPromise = null;
      this.client = null;
      throw err;
    });
    return this.startPromise;
  }

  private async bootstrap(capabilities?: InitializeCapabilities): Promise<InitializeResponse> {
    const client = new AppServerClient({
      createTransport: this.opts.createTransport,
      logger: this.opts.logger,
      onTransportError: (err) => this.handleTransportError(err),
      onAuthInvalidated: this.opts.onAuthInvalidated,
    });
    this.client = client;

    // 注册 notification handlers BEFORE initialize: server 在握手响应前可能就推了
    // banner / 启动 notification, 漏接就丢。
    for (const method of SUBSCRIBED_METHODS) {
      client.onNotification(method, (params) => this.routeNotification(method, params));
    }

    // ServerRequest handlers (Phase 2 approval) — 同样在 initialize 前注册,
    // 防 server 在握手过程中就发出 approval (虽然实际不会, 但 defensive)。
    client.setRequestHandler(Method.CommandExecutionRequestApproval, async (rawParams) => {
      const params = rawParams as CommandExecutionRequestApprovalParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.commandExecutionApproval) {
        this.logger.warn('commandExecution approval without subscriber → decline', {
          threadId: params.threadId,
          itemId: params.itemId,
        });
        return { decision: 'decline' };
      }
      try {
        return await handlers.commandExecutionApproval(params);
      } catch (e) {
        this.logger.error('commandExecutionApproval handler threw → decline', {
          threadId: params.threadId,
          message: (e as Error).message,
        });
        return { decision: 'decline' };
      }
    });

    client.setRequestHandler(Method.FileChangeRequestApproval, async (rawParams) => {
      const params = rawParams as FileChangeRequestApprovalParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.fileChangeApproval) {
        this.logger.warn('fileChange approval without subscriber → decline', {
          threadId: params.threadId,
          itemId: params.itemId,
        });
        return { decision: 'decline' };
      }
      try {
        return await handlers.fileChangeApproval(params);
      } catch (e) {
        this.logger.error('fileChangeApproval handler threw → decline', {
          threadId: params.threadId,
          message: (e as Error).message,
        });
        return { decision: 'decline' };
      }
    });

    client.setRequestHandler(Method.McpServerElicitationRequest, async (rawParams) => {
      const params = rawParams as McpServerElicitationRequestParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.mcpServerElicitation) {
        this.logger.warn('MCP server elicitation without subscriber -> decline', {
          threadId: params.threadId,
          serverName: params.serverName,
        });
        return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
      }
      try {
        return await handlers.mcpServerElicitation(params);
      } catch (e) {
        this.logger.error('mcpServerElicitation handler threw -> decline', {
          threadId: params.threadId,
          serverName: params.serverName,
          message: (e as Error).message,
        });
        return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
      }
    });

    client.setRequestHandler(Method.PermissionsRequestApproval, async (rawParams) => {
      const params = rawParams as PermissionsRequestApprovalParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.permissionsApproval) {
        this.logger.warn('permissions approval without subscriber → decline', {
          threadId: params.threadId,
        });
        return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
      }
      try {
        return await handlers.permissionsApproval(params);
      } catch (e) {
        this.logger.error('permissionsApproval handler threw → decline', {
          threadId: params.threadId,
          message: (e as Error).message,
        });
        return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
      }
    });

    client.setRequestHandler(Method.ToolRequestUserInput, async (rawParams, meta) => {
      const params = rawParams as ToolRequestUserInputParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.requestUserInput) {
        this.logger.warn('requestUserInput without subscriber -> empty response', {
          threadId: params.threadId,
          itemId: params.itemId,
        });
        return { answers: {} } satisfies ToolRequestUserInputResponse;
      }
      try {
        return await handlers.requestUserInput(params, { requestId: meta.id });
      } catch (e) {
        this.logger.error('requestUserInput handler threw -> empty response', {
          threadId: params.threadId,
          itemId: params.itemId,
          message: (e as Error).message,
        });
        return { answers: {} } satisfies ToolRequestUserInputResponse;
      }
    });

    client.setRequestHandler(Method.DynamicToolCall, async (rawParams, meta) => {
      const params = rawParams as DynamicToolCallParams;
      const handlers = this.subscribers.get(params.threadId);
      if (!handlers?.dynamicToolCall) {
        this.logger.warn('dynamicToolCall without subscriber -> failed result', {
          threadId: params.threadId,
          callId: params.callId,
          tool: params.tool,
        });
        return {
          contentItems: [{ type: 'inputText', text: 'Dynamic tool is unavailable.' }],
          success: false,
        } satisfies DynamicToolCallResponse;
      }
      try {
        return await handlers.dynamicToolCall(params, { requestId: meta.id });
      } catch (e) {
        this.logger.error('dynamicToolCall handler threw -> failed result', {
          threadId: params.threadId,
          callId: params.callId,
          tool: params.tool,
          message: (e as Error).message,
        });
        return {
          contentItems: [{ type: 'inputText', text: (e as Error).message || 'Dynamic tool failed.' }],
          success: false,
        } satisfies DynamicToolCallResponse;
      }
    });

    // start() = create transport + wire onLine/onStderr/onClose. 必须在所有
    // onNotification/setRequestHandler 之后, 在 initialize() 之前。等价于原版
    // 的 client.spawnProcess()。
    client.start();

    const mergedCapabilities: InitializeCapabilities = {
      experimentalApi: true,
      optOutNotificationMethods: NOTIFICATIONS_TO_OPT_OUT,
      ...capabilities,
    };
    const resp = await client.initialize(this.opts.clientInfo, mergedCapabilities);
    this.logger.info('shared app-server up', {
      userAgent: resp.userAgent,
      codexHome: resp.codexHome,
      platformOs: resp.platformOs,
    });
    return resp;
  }

  /**
   * 透传 JSON-RPC request 到底层 client (会先 ensureStarted)。
   * thread/start / turn/start / turn/interrupt / thread/resume / thread/fork 都走这里。
   */
  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    await this.ensureStarted();
    if (!this.client) throw new Error('AppServerHost: client missing after ensureStarted (unreachable)');
    return this.client.request<R>(method, params);
  }

  /**
   * 强制关停 (app.before-quit / 测试 cleanup / transport error 恢复)。幂等。
   * 清空 subscribers + close client (杀子进程)。**结束后允许 ensureStarted 重新 spawn**
   * (场景: 子进程崩溃后下一个 session 进来自动起一个新的)。
   *
   * **必须** 在 app.before-quit 显式调一次 — Windows 子进程不会随父进程死,
   * 不显式收割就成孤儿。
   */
  async shutdown(reason = 'AppServerHost.shutdown()'): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.subscribers.clear();
    this.buffered.clear();
    const c = this.client;
    this.client = null;
    this.startPromise = null;
    try {
      if (c) await c.close({ reason });
    } finally {
      // 重置, 允许之后的 ensureStarted 重新 spawn (transport error 恢复路径)
      this.shuttingDown = false;
    }
  }

  /**
   * 终态关停。凭据/账号切换后旧 host 不能再被旧 session 闭包重新拉起；
   * transport error 自愈仍走普通 shutdown(),保留同对象重启能力。
   */
  async retire(reason = 'AppServerHost.retire()'): Promise<void> {
    this.retired = true;
    await this.shutdown(reason);
  }

  /**
   * 强制收割前把终态 transport error 广播给仍在订阅的 session。
   *
   * retire()/shutdown() 会静默清空 subscribers —— 常规路径(凭证切换/app 退出)由
   * 上层先 Session.close 收尾,这是对的;但 auth 失效等强制路径会带着 in-flight turn
   * 直接收割 host,不先叫醒订阅者的话,session 的 isTurnRunning 永远不翻 false,上层
   * 的输入队列 / Stop 的 queueAbortPending 锁 / 凭证切换 busy 判定全部永久卡死
   * (2026-07-19 实排:auth app_session_terminated 触发 retire 后会话假 busy 数小时)。
   * 只广播、不清订阅 —— 紧随其后的 retire() 负责清理。
   */
  notifySubscribersOfForcedRetire(reason: string): void {
    if (this.subscribers.size === 0) return;
    this.logger.warn('forced retire with live subscribers — broadcasting terminal transport error', {
      subscribers: this.subscribers.size,
      reason,
    });
    this.broadcastTransportErrorToSubscribers(`app-server force-retired: ${reason}`);
  }

  // ── 订阅 / 路由 ───────────────────────────────────────────────────────────

  /**
   * 为 thread_id 注册一组 handler, release() 仅取消订阅 (不影响 server 生命周期)。
   * 如果 thread/started (或更早的 notification) 在 subscribe 之前就到了, drain
   * buffered 队列里匹配的项, 按到达顺序 dispatch — 保证不丢事件。
   *
   * **不**做 refcount → shutdown — server 只跟 host.shutdown() 绑定。session.close
   * 仅清掉路由表, server 自己会 GC 闲置 ThreadState。Phase 2 可考虑发
   * `thread/unsubscribe` 给 server 显式释放 listener (当前 server-side 内存
   * 占用极小, 跳过)。
   */
  subscribeThread(threadId: string, handlers: ThreadEventHandlers): ThreadSubscription {
    if (this.retired) {
      throw new Error(`AppServerHost.subscribeThread(${threadId}) after retirement`);
    }
    if (this.shuttingDown) {
      throw new Error(`AppServerHost.subscribeThread(${threadId}) during shutdown`);
    }
    if (this.subscribers.has(threadId)) {
      this.logger.warn('overwriting thread subscription', { threadId });
    }
    this.subscribers.set(threadId, handlers);

    // 排空缓存 (thread/started 比 subscribe 早到的固有竞争)
    const buf = this.buffered.get(threadId);
    if (buf) {
      this.buffered.delete(threadId);
      for (const item of buf) {
        this.dispatchToHandlers(handlers, item.method, item.params);
      }
    }

    // 账号配额 snapshot replay — 让新 session 立即看到当前账号配额, 不必等下次 turn。
    if (this.lastAccountRateLimits && handlers.accountRateLimitsUpdated) {
      try {
        handlers.accountRateLimitsUpdated(this.lastAccountRateLimits);
      } catch (e) {
        this.logger.error('accountRateLimitsUpdated replay threw', { message: (e as Error).message });
      }
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const cur = this.subscribers.get(threadId);
        if (cur === handlers) {
          this.subscribers.delete(threadId);
        }
      },
    };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private routeNotification(method: string, params: unknown): void {
    // 账号级 notification — 没有 threadId, 走全局 fan-out 路径:
    // 缓存最近 snapshot (给新 subscribe replay) + 广播给所有 active subscriber 各一份。
    if (method === 'account/rateLimits/updated') {
      const p = params as AccountRateLimitsUpdatedNotification['params'];
      this.lastAccountRateLimits = p;
      this.logger.info('accountRateLimits fan-out', {
        subscribers: this.subscribers.size,
        rawJson: JSON.stringify(p.rateLimits ?? null),
      });
      for (const handlers of this.subscribers.values()) {
        try {
          handlers.accountRateLimitsUpdated?.(p);
        } catch (e) {
          this.logger.error('accountRateLimitsUpdated handler threw', { message: (e as Error).message });
        }
      }
      return;
    }

    const threadId = extractThreadId(method, params);
    if (!threadId) {
      if (method === 'turn/plan/updated') {
        // Older app-server protocol snapshots do not carry threadId for plan updates.
        // Fan-out is best-effort and relies on downstream turnId filtering; newer
        // protocol events should include threadId so dispatch remains session-scoped.
        this.logger.debug('plan update without threadId; fan-out to subscribers', {
          subscribers: this.subscribers.size,
        });
        for (const handlers of this.subscribers.values()) {
          this.dispatchToHandlers(handlers, method, params);
        }
        return;
      }
      this.logger.warn('notification missing threadId', { method });
      return;
    }
    const handlers = this.subscribers.get(threadId);
    if (handlers) {
      this.dispatchToHandlers(handlers, method, params);
      return;
    }
    // subscribe 还没到 — 暂存 + TTL 清理。Codex 协议保证 server 内同 thread 顺序,
    // drain 时按到达顺序 dispatch 不会乱。
    this.bufferNotification(threadId, method, params);
  }

  private dispatchToHandlers(handlers: ThreadEventHandlers, method: string, params: unknown): void {
    let fn: ((p: never) => void) | undefined;
    switch (method) {
      case 'thread/started': fn = handlers.threadStarted as (p: never) => void; break;
      case 'turn/started': fn = handlers.turnStarted as (p: never) => void; break;
      case 'turn/completed': fn = handlers.turnCompleted as (p: never) => void; break;
      case 'thread/tokenUsage/updated': fn = handlers.tokenUsageUpdated as (p: never) => void; break;
      case 'item/started': fn = handlers.itemStarted as (p: never) => void; break;
      case 'item/updated': fn = handlers.itemUpdated as (p: never) => void; break;
      case 'item/completed': fn = handlers.itemCompleted as (p: never) => void; break;
      case 'turn/plan/updated': fn = handlers.turnPlanUpdated as (p: never) => void; break;
      case 'item/reasoning/summaryTextDelta': fn = handlers.reasoningSummaryTextDelta as (p: never) => void; break;
      case 'item/reasoning/summaryPartAdded': fn = handlers.reasoningSummaryPartAdded as (p: never) => void; break;
      case 'item/reasoning/textDelta': fn = handlers.reasoningTextDelta as (p: never) => void; break;
      case 'account/rateLimits/updated': fn = handlers.accountRateLimitsUpdated as (p: never) => void; break;
      case 'thread/status/changed': fn = handlers.threadStatusChanged as (p: never) => void; break;
      case 'thread/settings/updated': fn = handlers.threadSettingsUpdated as (p: never) => void; break;
      case 'serverRequest/resolved': fn = handlers.serverRequestResolved as (p: never) => void; break;
      case 'item/autoApprovalReview/started': fn = handlers.autoApprovalReviewStarted as (p: never) => void; break;
      case 'item/autoApprovalReview/completed': fn = handlers.autoApprovalReviewCompleted as (p: never) => void; break;
      case 'guardianWarning': fn = handlers.guardianWarning as (p: never) => void; break;
      case 'error': fn = handlers.error as (p: never) => void; break;
    }
    if (!fn) {
      this.logger.debug('subscriber has no handler for method', { method });
      return;
    }
    try {
      fn(params as never);
    } catch (e) {
      this.logger.error('thread handler threw', { method, message: (e as Error).message });
    }
  }

  private bufferNotification(threadId: string, method: string, params: unknown): void {
    const arr = this.buffered.get(threadId) ?? [];
    arr.push({ method, params, ts: Date.now() });
    this.buffered.set(threadId, arr);
    setTimeout(() => {
      const cur = this.buffered.get(threadId);
      if (!cur) return;
      const cutoff = Date.now() - this.bufferTtlMs;
      const remaining = cur.filter((x) => x.ts > cutoff);
      if (remaining.length === 0) {
        this.buffered.delete(threadId);
      } else {
        this.buffered.set(threadId, remaining);
      }
    }, this.bufferTtlMs).unref?.();
  }

  /**
   * 子进程 crash / IO 错误: 广播给所有 subscriber 的 error handler, 让上层每个
   * session 都能 emit 'error' AgentEvent + 结束自己的 event queue, 然后强制 shutdown
   * (此后任何 subscribeThread/request 都会拒绝, 上层下次需要时拿不到 host)。
   *
   * 注意: shutdown 之后 startPromise = null, 下一次 ensureStarted 可以重新 spawn。
   * 但当前内存里的 subscribers 都已被清掉 — 上层 session 拿到 error 后该自己 close。
   */
  private handleTransportError(err: Error): void {
    this.logger.error('transport error, notifying subscribers + shutting down', { message: err.message });
    this.broadcastTransportErrorToSubscribers(`app-server transport error: ${err.message}`);
    void this.shutdown(`transport error: ${err.message}`);
  }

  /** ErrorNotification 的 shape 不能完全合成 (没真实 turnId), 用最小可信字段。 */
  private broadcastTransportErrorToSubscribers(message: string): void {
    for (const [threadId, handlers] of this.subscribers) {
      try {
        handlers.error?.({
          threadId,
          turnId: '',
          willRetry: false,
          scope: 'transport',
          error: { message },
        });
      } catch (e) {
        this.logger.warn('error broadcast handler threw', { threadId, message: (e as Error).message });
      }
    }
  }

  // ── 诊断辅助 (测试 / 日志) ────────────────────────────────────────────────

  /** 当前活跃 subscriber 数 — diagnostics, 不参与业务。 */
  get activeSubscriptions(): number {
    return this.subscribers.size;
  }

  /** 是否已经 spawn 过子进程 (但可能已 close)。 */
  get hasStarted(): boolean {
    return this.client !== null;
  }
}
