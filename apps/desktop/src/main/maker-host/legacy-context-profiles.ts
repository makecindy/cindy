import type { AgentKind, Catalog, Provider } from '@cindy/model-providers';

/** Old GPT window presets remain in the runtime catalog for history/resume only. */
export function isLegacyGptContextProfile(provider: Pick<Provider, 'id' | 'source'>, modelId: string): boolean {
  return provider.source !== 'user' && provider.id === 'openai' &&
    /^(?:chatgpt\/)?gpt-[^/]+\[1m\]$/.test(modelId);
}

export function filterLegacyGptContextProfiles(catalog: Catalog): Catalog {
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      if (provider.id !== 'openai' || provider.source === 'user') return provider;
      return {
        ...provider,
        models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) => [
          agent as AgentKind,
          models?.filter((model) => !isLegacyGptContextProfile(provider, model.id)),
        ])),
      };
    }),
  };
}
