import type { AgentKind } from '@cindy/maker-core';

import type { OrcaWorkerProviderRoutingContext } from './orcaWorkerCreationService.js';

export interface OrcaModelRoute {
  modelId: string;
  label: string;
  providerId: string;
  providerName: string;
  isDefault: boolean;
}

/** Builds the provider-aware projection exposed by Orca model discovery. */
export function buildOrcaModelRoutes(params: {
  agent: AgentKind;
  models: ReadonlyArray<{ id: string; displayName: string }>;
  routing: OrcaWorkerProviderRoutingContext;
}): OrcaModelRoute[] {
  const labels = new Map(params.models.map((model) => [model.id, model.displayName]));
  const defaultProviderByModel = new Map<string, string | null>();
  const defaultProviderFor = (modelId: string): string | null => {
    if (!defaultProviderByModel.has(modelId)) {
      defaultProviderByModel.set(
        modelId,
        params.routing.resolveDefaultProviderIdForModel(params.agent, modelId),
      );
    }
    return defaultProviderByModel.get(modelId) ?? null;
  };

  return (params.routing.availability[params.agent] ?? []).flatMap((provider) =>
    provider.models.map((modelId) => ({
      modelId,
      label: labels.get(modelId) ?? modelId,
      providerId: provider.id,
      providerName: provider.name,
      isDefault: defaultProviderFor(modelId) === provider.id,
    })),
  );
}
