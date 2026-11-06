import type {
  AgentKind, Catalog, CatalogModel, ModelMetadata, ProviderRuntimeModelConfig, RoutingDescriptor,
} from '@cindy/model-providers';

/** model/list describes engine capabilities, not account membership or API entitlement. */
function isOpenAiApiCodexRoute(
  agent: AgentKind,
  model: Pick<ProviderRuntimeModelConfig, 'route' | 'api'>,
  routing: RoutingDescriptor,
): boolean {
  if (agent !== 'codex' || routing.authStrategy !== 'api-key-header') return false;
  const wire = model.route?.wireProtocol ?? routing.wireProtocol ?? 'openai-responses';
  if (wire !== 'openai-responses' || (model.api && model.api !== 'openai-responses')) return false;
  // Match providerRoutingForModel: a model route replaces the runtime path.
  const requestPath = model.route ? model.route.requestPath : routing.requestPath;
  if (requestPath && requestPath !== '/responses') return false;
  try {
    const url = new URL(model.route?.baseUrl ?? routing.upstream);
    return url.origin === 'https://api.openai.com' && url.pathname.replace(/[/]+$/, '') === '/v1'
      && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
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
): ModelMetadata | undefined {
  if (!models || !isOpenAiApiCodexRoute(agent, model, routing)) return undefined;
  // Exact IDs only. Do not infer support for aliases, relays, other engines or Ultrafast.
  const report = models.find(candidate => candidate.id === model.id)?.discoveredMetadata;
  if (!report) return undefined;
  return {
    ...(report.efforts !== undefined ? { efforts: report.efforts } : {}),
    ...(report.defaultEffort !== undefined ? { defaultEffort: report.defaultEffort } : {}),
    ...(report.supportsFastMode !== undefined ? { supportsFastMode: report.supportsFastMode } : {}),
  };
}

let probe: (() => void) | null = null;

/** The maker owns the control-plane process and drops its probe on owner teardown. */
export function setCodexApiModelProbe(next: (() => void) | null): void {
  probe = next;
}

export function requestCodexApiModelProbe(): void {
  probe?.();
}
