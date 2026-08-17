import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';

export function savedCustomProviderModelShape(
  model: ProviderRuntimeModelConfig,
  includePiCapabilities: boolean,
): ProviderRuntimeModelConfig {
  return {
    id: model.id.trim(),
    name: model.name.trim(),
    ...(includePiCapabilities && model.piApi ? { piApi: model.piApi } : {}),
    ...(model.route ? { route: { ...model.route } } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
    ...(includePiCapabilities && model.supportsImageInput === true
      ? { supportsImageInput: true }
      : {}),
    ...(includePiCapabilities && model.reasoning === true && model.reasoningEfforts?.length
      ? {
          reasoning: true,
          reasoningEfforts: [...model.reasoningEfforts],
          ...(model.reasoningDefaultEffort
            ? { reasoningDefaultEffort: model.reasoningDefaultEffort }
            : {}),
        }
      : {}),
  };
}
