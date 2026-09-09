import type { BotRuntimeMcpPolicy } from '../base-agent.js';

const BOT_ESSENTIAL_MCP_SERVERS = new Set(['cindy_memory', 'cindy_helper']);

/**
 * A Bot gets its memory and narrow helper gateway, plus servers the profile
 * explicitly mounted. Builtin capability servers (e.g. cindy_docs for the
 * docs toolset) go through the same explicit allowlist as custom MCPs: the
 * runtime writes them into the policy when the corresponding toolset is
 * mounted, so the prompt's capability claims and the tool surface stay in
 * sync.
 */
export function isBotMcpServerAllowed(
  policy: BotRuntimeMcpPolicy | undefined,
  serverName: string,
): boolean {
  if (!policy) return true;
  if (BOT_ESSENTIAL_MCP_SERVERS.has(serverName)) return true;
  const entry = policy.catalog.find((item) => item.name === serverName);
  if (!entry) return false;
  return entry.available !== false && policy.configured.includes(serverName);
}
