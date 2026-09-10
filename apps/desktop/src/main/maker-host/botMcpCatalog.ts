import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import type { McpTransport } from '../../shared/customMcp.js';
import { isPiCustomMcpProviderAvailable } from '../mcp-integrations/piMcpTransport.js';

function isCustomMcpAvailable(input: {
  agentKind: McpProviderContext['agentKind'];
  remoteHostId?: string | null;
  provider: McpProvider;
  custom?: { transport: McpTransport };
}): boolean {
  // SSH Codex receives only REMOTE_ALLOWED_SERVER_NAMES; user configs are not
  // written into its daemon. Remote Claude serializes http/sse into startParams.
  // Remote Pi connects to custom HTTP MCPs directly (`s.remote` is not tunneled).
  if (input.agentKind === 'codex') {
    return !input.remoteHostId && input.custom?.transport !== 'sse';
  }
  if (input.agentKind === 'pi' && input.custom) {
    return isPiCustomMcpProviderAvailable(input.provider, { remoteHostId: input.remoteHostId });
  }
  return true;
}

/** Freeze only metadata; compatibility is recomputed for each actual start route. */
export function buildBotMcpCatalog(input: {
  agentKind: McpProviderContext['agentKind'];
  remoteHostId?: string | null;
  providers: readonly McpProvider[];
  builtinNames: readonly string[];
  customServers: readonly { id: string; transport: McpTransport; updatedAt: number }[];
}) {
  const builtinNames = new Set(input.builtinNames);
  const customServers = new Map(input.customServers.map((entry) => [entry.id, entry]));
  return [...new Map(input.providers.map((provider) => {
    const builtin = builtinNames.has(provider.name);
    const custom = customServers.get(provider.name);
    // Builtins retain their SDK bridge path and are not instantiated by catalog queries.
    const available = builtin || isCustomMcpAvailable({
      agentKind: input.agentKind,
      remoteHostId: input.remoteHostId,
      provider,
      custom,
    });
    return [provider.name, {
      name: provider.name,
      source: builtin ? 'builtin' as const : 'custom' as const,
      available,
      generation: builtin ? 'builtin:1'
        : custom ? `${custom.transport}:${custom.updatedAt}` : 'custom:unknown',
    }];
  })).values()];
}
