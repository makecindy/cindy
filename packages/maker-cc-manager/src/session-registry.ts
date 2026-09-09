/**
 * SessionRegistry — manages per-session SDK Query lifecycle inside the manager.
 *
 * Phase 2 scope (MVP):
 *   - One Query per session
 *   - Async loop consumes Query → calls onEvent for each SDKMessage
 *   - inputQueue per session — query/send pushes into it, SDK streamInput consumes
 *   - Control methods (setModel/interrupt/etc.) forward to the live Query
 *   - Single attached client per session — newer attach replaces older
 *
 * Phase 5 will add: ring buffer + disk log for detach/reattach replay.
 *
 * SDK Query factory is injected so tests can pass a mock without touching the
 * real @anthropic-ai/claude-agent-sdk. Production binary wires the real SDK.
 */

import type {
  QueryEventNotification,
  QueryToolGuard,
  SubagentModelAccessResult,
  SessionClosedNotification,
  SessionListEntry,
  ClientReplacedNotification,
} from './protocol.js';
import { createAsyncQueue, type AsyncQueue } from './async-queue.js';

/* ============================== SDK-shaped types ============================== */

/**
 * Minimal subset of @anthropic-ai/claude-agent-sdk Query interface that the
 * manager actually uses. Declared locally to keep this file SDK-version-agnostic
 * (manager binary pins SDK in package.json; this interface evolves with it).
 */
export interface SdkQueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  /**
   * Optional — terminate the underlying CLI subprocess (SDK >= 0.2.x).
   * Used as kill escalation when interrupt + input end do not make the
   * consume loop exit: closing the transport ends/errors the async
   * iterator, so the loop genuinely finishes.
   */
  close?(): void;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  /**
   * Authoritative MCP registry after settings/plugin discovery. The init event
   * only carries names, so it cannot distinguish a harness plugin from a
   * user/project/local MCP that normalizes to the same tool prefix.
   */
  mcpServerStatus?(): Promise<Array<{
    name: string;
    status: string;
    scope?: string;
  }>>;
  /** Optional — stop a single background task (SDK >= 0.2.x). */
  stopTask?(taskId: string): Promise<void>;
  // streamInput(stream: AsyncIterable<...>) is implicit — we pass our queue
  // via options.prompt at construction time, not via post-construction call.
}

/**
 * canUseTool callback shape — mirrors SDK's CanUseTool but simplified for
 * wire transport. The daemon-side callback forwards this to the attached
 * client via reverse-request RPC.
 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolUseID: string;
    title?: string;
    displayName?: string;
    description?: string;
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    agentID?: string;
  },
) => Promise<{
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}>;

type SdkHookCallback = (input: unknown) => Promise<unknown>;

export type SdkHooks = Record<
  string,
  Array<{
    matcher?: string;
    hooks: SdkHookCallback[];
  }>
>;

export interface SdkQueryFactoryOptions {
  /** SDK options.prompt — push-based AsyncIterable of user messages. */
  inputStream: AsyncIterable<unknown>;
  /** Working directory for the cc subprocess. */
  cwd: string;
  /** Model id to start with. */
  model: string;
  /** Env dict forwarded to cc subprocess (auth, base url, etc.). */
  env: Record<string, string>;
  /** MCP server configs (stdio/sse/http only — in-process rejected before this layer). */
  mcpServers?: Record<string, unknown>;
  /** Defaults to acceptEdits in MVP — host explicitly passes if different. */
  permissionMode?: string;
  /** Verbatim passthrough; we don't introspect. */
  systemPrompt?: unknown;
  /** Verbatim passthrough. */
  additionalDirectories?: string[];
  /** Verbatim passthrough. */
  allowedTools?: string[];
  /** Verbatim passthrough. */
  disallowedTools?: string[];
  /** Verbatim passthrough (preset shape). */
  tools?: unknown;
  /** Resume an SDK session by uuid (Phase 5 reattach). */
  resume?: string;
  /** Extra SDK options; daemon-owned hooks are merged after this object. */
  extraOptions?: Record<string, unknown>;
  /**
   * Daemon-owned in-process hooks. Unlike callbacks inside extraOptions, these
   * are created after the RPC boundary and are never serialized.
   */
  hooks?: SdkHooks;
  /**
   * canUseTool callback — when SDK needs permission, this is called.
   * If not provided, SDK uses its own permissionMode logic (acceptEdits default).
   */
  canUseTool?: CanUseToolCallback;
  /**
   * SDK oauth_token_refresh callback — remote cc hit 401 on its subscription
   * OAuth token; forwarded to the attached desktop via reverse-request RPC.
   * Only wired when the session env carries CLAUDE_CODE_OAUTH_TOKEN (the SDK
   * auto-injects CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1 when the callback exists,
   * so wiring it for gateway-key sessions would misroute API-key 401s).
   */
  getOAuthToken?: () => Promise<string | null>;
}

/**
 * Factory returns an SDK Query-shaped object. Production wires the real SDK;
 * tests wire a fake that emits scripted events.
 */
export type SdkQueryFactory = (opts: SdkQueryFactoryOptions) => SdkQueryLike;

/* ============================== Session state ============================== */

export interface CreateSessionOptions {
  sessionId: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  permissionMode?: string;
  systemPrompt?: unknown;
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: unknown;
  toolGuards?: QueryToolGuard[];
  resumeSdkSessionId?: string;
  extraOptions?: Record<string, unknown>;
}

/**
 * Per-session ring buffer entry. Mirrors QueryEventNotification fields so
 * replay just sends them out verbatim.
 */
interface BufferedEvent {
  seq: number;
  ts: string;
  message: unknown;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  model: string;
  inputQueue: AsyncQueue<unknown>;
  query: SdkQueryLike;
  /** Seq counter — monotonic per session. */
  nextSeq: number;
  /** Latest seq we've emitted (`nextSeq - 1` after first event). */
  lastSeq: number;
  /** ISO when session was created. */
  startedAt: string;
  /** ISO of last observed SDK event (null until first event). */
  lastEventAt: string | null;
  /** SDK's internal session uuid, captured from first SDKSystemMessage (init). */
  sdkSessionId: string | null;
  /** Whether the consume loop is still running. */
  alive: boolean;
  /** Text from accepted user inputs in the current turn, used by tool guards. */
  toolGuardSelectionText: string;
  /** False after an SDK result; the next accepted input starts a fresh turn. */
  toolGuardTurnActive: boolean;
  /** Connected host/user/project/local MCPs that may own a colliding prefix. */
  toolGuardMcpServerNames: ReadonlySet<string>;
  /** Host-injected MCPs are non-harness sources even before SDK init. */
  toolGuardHostMcpServerNames: ReadonlySet<string>;
  /**
   * forceful kill 已开始 (interrupt 发出、inputQueue 已/将 end) 但 consume
   * loop 尚未退出 — 此窗口内 alive 仍为 true, sendMessage 必须显式拒绝
   * (Greptile P1: ended queue 的 push 静默丢, 其他连接 attach+send 会让
   * 用户消息看似成功实则消失)。
   */
  killing?: boolean;
  /** consume loop 的完成 promise — kill 同步等待它 (带看门狗)。 */
  consumeLoopDone?: Promise<void>;
  /** Currently attached client's notify function; null when no client is attached. */
  attachedNotify: AttachedNotify | null;
  /**
   * In-memory ring buffer of recent events for detach/reattach replay.
   * When over capacity, oldest entries are dropped (replay can't go back
   * to seq=1 anymore — UI should warn or refresh).
   */
  buffer: BufferedEvent[];
  /** Max events buffered before dropping oldest. */
  bufferCapacity: number;
  /** Lowest seq still present in buffer (so client can know if replay covers their sinceSeq). */
  bufferFirstSeq: number;
}

/**
 * Notify callback installed via `registry.attach()`. Single union signature so
 * TypeScript can dispatch the three variants without complaining about
 * overload mismatches. Callers narrow on `kind` to read `n` safely.
 */
export type AttachedNotify = (
  kind: 'event' | 'closed' | 'replaced',
  n: QueryEventNotification | SessionClosedNotification | ClientReplacedNotification,
) => void;

/* ============================== Registry ============================== */

/**
 * Callback that the session registry invokes when SDK's canUseTool fires for
 * a session. The implementation should forward this as a reverse-request to
 * the attached client and return the client's decision.
 */
export type ApprovalRequestForwarder = (
  sessionId: string,
  params: import('./protocol.js').ApprovalRequestParams,
) => Promise<import('./protocol.js').ApprovalRequestResult>;

/**
 * Callback that the session registry invokes when SDK's getOAuthToken fires
 * for a session (subscription token expired mid-turn). The implementation
 * should forward this as a reverse-request to the attached client and return
 * the fresh token (or null when refresh failed / client too old).
 */
export type OAuthRefreshForwarder = (
  sessionId: string,
  params: import('./protocol.js').OAuthRefreshParams,
) => Promise<import('./protocol.js').OAuthRefreshResult>;

export type SubagentModelAccessForwarder = (
  sessionId: string,
  params: import('./protocol.js').SubagentModelAccessParams,
) => Promise<import('./protocol.js').SubagentModelAccessResult>;

export interface SessionRegistryOptions {
  sdkQueryFactory: SdkQueryFactory;
  /**
   * Max events buffered per session for replay on reattach. Default 1000.
   * Phase 5 keeps this in-memory only; later PR adds disk log so reconnect
   * across manager restart works.
   */
  bufferCapacity?: number;
  /**
   * Watchdog for kill(): how long to wait for the consume loop to exit
   * after interrupt + input end before escalating to query.close().
   * Default 10_000. Tests override with small values.
   */
  killSettleWatchdogMs?: number;
  /**
   * Grace period after the close() escalation to still let the consume
   * loop exit before kill() fails with SESSION_KILL_TIMEOUT. Default 5_000.
   */
  killCloseGraceMs?: number;
  /**
   * Called when a session's SDK canUseTool fires and a client is attached.
   * Implementation should send a reverse-request RPC to the client. If not
   * provided (or if no client is attached), the registry defaults to 'deny'.
   */
  onApprovalRequest?: ApprovalRequestForwarder;
  /** Agent/Task 执行前向当前 desktop 查询实时账号模型准入。异常必须降级 unknown。 */
  onSubagentModelAccessRequest?: SubagentModelAccessForwarder;
  /**
   * Called when a session's SDK getOAuthToken fires (401 on the subscription
   * token). Implementation should send a reverse-request RPC to the client.
   * If not provided, sessions get no refresh callback (pre-refresh behavior).
   */
  onOAuthRefresh?: OAuthRefreshForwarder;
  logger?: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

const DEFAULT_BUFFER_CAPACITY = 1000;
const DEFAULT_KILL_SETTLE_WATCHDOG_MS = 10_000;
const DEFAULT_KILL_CLOSE_GRACE_MS = 5_000;

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly factory: SdkQueryFactory;
  private readonly logger: NonNullable<SessionRegistryOptions['logger']>;
  private readonly bufferCapacity: number;
  private readonly onApprovalRequest?: ApprovalRequestForwarder;
  private readonly onSubagentModelAccessRequest?: SubagentModelAccessForwarder;
  private readonly onOAuthRefresh?: OAuthRefreshForwarder;
  private readonly killSettleWatchdogMs: number;
  private readonly killCloseGraceMs: number;

  constructor(opts: SessionRegistryOptions) {
    this.factory = opts.sdkQueryFactory;
    this.bufferCapacity = opts.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.onApprovalRequest = opts.onApprovalRequest;
    this.onSubagentModelAccessRequest = opts.onSubagentModelAccessRequest;
    this.onOAuthRefresh = opts.onOAuthRefresh;
    this.killSettleWatchdogMs = opts.killSettleWatchdogMs ?? DEFAULT_KILL_SETTLE_WATCHDOG_MS;
    this.killCloseGraceMs = opts.killCloseGraceMs ?? DEFAULT_KILL_CLOSE_GRACE_MS;
    this.logger =
      opts.logger ?? {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  create(opts: CreateSessionOptions): SessionState {
    const existing = this.sessions.get(opts.sessionId);
    if (existing?.alive) {
      throw makeRegistryError('SESSION_ALREADY_EXISTS', `session ${opts.sessionId} already exists`);
    }
    if (existing) {
      // existing dead session(same sessionId 复用): 直接 delete 让新 query/start
      // 接管。**MVP**:dead session 未读 events(断开期间产出)当前**不恢复**;SDK 已把
      // 它们写进 jsonl,future 走 read-since-lineNo recovery 从磁盘读回(follow-up,
      // 尚未实现)。删掉这个内存 entry 是安全的,不影响未来的 jsonl recovery。
      this.sessions.delete(opts.sessionId);
    }
    const inputQueue = createAsyncQueue<unknown>();

    // sessionRef is captured by the canUseTool closure (called later, after session is assigned).
    let sessionRef: SessionState | null = null;
    const appendToolGuardSelectionText = (text: string | undefined): void => {
      if (!sessionRef || !text) return;
      sessionRef.toolGuardSelectionText = [sessionRef.toolGuardSelectionText, text]
        .filter(Boolean)
        .join('\n');
    };

    // Build canUseTool callback that routes approval requests to attached client via RPC.
    const canUseTool: CanUseToolCallback | undefined = this.onApprovalRequest
      ? async (toolName, input, options) => {
          const deniedGuard = findDeniedToolGuard(
            opts.toolGuards,
            toolName,
            sessionRef?.toolGuardSelectionText ?? '',
            sessionRef?.toolGuardMcpServerNames ?? EMPTY_MCP_SERVER_NAMES,
          );
          if (deniedGuard) {
            this.logger.warn('tool denied by host routing guard in canUseTool', {
              sessionId: opts.sessionId,
              toolName,
              toolNamePrefix: deniedGuard.toolNamePrefix,
              invocation: deniedGuard.invocation,
            });
            return {
              behavior: 'deny',
              message:
                deniedGuard.denialMessage ??
                'This downstream tool source was not selected.',
            };
          }
          if (!sessionRef?.attachedNotify) {
            this.logger.warn('canUseTool fired without attached client — denying', {
              sessionId: opts.sessionId,
              toolName,
            });
            return { behavior: 'deny', message: 'no client attached for approval' };
          }
          try {
            const result = await this.onApprovalRequest!(opts.sessionId, {
              sessionId: opts.sessionId,
              requestId: options.toolUseID,
              kind: toolName === 'AskUserQuestion' ? 'ask_user_question'
                : toolName === 'ExitPlanMode' ? 'plan_review'
                : 'permission',
              toolName,
              input,
              title: options.title,
              displayName: options.displayName,
              description: options.description,
              suggestions: options.suggestions,
              metadata: {
                ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
                ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
                ...(options.agentID ? { agentID: options.agentID } : {}),
                // The daemon has authoritative scoped MCP provenance. This
                // attestation tells the desktop not to repeat the route check
                // from the provenance-less init payload.
                capabilityRoutingChecked: true,
              },
            });
            if (result.kind === 'ask_user_question') {
              return {
                behavior: 'allow',
                updatedInput: { ...input, answers: result.answers ?? {} },
              };
            }
            if (result.kind === 'plan_review') {
              const originalPlan = typeof (input as Record<string, unknown>).plan === 'string'
                ? (input as Record<string, unknown>).plan as string
                : '';
              if (result.behavior === 'deny') {
                if (!result.dismissed) appendToolGuardSelectionText(result.reason);
                return { behavior: 'deny', message: result.reason ?? 'plan rejected by user' };
              }
              appendToolGuardSelectionText(
                toolGuardSelectionAddedByPlanEdit(
                  opts.toolGuards,
                  originalPlan,
                  result.editedPlan,
                ),
              );
              const finalPlan = result.editedPlan ?? originalPlan;
              return { behavior: 'allow', updatedInput: { ...input, plan: finalPlan } };
            }
            // permission kind
            if (result.behavior === 'allow') {
              return {
                behavior: 'allow',
                updatedInput: result.updatedInput ?? input,
                updatedPermissions: result.permissionUpdates,
              };
            }
            return { behavior: 'deny', message: result.reason ?? 'denied by user' };
          } catch (err) {
            this.logger.warn('onApprovalRequest threw — denying', {
              sessionId: opts.sessionId,
              toolName,
              error: (err as Error).message,
            });
            return { behavior: 'deny', message: 'approval request failed' };
          }
        }
      : undefined;

    // Wire the SDK's oauth refresh callback only for sessions whose env carries
    // a subscription OAuth token — the SDK injects CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1
    // whenever the callback exists, and gateway-key sessions must not have their
    // API-key 401s misrouted into a subscription refresh (mirrors the local
    // maker-core wiring in claude-code/index.ts).
    const getOAuthToken: (() => Promise<string | null>) | undefined =
      this.onOAuthRefresh && opts.env.CLAUDE_CODE_OAUTH_TOKEN
        ? async () => {
            if (!sessionRef?.attachedNotify) {
              this.logger.warn('getOAuthToken fired without attached client — returning null', {
                sessionId: opts.sessionId,
              });
              return null;
            }
            try {
              const result = await this.onOAuthRefresh!(opts.sessionId, {
                sessionId: opts.sessionId,
              });
              // 不回写 opts.env:远端 daemon 不会用旧 env 重建 Query(rewind/fork 不支持),
              // 重连 fresh-start 的 env 由 desktop 重新下发(desktop 侧才是 token 事实源)。
              return result.token ?? null;
            } catch (err) {
              // Old desktop (UNKNOWN_METHOD) / RPC timeout / refresh failure all land
              // here — null lets the SDK surface the auth error (pre-refresh behavior).
              this.logger.warn('onOAuthRefresh failed — returning null', {
                sessionId: opts.sessionId,
                error: (err as Error).message,
              });
              return null;
            }
          }
        : undefined;

    const resolveSubagentModelAccess = this.onSubagentModelAccessRequest
      ? async (toolName: string, toolInput: unknown): Promise<SubagentModelAccessResult & { model?: string }> => {
          const model = effectiveSubagentModel(
            opts.env.CLAUDE_CODE_SUBAGENT_MODEL,
            toolName,
            toolInput,
          );
          if (!model) return { status: 'unknown' };
          try {
            const result = await this.onSubagentModelAccessRequest!(opts.sessionId, {
              sessionId: opts.sessionId,
              model,
            });
            return { ...result, model };
          } catch (err) {
            this.logger.warn('subagent model access preflight unavailable — allowing', {
              sessionId: opts.sessionId,
              model,
              error: (err as Error).message,
            });
            return { status: 'unknown', model };
          }
        }
      : undefined;

    const hooks = createToolGuardHooks(
      opts.toolGuards,
      resolveSubagentModelAccess,
      () => sessionRef?.toolGuardSelectionText ?? '',
      () => sessionRef?.toolGuardMcpServerNames ?? EMPTY_MCP_SERVER_NAMES,
      (toolName, guard) => {
        this.logger.warn('tool denied by host routing guard', {
          sessionId: opts.sessionId,
          toolName,
          toolNamePrefix: guard.toolNamePrefix,
          invocation: guard.invocation,
        });
      },
    );

    const sdkOpts: SdkQueryFactoryOptions = {
      inputStream: inputQueue,
      cwd: opts.cwd,
      model: opts.model,
      env: opts.env,
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : { permissionMode: 'acceptEdits' }),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.resumeSdkSessionId ? { resume: opts.resumeSdkSessionId } : {}),
      ...(opts.extraOptions ? { extraOptions: opts.extraOptions } : {}),
      ...(hooks ? { hooks } : {}),
      ...(canUseTool ? { canUseTool } : {}),
      ...(getOAuthToken ? { getOAuthToken } : {}),
    };
    const query = this.factory(sdkOpts);
    const hostMcpServerNames = new Set(Object.keys(opts.mcpServers ?? {}));
    const session: SessionState = {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      model: opts.model,
      inputQueue,
      query,
      nextSeq: 1,
      lastSeq: 0,
      startedAt: new Date().toISOString(),
      lastEventAt: null,
      sdkSessionId: null,
      alive: true,
      toolGuardSelectionText: '',
      toolGuardTurnActive: false,
      toolGuardMcpServerNames: hostMcpServerNames,
      toolGuardHostMcpServerNames: hostMcpServerNames,
      attachedNotify: null,
      buffer: [],
      bufferCapacity: this.bufferCapacity,
      bufferFirstSeq: 1,
    };
    sessionRef = session;
    this.sessions.set(opts.sessionId, session);
    this.startConsumeLoop(session);
    this.logger.info('session created', { sessionId: opts.sessionId, model: opts.model });
    return session;
  }

  get(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw makeRegistryError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    return s;
  }

  list(): SessionListEntry[] {
    const out: SessionListEntry[] = [];
    for (const s of this.sessions.values()) {
      out.push(this.sessionToListEntry(s));
    }
    return out;
  }

  private sessionToListEntry(s: SessionState): SessionListEntry {
    return {
      sessionId: s.sessionId,
      ...(s.sdkSessionId ? { sdkSessionId: s.sdkSessionId } : {}),
      cwd: s.cwd,
      model: s.model,
      lastSeq: s.lastSeq,
      alive: s.alive,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
    };
  }

  /**
   * Push a user message into the session's SDK input queue.
   */
  sendMessage(sessionId: string, message: unknown): void {
    const s = this.get(sessionId);
    if (!s.alive) {
      throw makeRegistryError('SESSION_NOT_FOUND', `session ${sessionId} is no longer alive`);
    }
    // kill 窗口 (killing=true 且 consume loop 未退出) 必须显式拒绝:
    // inputQueue 已 end, push 静默丢 — 看似发送成功实则消息消失
    // (Greptile P1)。调用方应稍后重试或走 fresh start。
    if (s.killing) {
      throw makeRegistryError(
        'SESSION_KILL_PENDING',
        `session ${sessionId} is being killed (input closed) — retry shortly or start a fresh query`,
      );
    }
    const accepted = s.inputQueue.push(message);
    if (!accepted) {
      throw makeRegistryError(
        'SESSION_NOT_FOUND',
        `session ${sessionId} input is closed`,
      );
    }
    const userText = extractUserMessageText(message);
    s.toolGuardSelectionText = s.toolGuardTurnActive
      ? [s.toolGuardSelectionText, userText].filter(Boolean).join('\n')
      : userText;
    s.toolGuardTurnActive = true;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.setModel(model);
    s.model = model; // Local mirror — actual SDK takes effect next turn.
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.setPermissionMode(mode);
  }

  async applyFlagSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
    const s = this.get(sessionId);
    await s.query.applyFlagSettings(settings);
  }

  async getContextUsage(sessionId: string): Promise<unknown> {
    const s = this.get(sessionId);
    if (!s.query.getContextUsage) {
      throw makeRegistryError('SDK_ERROR', 'query.getContextUsage is not supported by this SDK');
    }
    return s.query.getContextUsage();
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.get(sessionId);
    await s.query.interrupt();
  }

  /** 停止单个后台任务(desktop 用户 Stop 的确定性全停链路,SDK 老版本不支持时报错由客户端降级)。 */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s.query.stopTask) {
      throw makeRegistryError('SDK_ERROR', 'query.stopTask is not supported by this SDK');
    }
    await s.query.stopTask(taskId);
  }

  /**
   * Close a session: end input queue (lets SDK exit cleanly), mark dead.
   * Idempotent.
   *
   * **关键**: `s.alive = false` 必须在 inputQueue.end() 之前 (或之后立刻) set,
   * **不能等 SDK consume loop 自然退出再设**。否则:
   * 1. client 调 query/close → 这里 return
   * 2. user 立即调 query/send (或新 client attach + send) → openCcManagerSession
   *    看 list 还是 alive=true → 不走 fresh start, 直接 push 进 inputQueue
   * 3. inputQueue 已 end, AsyncQueue.push 静默丢 (没 throw)
   * 4. UI 卡 streaming, 远端永远没新 turn
   * 早设 alive=false 让后续 attach / start 路径正确判 dead。
   */
  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.alive) return;
    s.alive = false;
    try {
      await s.query.interrupt();
    } catch (err) {
      this.logger.warn('query interrupt during close threw', {
        sessionId,
        error: (err as Error).message,
      });
    }
    s.inputQueue.end();
  }

  /**
   * Kill (forceful): end input queue + remove from registry without waiting
   * for consume loop to drain. Loop will exit on its own after this.
   */
  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.alive) {
      this.sessions.delete(sessionId);
      return;
    }
    // 先标 killing 再 interrupt:终止窗口从这一刻起对 sendMessage 可见
    // (Greptile P1, 见 SessionState.killing)。
    s.killing = true;
    try {
      await s.query.interrupt();
    } catch (err) {
      this.logger.warn('query interrupt during kill threw', {
        sessionId,
        error: (err as Error).message,
      });
    }
    s.inputQueue.end();
    // 同步等 consume loop 真正退出 (带看门狗):kill 返回时 session
    // 必然不再 alive — client 不再需要用「固定期限轮询 list」猜终止状态
    // (Greptile R27 confidence:固定期限的客户端等待没有 daemon 侧保证,
    // 慢退出场景反复失败)。
    if (s.consumeLoopDone) {
      const settled = await raceWithTimeout(s.consumeLoopDone, this.killSettleWatchdogMs);
      if (!settled) {
        // 升级: 真实 SDK Query 的 close() 直接终止 CLI 子进程 — transport
        // 关闭后 async iterator 必然结束/报错, consume loop 随之为
        // alive=false (由 loop 自己置)。只在 loop 无视 interrupt 的
        // 卡死场景才会走到这里。
        if (typeof s.query.close === 'function') {
          this.logger.warn('consume loop ignored interrupt during kill — escalating to query.close()', {
            sessionId,
            watchdogMs: this.killSettleWatchdogMs,
          });
          try {
            s.query.close();
          } catch (err) {
            this.logger.warn('query.close during kill escalation threw', {
              sessionId,
              error: (err as Error).message,
            });
          }
          const settledAfterClose = await raceWithTimeout(s.consumeLoopDone, this.killCloseGraceMs);
          if (settledAfterClose) return;
        }
        // close() 不可用或 loop 仍不退出 = daemon 病态。绝不把 session
        // 谎报为已退出让恢复路径继续 (Greptile confidence 3/5:同 ID 的
        // 新旧 query 会在远端重叠执行)。抛 SESSION_KILL_TIMEOUT 并保留
        // session (alive 仍 true、killing 保持) — 重试 kill 幂等重进
        // 本流程;恢复手段是重启 cc-mgr daemon。
        throw makeRegistryError(
          'SESSION_KILL_TIMEOUT',
          `SESSION_KILL_TIMEOUT: session ${sessionId} consume loop did not exit after kill ` +
            `(watchdog ${this.killSettleWatchdogMs}ms` +
            `${typeof s.query.close === 'function' ? ` + close grace ${this.killCloseGraceMs}ms` : ''}) — ` +
            `restart the cc-mgr daemon to recover; refusing to report it as exited ` +
            `while the old loop may still be running`,
        );
      }
    }
  }

  /**
   * Attach a client's notify callback to receive event notifications.
   * If another client is already attached, replace it (notify old that
   * it has been replaced).
   *
   * Returns the session's current lastSeq so the client can request
   * replay-from-X if it had been receiving events before disconnect.
   *
   * Phase 5 will add: replay events with seq > sinceSeq from disk log.
   * Phase 2 just connects to live stream (sinceSeq is recorded but no replay).
   */
  attach(
    sessionId: string,
    notify: AttachedNotify,
    opts: { sinceSeq?: number } = {},
  ): { currentSeq: number; alive: boolean; replayedCount: number; replayLossy: boolean } {
    const s = this.get(sessionId);
    if (s.attachedNotify && s.attachedNotify !== notify) {
      const replacedNotify = s.attachedNotify;
      // Switch to new client first, then notify the old one (avoid race).
      s.attachedNotify = notify;
      try {
        const replacedMsg: ClientReplacedNotification = {
          sessionId,
          reason: 'another-client-attached',
        };
        replacedNotify('replaced', replacedMsg);
      } catch (err) {
        this.logger.warn('failed to notify replaced client', {
          sessionId,
          error: (err as Error).message,
        });
      }
    } else {
      s.attachedNotify = notify;
    }
    // Replay buffered events with seq > sinceSeq (if requested).
    let replayedCount = 0;
    let replayLossy = false;
    if (opts.sinceSeq !== undefined && s.buffer.length > 0) {
      // If sinceSeq is before bufferFirstSeq, we've dropped events the client needs.
      // We still replay what we have; client sees a gap (signaled by replayLossy).
      if (opts.sinceSeq < s.bufferFirstSeq - 1) {
        replayLossy = true;
      }
      for (const ev of s.buffer) {
        if (ev.seq <= opts.sinceSeq) continue;
        const notification: QueryEventNotification = {
          sessionId,
          seq: ev.seq,
          ts: ev.ts,
          message: ev.message,
        };
        try {
          notify('event', notification);
          replayedCount++;
        } catch (err) {
          this.logger.warn('replay event throw', {
            sessionId,
            seq: ev.seq,
            error: (err as Error).message,
          });
        }
      }
    }
    return { currentSeq: s.lastSeq, alive: s.alive, replayedCount, replayLossy };
  }

  /**
   * Detach a specific client's notify (if it's the current attached one).
   * Used when a client disconnects gracefully.
   */
  detachIfCurrent(sessionId: string, notify: AttachedNotify): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.attachedNotify === notify) {
      s.attachedNotify = null;
    }
  }

  /**
   * Detach all sessions that are using the given notify (used when a client
   * connection drops — clear it from every session it might have been on).
   */
  detachAll(notify: AttachedNotify): void {
    for (const s of this.sessions.values()) {
      if (s.attachedNotify === notify) {
        s.attachedNotify = null;
      }
    }
  }

  /**
   * Daemon-wide graceful shutdown — broadcast SESSION_CLOSED with reason='killed'
   * to every still-attached client, then mark all sessions as not-alive.
   *
   * Called from the cc-mgr SIGTERM / SIGINT handler **before** server.stop()
   * closes the socket, so each attached desktop client gets an explicit
   * "session ended" notification it can use to:
   *   1. unblock the in-flight turn's for-await loop (RemoteQuery treats
   *      SESSION_CLOSED as iterator-end)
   *   2. surface a structured error to maker / renderer (vs the silent
   *      "ssh stream just stopped" state, which leaves UI stuck in
   *      isStreaming=true forever — see U2 fallback)
   *
   * Without this, force-upgrade pkill'ing the daemon would silently drop
   * every active turn — UI stays in "thinking..." state until user restarts
   * the desktop. With this, U2's translator can convert SESSION_CLOSED into
   * a proper aborted-turn event, U3 can read those aborts to schedule auto-retry.
   */
  shutdownAll(detail?: string): void {
    for (const s of this.sessions.values()) {
      // Mark dead BEFORE notify — keeps `alive` flag consistent if notify
      // synchronously throws (we still want the registry to reflect the
      // post-shutdown state).
      const wasAlive = s.alive;
      s.alive = false;
      if (wasAlive) {
        this.notifyClosed(s, 'killed', detail ?? 'daemon shutting down');
      }
    }
  }

  /* ============================== private ============================== */

  private startConsumeLoop(session: SessionState): void {
    session.consumeLoopDone = (async (): Promise<void> => {
      try {
        for await (const message of session.query) {
          if (isSdkInitMessage(message)) {
            await this.refreshToolGuardMcpServerNames(session);
          }
          this.recordEvent(session, message);
        }
        // Generator returned normally — session completed.
        session.alive = false;
        this.notifyClosed(session, 'completed');
      } catch (err) {
        session.alive = false;
        this.logger.warn('session consume loop threw', {
          sessionId: session.sessionId,
          error: (err as Error).message,
        });
        this.notifyClosed(session, 'error', (err as Error).message);
      }
    })();
    // 迟到失败不成 unhandled rejection (kill 的同步等待另有 race 兜底)。
    session.consumeLoopDone.catch(() => undefined);
  }

  private recordEvent(session: SessionState, message: unknown): void {
    const seq = session.nextSeq++;
    session.lastSeq = seq;
    const ts = new Date().toISOString();
    session.lastEventAt = ts;

    // Capture SDK's session uuid from the first SDKSystemMessage (init subtype).
    if (!session.sdkSessionId && isSdkInitMessage(message)) {
      session.sdkSessionId = message.session_id;
    }
    if (isSdkTurnResult(message)) {
      // Keep the text until the next accepted input so any SDK-managed
      // continuation after the result retains the same explicit selection.
      session.toolGuardTurnActive = false;
    }

    // Append to ring buffer for replay. Drop oldest when over capacity.
    session.buffer.push({ seq, ts, message });
    if (session.buffer.length > session.bufferCapacity) {
      const dropped = session.buffer.shift();
      if (dropped) {
        session.bufferFirstSeq = dropped.seq + 1;
      }
    }

    const notification: QueryEventNotification = {
      sessionId: session.sessionId,
      seq,
      ts,
      message,
    };
    if (session.attachedNotify) {
      try {
        session.attachedNotify('event', notification);
      } catch (err) {
        this.logger.warn('attachedNotify event threw', {
          sessionId: session.sessionId,
          seq,
          error: (err as Error).message,
        });
      }
    }
  }

  private async refreshToolGuardMcpServerNames(session: SessionState): Promise<void> {
    const fallbackNames = new Set(session.toolGuardHostMcpServerNames);
    if (!session.query.mcpServerStatus) {
      session.toolGuardMcpServerNames = fallbackNames;
      return;
    }
    try {
      const statuses = await session.query.mcpServerStatus();
      const connectedNonHarnessNames = new Set<string>();
      for (const server of statuses) {
        if (
          server.status === 'connected' &&
          typeof server.name === 'string' &&
          server.name.length > 0 &&
          (
            session.toolGuardHostMcpServerNames.has(server.name) ||
            isUserSettingsMcpScope(server.scope)
          )
        ) {
          connectedNonHarnessNames.add(server.name);
        }
      }
      session.toolGuardMcpServerNames = connectedNonHarnessNames;
      return;
    } catch (error) {
      // Unknown provenance must not disable a host routing guard. Host-injected
      // MCPs remain known non-harness sources; settings MCPs fail closed.
      this.logger.warn('failed to read scoped MCP status for tool guards', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    session.toolGuardMcpServerNames = fallbackNames;
  }

  private notifyClosed(session: SessionState, reason: SessionClosedNotification['reason'], detail?: string): void {
    if (session.attachedNotify) {
      try {
        const n: SessionClosedNotification = {
          sessionId: session.sessionId,
          reason,
          ...(detail ? { detail } : {}),
        };
        session.attachedNotify('closed', n);
      } catch (err) {
        this.logger.warn('attachedNotify closed threw', {
          sessionId: session.sessionId,
          error: (err as Error).message,
        });
      }
    }
    // GC: keep dead session briefly for session/list diagnostics, then remove
    // to prevent unbounded memory growth in long-running daemon.
    setTimeout(() => {
      const current = this.sessions.get(session.sessionId);
      if (current === session && !current.alive) {
        this.sessions.delete(session.sessionId);
        session.buffer.length = 0;
      }
    }, 60_000);
  }
}

interface RegistryError extends Error {
  code:
    | 'SESSION_NOT_FOUND'
    | 'SESSION_ALREADY_EXISTS'
    | 'SESSION_KILL_PENDING'
    | 'SESSION_KILL_TIMEOUT'
    | 'SDK_ERROR';
}

function makeRegistryError(code: RegistryError['code'], message: string): RegistryError {
  const err = new Error(message) as RegistryError;
  err.code = code;
  return err;
}

/** Race a promise against a timeout; resolves true if settled, false on timeout. */
function raceWithTimeout(p: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/** SDK's first SDKSystemMessage variant always has subtype='init' and session_id. */
function isSdkInitMessage(msg: unknown): msg is {
  type: 'system';
  subtype: 'init';
  session_id: string;
  mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
} {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string';
}

function isSdkTurnResult(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  return (msg as Record<string, unknown>).type === 'result';
}

function extractUserMessageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const envelope = message as Record<string, unknown>;
  if (typeof envelope.text === 'string') return envelope.text;
  if (typeof envelope.message !== 'object' || envelope.message === null) return '';
  const content = (envelope.message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        return [(block as Record<string, unknown>).text as string];
      }
      return [];
    })
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesExplicitSelector(text: string, selector: string): boolean {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) return false;
  if (normalizedSelector.startsWith('$')) {
    return new RegExp(
      `(^|[^A-Za-z0-9_:-])${escapeRegExp(normalizedSelector)}(?![A-Za-z0-9_:-])`,
      'iu',
    ).test(text);
  }
  if (normalizedSelector.startsWith('/')) {
    return new RegExp(
      `(^|\\s)${escapeRegExp(normalizedSelector)}(?=$|\\s|[.,!?;:，。！？；：])`,
      'iu',
    ).test(text);
  }
  return false;
}

function toolGuardSelectionAddedByPlanEdit(
  toolGuards: readonly QueryToolGuard[] | undefined,
  originalPlan: string,
  editedPlan: string | undefined,
): string {
  if (editedPlan === undefined || editedPlan === originalPlan) return '';
  const added = new Set<string>();
  for (const guard of toolGuards ?? []) {
    if (guard.invocation !== 'explicit-only') continue;
    const selectors = guard.explicitSelectors ?? [];
    for (const selector of selectors) {
      if (
        !matchesExplicitSelector(originalPlan, selector) &&
        matchesExplicitSelector(editedPlan, selector)
      ) {
        added.add(selector.trim());
      }
    }
  }
  return [...added].filter(Boolean).join('\n');
}

const EMPTY_MCP_SERVER_NAMES: ReadonlySet<string> = new Set();

function isUserSettingsMcpScope(scope: unknown): boolean {
  return scope === 'user' || scope === 'project' || scope === 'local';
}

function claudeMcpToolPrefix(serverId: string): string {
  return `mcp__${serverId.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
}

function hasToolGuardMcpPrefixCollision(
  guard: QueryToolGuard,
  mcpServerNames: ReadonlySet<string>,
): boolean {
  if (guard.invocation === 'root-only') return false;
  if (!guard.sourceServerId) return false;
  // The caller passes only connected host/user/project/local MCPs. An exact id
  // can therefore be a user MCP shadowing the harness source.
  for (const serverId of mcpServerNames) {
    if (claudeMcpToolPrefix(serverId) === guard.toolNamePrefix) return true;
  }
  return false;
}

function findDeniedToolGuard(
  toolGuards: readonly QueryToolGuard[] | undefined,
  toolName: string,
  selectionText: string,
  mcpServerNames: ReadonlySet<string>,
  agentId?: string,
): QueryToolGuard | undefined {
  const guard = toolGuards?.find(
    (candidate) =>
      (candidate.invocation === 'root-only'
        ? toolName === candidate.toolNamePrefix
        : toolName.startsWith(candidate.toolNamePrefix)) &&
      !hasToolGuardMcpPrefixCollision(candidate, mcpServerNames),
  );
  if (!guard || guard.invocation === 'auto') return undefined;
  if (guard.invocation === 'root-only') {
    return typeof agentId === 'string' && agentId.length > 0 ? guard : undefined;
  }
  if (
    guard.invocation === 'explicit-only' &&
    guard.explicitSelectors?.some((selector) =>
      matchesExplicitSelector(selectionText, selector),
    )
  ) {
    return undefined;
  }
  return guard;
}

function normalizeSubagentModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith('[1m]')
    ? normalized.slice(0, -'[1m]'.length)
    : normalized;
}

function effectiveSubagentModel(
  forcedModel: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (toolName !== 'Agent' && toolName !== 'Task') return undefined;
  const input = typeof toolInput === 'object' && toolInput !== null
    ? toolInput as Record<string, unknown>
    : {};
  const requested = typeof input.model === 'string' ? input.model : '';
  const effectiveModel = normalizeSubagentModel(forcedModel ?? requested);
  return !effectiveModel || effectiveModel === 'inherit' ? undefined : effectiveModel;
}

function subagentModelDenialReason(model: string): string {
  return `Subagent model "${model}" is not available from the current account and provider. Choose an available model, or remove the unavailable override from the Agent call or Subagent Model setting.`;
}

function createToolGuardHooks(
  toolGuards: readonly QueryToolGuard[] | undefined,
  resolveSubagentModelAccess: ((
    toolName: string,
    toolInput: unknown,
  ) => Promise<SubagentModelAccessResult & { model?: string }>) | undefined,
  getSelectionText: () => string,
  getMcpServerNames: () => ReadonlySet<string>,
  onDeny: (toolName: string, guard: QueryToolGuard) => void,
): SdkHooks | undefined {
  if ((!toolGuards || toolGuards.length === 0) && !resolveSubagentModelAccess) return undefined;

  const guardTool: SdkHookCallback = async (rawInput) => {
    if (typeof rawInput !== 'object' || rawInput === null) return { continue: true };
    const input = rawInput as Record<string, unknown>;
    if (input.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string') {
      return { continue: true };
    }
    const toolName = input.tool_name;
    const modelAccess = await resolveSubagentModelAccess?.(toolName, input.tool_input);
    if (modelAccess?.status === 'denied' && modelAccess.model) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: modelAccess.reason?.trim()
            || subagentModelDenialReason(modelAccess.model),
        },
      };
    }
    const guard = findDeniedToolGuard(
      toolGuards,
      toolName,
      getSelectionText(),
      getMcpServerNames(),
      typeof input.agent_id === 'string' ? input.agent_id : undefined,
    );
    if (!guard) return { continue: true };

    onDeny(toolName, guard);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          guard.denialMessage ?? 'This downstream tool source was not selected.',
      },
    };
  };

  return {
    PreToolUse: [{ hooks: [guardTool] }],
  };
}
