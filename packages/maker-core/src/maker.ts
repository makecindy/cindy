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
import fs from 'node:fs';
import path from 'node:path';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';

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
import type { PiRuntimeCapabilityManifest } from './types/pi-runtime-capabilities.js';
import { piExplicitSkillRuntimePath } from './agents/pi/skill-runtime-provenance.js';
import { fingerprintPiProjectSkillEntrypoint } from './agents/pi/project-resource-assembly.js';
import { Session, generateSessionId } from './session.js';
import type {
  AgentSessionHandle,
  AgentSessionTeardownOptions,
  AgentSessionTeardownReason,
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
  /**
   * 可选: 视觉桥钩子（层 B）的全局默认。host 创建 Maker 时注入一次，所有
   * createSession 自动带上；单个 createSession 的 visionBridge 优先。缺省不注入 =
   * 零干扰（见 docs/vision-bridge-design.md 层 B）。
   */
  visionBridge?: import('./types/vision-bridge.js').VisionBridgeHook;
}

export interface CreateSessionOptions extends StartSessionOptions {
  agentKind: AgentKind;
  /** 可选：UI 显示用 */
  title?: string;
  /**
   * 可选：视觉桥钩子（层 B）。host 注入后，session.send 在把用户贴图交给 agent 前
   * 用视觉模型转成文字描述（见 docs/vision-bridge-design.md 层 B）。缺省不注入 = 零干扰。
   */
  visionBridge?: import('./types/vision-bridge.js').VisionBridgeHook;
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

function canonicalPiRuntimePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

// Windows realpath/stat calls can legitimately take longer than 250 ms under
// concurrent CI or endpoint scanning even for a tiny skill tree. Keep the
// entry budget as the complexity bound, but give the fail-closed fingerprint
// enough wall-clock time to preserve an unchanged launch snapshot's loaded
// status across supported platforms.
const PI_PROJECT_SKILL_PALETTE_FINGERPRINT_TIMEOUT_MS = 1_000;
const PI_PROJECT_SKILL_PALETTE_FINGERPRINT_ENTRY_BUDGET = 2_048;

async function fingerprintPiProjectSkillForPalette(
  sourcePath: string,
  canonicalRepoRoot: string,
  budget: { remainingEntries: number; deadlineAtMs: number },
): ReturnType<typeof fingerprintPiProjectSkillEntrypoint> {
  const remainingMs = budget.deadlineAtMs - Date.now();
  if (remainingMs <= 0) return null;
  let timeout: number | NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fingerprintPiProjectSkillEntrypoint(sourcePath, canonicalRepoRoot, { budget }),
      new Promise<null>((resolve) => {
        timeout = setNodeTimeout(() => resolve(null), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearNodeTimeout(timeout);
  }
}

async function mergePiRuntimeSkillStatuses(
  result: ListAgentSkillsResult,
  manifest: PiRuntimeCapabilityManifest | undefined,
): Promise<ListAgentSkillsResult> {
  // The global managed-package store can change while a task is running. An
  // active Pi task must expose only its launch-time roster, never a fresh scan
  // that makes a newly installed or renamed skill look executable mid-session.
  const currentManagedSkills = result.skills.filter((skill) => skill.runtimeStatus === 'approved');
  const nonManagedSkills = result.skills.filter((skill) => skill.runtimeStatus !== 'approved');
  const managedSnapshot = manifest?.managedPackageSkills;
  const managedSkills = managedSnapshot
    ? managedSnapshot.map((skill) => ({
        kind: 'agent-skill' as const,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        source: 'skill' as const,
        path: skill.sourcePath,
        scope: 'user' as const,
        enabled: true,
        runtimeStatus: skill.runtimeCommandName ? 'loaded' as const : 'unknown' as const,
        ...(skill.runtimeCommandName ? { runtimeCommandName: skill.runtimeCommandName } : {}),
      }))
    : currentManagedSkills.map((skill) => ({
        ...skill,
        runtimeStatus: 'unknown' as const,
        runtimeCommandName: undefined,
      }));
  const sessionResult: ListAgentSkillsResult = {
    ...result,
    skills: [...nonManagedSkills, ...managedSkills],
  };
  if (manifest?.status !== 'loaded') return sessionResult;
  const loadedExplicitSkills = new Map<string, string>();
  const loadedLegacyProjectSkills = new Map<string, string>();
  const changedProjectSkills = new Map<string, string>();
  const fingerprintBudget = {
    remainingEntries: PI_PROJECT_SKILL_PALETTE_FINGERPRINT_ENTRY_BUDGET,
    deadlineAtMs: Date.now() + PI_PROJECT_SKILL_PALETTE_FINGERPRINT_TIMEOUT_MS,
  };
  for (const skill of manifest.projectResources?.loadedSkills ?? []) {
    const canonicalSourcePath = canonicalPiRuntimePath(skill.sourcePath);
    if (!skill.snapshotDigest || !skill.sourceFingerprint || !skill.canonicalRepoRoot) {
      changedProjectSkills.set(canonicalSourcePath, skill.sourcePath);
      continue;
    }
    const currentFingerprint = await fingerprintPiProjectSkillForPalette(
      skill.sourcePath,
      skill.canonicalRepoRoot,
      fingerprintBudget,
    );
    if (
      currentFingerprint?.contentDigest !== skill.snapshotDigest
      || currentFingerprint.sourceStateDigest !== skill.sourceFingerprint
    ) {
      changedProjectSkills.set(canonicalSourcePath, skill.sourcePath);
      continue;
    }
    loadedExplicitSkills.set(canonicalSourcePath, skill.commandName);
  }
  for (const command of manifest.commands) {
    const baseDir = command.sourceInfo.baseDir;
    if (command.source !== 'skill' || !command.name.startsWith('skill:')) continue;
    const skillName = command.name.slice('skill:'.length);
    if (command.sourceInfo.scope === 'project' && typeof baseDir === 'string') {
      loadedLegacyProjectSkills.set(
        [skillName, canonicalPiRuntimePath(baseDir)].join('\0'),
        command.name,
      );
      continue;
    }
    // Pinned Pi reports explicit --skill with a paired baseDir + SKILL.md path.
    // The shared helper rejects partial/mismatched provenance before a
    // user/global collision can mark a project scanner result loaded. Match
    // explicit resources by path because frontmatter names need not equal
    // their containing folder names.
    const explicitPath = piExplicitSkillRuntimePath(command);
    if (explicitPath) {
      loadedExplicitSkills.set(canonicalPiRuntimePath(explicitPath), command.name);
    }
  }
  if (
    loadedExplicitSkills.size === 0
    && loadedLegacyProjectSkills.size === 0
    && changedProjectSkills.size === 0
  ) return sessionResult;
  const changedSkillErrors = [...changedProjectSkills.values()].map((skillPath) => ({
    path: skillPath,
    message: 'Project skill changed after this Pi session started; restart the session to load the current version.',
  }));
  return {
    ...sessionResult,
    skills: sessionResult.skills.map((skill) => {
      let runtimeCommandName: string | undefined;
      if (skill.scope === 'repo' && skill.path) {
        const canonicalSkillPath = canonicalPiRuntimePath(skill.path);
        if (!changedProjectSkills.has(canonicalSkillPath)) {
          runtimeCommandName = loadedExplicitSkills.get(canonicalSkillPath)
            ?? [skill.path, path.dirname(path.dirname(skill.path))]
              .map(canonicalPiRuntimePath)
              .map((skillPath) => loadedLegacyProjectSkills.get([skill.name, skillPath].join('\0')))
              .find((commandName) => commandName !== undefined);
        }
      }
      return runtimeCommandName
        ? { ...skill, runtimeStatus: 'loaded' as const, runtimeCommandName }
        : skill;
    }),
    ...(changedSkillErrors.length > 0
      ? { errors: [...(sessionResult.errors ?? []), ...changedSkillErrors] }
      : {}),
  };
}

function isClaimableCodexThreadId(id: string | undefined): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    !id.startsWith('<') &&
    /^[0-9a-fA-F-]+$/.test(id)
  );
}

function codexThreadClaimKey(remoteHostId: string | undefined, threadId: string): string {
  return JSON.stringify([remoteHostId ?? null, threadId]);
}

interface CodexThreadClaimOwner {
  token: symbol;
  sessionId: string;
  sessionInstanceId: string;
}

interface CodexThreadClaimLease {
  moveTo(threadId: string): void;
  release(): void;
}

/**
 * What `Maker.shutdown` could not tear down.
 *
 * Additive and, until now, unobservable: shutdown collected per-session detach
 * failures, logged them, and resolved anyway. A caller that hands the runtime to
 * a different owner afterwards needs to know, because a PI session whose detach
 * threw may still have a live process — and that process owns durable Subagent
 * children holding BYOM credentials the outgoing account cannot revoke.
 */
export interface MakerShutdownReport {
  sessionFailures: Array<{ sessionId: string; agentKind: AgentKind; error: unknown }>;
}

interface FailedHandleCleanup {
  handle: AgentSessionHandle;
  promise: Promise<void> | null;
  onCleaned?: () => void;
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
  /** All create paths, including anonymous ids, that may still publish or quarantine a handle. */
  private readonly pendingSessionCreations = new Set<Promise<Session>>();
  /** Once shutdown starts, no new handle may race past its creation barrier. */
  private shutdownStarted = false;
  /**
   * startSession 已返回、但 Session 尚未发布时 cleanup 失败的 handle。后续同 id
   * create 必须先把它确认关闭，不能丢失所有权后再 spawn 一个并存进程。
   */
  private readonly failedHandleCleanups = new Map<string, FailedHandleCleanup>();
  /**
   * Codex 0.145 会忽略已加载 thread 的 thread/resume.config。不同 Cindy task
   * 若同时复用同一 native thread，后启动者会继续使用前一 Session 的 MCP URL，
   * 使实例绑定失配并破坏通知路由。按 target(local / remote host)+thread 独占；
   * claim 由启动前持有到 Session 真正 close，禁止覆盖或抢占。
   */
  private readonly activeCodexThreadClaims = new Map<string, CodexThreadClaimOwner>();
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
  /** 视觉桥钩子（层 B）全局默认（可选）。见 MakerDeps.visionBridge。 */
  protected readonly visionBridge: import('./types/vision-bridge.js').VisionBridgeHook | undefined;

  constructor(deps: MakerDeps) {
    this.agents = deps.agents;
    this.storage = deps.storage;
    this.visionBridge = deps.visionBridge;
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

  private claimCodexThread(params: {
    sessionId: string;
    sessionInstanceId: string;
    remoteHostId?: string;
    threadId: string;
  }): CodexThreadClaimLease {
    const owner: CodexThreadClaimOwner = {
      token: Symbol('codex-thread-claim'),
      sessionId: params.sessionId,
      sessionInstanceId: params.sessionInstanceId,
    };
    let currentKey: string | null = null;
    let released = false;

    const moveTo = (threadId: string): void => {
      if (released) throw new Error('Codex thread claim was already released');
      const nextKey = codexThreadClaimKey(params.remoteHostId, threadId);
      if (nextKey === currentKey) return;
      const existing = this.activeCodexThreadClaims.get(nextKey);
      if (existing && existing.token !== owner.token) {
        throw new Error(
          `Codex thread ${threadId} is already active in another Cindy task. Close that task and try again.`,
        );
      }
      this.activeCodexThreadClaims.set(nextKey, owner);
      const previousKey = currentKey;
      currentKey = nextKey;
      if (
        previousKey &&
        previousKey !== nextKey &&
        this.activeCodexThreadClaims.get(previousKey)?.token === owner.token
      ) {
        this.activeCodexThreadClaims.delete(previousKey);
      }
    };

    moveTo(params.threadId);
    return {
      moveTo,
      release: () => {
        if (released) return;
        released = true;
        if (
          currentKey &&
          this.activeCodexThreadClaims.get(currentKey)?.token === owner.token
        ) {
          this.activeCodexThreadClaims.delete(currentKey);
        }
        currentKey = null;
      },
    };
  }

  private async retryFailedHandleCleanup(
    sessionId: string,
    expectedEntry?: FailedHandleCleanup,
  ): Promise<void> {
    const entry = this.failedHandleCleanups.get(sessionId);
    if (!entry || (expectedEntry && entry !== expectedEntry)) return;
    // Startup-failure rollback, not an ownership change.
    const cleanup = entry.promise ?? entry.handle.close({ reason: 'navigation' });
    entry.promise = cleanup;
    try {
      await cleanup;
    } catch (error) {
      if (this.failedHandleCleanups.get(sessionId) === entry && entry.promise === cleanup) {
        entry.promise = null;
      }
      throw error;
    }
    if (this.failedHandleCleanups.get(sessionId) === entry) {
      this.failedHandleCleanups.delete(sessionId);
      entry.onCleaned?.();
    }
  }

  /**
   * 创建一个新会话。
   *
   * 幂等性: 若 opts.id 已在 storage 命中, 跳过 storage.create 改用现有 meta;
   * 同 id 已有 active Session 或正在创建时直接复用 —— 适配"用户切回老 session
   * 继续聊"以及多个后台入口同时恢复同一会话的场景。
   */
  async createSession(opts: CreateSessionOptions): Promise<Session> {
    if (this.shutdownStarted) {
      throw new Error('Maker is shutting down; refusing to create a new session');
    }
    const creation = this.createSessionWhileRunning(opts);
    this.pendingSessionCreations.add(creation);
    try {
      return await creation;
    } finally {
      this.pendingSessionCreations.delete(creation);
    }
  }

  private async createSessionWhileRunning(opts: CreateSessionOptions): Promise<Session> {
    if (!opts.id) {
      return this.createSessionOnce(opts);
    }

    // Any handle that failed cleanup before publication still owns this
    // business id. Confirm its shutdown before checking/starting live state.
    if (this.failedHandleCleanups.has(opts.id)) {
      await this.retryFailedHandleCleanup(opts.id);
    }

    // 进程内已经活着或正在启动的 session, 直接复用 (避免 spawn 第二个 SDK)。
    // close() 失败的 Session 不能继续收消息，但也不能立刻从 activeSessions
    // 摘掉并与可能仍存活的底层 transport 并存。先重试同一个 close；只有真实
    // 关闭成功、status listener 将其移除后，才允许创建新的 handle。
    const existing = this.activeSessions.get(opts.id);
    if (existing?.getStatus() === 'error') {
      await existing.close();
    }
    const reusable = this.activeSessions.get(opts.id);
    if (reusable) return reusable;

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
    // business id 在 close/rebuild 后会复用；另铸一个只活在本次内存实例里的
    // 代号，让迟到的旧 MCP 请求不能借用新 Session 的权限状态。
    const sessionInstanceId = generateSessionId();
    let codexThreadClaim =
      opts.agentKind === 'codex' && isClaimableCodexThreadId(startOpts.resumeSessionId)
        ? this.claimCodexThread({
            sessionId: id,
            sessionInstanceId,
            remoteHostId: startOpts.remoteHostId,
            threadId: startOpts.resumeSessionId,
          })
        : null;
    let handle: AgentSessionHandle;
    try {
      handle = await agent.startSession({
        ...startOpts,
        sessionId: id,
        sessionInstanceId,
        // 强制由 Maker 注入持久化 CAS，不能信任外部 CreateSessionOptions 自带回调。
        // Claude adapter 只在精确识别 invalid-resume 时调用；Codex 不消费该字段。
        // 对所有 claude-code 会话装配(不止 resume):全新会话也可能在首个 turn 崩溃前
        // 就把 SDK 回填、已落库的 sdk_session_id 变成幽灵 id(见 claude-code/index.ts
        // 的 fresh-session self-reference 恢复),需要同一把 CAS 才能把它清掉,否则下一次
        // send 会 resume 同一个不存在的会话反复失败。
        onInvalidResumeSession:
          opts.agentKind === 'claude-code' || opts.agentKind === 'pi'
            ? (expectedSdkSessionId) =>
                this.invalidateAndClearSdkSessionId(id, expectedSdkSessionId)
            : undefined,
      });
    } catch (error) {
      codexThreadClaim?.release();
      throw error;
    }
    if (opts.agentKind === 'codex' && isClaimableCodexThreadId(handle.id)) {
      try {
        if (codexThreadClaim) {
          codexThreadClaim.moveTo(handle.id);
        } else {
          codexThreadClaim = this.claimCodexThread({
            sessionId: id,
            sessionInstanceId,
            remoteHostId: startOpts.remoteHostId,
            threadId: handle.id,
          });
        }
      } catch (error) {
        try {
          await handle.close({ reason: 'navigation' });
        } catch (closeError) {
          this.logger.warn('failed to close Codex handle after thread claim conflict', {
            sessionId: id,
            error: String(closeError),
          });
        }
        codexThreadClaim?.release();
        throw error;
      }
    }
    this.logger.debug('createSession ↑ agent.startSession returned', {
      localSessionId: id,
      sdkSessionId: handle.id,
      elapsedMs: Date.now() - startedAt,
    });

    // 落地元数据 —— storage 已有同 id 的 row 时跳过 insert, 走 update 把 sdkSessionId 写回
    let meta: SessionMeta;
    try {
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
          reviewMode: opts.reviewMode,
          parentSessionId: opts.parentSessionId,
          // remoteHostId: 远端 session 把目标机器持久化, 之后 resume / list 都能识别。
          // 本地 session 留 undefined (sqlite 落空), 跟历史行为兼容。
          remoteHostId: opts.remoteHostId,
          sdkSessionId: handle.id !== '<pending>' ? handle.id : undefined,
        });
      }
    } catch (error) {
      // 轮 40-w4-t5 CRITICAL:agent-agnostic 回滚 —— startSession 成功后 storage
      // 写失败时, 已启动的 agent handle(PI 远端 daemon session / CC / Codex)必须
      // close, 否则 PI 无 codexThreadClaim 时 handle 不关, 远端 pi-manager session/
      // MCP bridge 残留成「用户看不到、Maker 管不到」的半创建状态。
      let cleanupFailed = false;
      try {
        await handle.close({ reason: 'navigation' });
      } catch (closeError) {
        cleanupFailed = true;
        this.failedHandleCleanups.set(id, {
          handle,
          promise: null,
          ...(codexThreadClaim
            ? { onCleaned: () => codexThreadClaim?.release() }
            : {}),
        });
        this.logger.warn('failed to close agent handle after session storage failure', {
          sessionId: id,
          error: String(closeError),
        });
      }
      if (!cleanupFailed && codexThreadClaim) {
        codexThreadClaim.release();
      }
      throw error;
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
      sessionInstanceId,
      agentKind: meta.agentKind,
      workDir: meta.workDir,
      handle,
      capabilities: capabilitiesForSession(meta.agentKind, agent.capabilities, meta.remoteHostId),
      logger: this.logger,
      permissionMode: startOpts.permissionMode,
      // 透传 remoteHostId 让 host 层在 hot path 上能 O(1) 判 local/remote
      // (不用每次 send 回 DB 读 SessionMeta — register.ts checkWorkDirExists 走这条)。
      remoteHostId: meta.remoteHostId ?? null,
      // 层 B：视觉桥钩子（per-session 优先，否则全局默认；缺省不传 = 零干扰）。
      visionBridge: startOpts.visionBridge ?? this.visionBridge,
    });

    // 当 SDK 回填 sdkSessionId 时持久化
    session.onEvent((evt) => {
      if (evt.type === 'session_id' && typeof evt.data === 'string' && evt.data) {
        if (opts.agentKind === 'codex' && isClaimableCodexThreadId(evt.data)) {
          try {
            if (codexThreadClaim) {
              codexThreadClaim.moveTo(evt.data);
            } else {
              codexThreadClaim = this.claimCodexThread({
                sessionId: id,
                sessionInstanceId,
                remoteHostId: startOpts.remoteHostId,
                threadId: evt.data,
              });
            }
          } catch (error) {
            this.logger.error('Codex thread claim move failed; closing conflicting session', {
              sessionId: id,
              sdkSessionId: evt.data,
              error: String(error),
            });
            void session.close();
            return;
          }
        }
        void this.persistSdkSessionId(meta.id, evt.data).catch((e) => {
          this.logger.warn('failed to persist sdkSessionId', { error: String(e) });
        });
      }
    });

    session.onStatusChange((status) => {
      if (status === 'closed') {
        codexThreadClaim?.release();
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

  /** Read a live session's per-runtime Pi capability snapshot without creating or resuming it. */
  getSessionRuntimeCapabilities(id: string): PiRuntimeCapabilityManifest | undefined {
    return this.activeSessions.get(id)?.getRuntimeCapabilities();
  }

  /** Subscribe to a live session's per-runtime Pi catalog without sharing state across sessions. */
  onSessionRuntimeCapabilitiesChange(
    id: string,
    listener: (manifest: PiRuntimeCapabilityManifest | undefined) => void,
  ): () => void {
    return this.activeSessions.get(id)?.onRuntimeCapabilitiesChange(listener) ?? (() => undefined);
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
   * Return the close cause for the exact runtime Session instance.
   *
   * A missing explicit cause means the vendor/Session closed itself. Keep this
   * keyed by instance rather than business session id: a replacement can be
   * created before a late close notification from the old instance arrives.
   */
  getSessionCloseReason(session: Session): MakerSessionCloseReason {
    return this.closeReasons.get(session) ?? 'unexpected';
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
  async shutdown(opts?: { reason?: AgentSessionTeardownReason }): Promise<MakerShutdownReport> {
    this.shutdownStarted = true;
    // Fail closed: a caller that cannot name its boundary is treated as an
    // account boundary, so adapters with detached, credential-holding children
    // (Pi durable Subagents) always stop them rather than letting them run on
    // into the next owner. The two real callers name themselves explicitly
    // (`app-quit` from before-quit, `account-boundary` from logout/switch).
    const teardown: AgentSessionTeardownOptions = { reason: opts?.reason ?? 'account-boundary' };
    const agentEntries = Object.entries(this.agents);
    const errors: Array<{ kind: string; name: string; error: unknown }> = [];
    const sessionFailures: MakerShutdownReport['sessionFailures'] = [];

    // Snapshot current sessions before the creation barrier. Existing local
    // Claude/PI processes must start terminating immediately; a stuck startup
    // must not consume the entire host quit window before their detach begins.
    const initialSessionSnapshot = Array.from(this.activeSessions.values());
    const initialSessionIdentities = new Set(initialSessionSnapshot);
    const queueSessionDetaches = (
      sessions: readonly Session[],
      phase: 'initial' | 'late',
    ): Array<Promise<void>> => {
      for (const session of sessions) {
        if (!this.closeReasons.has(session)) this.closeReasons.set(session, 'requested');
      }
      return sessions.map((session) =>
        Promise.resolve()
          .then(() => session.detach(teardown))
          .catch((e) => {
            errors.push({ kind: `session-${phase}`, name: session.id, error: e });
            // Reported, not just logged: a detach that threw may have left the
            // agent's process alive, which the caller has to weigh before
            // handing the runtime to someone else.
            sessionFailures.push({ sessionId: session.id, agentKind: session.agentKind, error: e });
          }),
      );
    };

    // Queue agent-level process shutdown and the initial Session snapshot
    // before waiting for session creation. PiAgent.dispose() owns its startup
    // barrier; Session detach owns already-published local agent processes.
    const initialAgentDisposes = agentEntries.map(([kind, agent]) =>
      Promise.resolve()
        .then(() => agent.dispose())
        .catch((e) => {
          errors.push({ kind: 'agent', name: kind, error: e });
        }),
    );
    const initialSessionDetaches = queueSessionDetaches(initialSessionSnapshot, 'initial');

    // createSession registers its promise before yielding. Blocking new calls
    // above makes this a stable barrier: after it settles, every handle started
    // before shutdown is active, closed, or present in failedHandleCleanups.
    const creationSnapshot = Array.from(this.pendingSessionCreations);
    await Promise.allSettled(creationSnapshot);

    const finalAgentDisposes = agentEntries.map(([kind, agent], index) =>
      initialAgentDisposes[index]!
        .then(() => agent.dispose())
        .catch((e) => {
          errors.push({ kind: 'agent-final', name: kind, error: e });
        }),
    );

    // Only sessions published while the creation barrier was settling belong
    // to the late pass. Identity filtering avoids detaching an initial Session
    // twice when it remains in activeSessions until its first detach settles.
    const lateSessionSnapshot = Array.from(this.activeSessions.values())
      .filter((session) => !initialSessionIdentities.has(session));
    const lateSessionDetaches = queueSessionDetaches(lateSessionSnapshot, 'late');
    const failedHandleCleanupSnapshot = Array.from(this.failedHandleCleanups.entries());

    const failedHandleCloses = failedHandleCleanupSnapshot.map(([sessionId, entry]) =>
      Promise.resolve()
        .then(() => this.retryFailedHandleCleanup(sessionId, entry))
        .catch((e) => {
          errors.push({ kind: 'unpublished-handle', name: sessionId, error: e });
        }),
    );

    await Promise.allSettled([
      ...initialSessionDetaches,
      ...finalAgentDisposes,
      ...failedHandleCloses,
      ...lateSessionDetaches,
    ]);

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
    return { sessionFailures };
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
   * Register an optional agent after Maker construction.
   *
   * Hosts may provision optional runtimes asynchronously (for example after a
   * transient network failure during startup). Registration is intentionally
   * additive and idempotent so existing sessions and agent instances remain
   * untouched.
   */
  registerAgent(kind: AgentKind, agent: BaseAgent): boolean {
    if (this.shutdownStarted) return false;
    if (this.agents[kind]) return false;
    this.agents[kind] = agent;
    return true;
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
    opts: ListAgentSkillsOptions & { sessionId?: string },
  ): Promise<ListAgentSkillsResult> {
    const { sessionId, ...agentOpts } = opts;
    const sessionMeta = sessionId ? await this.storage.get(sessionId) : null;
    const includeManagedPiPackages = agentKind === 'pi'
      && (!sessionId || (
        sessionMeta?.agentKind === 'pi'
        && sessionMeta.reviewMode !== true
        && !sessionMeta.remoteHostId
      ));
    const result = await this.requireAgent(agentKind).listAgentSkills({
      ...agentOpts,
      includeManagedPiPackages,
    });
    if (agentKind !== 'pi' || !sessionId) return result;
    const session = this.getSession(sessionId);
    if (
      session?.agentKind !== 'pi'
      || !opts.workingDir
      || canonicalPiRuntimePath(opts.workingDir) !== canonicalPiRuntimePath(session.workDir)
    ) {
      return result;
    }
    return mergePiRuntimeSkillStatuses(result, session.getRuntimeCapabilities());
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
   * binaryReady: 已注册 agent 由其 binaryPath 判定；平台不支持或 provision 尚未完成的
   *              optional runtime 不注册 agent，并在这里明确返回 false。
   * authReady / identity: 走 deps.auth.getState()。
   */
  async getAgentStatus(agentKind: AgentKind): Promise<{
    binaryReady: boolean;
    binaryPath: string | null;
    authReady: boolean;
    identity?: string;
  }> {
    const agent = this.agents[agentKind];
    // Optional runtimes (currently Pi on unsupported/unprepared platforms) are
    // intentionally not registered. Status is the one discovery API that must
    // represent that state instead of throwing and hiding it as an auth error.
    if (!agent) {
      return { binaryReady: false, binaryPath: null, authReady: false };
    }
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
