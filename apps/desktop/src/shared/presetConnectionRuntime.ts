import type {
  AgentKind,
  CustomProviderRuntimeConfig,
  ProviderPreset,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

/** Shared by the add wizard and import: keep defaults linked to the live preset. */
export function presetConnectionRuntime(
  preset: ProviderPreset,
  agent: AgentKind,
  models: ProviderRuntimeModelConfig[],
  baseUrl = preset.runtimes[agent]!.baseUrl,
): CustomProviderRuntimeConfig {
  const rt = preset.runtimes[agent]!;
  return {
    catalogPresetId: preset.id,
    baseUrl,
    models: models.map(model => {
      // Import-time interface defaults remain references, not manual overrides.
      if (!rt.models.some(candidate => candidate.id === model.id)) return model;
      const { api: _api, piApi: _piApi, route: _route, ...stored } = model;
      return stored;
    }),
    ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
    ...(rt.requestPath ? { requestPath: rt.requestPath } : {}),
    ...(agent === 'codex' && rt.supportsImageGeneration === true
      ? { supportsImageGeneration: true }
      : {}),
    ...(rt.headers ? { headers: rt.headers } : {}),
    ...(rt.modelsUrl ? { modelsUrl: rt.modelsUrl } : {}),
    ...(rt.piCatalogProviderId ? { piCatalogProviderId: rt.piCatalogProviderId } : {}),
    ...(rt.accountUsage ? { accountUsage: { ...rt.accountUsage } } : {}),
  };
}
