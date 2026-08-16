import type { BotRuntimeMcpPolicy } from '../base-agent.js';

/**
 * Hermes-style per-profile MCP selection only controls the profile's custom
 * MCP catalog. Cindy built-ins remain owned by the Toolset policy so memory,
 * scheduler, collaboration and other first-party gates keep their native
 * permission and availability rules.
 */
export function isBotMcpServerAllowed(
  policy: BotRuntimeMcpPolicy | undefined,
  serverName: string,
): boolean {
  if (!policy || policy.mode === 'inherit') return true;
  const entry = policy.catalog.find((item) => item.name === serverName);
  if (!entry || entry.source !== 'custom') return true;
  return entry.available !== false && policy.configured.includes(serverName);
}
