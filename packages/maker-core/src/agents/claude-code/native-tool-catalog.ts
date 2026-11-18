import type { ClaudeMcpServerStatusEntry } from './mcp-server-tools.js';

/** Only public SDK calls; no host-owned catalog or replacement policy. */
export async function callClaudeToolCatalog(query: unknown, method: string, args: unknown[]): Promise<unknown> {
  const sdk = query as {
    mcpServerStatus?: () => Promise<ClaudeMcpServerStatusEntry[]>;
    setMcpServers?: (servers: unknown) => Promise<unknown>;
  };
  if (method === 'mcpServerStatus' && typeof sdk.mcpServerStatus === 'function') {
    return (await sdk.mcpServerStatus()).map(({ name, status, tools }) => ({ name, status, tools }));
  }
  if (method === 'setMcpServers' && typeof sdk.setMcpServers === 'function') {
    return sdk.setMcpServers(args[0]);
  }
  throw new Error('UNSUPPORTED_CAPABILITY');
}
