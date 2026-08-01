/**
 * Maker — Session 注册中心 + Agent 路由。
 *
 * 当前职责（一阶段）：
 * - 持有按 AgentKind 注册的 BaseAgent 实例
 * - 按 (agentKind, workDir) 创建 Session
 * - 维护 Session 列表
 *
 * 未来扩展（MetaAgent 升级）：
 * - 自带 LLM 决策循环 → 当前类做成 extends-friendly（关键方法 protected）
 * - workdir-scoped 记忆 / constraints → 预留 deps 字段
 *
 * 不做：
 * - UI 状态、权限弹窗（host 注入 PermissionListener）
 * - 业务 token 管理、飞书业务态
 */

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { AgentKind } from './types/common.js';
import type { Capabilities } from './types/capabilities.js';
import type { ForkSdkSessionOptions, ForkSdkSessionResult } from './types/events.js';
import type {
  ScanAtResourcesOptions,
  ScanAtResourcesResult,
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from './types/palette.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from './types/customizations.js';
import { Session, generateSessionId } from './session.js';
import type {
  BaseAgent,
  StartSessionOptions,
  OneShotOptions,
  RefreshLocalModelsOptions,
} from './agents/base-agent.js';
import type { MemoryStatus, MemorySetResult, MemoryResetResult } from './types/memory.js';
import type { ConsumeAccountRateLimitResetCreditParams } from './types/account-rate-limits.js';
import type { SessionStorage, SessionMeta } from './interfaces/session-storage.js';
import type { Logger } from './interfaces/logger.js';
import type { AuthLoginOptions } from './interfaces/auth-adapter.js';
import type { MakerMemoryManager } from './memory/manager.js';

/**
 * Session 生命周期钩子 —— host 层声明 session 启动 / 成功发布 / 关闭时的副作用。
 * Maker 不知道 hook 内部干什么 (持久化上下文 / worktree / temp 文件 / metric / ...)。
 *
 * 设计动机: 把 desktop-specific 的 cleanup (worktree / OS temp 文件) 集中在 host
 * 一处声明,避免散落在各个 IPC handler 的 post-hook 里; maker-core 抽象保持干净
 * (零 Electron / 零 file system 概念)。
 */
export interface SessionBeforeStartContext {
  agentKind: AgentKind;
  workingDir: string;
  remoteHostId?: string;
}

export interface SessionLifecycleHooks {
  /**
   * Agent 启动前补齐 start options。该步骤属于正确启动的前置条件，失败会阻断创建。
   * 允许直接修改 options；Maker 会把同一个对象传给 agent 和成功钩子。
   */
  prepareStartOptions?: (sessionId: string, options: CreateSessionOptions) => void | Promise<void>;
  /** Agent 启动前的 host 准备动作。失败只记日志，不阻断 session 创建。 */
  onBeforeStart?: (context: SessionBeforeStartContext) => void | Promise<void>;
  /** Agent 和 Session 均创建成功后、对外发布前调用。失败只记日志，不阻断创建。 */
  onStartSucceeded?: (sessionId: string, options: CreateSessionOptions) => void | Promise<void>;
  /** session 关闭时 (Maker.closeSession 主动 / 内部异常 / handle 自然结束)。 */
  onClose?: (sessionId: string) => void | Promise<void>;
  /**
   * Codex-only: resume 前读取该业务 session 对应 thread history 是否已可靠包含
   * 产品 prompt。读取失败由 Maker 视为 unknown,让 Codex fail toward restore。
   */
  getCodexHistoryHasProductPrompt?: (sessionId: string) => boolean | undefined | Promise<boolean | undefined>;
  /**
   * Codex-only: start/resume 成功后写入真实投递事实。只在 handle 有有效 threadId
   * 且 agent 明确报告 delivery 时调用;失败只记日志,不阻塞 session 创建。
   */
  onCodexProductPromptDelivery?: (args: {
    sessionId: string;
    threadId: string;
    historyHasProductPrompt: boolean;
  }) => void | Promise<void>;
}

export interface MakerDeps {
  agents: Partial<Record<AgentKind, BaseAgent>>;
  storage: SessionStorage;
  logger: Logger;
  /** 可选: session 生命周期副作用钩子 (host 层注入)。详见 SessionLifecycleHooks。 */
  lifecycleHooks?: SessionLifecycleHooks;
  /**
   * 可选: Maker Memory 顶层单例 (host 注入)。host 在创建 Maker 前先实例化
   * MakerMemoryManager (传 sqliteFactory + userDataPath + agents), 再传给 Maker。
   * 缺省时 Maker.makerMemory 为 undefined, agent 端 startSession 不注入 memory 段
   * (即跟改造前行为一致, native auto-memory 走自家)。
   */
  makerMemory?: MakerMemoryManager;
}

export interface CreateSessionOptions extends StartSessionOptions {
  agentKind: AgentKind;
  /** 可选：UI 显示用 */
  title?: string;
  /** 可选：父会话 id，用于 fork / orchestration 等会话关系。 */
  parentSessionId?: string;
  /**
   * 可选：调用方提供的 sessionId(通常来自外部 DB row)。提供后:
   *   - storage 已有同 id 的 row → 跳过 create, 直接复用
   *   - storage 没有 → 用此 id 创建新 row
   * 不提供则 maker 自己生成 uuid。chat 切换场景必传(本端 sessions 表的 id 来自
   * local-db:sessions:create, maker 必须复用而不是再生成一个)。
   */
  id?: string;
}

export type MakerSessionCloseReason = 'requested' | 'agent-switch' | 'unexpected';

export type MakerEvent =
  | { type: 'session:created'; session: Session }
  | {
      type: 'session:closed';
      sessionId: string;
      session: Session;
      reason: MakerSessionCloseReason;
    };

export type MakerEventListener = (event: MakerEvent) => void;

function capabilitiesForSession(
  agentKind: AgentKind,
  base: Capabilities,
  remoteHostId?: string | null,
): Capabilities {
  if (agentKind !== 'codex' || !remoteHostId) return base;
  return {
    ...base,
    rewind: {
      supported: false,
      reason: 'platform-limited',
      message: '远端 Codex 会话暂不支持对话 rewind',
    },
  };
}

export class Maker {
  protected readonly agents: Partial<Record<AgentKind, BaseAgent>>;
  protected readonly storage: SessionStorage;
  protected readonly logger: Logger;
  protected readonly lifecycleHooks: SessionLifecycleHooks;
  protected readonly activeSessions = new Map<string, Session>();
  protected readonly listeners = new Set<MakerEventListener>();
  /**
   * 同一 business session 的启动必须 singleflight。activeSessions 只在所有异步
   * startup / storage 步骤完成后写入；没有这层占位时，并发恢复会各自 spawn SDK
   * handle，Codex 同 thread 的后一个 subscriber 会覆盖前一个并让前一个 send 永久悬挂。
   */
  private readonly inFlightSessionCreations = new Map<
    string,
    { promise: Promise<Session> }
  >();
  /**
   * 同一 business session 的 vendor id 写入必须串行。invalid-resume CAS 只有排在
   * 已在途的 session_id update 之后执行，才能保证旧写入不会在清空后反向覆盖。
   */
  private readonly sdkSessionPersistenceTails = new Map<string, Promise<void>>();
  /** 已确认失效的 vendor id；用于丢弃 CAS 之后才到达的旧 query session_id 事件。 */
  private readonly invalidSdkSessionIds = new Map<string, Set<string>>();
  /** Explicit close cause keyed by the exact Session instance that will emit closed. */
  private readonly closeReasons = new WeakMap<Session, MakerSessionCloseReason>();
  /** Maker Memory 顶层单例 (可选). undefined 时 maker memory 功能整体禁用. */
  public readonly makerMemory: MakerMemoryManager | undefined;

  constructor(deps: MakerDeps) {
    this.agents = deps.agents;
    this.storage = deps.storage;
    // 不 child 自己名字 — host 传进来的 logger 通常已经命名(如 'maker'),
    // 再 child 'maker' 会变成 'maker/maker'。host 自己决定 root scope 名字。
    this.logger = deps.logger;
    this.lifecycleHooks = deps.lifecycleHooks ?? {};
    this.makerMemory = deps.makerMemory;
    this.logger.info('Maker initialized', {
      agents: Object.keys(this.agents),
      hasOnBeforeStartHook: !!this.lifecycleHooks.onBeforeStart,
      hasOnCloseHook: !!this.lifecycleHooks.onClose,
      makerMemory: !!this.makerMemory,
    });
  }

  /**
   * 创建一个新会话。
   *
   * 幂等性: 若 opts.id 已在 storage 命中, 跳过 storage.create 改用现有 meta;
   * 同 id 已有 active Session 或正在创建时直接复用 —— 适配"用户切回老 session
   * 继续聊"以及多个后台入口同时恢复同一会话的场景。
   */
  async createSession(opts: CreateSessionOptions): Promise<Session> {
    if (!opts.id) {
      return this.createSessionOnce(opts);
    }

    // 进程内已经活着或正在启动的 session, 直接复用 (避免 spawn 第二个 SDK)。
    const existing = this.activeSessions.get(opts.id);
    if (existing) return existing;

    const inFlight = this.inFlightSessionCreations.get(opts.id);
    if (inFlight) return inFlight.promise;

    const creation = { promise: this.createSessionOnce(opts) };
    this.inFlightSessionCreations.set(opts.id, creation);
    try {
      return await creation.promise;
    } finally {
      // entry 身份比较防御未来替换 / 重试逻辑误删更新的占位。
      if (this.inFlightSessionCreations.get(opts.id) === creation) {
        this.inFlightSessionCreations.delete(opts.id);
      }
    }
  }

  /** 执行一次真实 session startup；带 id 的并发去重由 createSession 统一负责。 */
  private async createSessionOnce(opts: CreateSessionOptions): Promise<Session> {
    const agent = this.requireAgent(opts.agentKind);
    const id = opts.id ?? generateSessionId();

    this.logger.debug('createSession ↓', {
      localSessionId: id,
      providedId: !!opts.id,
      agentKind: opts.agentKind,
      workingDir: opts.workingDir,
      model: opts.model,
      title: opts.title,
      effort: opts.effort,
      fastMode: opts.fastMode ?? 'default',
      permissionMode: opts.permissionMode,
      displayReasoning: opts.displayReasoning,
      resumeSessionId: opts.resumeSessionId,
      vendorOptionKeys: opts.vendorOptions ? Object.keys(opts.vendorOptions) : undefined,
    });

    const startedAt = Date.now();
    const startOpts: CreateSessionOptions = { ...opts };
    if (this.lifecycleHooks.prepareStartOptions) {
      await this.lifecycleHooks.prepareStartOptions(id, startOpts);
    }
    if (this.lifecycleHooks.onBeforeStart) {
      try {
        await this.lifecycleHooks.onBeforeStart({
          agentKind: opts.agentKind,
          workingDir: opts.workingDir,
          ...(opts.remoteHostId ? { remoteHostId: opts.remoteHostId } : {}),
        });
      } catch (err) {
        this.logger.warn('lifecycleHooks.onBeforeStart threw; continuing session startup', {
          sessionId: id,
          workingDir: opts.workingDir,
          error: String(err),
        });
      }
    }
    if (
      opts.agentKind === 'codex' &&
      opts.resumeSessionId &&
      startOpts.codexHistoryHasProductPrompt === undefined &&
      this.lifecycleHooks.getCodexHistoryHasProductPrompt
    ) {
      try {
        startOpts.codexHistoryHasProductPrompt =
          await this.lifecycleHooks.getCodexHistoryHasProductPrompt(id);
      } catch (err) {
        this.logger.warn('failed to read codex prompt history state; resume will fail toward restore', {
          sessionId: id,
          error: String(err),
        });
        startOpts.codexHistoryHasProductPrompt = undefined;
      }
    }
    // 把 business sessionId 透传给 agent.startSession, 让 agent 在构造 MCP
    // provider ctx 时塞到 ctx.sessionId 上 (claude-code/index.ts buildMcpServers)。
    // MCP server 工厂据此闭包绑定 "我属于哪个 session", 控制类工具 (如
    // start_team / create_worker) 需要它把回调路由到对应 session 的业务函数。
    const handle = await agent.startSession({
      ...startOpts,
      sessionId: id,
      // 强制由 Maker 注入持久化 CAS，不能信任外部 CreateSessionOptions 自带回调。
      // Claude adapter 只在精确识别 invalid-resume 时调用；Codex 不消费该字段。
      // 对所有 claude-code 会话装配(不止 resume):全新会话也可能在首个 turn 崩溃前
      // 就把 SDK 回填、已落库的 sdk_session_id 变成幽灵 id(见 claude-code/index.ts
      // 的 fresh-session self-reference 恢复),需要同一把 CAS 才能把它清掉,否则下一次
      // send 会 resume 同一个不存在的会话反复失败。
      onInvalidResumeSession:
        opts.agentKind === 'claude-code'
          ? (expectedSdkSessionId) =>
              this.invalidateAndClearSdkSessionId(id, expectedSdkSessionId)
          : undefined,
    });
    this.logger.debug('createSession ↑ agent.startSession returned', {
      localSessionId: id,
      sdkSessionId: handle.id,
      elapsedMs: Date.now() - startedAt,
    });

    // 落地元数据 —— storage 已有同 id 的 row 时跳过 insert, 走 update 把 sdkSessionId 写回
    let meta: SessionMeta;
    const existingRow = opts.id ? await this.storage.get(opts.id) : null;
    if (existingRow) {
      meta = handle.id !== '<pending>' && existingRow.sdkSessionId !== handle.id
        ? await this.storage.update(id, { sdkSessionId: handle.id })
        : existingRow;
    } else {
      meta = await this.storage.create({
        id,
        agentKind: opts.agentKind,
        workDir: opts.workingDir,
        title: opts.title ?? DEFAULT_DRAFT_SESSION_TITLE,
        model: opts.model,
        workspaceKind: opts.workspaceKind,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        fastMode: opts.fastMode,
        parentSessionId: opts.parentSessionId,
        // remoteHostId: 远端 session 把目标机器持久化, 之后 resume / list 都能识别。
        // 本地 session 留 undefined (sqlite 落空), 跟历史行为兼容。
        remoteHostId: opts.remoteHostId,
        sdkSessionId: handle.id !== '<pending>' ? handle.id : undefined,
      });
    }

    const delivery = handle.codexProductPromptDelivery;
    if (
      opts.agentKind === 'codex' &&
      delivery &&
      handle.id !== '<pending>' &&
      handle.id !== '<failed>' &&
      this.lifecycleHooks.onCodexProductPromptDelivery
    ) {
      try {
        await this.lifecycleHooks.onCodexProductPromptDelivery({
          sessionId: id,
          threadId: delivery.threadId,
          historyHasProductPrompt: delivery.historyHasProductPrompt,
        });
      } catch (err) {
        this.logger.warn('failed to persist codex prompt delivery state', {
          sessionId: id,
          threadId: delivery.threadId,
          error: String(err),
        });
      }
    }

    const session = new Session({
      id: meta.id,
      agentKind: meta.agentKind,
      workDir: meta.workDir,
      handle,
      capabilities: capabilitiesForSession(meta.agentKind, agent.capabilities, meta.remoteHostId),
      logger: this.logger,
      permissionMode: startOpts.permissionMode,
      // 透传 remoteHostId 让 host 层在 hot path 上能 O(1) 判 local/remote
      // (不用每次 send 回 DB 读 SessionMeta — register.ts checkWorkDirExists 走这条)。
      remoteHostId: meta.remoteHostId ?? null,
    });

    // 当 SDK 回填 sdkSessionId 时持久化
    session.onEvent((evt) => {
      if (evt.type === 'session_id' && typeof evt.data === 'string' && evt.data) {
        void this.persistSdkSessionId(meta.id, evt.data).catch((e) => {
          this.logger.warn('failed to persist sdkSessionId', { error: String(e) });
        });
      }
    });

    session.onStatusChange((status) => {
      if (status === 'closed') {
        // 不再持久化运行态: 'closed' 是 SDK 子进程的瞬态, 重启即灭, 无意义存盘。
        this.activeSessions.delete(meta.id);
        this.emit({
          type: 'session:closed',
          sessionId: meta.id,
          session,
          reason: this.closeReasons.get(session) ?? 'unexpected',
        });
        // 注入的副作用钩子 (worktree / temp 文件 / image cache 清理等)。
        // fire-and-forget, 异常只记日志, 不影响其他清理。在 storage update / activeSessions
        // delete / emit 之后调 —— 钩子里的逻辑可能对外发 IPC 或读 maker state, 让 Maker
        // 自己的 invariant 先一致。
        if (this.lifecycleHooks.onClose) {
          void Promise.resolve()
            .then(() => this.lifecycleHooks.onClose!(meta.id))
            .catch((err) => {
              this.logger.warn('lifecycleHooks.onClose threw', { sessionId: meta.id, error: String(err) });
            });
        }
      }
    });

    if (this.lifecycleHooks.onStartSucceeded) {
      try {
        await this.lifecycleHooks.onStartSucceeded(id, startOpts);
      } catch (err) {
        this.logger.warn('lifecycleHooks.onStartSucceeded threw; continuing session publish', {
          sessionId: id,
          error: String(err),
        });
      }
    }

    this.activeSessions.set(meta.id, session);
    this.emit({ type: 'session:created', session });
    return session;
  }

  /**
   * 将同一 session 的 vendor id 持久化操作排成单通道；单次失败不阻断后续操作。
   */
  private enqueueSdkSessionPersistence<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sdkSessionPersistenceTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.sdkSessionPersistenceTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sdkSessionPersistenceTails.get(sessionId) === tail) {
        this.sdkSessionPersistenceTails.delete(sessionId);
      }
    });
    return result;
  }

  /** 标记旧 vendor id 失效，并在所有已在途回填完成后执行 compare-and-clear。 */
  private invalidateAndClearSdkSessionId(sessionId: string, expectedSdkSessionId: string): Promise<boolean> {
    let invalidIds = this.invalidSdkSessionIds.get(sessionId);
    if (!invalidIds) {
      invalidIds = new Set<string>();
      this.invalidSdkSessionIds.set(sessionId, invalidIds);
    }
    // 先标记再排 CAS：CAS 等待期间新到达的同 id 事件也必须在执行时被丢弃。
    invalidIds.add(expectedSdkSessionId);
    return this.enqueueSdkSessionPersistence(sessionId, () =>
      this.storage.compareAndClearSdkSessionId(sessionId, expectedSdkSessionId),
    );
  }

  /** 串行持久化有效 vendor id，并屏蔽已判失效 query 的晚到事件。 */
  private persistSdkSessionId(sessionId: string, sdkSessionId: string): Promise<void> {
    return this.enqueueSdkSessionPersistence(sessionId, async () => {
      if (this.invalidSdkSessionIds.get(sessionId)?.has(sdkSessionId)) {
        this.logger.debug('ignored stale sdkSessionId event after invalid-resume recovery', {
          sessionId,
          sdkSessionId,
        });
        return;
      }
      await this.storage.update(sessionId, { sdkSessionId });
    });
  }

  /** 拿到一个已激活的 session（不发起恢复） */
  getSession(id: string): Session | undefined {
    return this.activeSessions.get(id);
  }

  /**
   * 读 session 持久化元数据 (title / agentKind / sdkSessionId / ...).
   * 主要给 IPC 层在 send 前查最新 title 作为日志诊断字段透传用 ——
   * 不走业务路径, 失败 (找不到) 返回 null 由调用方决定怎么降级。
   */
  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    return this.storage.get(id);
  }

  /**
   * 查 session 是否在内存中且 SDK 子进程未关闭。
   * "在跑" 的权威来源 —— 不在 activeSessions Map 或 status==='closed' 都算 false。
   * sidebar / 归档防误伤等场景应走这个判断, 不要碰 DB (DB 的 status 是产品归档语义,
   * 跟运行态无关)。
   */
  isSessionAlive(id: string): boolean {
    const sess = this.activeSessions.get(id);
    return sess !== undefined && sess.getStatus() !== 'closed';
  }

  /** 列出所有当前激活的 session */
  listActiveSessions(): Session[] {
    return Array.from(this.activeSessions.values());
  }

  /** 列出所有元数据（含已关闭的） */
  async listAllMeta(): Promise<SessionMeta[]> {
    return this.storage.list();
  }

  /** 关闭并移除一个 session */
  async closeSession(
    id: string,
    reason: Exclude<MakerSessionCloseReason, 'unexpected'> = 'requested',
  ): Promise<void> {
    const sess = this.activeSessions.get(id);
    if (sess) {
      // First closer owns the cause. A later concurrent close must not relabel
      // a user-requested close as an internal replacement (or vice versa).
      if (!this.closeReasons.has(sess)) this.closeReasons.set(sess, reason);
      await sess.close();
      // status listener 会自动清理 activeSessions 并 emit
    }
    // 已经不在内存里就 no-op —— 没有持久化的运行态需要更新。
  }

  /**
   * Maker 进程级 shutdown — app.before-quit / 信号 / 崩溃 hook 调一次。
   *
   * **强制退出语义** (与 normal logout 路径不同): agent.dispose() 和 session.close()
   * 完全并发跑, 不再串行"先 session 再 agent"。
   *
   * 之前的"Layer 1 先于 Layer 2"是为了 codex session.close 的 subscription.release
   * 看到的 host subscribers Map 还在 (语义洁癖)。但 release() 用闭包 + cur === handlers
   * 身份比较做幂等 (host.ts:427-436), 即便 host 已清空 Map 也安全。
   *
   * **关键修复 (Windows lingering process bug)**: 之前串行结构下, Codex SIGTERM 是
   * Layer 2 才发出的 — 如果 Layer 1 任何一个 session.close 卡住 (例如 Claude SDK
   * abort 没让 cli.js 子进程及时退出), lifecycle 6s 超时一到 → app.exit(0) →
   * Codex app-server 子进程在 Windows 上不会随父死 → 残留孤儿, 持有 binary 文件锁。
   * 现在并发跑, agent.dispose 不被任何 session.close 阻塞, SIGTERM 一定先被排进
   * Node event queue, 退出窗口期内可靠送达。
   *
   * 调用方:**只调一次**这个方法就够了。不需要再单独遍历 sessions。
   * 失败一律 swallow + 聚合日志, 不抛 (before-quit 阶段不能阻断退出流程)。
   */
  async shutdown(): Promise<void> {
    // snapshot 必须先做 (status listener 在 close 完成后会从 activeSessions 删条目,
    // 不 snapshot 则迭代到一半 Map mutate)。
    const sessSnapshot = Array.from(this.activeSessions.values());
    const agentEntries = Object.entries(this.agents);

    const errors: Array<{ kind: string; name: string; error: unknown }> = [];

    // **agent.dispose 优先排队**: 微任务 ordering 不是强保证 (dispose 内部还有 await
    // hostPromise 等 hop), 但先排队意味着 SIGTERM 那一步至少不会被 session-close
    // 的工作排在后面。真正的 safety net 是下面 Promise.allSettled 永不抛 + lifecycle
    // 6s 超时 (lifecycle.ts) — 即便某个 disposer hang, agent dispose 已经独立把
    // SIGTERM 送进 event loop 了, 6s 内可靠送达。
    // **同步抛防御**: 用 Promise.resolve().then 包一层, 防 dispose() 实现哪天换成
    // sync function 然后同步抛 — 那种情况下裸 .catch() 自己也炸, 后续的 sessionCloses
    // 根本来不及构造。
    const agentDisposes = agentEntries.map(([kind, agent]) =>
      Promise.resolve()
        .then(() => agent.dispose())
        .catch((e) => {
          errors.push({ kind: 'agent', name: kind, error: e });
        }),
    );

    const sessionCloses = sessSnapshot.map((s) =>
      Promise.resolve()
        .then(() => s.detach())
        .catch((e) => {
          errors.push({ kind: 'session', name: s.id, error: e });
        }),
    );

    await Promise.allSettled([...agentDisposes, ...sessionCloses]);

    if (errors.length > 0) {
      // Maker 没注入 logger; host 端 stdout 能看到 (before-quit 阶段, 不阻塞流程)
      console.error('[Maker.shutdown] some disposers failed', errors);
    }

    // 最后: maker memory db pool (synchronous close, idempotent)。
    // 放在 await 之后是因为 better-sqlite3 close() 是同步 I/O, 没必要并发;
    // 且 agent / session 不依赖 memory db, 顺序无关。
    try {
      this.makerMemory?.dispose();
    } catch (e) {
      console.error('[Maker.shutdown] makerMemory.dispose failed', e);
    }
  }

  /** 获取某 agent 的能力声明（用于 UI 在创建 session 前就能查能力） */
  getCapabilities(agentKind: AgentKind) {
    return this.requireAgent(agentKind).capabilities;
  }

  /** 列出已注册的 agent kind */
  listAvailableAgents(): AgentKind[] {
    return Object.keys(this.agents) as AgentKind[];
  }

  /**
   * Agent 内置 command (palette 'agent-builtin' 类目) —— 同步硬编码白名单。
   * 见 agents/<kind>/commands.ts。
   */
  listAgentCommands(agentKind: AgentKind): AgentBuiltinCommand[] {
    return this.requireAgent(agentKind).listAgentCommands();
  }

  /**
   * Agent 用户/项目目录扫出的 skill (palette 'agent-skill' 类目) —— 异步, 有 IO。
   */
  async listAgentSkills(
    agentKind: AgentKind,
    opts: ListAgentSkillsOptions,
  ): Promise<ListAgentSkillsResult> {
    return this.requireAgent(agentKind).listAgentSkills(opts);
  }

  /** ChatInput `@` palette entries, routed by agent kind. */
  async scanAtResources(
    agentKind: AgentKind,
    opts: ScanAtResourcesOptions,
  ): Promise<ScanAtResourcesResult> {
    return this.requireAgent(agentKind).scanAtResources(opts);
  }

  /**
   * 列出某 agent (或所有 agent) 的本地 customization (skill / command / agent / ...)。
   *
   * 调用方式:
   *  - 指定 agentKind: 单 agent, 直返该 engine 的 result
   *  - 不指定 agentKind: 并行所有已注册 agent, 单个失败不影响其他, 失败合进 errors
   *
   * 不指定时 items 会包含混合 engine 的条目, UI 自己用 item.engine 分组。
   *
   * 设计意图: 给 SkillHub 这类"想看本地全集"的外部消费者一个单一入口,
   * main 进程不再需要知道 Claude 扫 ~/.claude / Codex 走 RPC 等实现细节。
   */
  async listCustomizations(
    opts: ListCustomizationsOptions & { agentKind?: AgentKind },
  ): Promise<ListCustomizationsResult> {
    const { agentKind, ...rest } = opts;
    if (agentKind) {
      return this.requireAgent(agentKind).listCustomizations(rest);
    }
    const kinds = this.listAvailableAgents();
    const results = await Promise.allSettled(
      kinds.map((k) => this.requireAgent(k).listCustomizations(rest)),
    );
    const merged: ListCustomizationsResult = { items: [], errors: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        merged.items.push(...r.value.items);
        merged.errors.push(...r.value.errors);
      } else {
        merged.errors.push({
          message: `[${kinds[i]}] ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        });
      }
    });
    return merged;
  }

  /**
   * 一次性 LLM 调用 —— 路由到对应 agent 的 oneShot 实现。
   * 用途: 起标题 / 命名 / 总结摘要 / skillReview 等 "纯文本 → 文本" 任务,
   * 不需要 session 生命周期 / 事件流 / 持久化。
   *
   * 各 agent 默认模型 (Claude → haiku-4-5, Codex → gpt-5.4-mini), 鉴权与正常 session 同源。
   * 失败抛 OneShotError (reason: timeout/auth/network/malformed) —— 调用方按 reason
   * 决定 swallow (起标题) 还是上报 (skillReview)。
   */
  async oneShot(agentKind: AgentKind, prompt: string, opts?: OneShotOptions): Promise<string> {
    return this.requireAgent(agentKind).oneShot(prompt, opts);
  }

  /**
   * Fork SDK session — 不依赖 live session, 不查 activeSessions。
   * Claude 走 SDK jsonl 截断；Codex 走 thread/fork + 可选 thread/rollback。
   *
   * 业务编排在 host 一侧: 计算 agent 截断信息 + SQLite 事务。
   */
  async forkSdkSession(agentKind: AgentKind, opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    return this.requireAgent(agentKind).forkSdkSession(opts);
  }

  // ── Agent 鉴权 ───────────────────────────────────────────────────────────
  // 透传到 agent.deps.auth, 让 host 的 maker:auth:* IPC 不必直接拿 AuthAdapter,
  // renderer 也不需要写死任何 vendor 名 (统一 maker:auth:get-state(agentKind) 入口)。

  async getAgentAuthState(agentKind: AgentKind) {
    return this.requireAgent(agentKind).getAuthState();
  }

  async triggerAgentLogin(agentKind: AgentKind, opts?: AuthLoginOptions) {
    return this.requireAgent(agentKind).triggerLogin(opts);
  }

  async logoutAgent(agentKind: AgentKind): Promise<void> {
    return this.requireAgent(agentKind).logout();
  }

  /** 刷新指定 agent 的本机运行时模型清单；不支持或结果已过期时返回 false。 */
  async refreshAgentLocalModels(
    agentKind: AgentKind,
    options?: RefreshLocalModelsOptions,
  ): Promise<boolean> {
    return this.requireAgent(agentKind).refreshLocalModels(options);
  }

  /** Read account quota and banked reset credits through the selected agent runtime. */
  async readAgentAccountRateLimits(agentKind: AgentKind) {
    return this.requireAgent(agentKind).readAccountRateLimits();
  }

  /** Consume one banked account reset credit through the selected agent runtime. */
  async consumeAgentAccountRateLimitResetCredit(
    agentKind: AgentKind,
    params: ConsumeAccountRateLimitResetCreditParams,
  ) {
    return this.requireAgent(agentKind).consumeAccountRateLimitResetCredit(params);
  }

  /** Codex 浏览器登录中途取消; Claude 之类同步弹窗式登录调到底层 no-op。 */
  cancelAgentLogin(agentKind: AgentKind): void {
    this.requireAgent(agentKind).cancelLogin();
  }

  // ── Memory 控制 (跨 agent 统一入口) ──────────────────────────────────────
  // BaseAgent 的 getMemoryStatus / setMemory / resetMemory 是 protected? 不,
  // 是 public 抽象 (基类默认 throw NotSupported, 子类按需实现)。这里包成 public
  // wrapper 让 host (xdt-maker IPC) 通过 (agentKind) 选 agent, 跟 getAgentAuthState
  // / triggerAgentLogin 同模式 — host 不需要直接持 BaseAgent 引用。

  async getAgentMemoryStatus(agentKind: AgentKind): Promise<MemoryStatus> {
    return this.requireAgent(agentKind).getMemoryStatus();
  }

  async setAgentMemory(agentKind: AgentKind, enabled: boolean): Promise<MemorySetResult> {
    return this.requireAgent(agentKind).setMemory(enabled);
  }

  async resetAgentMemory(agentKind: AgentKind): Promise<MemoryResetResult> {
    return this.requireAgent(agentKind).resetMemory();
  }

  /**
   * Agent 联合状态查询 (binary 是否就绪 + 是否登录)。
   * 老 codex:binary:status 的功能等价物, 现在跨 agent 统一。
   *
   * binaryReady: maker-core 构造期已校验 binaryPath 非空, 这里返回 true 即可
   *              (host 真正在 splash 阶段做下载, 走到这里时 binary 必然 ready)。
   * authReady / identity: 走 deps.auth.getState()。
   */
  async getAgentStatus(agentKind: AgentKind): Promise<{
    binaryReady: boolean;
    binaryPath: string;
    authReady: boolean;
    identity?: string;
  }> {
    const agent = this.requireAgent(agentKind);
    const auth = await agent.getAuthState();
    return {
      binaryReady: !!agent.getBinaryPath(),
      binaryPath: agent.getBinaryPath(),
      authReady: auth.authenticated,
      identity: auth.identity,
    };
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────

  on(listener: MakerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: MakerEvent): void {
    this.listeners.forEach((cb) => {
      try { cb(event); } catch (e) { this.logger.error('maker event listener threw', { error: String(e) }); }
    });
  }

  protected requireAgent(kind: AgentKind): BaseAgent {
    const agent = this.agents[kind];
    if (!agent) {
      throw new Error(`Agent '${kind}' is not registered (available: ${this.listAvailableAgents().join(', ')})`);
    }
    return agent;
  }
}
