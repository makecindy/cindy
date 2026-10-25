import type { Maker } from '@cindy/maker-core';
import type { DbClient } from '@cindy/runtime-db';
import { ESSENTIAL_PLUGIN_IDS } from './builtin-tools/types.js';
import type { BotCapabilityServiceDeps } from './botCapabilityService.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';

/** The runtime and capability picker use the same native discovery and gates. */
export function createBotRuntimeCatalog(host: Omit<BotProfileRuntimeDeps, 'listSkills' | 'listToolsets'> & {
  getMaker(): Pick<Maker, 'listAgentSkills'>;
  getPluginRegistry: BotCapabilityServiceDeps['getPluginRegistry'];
  isBotToolsetAvailable: BotCapabilityServiceDeps['isBotToolsetAvailable'];
  skillLinksChanged?: boolean;
}): BotProfileRuntimeDeps {
  const { getMaker, getPluginRegistry, isBotToolsetAvailable, skillLinksChanged, ...ports } = host;
  return {
    ...ports,
    listSkills: async ({ agentKind, workingDir, remoteHostId }) => {
      const result = await getMaker().listAgentSkills(agentKind, {
        workingDir, remoteHostId, forceReload: agentKind === 'codex' && skillLinksChanged,
      });
      return result.skills;
    },
    listToolsets: async (input) => {
      const registry = getPluginRegistry();
      return Promise.all(registry.getPlugins().map(async (plugin) => {
        const state = await registry.getEnableState(plugin.id, input.workingDir);
        return {
          id: plugin.id, name: plugin.name, essential: ESSENTIAL_PLUGIN_IDS.has(plugin.id),
          available: state.effectiveEnabled && isBotToolsetAvailable({ ...input, toolsetId: plugin.id }),
          version: plugin.version,
        };
      }));
    },
  };
}

export async function listBotTeammates(client: DbClient, input: { excludeBotId: string }) {
  const rows = await client.query<{ id: string; name: string; description: string | null }>(
    `SELECT id, display_name AS name, description
       FROM bot_profiles
      WHERE id <> ?
        AND status = 'active'
      ORDER BY display_name ASC`,
    [input.excludeBotId],
  );
  return rows.map(row => ({ id: row.id, name: row.name, description: row.description }));
}
