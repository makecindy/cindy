import type { AgentKind, ProviderPreset, ProviderPresetRuntime } from './types.js';
import { bindProviderPresetRuntime, providerEndpointBindings } from './providerEndpointTemplate.js';
import { providerInterfaceDefaultRoute } from './providerInterfaceRoutes.js';
import { isLoopbackProviderUrl } from './provider-url.js';
import { parseModelsListResponse } from './modelDiscovery.js';
import type { DiscoveredModel, ModelMetadata } from './modelMetadataLayers.js';

/** Compatibility fingerprints, never an assertion about a model's upstream manufacturer. */
export const DETECTION_RULE_VERSION = '2026-10-21';
export const DEPLOYMENT_PROVIDERS = ['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm'] as const;
export type DeploymentProvider = typeof DEPLOYMENT_PROVIDERS[number];
export type ProviderEvidence = Partial<Record<'subPublic' | 'subBilling' | 'liteReady' | 'liteModels' | 'lmGreeting' | 'lmModels' | 'llamaProps' | 'vllmVersion' | 'models', unknown>>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const list = (v: unknown, key: string): unknown[] | undefined => object(v) && Array.isArray(v[key]) ? v[key] : undefined;

export function detectDeploymentProviders(e: ProviderEvidence): DeploymentProvider[] {
  const hits: DeploymentProvider[] = [];
  const pub = object(e.subPublic) ? e.subPublic : {};
  const data = object(pub.data) ? pub.data : {};
  const billing = object(e.subBilling) ? e.subBilling : {};
  if (pub.code === 0 && text(data.version)
    && ['hide_ccs_import_button', 'backend_mode_enabled', 'subscription_enabled'].every(k => typeof data[k] === 'boolean')
    && billing.object === 'sub2api.key_billing' && billing.schema_version === 1) hits.push('sub2api');
  const ready = object(e.liteReady) ? e.liteReady : {};
  const lite = list(e.liteModels, 'data');
  if (text(ready.litellm_version) && ready.status === 'healthy' && Array.isArray(ready.success_callbacks)
    && lite?.length && lite.every(m => object(m) && text(m.model_name) && object(m.litellm_params) && object(m.model_info))) hits.push('litellm');
  const lm = list(e.lmModels, 'models');
  const native = lm?.every(m => object(m) && text(m.key) && ['llm', 'embedding'].includes(String(m.type))
    && typeof m.publisher === 'string' && Array.isArray(m.loaded_instances));
  if (native && ((object(e.lmGreeting) && e.lmGreeting.lmstudio === true) || !!lm?.length)) hits.push('lmstudio');
  const models = list(e.models, 'data');
  const validModels = models?.every(m => object(m) && text(m.id));
  const props = object(e.llamaProps) ? e.llamaProps : {};
  if (object(props.default_generation_settings) && integer(props.total_slots) && props.total_slots >= 0
    && text(props.build_info) && validModels) hits.push('llamacpp');
  if (object(e.vllmVersion) && text(e.vllmVersion.version) && models?.length
    && models.every(m => object(m) && text(m.id) && text(m.root) && m.owned_by === 'vllm'
      && integer(m.max_model_len) && m.max_model_len > 0)) hits.push('vllm');
  return hits;
}

/** Details enrich account-visible IDs only. Deployment aliases never become new members. */
export function enrichDetectedModels(models: readonly DiscoveredModel[], system: DeploymentProvider, evidence: ProviderEvidence): DiscoveredModel[] {
  const entries = system === 'litellm' ? list(evidence.liteModels, 'data') : system === 'lmstudio' ? list(evidence.lmModels, 'models') : undefined;
  if (!entries) return [...models];
  return models.map(model => {
    const matches = entries.filter(entry => object(entry) && (system === 'litellm' ? entry.model_name === model.id
      : entry.key === model.id || (Array.isArray(entry.loaded_instances) && entry.loaded_instances.some(instance => object(instance) && instance.id === model.id))));
    if (!matches.length || (system === 'lmstudio' && matches.length !== 1)) return model;
    const metadata = matches.map(entry => {
      const record = entry as Record<string, unknown>;
      return parseModelsListResponse({ data: [{ ...record, id: model.id,
        ...(system === 'lmstudio' ? { mode: record.type === 'embedding' ? 'embedding' : 'chat' } : {}),
      }] })?.[0]?.discoveredMetadata ?? {};
    });
    // Multiple backends sharing an alias: only facts declared identically by every backend.
    const common = Object.fromEntries(Object.entries(metadata[0]).filter(([key, value]) =>
      metadata.every(m => JSON.stringify(m[key as keyof ModelMetadata]) === JSON.stringify(value)))) as ModelMetadata;
    return { ...model, discoveredMetadata: { ...common, ...model.discoveredMetadata } };
  });
}

export function detectionUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || /[{}]/.test(value)) return;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
  } catch { return; }
}
const clean = (value: string) => value.replace(/\/+$/, '');
// Documented public aliases only. Do not strip /v1 or rewrite hostnames for
// arbitrary providers. Each pair is gated on a declared canonical runtime.
const officialAliases: Record<string, { canonical: string; input: string }> = {
  mistral: { canonical: 'https://api.mistral.ai', input: 'https://api.mistral.ai/v1' },
  together: { canonical: 'https://api.together.ai/v1', input: 'https://api.together.xyz/v1' },
};

/** Never climb business prefixes or propagate query credentials into diagnostic endpoints. */
export function providerDeploymentRoot(value: string): string | undefined {
  const url = detectionUrl(value);
  if (!url || url.search || /\/(?:responses|completions|messages|models)$/.test(url.pathname)) return;
  url.pathname = url.pathname.replace(/\/v1$/, '') || '/';
  return clean(url.toString());
}

export type ProviderAddressClass = 'deployment' | 'resource-template' | 'official' | 'manual';
export function classifyProviderAddress(preset: ProviderPreset): ProviderAddressClass {
  if ((DEPLOYMENT_PROVIDERS as readonly string[]).includes(preset.id)) return 'deployment';
  const urls = Object.values(preset.runtimes).flatMap(rt => rt ? [rt.baseUrl] : []);
  if (!urls.length) return 'manual';
  if (urls.some(url => url.includes('{endpoint}') || isLoopbackProviderUrl(url))) return 'manual';
  if (urls.some(url => url.includes('{'))) return 'resource-template';
  return urls.every(url => detectionUrl(url)) ? 'official' : 'manual';
}

/** Exact official addresses; localhost and arbitrary endpoint templates are not identities. */
export function matchOfficialProviders(baseUrl: string, presets: readonly ProviderPreset[]): ProviderPreset[] {
  const url = detectionUrl(baseUrl);
  if (!url || url.search || isLoopbackProviderUrl(baseUrl)) return [];
  return presets.filter(preset => {
    const kind = classifyProviderAddress(preset);
    if (kind === 'deployment' || kind === 'manual') return false;
    return Object.entries(preset.runtimes).some(([agent, rt]) => {
      if (!rt) return false;
      if (rt.baseUrl.includes('{')) {
        // Account-family templates describe the official default port, not any
        // service on the same hostname. Leave nonstandard ports in custom setup.
        if (url.port) return false;
        return !!providerEndpointBindings(rt.baseUrl, clean(url.toString()));
      }
      const declared = detectionUrl(rt.baseUrl);
      if (!declared || declared.search) return false;
      const input = clean(url.toString());
      const canonical = clean(declared.toString());
      if (canonical === input) return true;
      const alias = officialAliases[preset.id];
      if (alias?.canonical === canonical && alias.input === input) return true;
      // Mixed-protocol connections may publish the other protocol's address
      // only in their maintained contract/model routes, not the default URL.
      const route = providerInterfaceDefaultRoute(preset.id, agent as AgentKind, input);
      const current = providerInterfaceDefaultRoute(preset.id, agent as AgentKind, canonical);
      if (route && current && route.baseUrl === current.baseUrl) return true;
      return rt.models.some(model => model.route && clean(model.route.baseUrl) === input);
    });
  });
}

/** Bind only the selected harness. Do not create sibling accounts or inherit localhost. */
export function bindDetectedProvider(preset: ProviderPreset, agent: AgentKind, input: string): ProviderPreset | undefined {
  const original = preset.runtimes[agent];
  if (!original) return;
  // Match and bind the same normalized URL: scheme/host case and default
  // ports are equivalent, while account IDs and business paths remain exact.
  const normalized = detectionUrl(input);
  if (!normalized || normalized.search) return;
  input = clean(normalized.toString());
  if (classifyProviderAddress(preset) === 'resource-template' && detectionUrl(input)?.port) return;
  let runtime: ProviderPresetRuntime;
  if (classifyProviderAddress(preset) === 'deployment') {
    const root = providerDeploymentRoot(input);
    if (!root) return;
    // Only the verified root / v1 relationship is portable to arbitrary deployments.
    const template = original.baseUrl.replace('https://{endpoint}', 'https://deployment.invalid');
    const base = detectionUrl(template);
    if (!base || !['/', '/v1'].includes(base.pathname)) return;
    const resolved = providerInterfaceDefaultRoute(preset.id, agent, original.baseUrl);
    const route = detectionUrl(resolved?.baseUrl ?? template);
    if (!route || !['/', '/v1'].includes(route.pathname)) return;
    const rebase = (value: string): string | undefined => {
      const u = detectionUrl(value.replace('https://{endpoint}', 'https://deployment.invalid'));
      if (!u || u.origin !== base.origin) return;
      return root + (u.pathname === '/' ? '' : u.pathname) + u.search;
    };
    const modelsUrl = original.modelsUrl ? rebase(original.modelsUrl) : undefined;
    if (original.modelsUrl && !modelsUrl) return;
    runtime = { ...original, baseUrl: root + (route.pathname === '/' ? '' : route.pathname),
      ...(resolved ? { wireProtocol: resolved.wireProtocol } : {}), modelsUrl,
      // Discovery/member defaults must not retain deployment-local routes.
      models: original.models.map(m => ({ ...m, ...(m.route ? { route: { ...m.route, baseUrl: rebase(m.route.baseUrl) ?? '' } } : {}) })),
      modelDiscovery: original.modelDiscovery?.map(s => ({ ...s, baseUrl: rebase(s.baseUrl) ?? '', modelsUrl: s.modelsUrl ? rebase(s.modelsUrl) : undefined })),
    };
    if (runtime.models.some(m => m.route && !m.route.baseUrl) || runtime.modelDiscovery?.some(s => !s.baseUrl)) return;
  } else {
    const source = Object.values(preset.runtimes).find(rt => rt && providerEndpointBindings(rt.baseUrl, input));
    const bindings = source && providerEndpointBindings(source.baseUrl, input);
    const target = original.baseUrl.includes('{') && bindings
      ? original.baseUrl.replace(/\{([^}]+)\}/g, (token, key: string) => bindings[key] ?? token) : original.baseUrl;
    runtime = bindProviderPresetRuntime(original, original.baseUrl.includes('{') && providerEndpointBindings(original.baseUrl, input) ? input : target);
    const resolved = providerInterfaceDefaultRoute(preset.id, agent, input);
    if (resolved) runtime = { ...runtime, ...resolved };
    if (!detectionUrl(runtime.baseUrl)) return;
  }
  return { ...preset, runtimes: { [agent]: { ...runtime, baseUrlEditable: true } } };
}
