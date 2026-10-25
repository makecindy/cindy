/**
 * Claude's native OAuth `auto` mode never calls Cindy's approval bridge.
 * Remote collaboration MCP servers are injected by the Desktop host after
 * maker-core has chosen the initial mode, so the host must finalize the mode
 * before opening the remote query.
 */
export function routeInjectedRemoteMcpApprovalsThroughCindy(
  startParams: Record<string, unknown>,
  injectedServerCount: number,
): void {
  if (injectedServerCount > 0 && startParams.permissionMode === 'auto') {
    startParams.permissionMode = 'default';
  }
}
