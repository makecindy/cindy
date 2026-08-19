/**
 * `maker:list-agent-commands` crosses two trusted Main-owned entry paths:
 * a registered Cindy app Renderer, or an authenticated device-link invoke context.
 * Renderer payload fields never participate in that decision.
 */

export const AGENT_COMMAND_LIST_FAILURE_MESSAGE = 'Unable to load agent commands';

export interface AgentCommandListFailure {
  success: false;
  error: typeof AGENT_COMMAND_LIST_FAILURE_MESSAGE;
  commands: [];
}

interface AgentCommandListCallerBoundaryDeps {
  isDeviceLinkInvoke(): boolean;
  assertTrustedSender(event: unknown): void;
}

interface AgentCommandListFailureBoundaryDeps {
  reportError(error: unknown): void;
}

export function assertAgentCommandListIpcCaller(
  event: unknown,
  deps: AgentCommandListCallerBoundaryDeps,
): void {
  // A synthetic device-link event has no Electron sender. Its authority comes
  // only from dispatch.ts' authenticated Main-owned async context.
  if (!deps.isDeviceLinkInvoke()) {
    deps.assertTrustedSender(event);
  }
}

export function toAgentCommandListFailure(
  error: unknown,
  deps: AgentCommandListFailureBoundaryDeps,
): AgentCommandListFailure {
  deps.reportError(error);
  return {
    success: false,
    error: AGENT_COMMAND_LIST_FAILURE_MESSAGE,
    commands: [],
  };
}
