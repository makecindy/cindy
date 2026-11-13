import { runtimeCustomProviderId, type Catalog, type CustomProviderConfig } from '@cindy/model-providers';

/**
 * Copy image input already resolved on the active catalog onto each Pi model.
 *
 * Headless host does not thread the catalog into the shared projection (Desktop
 * does). That projection only trusts an explicit model flag, same-origin bundled
 * metadata, or the catalog it was given, and otherwise marks the model text-only.
 * A model the user marked visual in model-catalog-overrides.json would then make
 * Pi refuse the image with PI_IMAGE_INPUT_UNSUPPORTED. An unresolved model keeps
 * its own flag, including "not declared".
 */
export function withResolvedPiImageInput(
  configs: readonly CustomProviderConfig[],
  catalog: Catalog,
): CustomProviderConfig[] {
  return configs.map(config => {
    const runtime = config.runtimes.pi;
    if (!runtime) return config;
    const provider = catalog.providers.find(item => item.id === runtimeCustomProviderId(config.id));
    return {
      ...config,
      runtimes: {
        ...config.runtimes,
        pi: {
          ...runtime,
          models: runtime.models.map(model => {
            const supportsImageInput = provider?.models.pi?.find(item => item.id === model.id)?.supportsImageInput;
            return supportsImageInput === undefined ? model : { ...model, supportsImageInput };
          }),
        },
      },
    };
  });
}
