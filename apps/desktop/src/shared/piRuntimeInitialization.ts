import type {
  CustomProviderRuntimeConfig,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

export function savedCustomProviderModelShape(
  model: ProviderRuntimeModelConfig,
  includePiCapabilities: boolean,
): ProviderRuntimeModelConfig {
  return {
    id: model.id.trim(),
    name: model.name.trim(),
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

export function derivePiRuntimeFromClaudeRuntime(
  runtime: CustomProviderRuntimeConfig,
): CustomProviderRuntimeConfig | null {
  if (runtime.requestPath?.trim()) return null;
  if (runtime.wireProtocol && runtime.wireProtocol !== 'anthropic-messages') return null;

  return {
    baseUrl: runtime.baseUrl,
    wireProtocol: 'anthropic-messages',
    models: runtime.models.map((model) => savedCustomProviderModelShape(model, false)),
    ...(runtime.headers && Object.keys(runtime.headers).length > 0
      ? { headers: { ...runtime.headers } }
      : {}),
    ...(runtime.modelsUrl ? { modelsUrl: runtime.modelsUrl } : {}),
  };
}
