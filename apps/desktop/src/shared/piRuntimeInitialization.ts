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

/** Copy reasoning metadata into a runtime's supported vocabulary without mutating the source. */
export function adaptCustomProviderModelEfforts(
  source: ProviderRuntimeModelConfig,
  agent: AgentKind,
): ProviderRuntimeModelConfig {
  const model = structuredClone(source);
  // Adapt every representation before persistence; canonical metadata otherwise
  // bypasses the legacy field validator. Keep Pi's shared endpoint record intact.
  if (agent !== 'pi') {
    const supported = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    if (model.reasoningEfforts) {
      model.reasoningEfforts = model.reasoningEfforts.filter(effort => supported.has(effort));
    }
    if (model.reasoningDefaultEffort != null &&
        (!supported.has(model.reasoningDefaultEffort) ||
          (model.reasoningEfforts && !model.reasoningEfforts.includes(model.reasoningDefaultEffort)))) {
      delete model.reasoningDefaultEffort;
    }
    for (const metadata of [model, model.discoveredMetadata]) {
      if (!metadata) continue;
      if (metadata.efforts) metadata.efforts = metadata.efforts.filter(effort => supported.has(effort));
      if (metadata.defaultEffort != null &&
          (!supported.has(metadata.defaultEffort) ||
            (metadata.efforts && !metadata.efforts.includes(metadata.defaultEffort)))) {
        delete metadata.defaultEffort;
      }
    }
  }
  return model;
}
