import type { ProviderPresetRuntime } from './types.js';

const token = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
export function providerEndpointBindings(template: string, endpoint: string): Record<string, string> | null {
  if (!template.includes('{')) return template.replace(/\/+$/, '') === endpoint.replace(/\/+$/, '') ? {} : null;
  const names: string[] = [];
  const escaped = template.split(token).map((part, index) => {
    if (index % 2) { names.push(part); return '([A-Za-z0-9_-]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  const matches = new RegExp(`^${escaped}/?$`).exec(endpoint);
  if (!matches) return null;
  const bindings: Record<string, string> = {};
  names.forEach((name, index) => { bindings[name] = matches[index + 1]; });
  return names.every((name, index) => bindings[name] === matches[index + 1]) ? bindings : null;
}
export function bindProviderEndpoint(template: string, bindings: Record<string, string>): string {
  return template.replace(token, (source, name) => bindings[name] ?? source);
}
/** Only declared account/location placeholders are substituted. No cross-origin URL guessing. */
export function bindProviderPresetRuntime(runtime: ProviderPresetRuntime, endpoint: string): ProviderPresetRuntime {
  const bindings = providerEndpointBindings(runtime.baseUrl, endpoint) ?? {};
  return { ...runtime, baseUrl: endpoint,
    ...(runtime.modelsUrl ? { modelsUrl: bindProviderEndpoint(runtime.modelsUrl, bindings) } : {}),
    models: runtime.models.map(model => ({ ...model, ...(model.route ? { route: {
      ...model.route, baseUrl: bindProviderEndpoint(model.route.baseUrl, bindings),
    } } : {}) })),
    ...(runtime.modelDiscovery ? { modelDiscovery: runtime.modelDiscovery.map(source => ({ ...source,
      baseUrl: bindProviderEndpoint(source.baseUrl, bindings),
      ...(source.modelsUrl ? { modelsUrl: bindProviderEndpoint(source.modelsUrl, bindings) } : {}),
    })) } : {}),
  };
}
