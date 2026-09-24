import type {
  AgentKind,
  ProviderPreset,
  ProviderPresetRuntime,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

/** Remote presets may predate explicit Pi protocol metadata. Such a runtime is not saveable. */
export function isConfiguredPresetRuntime(
  agent: AgentKind,
  runtime: ProviderPresetRuntime | undefined,
): runtime is ProviderPresetRuntime {
  return runtime !== undefined && (agent !== 'pi' || runtime.wireProtocol !== undefined);
}

export function configuredPresetAgents(preset: ProviderPreset): AgentKind[] {
  return (Object.keys(preset.runtimes) as AgentKind[]).filter((agent) =>
    isConfiguredPresetRuntime(agent, preset.runtimes[agent]),
  );
}

export function savedCustomProviderModelShape(
  model: ProviderRuntimeModelConfig,
  includePiApi: boolean,
): ProviderRuntimeModelConfig {
  const { piApi, ...portable } = structuredClone(model);
  return {
    ...portable,
    id: model.id.trim(),
    name: model.name.trim(),
    ...(!includePiApi && !model.api && piApi ? { api: piApi } : {}),
    ...(includePiApi && piApi ? { piApi } : {}),
  };
}
