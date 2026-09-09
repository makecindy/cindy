import type { PiModelApi, ProviderRuntimeModelConfig, ProviderWireProtocol } from './types.js';

/** Preserve omission as a distinct state: Pi has no implicit protocol default. */
export function effectivePiWireProtocol(
  value: ProviderWireProtocol | undefined,
): ProviderWireProtocol | undefined {
  return value;
}

interface PiProtocolModelLike {
  piApi?: PiModelApi;
  route?: { baseUrl?: string; wireProtocol: ProviderWireProtocol; requestPath?: string };
}

export interface ResolvedPiModelRoute {
  baseUrl: string;
  wireProtocol: ProviderWireProtocol;
  requestPath?: string;
}

/**
 * Resolve the portable Pi model API to the provider wire protocol used by host-side probes and
 * visual requests. A model override is authoritative over a route/provider default. Google uses
 * a native Pi SDK surface that these HTTP bridges do not implement, so it fails closed here.
 */
export function resolvePiModelWireProtocol(
  model: PiProtocolModelLike | undefined,
  providerDefault: ProviderWireProtocol | undefined,
): ProviderWireProtocol | null {
  switch (model?.piApi) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-completions':
      return 'openai-chat';
    case 'google-generative-ai':
      return null;
    default:
      return model?.route?.wireProtocol ?? providerDefault ?? null;
  }
}

/** Resolve the effective HTTP target as one unit so protocol and endpoint cannot drift apart. */
export function resolvePiModelRoute(
  model: PiProtocolModelLike | undefined,
  providerDefault: { baseUrl: string; wireProtocol: ProviderWireProtocol | undefined },
): ResolvedPiModelRoute | null {
  const wireProtocol = resolvePiModelWireProtocol(model, providerDefault.wireProtocol);
  if (!wireProtocol) return null;
  const modelRouteMatchesProtocol = model?.route?.wireProtocol === wireProtocol;
  return {
    // An explicit portable override is authoritative. Legacy configs may pair it with a stale
    // route from the previous protocol; only reuse that endpoint when the route still agrees.
    baseUrl: modelRouteMatchesProtocol
      ? (model.route?.baseUrl ?? providerDefault.baseUrl)
      : providerDefault.baseUrl,
    wireProtocol,
    ...(modelRouteMatchesProtocol && model.route?.requestPath
      ? { requestPath: model.route.requestPath }
      : {}),
  };
}

function projectedPiCatalogFields(model: ProviderRuntimeModelConfig): object {
  return {
    name: model.name,
    contextWindow: model.contextWindow,
    supportsImageInput: model.supportsImageInput,
    reasoning: model.reasoning,
    reasoningEfforts: model.reasoningEfforts,
    reasoningDefaultEffort: model.reasoningDefaultEffort,
  };
}

/**
 * Whether an edited model list still represents the same catalog-backed models.
 *
 * New models and presentation-only edits may coexist with the catalog snapshot, but every
 * previously saved model must still exist with the same catalog-projected fields. First-wins
 * duplicate handling mirrors custom-provider persistence normalization, so a duplicate row cannot
 * hide a replacement or metadata override from the main-process check.
 */
export function preservesPiCatalogModels(
  previous: readonly ProviderRuntimeModelConfig[] | undefined,
  next: readonly ProviderRuntimeModelConfig[] | undefined,
): boolean {
  const nextById = new Map<string, ProviderRuntimeModelConfig>();
  for (const model of next ?? []) {
    if (!nextById.has(model.id)) nextById.set(model.id, model);
  }
  return (previous ?? []).every((model) => {
    const candidate = nextById.get(model.id);
    return candidate !== undefined
      && JSON.stringify(projectedPiCatalogFields(model))
        === JSON.stringify(projectedPiCatalogFields(candidate));
  });
}
