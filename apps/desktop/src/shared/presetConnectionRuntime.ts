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
    models,
    ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
    ...(rt.requestPath ? { requestPath: rt.requestPath } : {}),
    ...(agent === 'codex' && rt.supportsImageGeneration === true
      ? { supportsImageGeneration: true }
      : {}),
    ...(rt.headers ? { headers: rt.headers } : {}),
    ...(rt.modelsUrl ? { modelsUrl: rt.modelsUrl } : {}),
    ...(rt.piCatalogProviderId ? { piCatalogProviderId: rt.piCatalogProviderId } : {}),
  };
}
