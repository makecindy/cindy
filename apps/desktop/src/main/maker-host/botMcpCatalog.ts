import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import type { McpTransport } from '../../shared/customMcp.js';
import { isPiCustomMcpProviderAvailable } from '../mcp-integrations/piMcpTransport.js';
import { CustomMcpProvider } from '../mcp-integrations/custom-mcp-provider.js';
import { getHarnessMcpCatalog } from './harnessMcpCatalog.js';

function isCustomMcpAvailable(input: {
  agentKind: McpProviderContext['agentKind'];
  remoteHostId?: string | null;
  provider: McpProvider;
  custom?: { transport: McpTransport };
}): boolean {
  // The Apps facade is carried by the authenticated Host bridge for every
  // harness, including SSH. Direct-transport limitations do not apply to it.
  if (input.provider instanceof CustomMcpProvider && input.provider.supportsApps) return true;
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
  const providers = [...new Map(input.providers.map((provider) => {
    const builtin = builtinNames.has(provider.name) && provider.name !== 'companion_connections';
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
  const harness = getHarnessMcpCatalog(input);
  return [...providers.filter((provider) => !harness.some((entry) => entry.name === provider.name)), ...harness];
}
