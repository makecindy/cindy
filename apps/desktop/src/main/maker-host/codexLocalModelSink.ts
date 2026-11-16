import type { AgentDeps } from '@cindy/maker-core';
import { getActiveAppSession } from '../appSessionState.js';
import { mapCodexAppServerModelsToCatalog } from './codexModelMapping.js';
import { getCustomProvider, updateCustomProviderIfUnchanged } from './custom-provider-store.js';
import { setDiscoveredCodexModels } from './active-catalog.js';

export function createCodexLocalModelSink(refreshCustomProvidersIntoCatalog: () => Promise<unknown>): NonNullable<AgentDeps['onCodexLocalModelsListed']> {
  return async (models, providerId) => {
        const owner = getActiveAppSession();
        const mapped = mapCodexAppServerModelsToCatalog(models);
        if (providerId) {
          const previous = await getCustomProvider(providerId);
          if (getActiveAppSession().generation !== owner.generation) return;
          if (!previous?.runtimes.codex || previous.auth?.native !== 'codex') return;
          const next = { ...previous, runtimes: { codex: { ...previous.runtimes.codex,
            models: mapped.map((model) => ({ id: model.id, name: model.name,
              supportsUltrafastMode: model.supportsUltrafastMode === true,
              ...(model.contextWindowVerified ? { contextWindow: model.contextWindow } : {}),
              discoveredMetadata: model.discoveredMetadata,
            })),
          } } };
          const updated = await updateCustomProviderIfUnchanged(providerId, previous, next);
          if (getActiveAppSession().generation !== owner.generation) return;
          if (updated) await refreshCustomProvidersIntoCatalog();
          return;
        }
        setDiscoveredCodexModels(mapped, { source: 'list' });
      };
}
