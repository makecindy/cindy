import { buildBotMemoryScopeKey, type McpProvider } from '@cindy/maker-core';
import { isBotToolsetAvailableOnTarget, type BotToolsetContext } from '../../shared/botRemoteCapabilities.js';
import { pluginIdForKnownProviderName } from './plugins/builtin-plugins.js';

/** Query the mounted provider gates without creating servers or changing global settings. */
export function isBotToolsetProviderAvailable(
  providers: readonly McpProvider[],
  input: BotToolsetContext & { toolsetId: string },
): boolean {
  if (!isBotToolsetAvailableOnTarget(input)) return false;
  // Do not use the current runtime's frozen allowlist: discovery must also
  // include capabilities this Bot can join for its next turn.
  const context = {
    agentKind: input.agentKind,
    workingDir: input.workingDir,
    remoteHostId: input.remoteHostId ?? undefined,
    memoryScopeKey: buildBotMemoryScopeKey(input.botId),
  };
  const provider = providers.find((entry) =>
    pluginIdForKnownProviderName(entry.name) === input.toolsetId);
  if (!provider || provider.isEnabled?.(context) === false) return false;
  // Codex/Pi register factories on a shared bridge before a workdir exists.
  // A provider rejected there cannot be mounted even if its per-Bot gate passes.
  return input.agentKind === 'claude-code'
    || (provider.isEnabled?.({ agentKind: input.agentKind, workingDir: '' }) ?? true);
}
