import {isOrganizationManagedProvider, catalogModelMetadata, type CustomProviderConfig, type Provider} from '@cindy/model-providers';

export function byokNativeConfigs(providers: readonly Provider[]): CustomProviderConfig[] {
  return providers
    .filter((provider) => isOrganizationManagedProvider(provider) && provider.agents.includes('pi'))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: provider.routing.pi!.upstream,
          wireProtocol: provider.routing.pi!.wireProtocol,
          models: (provider.models.pi ?? []).map((model) => ({
            id: model.id,
            name: model.name,
            ...catalogModelMetadata(model),
            defaultEnabled: model.defaultEnabled,
            ...(model.cost ? { discoveredCost: model.cost } : {}),
            piApi: model.piApi,
            ...(model.route ? { route: model.route } : {}),
            supportsImageInput: model.supportsImageInput,
            reasoning: model.efforts.length > 0,
            reasoningEfforts: model.efforts.filter((effort) => effort !== 'ultra'),
            reasoningDefaultEffort:
              model.defaultEffort === 'ultra' ? undefined : (model.defaultEffort ?? undefined),
          })),
        },
      },
    }));
}

/** Managed connections win an id collision without mixing a personal endpoint with a member key. */
export function mergeByokNativeConfigs(
  personal: readonly CustomProviderConfig[],
  providers: readonly Provider[],
): CustomProviderConfig[] {
  const managed = byokNativeConfigs(providers);
  // The organization directory owns its ids even while a credential is pending.
  // Falling back to a same-id personal native config would combine the enterprise
  // catalog selection with a personal endpoint or a keyless local runtime.
  const managedIds = new Set(
    providers.filter(isOrganizationManagedProvider).map((provider) => provider.id),
  );
  return [...personal.filter((provider) => !managedIds.has(provider.id)), ...managed];
}
