import { isOpenAiSubscriptionProvider, type AgentKind, type Catalog, type Provider } from '@cindy/model-providers';

/** Old GPT window presets remain in the runtime catalog for history/resume only. */
export function isLegacyGptContextProfile(provider: Pick<Provider, 'id' | 'auth'>, modelId: string): boolean {
  return isOpenAiSubscriptionProvider(provider) &&
    /^(?:chatgpt\/)?gpt-[^/]+\[1m\]$/.test(modelId);
}

export function filterLegacyGptContextProfiles(catalog: Catalog): Catalog {
  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      if (!isOpenAiSubscriptionProvider(provider)) return provider;
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
