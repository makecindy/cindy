import type { McpProviderContext } from '@cindy/maker-core';

// Reserved across all engines: custom configs are shared and can outlive a route switch.
const CODEX_APPS_SERVER_NAME = 'codex_apps';
export const HARNESS_MCP_SERVER_NAMES: readonly string[] = [CODEX_APPS_SERVER_NAME];

/** Engine-owned surfaces have no Cindy transport. This is metadata, not a connection claim. */
export function getHarnessMcpCatalog(context: { agentKind: McpProviderContext['agentKind']; remoteHostId?: string | null }) {
  if (context.agentKind !== 'codex') return [];
  return [{
    name: CODEX_APPS_SERVER_NAME,
    title: 'Codex Apps',
    description: 'External service connectors supplied by Codex; availability and tools come from the current thread. These are not Cindy tasks, routines or plugins.',
    source: 'harness' as const,
    available: !context.remoteHostId,
    generation: 'codex-apps:1',
  }];
}
