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
import type { Capabilities } from './types/capabilities.js';
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

export type SessionEventListener = (event: AgentEvent) => void;
export type SessionStatusListener = (status: SessionStatus) => void;
export type InteractionRequestListener = (req: InteractionRequest) => Promise<InteractionDecision>;

export interface SessionOptions {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  handle: AgentSessionHandle;
  capabilities: Capabilities;
  logger: Logger;
  /**
   * 远端 SSH 主机的 alias (来自 `@cindy/maker-remote-ssh` ConnectionPool)。
   * 非空 → 这个 session 实际跑在远端机器上, workDir 是远端机器上的路径。
   * 主进程的 send 路径用它判断 "local fs guard 应不应该跑" — 远端 workdir
   * 是不可能存在于本地 fs 的, 没必要也不该 stat。
   */
  remoteHostId?: string | null;
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
   * 产品层 accepted hook。
   * Session 在 active/running 守卫通过、turn reservation 建立后调用；
   * hook 完成后才启动 vendor handle。
   */
  onAccepted?: () => void | Promise<void>;
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
  readonly agentKind: AgentKind;
  readonly workDir: string;
  readonly capabilities: Capabilities;
  /** 见 SessionOptions.remoteHostId。 */
  readonly remoteHostId: string | null;

  private readonly handle: AgentSessionHandle;
  private readonly logger: Logger;
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly statusListeners = new Set<SessionStatusListener>();
  private interactionListener: InteractionRequestListener | null = null;
  private status: SessionStatus = 'active';
  /**
   * 同一 Session 的并发 close 共享一次底层关闭过程。renderer 与 main 生命周期钩子可能
   * 同时请求关闭；所有调用方都必须等到 transport / 子进程真正释放后才能继续回收 worktree。
   */
  private closePromise: Promise<void> | null = null;
  private eventLoopStarted = false;
  private sendReservation: SendReservation | null = null;
  /**
   * 当前进行中 turn 的发起来源(来自 send 的 opts.origin)。事件 fan-out 前打到
   * AgentEvent.turnOrigin 上,turn 终止(isTerminalTurnEvent)后清空 — 共享
   * session(心跳 + 远程控制)下区分 per-turn 归属。null = 未标记来源(默认)。
   */
  private currentTurnOrigin: SendOrigin | null = null;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.agentKind = opts.agentKind;
    this.workDir = opts.workDir;
    this.handle = opts.handle;
    this.capabilities = opts.capabilities;
    this.remoteHostId = opts.remoteHostId ?? null;
    this.logger = opts.logger.child(`s:${this.id}`);

    // 注入 InteractionResolver 到底层 handle, 转发到 host 维护的 listener。
    // 没接 listener 时按 kind 给出安全默认: 都视作 deny(host 必须接 listener 才能交互)。
    this.handle.setInteractionResolver(async (req) => {
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
      return this.interactionListener(req);
    });
  }

  // ── 公开 API ─────────────────────────────────────────────────────────────

  async send(message: UserMessage | string, opts?: SessionSendOptions): Promise<SessionSendResult> {
    const msg: UserMessage = typeof message === 'string'
      ? { type: 'user', content: message }
      : message;
    const { onAccepted, ...handleOpts } = opts ?? {};
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
    const cleanupExternalAbort = this.attachExternalCancellation(reservation, handleOpts.signal);
    // originInstalled:已越过 dispatch 边界、把本次 origin 装进 currentTurnOrigin。
    // turnDispatched:handle.send 成功、本次 send 真正成为运行中的 turn。
    let originInstalled = false;
    let turnDispatched = false;
    let previousTurnOrigin: SendOrigin | null = null;
    try {
      await onAccepted?.();
      this.ensureActive();
      if (reservation.cancelled || this.sendReservation !== reservation) {
        if (this.sendReservation === reservation) {
          this.sendReservation = null;
        }
        return { accepted: false, reason: 'cancelled-before-dispatch' };
      }
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
    this.closePromise = this.performClose();
    return this.closePromise.then(() => true);
  }

  private async performClose(): Promise<void> {
    try {
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

  // ── 运行时切换 ─────────────────────────────────────────────────────────────

  async setModel(model: string): Promise<void> {
    if (!this.capabilities.switchModel.supported) {
      throw new NotSupportedError('switchModel', this.capabilities.switchModel);
    }
    if (!this.handle.setModel) {
      throw new NotSupportedError('switchModel', { supported: false, reason: 'not-implemented' });
    }
    await this.handle.setModel(model);
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
    await this.handle.setPermissionMode(mode);
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
   * 运行时覆盖 extraDirs (附加只读引用目录)。Claude 即时生效, Codex capability=false。
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
    return this.sendReservation !== null || this.isHandleTurnRunning();
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

  private async runEventLoop(): Promise<void> {
    try {
      for await (const event of this.handle.events()) {
        this.releaseSendReservationIfObserved();
        // fan-out 前打 turn origin(所有 listener 拿到同一份);事件对象由
        // translator 每次新建,不会串台。=== undefined 守卫:不覆盖 agent 自带的。
        if (this.currentTurnOrigin && event.turnOrigin === undefined) {
          event.turnOrigin = this.currentTurnOrigin;
        }
        const listenerEvent = redactEventForListeners(event);
        for (const listener of this.eventListeners) {
          try { listener(listenerEvent); } catch (e) { this.logger.error('event listener threw', { error: String(e) }); }
        }
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
        if (event.type === 'done' || isTerminalAgentErrorEvent(event)) {
          this.currentTurnOrigin = null;
        }
      }
    } catch (e) {
      this.logger.error('event loop crashed', { error: String(e) });
      this.sendReservation = null;
      this.currentTurnOrigin = null;
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
