import { redactEventForRenderer } from '../sessionEventRedaction.js';
import type { AgentEvent, InteractionRequest } from '@cindy/maker-core';
import type { DbLogger } from '@cindy/runtime-db/logging';
import { isProductTurnCompletionTailEvent } from '@cindy/maker-shared/turn-continuation';
import { extractAgentIslandPromptText } from '@cindy/im-runtime/agentHandoff';
import type { AgentInputCoordinator } from '../agent-input-coordinator.js';
import type { AutoResumeBookkeeping, SuppressedTurnError } from '../autoResumeBookkeeping.js';
import { isTerminalTurnErrorEvent } from '../sessionTurnActivityTracker.js';
import { shouldNotifyAgentIslandForSession as shouldNotifyAgentIslandForSessionByPolicy, shouldClearAgentIslandSessionForOrcaWorker } from './notificationPolicy.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from './displayConfig.js';
import type { AgentIslandService } from './service.js';
export interface ActivitySession { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown; remoteHostId?: unknown }
export function createSessionActivityBridge(host: {
  log: DbLogger;
  getAgentIslandService(): AgentIslandService | null | undefined;
  getCoordinator(): Pick<AgentInputCoordinator, 'isAutoResumePending' | 'isAutoResumeDeferred' | 'getProviderGroupSwitchHoldId'> | null | undefined;
  getBookkeeping(): Pick<AutoResumeBookkeeping, 'shouldSuppressAgentIslandError' | 'shouldSuppressAgentIslandCompletionTail'>;
  getSession(id: string): ActivitySession | null | undefined;
  isSessionHiddenSync(id: string): boolean;
  isKnownOrcaWorkerSession(id: string): boolean;
  isRemoteAuthRetryErrorEvent(session: ActivitySession, event: AgentEvent): boolean;
  isGatewayProxyTokenRecoveryErrorEvent(id: string, event: AgentEvent): boolean;
}) {
const { log, getAgentIslandService, isSessionHiddenSync, isKnownOrcaWorkerSession,
  isRemoteAuthRetryErrorEvent, isGatewayProxyTokenRecoveryErrorEvent } = host;
function sessionMetaForIsland(session: {
  id: string;
  agentKind?: unknown;
  workDir?: unknown;
  workspaceKind?: unknown;
}): {
  sessionId: string;
  agentKind?: string;
  workingDir?: string | null;
  workspaceKind?: string | null;
} {
  return {
    sessionId: session.id,
    agentKind: typeof session.agentKind === 'string' ? session.agentKind : undefined,
    workingDir: typeof session.workDir === 'string' ? session.workDir : null,
    workspaceKind: typeof session.workspaceKind === 'string' ? session.workspaceKind : null,
  };
}

function handleAgentIslandEventAfterBroadcast(
  session: {
    id: string;
    agentKind?: unknown;
    workDir?: unknown;
    workspaceKind?: unknown;
    remoteHostId?: unknown;
  },
  event: AgentEvent,
): void {
  if (!shouldNotifyAgentIslandForSession(session.id)) return;
  try {
    const service = getAgentIslandService();
    if (!service) return;
    const meta = sessionMetaForIsland(session);
    if (
      isRemoteAuthRetryErrorEvent(session, event) ||
      isGatewayProxyTokenRecoveryErrorEvent(session.id, event)
    ) {
      service.deferRemoteAuthRetryError(meta, event);
      return;
    }
    const terminalError = event.type === 'error' && isTerminalTurnErrorEvent(event);
    // 供应商组正在为这次失败换电脑：与中断自愈同样先不提醒，没换成时由 providerGroupHeldErrors 补上。
    const autoResumePendingOrDeferred =
      host.getCoordinator()?.isAutoResumePending(session.id) === true ||
      host.getCoordinator()?.isAutoResumeDeferred(session.id) === true ||
      (host.getCoordinator()?.getProviderGroupSwitchHoldId(session.id) ?? null) !== null;
    const autoResumeOwnsError =
      autoResumePendingOrDeferred ||
      host.getBookkeeping().shouldSuppressAgentIslandError(session.id);
    const autoResumeOwnsCompletionTail =
      autoResumePendingOrDeferred ||
      host.getBookkeeping().shouldSuppressAgentIslandCompletionTail(session.id);
    if (
      (terminalError && autoResumeOwnsError) ||
      (isAgentIslandCompletionTail(event) && autoResumeOwnsCompletionTail)
    ) {
      return;
    }
    service.handleAgentEvent(meta, event);
  } catch (error) {
    log.warn('Agent Island event update failed after maker event broadcast', {
      sessionId: session.id,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isAgentIslandCompletionTail(event: AgentEvent): boolean {
  return isProductTurnCompletionTailEvent(event);
}

function surfaceSuppressedAutoResumeErrorInAgentIsland(
  sessionId: string,
  detail: SuppressedTurnError,
): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    const service = getAgentIslandService();
    if (!service) return;
    const wired = host.getSession(sessionId);
    const meta = wired ? sessionMetaForIsland(wired) : { sessionId };
    service.handleAgentEvent(
      meta,
      redactEventForRenderer({ type: 'error', data: { ...detail, isTerminal: true } }),
    );
  } catch (error) {
    log.warn('Agent Island suppressed auto-resume error restore failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandInteractionAfterBroadcast(
  session: { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
  request: InteractionRequest,
  interactionEpoch: number | null,
): void {
  if (interactionEpoch === null || !shouldNotifyAgentIslandForSession(session.id)) return;
  try {
    getAgentIslandService()?.handleInteractionRequest(
      sessionMetaForIsland(session),
      request,
      interactionEpoch,
    );
  } catch (error) {
    log.warn('Agent Island interaction update failed after maker interaction broadcast', {
      sessionId: session.id,
      requestId: request.requestId,
      kind: request.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandInteractionDismissed(sessionId: string, requestId: string): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleInteractionDismissed(sessionId, requestId);
  } catch (error) {
    log.warn('Agent Island interaction dismiss update failed during mandatory cleanup', {
      sessionId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandInteractionDismissedByRequestId(requestId: string): void {
  try {
    getAgentIslandService()?.handleInteractionDismissedByRequestId(requestId);
  } catch (error) {
    log.warn('Agent Island interaction dismiss update failed by request id', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandSessionClosedAfterCleanup(
  sessionId: string,
  reason: 'discarded' | 'process-closed' = 'discarded',
): void {
  try {
    getAgentIslandService()?.handleSessionClosed(sessionId, { reason });
  } catch (error) {
    log.warn('Agent Island session close cleanup failed after mandatory session cleanup', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandSessionStopped(
  session: string | { id: string; getCurrentTurnId?: () => string | null },
): void {
  const sessionId = typeof session === 'string' ? session : session.id;
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleSessionStopped(
      sessionId,
      typeof session === 'string' ? null : (session.getCurrentTurnId?.() ?? null),
    );
  } catch (error) {
    log.warn('Agent Island session stop update failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldNotifyAgentIslandForSession(sessionId: string): boolean {
  // 插件后台隐藏任务不在灵动岛/菜单栏展示运行中，也不提醒(显示到任务列表后恢复)。
  if (isSessionHiddenSync(sessionId)) return false;
  return shouldNotifyAgentIslandForSessionByPolicy(
    AGENT_ISLAND_DISPLAY_CONFIG,
    isKnownOrcaWorkerSession(sessionId),
  );
}

function clearSuppressedOrcaWorkerAgentIslandSession(sessionId: string): void {
  if (!shouldClearAgentIslandSessionForOrcaWorker(AGENT_ISLAND_DISPLAY_CONFIG)) return;
  handleAgentIslandSessionClosedAfterCleanup(sessionId);
}

function notifyAgentIslandUserPrompt(
  session: { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
  content: unknown,
  options: { source: string; clientId?: string; replacesCurrentTurn?: boolean } = {
    source: 'unknown',
  },
): boolean {
  if (!shouldNotifyAgentIslandForSession(session.id)) return false;
  const prompt = extractAgentIslandPromptText(content);
  if (!prompt) return false;
  try {
    const service = getAgentIslandService();
    if (!service) return false;
    return service.handleUserPrompt(sessionMetaForIsland(session), prompt, {
      source: options.source,
      clientId: options.clientId,
      notifiedAt: Date.now(),
      replacesCurrentTurn: options.replacesCurrentTurn,
    });
  } catch (error) {
    log.warn('Agent Island prompt preview update failed after user message persistence', {
      sessionId: session.id,
      source: options.source,
      clientId: options.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function dispatchAgentIslandUserPrompt(sessionId: string): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleUserPromptDispatching(sessionId);
  } catch (error) {
    log.warn('Agent Island prompt dispatch boundary update failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function commitAgentIslandUserPrompt(sessionId: string, clientId: string | undefined): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.commitUserPrompt(sessionId, clientId);
  } catch (error) {
    log.warn('Agent Island prompt preview commit failed', {
      sessionId,
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function rollbackAgentIslandUserPrompt(
  sessionId: string,
  clientId: string | undefined,
  source: string,
): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.rollbackUserPrompt(sessionId, clientId);
  } catch (error) {
    log.warn('Agent Island prompt preview rollback failed', {
      sessionId,
      clientId,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}


return { sessionMetaForIsland, handleAgentIslandEventAfterBroadcast, isAgentIslandCompletionTail, surfaceSuppressedAutoResumeErrorInAgentIsland, handleAgentIslandInteractionAfterBroadcast, handleAgentIslandInteractionDismissed, handleAgentIslandInteractionDismissedByRequestId, handleAgentIslandSessionClosedAfterCleanup, handleAgentIslandSessionStopped, shouldNotifyAgentIslandForSession, clearSuppressedOrcaWorkerAgentIslandSession, notifyAgentIslandUserPrompt, dispatchAgentIslandUserPrompt, commitAgentIslandUserPrompt, rollbackAgentIslandUserPrompt };
}
