import type { InteractionRequest } from '@cindy/maker-core';

export interface AgentIslandNotificationPolicyConfig {
  notifyOrcaWorkerSessions: boolean;
}

export function shouldNotifyAgentIslandForSession(
  config: AgentIslandNotificationPolicyConfig,
  isOrcaWorkerSession: boolean,
): boolean {
  return config.notifyOrcaWorkerSessions || !isOrcaWorkerSession;
}

/**
 * Orca Worker activity stays quiet by default. A permission prompt is the one
 * interaction that cannot make progress without the user, so it may reuse the
 * existing safe Agent Island permission card without opening the event gate.
 */
export function shouldNotifyAgentIslandForInteraction(
  config: AgentIslandNotificationPolicyConfig,
  isOrcaWorkerSession: boolean,
  interactionKind: string,
): boolean {
  return (
    shouldNotifyAgentIslandForSession(config, isOrcaWorkerSession) ||
    (isOrcaWorkerSession && interactionKind === 'permission')
  );
}

/**
 * Worker permissions cross a boundary that ordinary Worker traffic does not.
 * Keep only the interaction identity and tool identifier needed by the
 * focus-only reminder. Never forward raw tool input, provider-authored display
 * fields, suggestions or opaque metadata into Agent Island.
 */
export function projectAgentIslandInteractionForOrcaWorker(
  request: InteractionRequest,
  isOrcaWorkerSession: boolean,
): InteractionRequest {
  if (!isOrcaWorkerSession || request.kind !== 'permission') return request;
  return {
    kind: 'permission',
    requestId: request.requestId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    input: {},
  };
}

export function shouldClearAgentIslandSessionForOrcaWorker(
  config: AgentIslandNotificationPolicyConfig,
): boolean {
  return !config.notifyOrcaWorkerSessions;
}
