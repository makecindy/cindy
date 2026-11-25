import { isOpenAiApiResponsesEndpoint } from '@cindy/model-providers';
import type {
  AgentKind, Catalog, CatalogModel, ModelMetadata, Provider, ProviderRuntimeModelConfig, RoutingDescriptor,
} from '@cindy/model-providers';

// OpenAI documents these exact API model IDs in the Fast pricing tables:
// https://developers.openai.com/api/docs/pricing.md#fast-pricing-data
const OFFICIAL_API_FAST_FALLBACK_MODELS = new Set([
  'gpt-6.2-astra',
  'gpt-6.2-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'gpt-5.3-codex',
]);

// https://developers.openai.com/api/docs/guides/ultrafast-mode
const OFFICIAL_API_ULTRAFAST_MODELS = new Set([
  'gpt-6.2-astra',
  'gpt-6.2-sol',
  'gpt-6-astra',
  'gpt-6.1-sol',
]);

/** model/list describes engine capabilities, not account membership or API entitlement. */
function isOpenAiApiCodexRoute(
  agent: AgentKind,
  model: Pick<ProviderRuntimeModelConfig, 'route' | 'api'>,
  routing: RoutingDescriptor,
): boolean {
  if (agent !== 'codex' || routing.disabled || routing.authStrategy !== 'api-key-header') return false;
  const wire = model.route?.wireProtocol ?? routing.wireProtocol ?? 'openai-responses';
  if (model.api && model.api !== 'openai-responses') return false;
  // Match providerRoutingForModel: a model route replaces the runtime path.
  return isOpenAiApiResponsesEndpoint(
    model.route?.baseUrl ?? routing.upstream, wire, model.route ? model.route.requestPath : routing.requestPath,
  );
}

export function hasCodexApiConnections(catalog: Catalog): boolean {
  return catalog.providers.some(provider => provider.source === 'user' && provider.routing.codex
    && provider.models.codex?.some(model => isOpenAiApiCodexRoute('codex', model, provider.routing.codex!)));
}

export function codexApiModelMetadata(
  models: readonly CatalogModel[] | null,
  agent: AgentKind,
  model: ProviderRuntimeModelConfig,
  routing: RoutingDescriptor,
): (ModelMetadata & Pick<CatalogModel, 'supportsUltrafastMode'>) | undefined {
  if (!isOpenAiApiCodexRoute(agent, model, routing)) return undefined;
  const report = models?.find(candidate => candidate.id === model.id)?.discoveredMetadata;
  const supportsFastMode = report?.supportsFastMode ??
    (OFFICIAL_API_FAST_FALLBACK_MODELS.has(model.id) && model.discoveredMetadata?.supportsFastMode === undefined
      ? true : undefined);
  // The app-server report is shared across API connections. The confirmation is local
  // to the current connection, whose credential and project may have a different policy.
  const supportsUltrafastMode = routing.openAiApiUltrafastConfirmed === true &&
    OFFICIAL_API_ULTRAFAST_MODELS.has(model.id);
  if (!report && supportsFastMode === undefined && !supportsUltrafastMode) return undefined;
  return {
    ...(report?.efforts !== undefined ? { efforts: report.efforts } : {}),
    ...(report?.defaultEffort !== undefined ? { defaultEffort: report.defaultEffort } : {}),
    ...(supportsFastMode !== undefined ? { supportsFastMode } : {}),
    ...(supportsUltrafastMode ? { supportsUltrafastMode } : {}),
  };
}

/** The execution catalog must use the same final, route-specific capability as the picker. */
export function needsOpenAiApiCodexFastDeclaration(
  provider: Provider | undefined,
  modelId: string,
): boolean {
  if (!OFFICIAL_API_FAST_FALLBACK_MODELS.has(modelId) || provider?.source !== 'user') return false;
  const routing = provider.routing.codex;
  const model = provider.models.codex?.find(candidate => candidate.id === modelId);
  return !!routing && !routing.disabled && model?.supportsFastMode === true &&
    isOpenAiApiCodexRoute('codex', { route: model.route, api: model.userModelConfig?.api }, routing);
}

/** Add the API tier only for the selected model whose picker exposes it. */
export function needsOpenAiApiCodexUltrafastDeclaration(
  provider: Provider | undefined,
  modelId: string,
): boolean {
  return provider?.routing.codex?.openAiApiUltrafastConfirmed === true &&
    OFFICIAL_API_ULTRAFAST_MODELS.has(modelId) &&
    needsOpenAiApiCodexFastDeclaration(provider, modelId) &&
    provider?.models.codex?.some(model => model.id === modelId && model.supportsUltrafastMode === true) === true;
}

let probe: (() => void) | null = null;

/** The maker owns the control-plane process and drops its probe on owner teardown. */
export function setCodexApiModelProbe(next: (() => void) | null): void {
  probe = next;
}

export function requestCodexApiModelProbe(): void {
  probe?.();
}
