import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import { CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY, CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '@cindy/mcps/host/codexBuiltinToolPolicy';
import { isBotMcpServerAllowed } from '@cindy/maker-core';
import { resolveBotAllowedBuiltinPluginIds } from './builtin-tools/types.js';
import { RUNTIME_MCP_NAMES_KEY } from './agentCapabilityCatalog.js';
import type { BotProfileRuntimeSnapshot } from './botProfileRuntime.js';

/** The GUI and Node hosts freeze the same tool policy before starting a native runtime. */
export function applyBotRuntimeToolPolicy(input: {
  options: MakerSessionCreateOpts;
  snapshot: BotProfileRuntimeSnapshot | null;
  disabledPluginIds: readonly string[];
  providers: readonly { name: string }[];
}): void {
  const { options, snapshot, providers } = input;
  options.vendorOptions = {
    ...(options.vendorOptions ?? {}),
    [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [...new Set([
      ...input.disabledPluginIds,
      ...(snapshot?.disabledToolsets ?? []),
    ])],
    ...(snapshot ? {
      [RUNTIME_MCP_NAMES_KEY]: providers
        .filter(provider => isBotMcpServerAllowed(options.botRuntimeProfile?.mcpPolicy, provider.name))
        .map(provider => provider.name),
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [...resolveBotAllowedBuiltinPluginIds(
        options.botRuntimeProfile?.toolsetPolicy.catalog ?? [],
        options.botRuntimeProfile?.toolsetPolicy.configured ?? [],
      )],
    } : {}),
  };
}
