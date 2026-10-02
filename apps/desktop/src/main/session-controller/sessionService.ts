import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { BotAuthorizationInputGuard } from '../maker-ipc/botAuthorizationService.js';
import type { AgentKind, PermissionMode, ManualCompactResult } from '@cindy/maker-core';
import type { SessionCapability, SessionControllerSnapshot, SessionDiagnosis, SessionExecutionIdentity } from '@cindy/maker-shared/session-controller';
import type { SessionQueueInspectionEntry } from '../maker-ipc/sessionQueueInspection.js';
import type { createSessionControlService } from '../maker-ipc/sessionControlService.js';
type SessionControlPorts = ReturnType<typeof createSessionControlService>;
import type { SendToSessionExecutionOverrides } from '../maker-ipc/sendToSessionExecutionConfig.js';
import type { SessionManagementPorts } from './management.js';

export type SendToSessionCreateDefaults = {
  agentKind: AgentKind;
  model: string;
  providerId?: string | null;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode?: boolean;
  workingDir: string;
  workspaceKind?: 'project' | 'dialogue';
  permissionMode?: 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
};

export type SendToSessionInternalResult =
  | {
      ok: true;
      /** 目标 session 的 business id。create 分支回传新建 id;jump 分支回显入参 id。 */
      targetSessionId: string;
      agentKind: AgentKind;
      /** created = 本次新建并投递;resumed = 既有 session 被唤醒;already-active = 已在线直送;queued = 目标繁忙时进入输入队列。 */
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** jump 排队时的可寻址句柄；直发 / create 时省略。 */
      queuedMessageId?: string;
      /** create + useWorktree 成功时为新 session 的 worktree 绝对路径;其余情况 undefined。 */
      worktreePath?: string | null;
      model?: string;
      effort?: SendToSessionCreateDefaults['effort'] | null;
      fastMode?: boolean;
      providerId?: string | null;
    }
  | {
      ok: false;
      errorCode:
        | 'INVALID_ARGS'
        | 'NOT_FOUND'
        | 'ARCHIVED'
        | 'DELETED'
        | 'BUSY'
        | 'AGENT_NOT_READY'
        | 'UNSUPPORTED_CAPABILITY'
        | 'BUDGET_MODEL_REQUIRES_API_MODE'
        | 'PROVIDER_ROUTE_UNAVAILABLE'
        // create 分支专用:dispatcher 无 session 上下文时无法继承配置新建。
        | 'LEAD_NOT_SUPPORTED'
        // create + useWorktree 专用:workingDir 不是 git 仓库 / git 未装 / worktree 创建失败。
        // 显式要隔离却拿不到时硬报,不静默降级成共享工作树(调用方自行决定是否去掉参数重试)。
        | 'WORKTREE_UNAVAILABLE'
        | 'INTERNAL';
      message: string;
    };

/** Main-only dispatch options; callback capabilities never enter the wire contract. */
export interface SendToSessionParams {
    files?: AgentInputQueuedMessage['files'];
    /** Host-only resource validation, repeated inside the acceptance transaction. */
    validateResources?: () => Promise<void>;
    targetSessionId?: string;
    message: string;
    persistedContent?: string;
    clientId?: string;
    dispatcherSessionId?: string;
    title?: string;
    useWorktree?: boolean;
    /** create 分支可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
    workingDir?: string;
    /** create 分支可选:显式执行配置；未提供的字段继续继承 dispatcher。jump 忽略。 */
    execution?: SendToSessionExecutionOverrides;
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    onAcceptedCommit?: () => void | Promise<void>;
    origin?: AgentInputQueuedMessage['origin'];
    /** Host-only receipt: plugin-authored input is not user-authored permission. */
    autoReviewUserText?: { kind: 'delegated-continuation' };
    authorizationGuard?: BotAuthorizationInputGuard;
    createDefaults?: SendToSessionCreateDefaults;
    /** 安全调用方可要求新会话不比来源会话拥有更高的权限。 */
    inheritSourcePermissionMode?: boolean;
    /** Host-owned durable inputs use the coordinator even when idle. */
    forceQueue?: boolean;
}

/** Internal companion input lane; attachment/welcome handling remains in its
 * existing port. Callbacks are host capabilities and never part of MCP/IPC JSON.
 */
export interface HostSessionInput {
  targetSessionId: string;
  dispatcherSessionId?: string;
  authorizationGuard?: BotAuthorizationInputGuard;
  toolsDisabled?: boolean;
  retry?: boolean;
  onQueued?: (clientId: string) => Promise<void>;
  message: string;
  persistedContent?: string;
  clientId?: string;
  files?: AgentInputQueuedMessage['files'];
  onAccepted?: (replayed?: boolean) => void | Promise<void>;
  onAcceptedRollback?: () => void | Promise<void>;
}
export type HostSessionInputResult = SendToSessionInternalResult | {
  ok: true;
  targetSessionId: string;
  wakeKind: 'already-active' | 'queued';
  queuedMessageId?: string;
};

/** Ordinary Session operations. Caller policies stay outside the execution ports. */
export interface SessionService extends SessionManagementPorts {
  ensureRuntime(params: { sessionId: string }): Promise<SessionControllerSnapshot>;
  changePermission(params: { sessionId: string; mode: PermissionMode }): Promise<true | Record<string, never>>;
  compact(params: { sessionId: string; instructions?: string }): Promise<ManualCompactResult | null>;
  sendHostInput(input: HostSessionInput): Promise<HostSessionInputResult>;
  listActiveSessions(): Promise<SessionControllerSnapshot[]>;
  sessionCapabilities(sessionId: string): Promise<SessionCapability[]>;
  stopBackgroundTask(params: { sessionId: string; taskId: string }): Promise<{ ok: true }>;
  abortSession(params: { sessionId: string; expectedExecution?: SessionExecutionIdentity | null }): Promise<void>;
  closeSession(params: { sessionId: string; expectedExecution?: SessionExecutionIdentity | null; preserveWorkspace?: boolean }): Promise<void>;
  inspectSession(sessionId: string): Promise<SessionControllerSnapshot>;
  diagnoseSession(sessionId: string): Promise<SessionDiagnosis>;
  listSessionQueue: (
    sessionId: string,
  ) => Promise<
    | { ok: true; messages: SessionQueueInspectionEntry[] }
    | { ok: false; errorCode: 'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  listSessionQueuedCounts: (
    sessionIds: string[],
  ) => Promise<
    | { ok: true; counts: Record<string, number> }
    | { ok: false; errorCode: 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  updateSessionQueuedMessage: SessionControlPorts['updateQueuedMessage'];
  cancelSessionQueuedMessage: SessionControlPorts['cancelQueuedMessage'];
  steerSession: SessionControlPorts['steerSession'];
  stopSessionTurn: SessionControlPorts['stopSessionTurn'];
  getSessionRuntime: SessionControlPorts['getSessionRuntime'];
  setSessionRuntime: SessionControlPorts['setSessionRuntime'];
  sendToSession: (params: SendToSessionParams) => Promise<SendToSessionInternalResult>;
}

let service: SessionService | null = null;

/** Installed by the Main composition root; no runtime or record state lives here. */
export function installSessionService(value: SessionService): void { service = value; }
export function tryGetSessionService(): SessionService | null { return service; }
