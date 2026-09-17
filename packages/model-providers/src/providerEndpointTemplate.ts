import type { ProviderPresetRuntime } from './types.js';

const token = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const GCP_REGION = /^[a-z]+(?:-[a-z]+)+[0-9]+$/;
const VERTEX_MULTIREGION = /^(us|eu)$/;
const AZURE_RESOURCE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/;
const VERTEX_REGIONAL_TEMPLATE = 'https://{location}-aiplatform.googleapis.com';
const VERTEX_MULTIREGION_TEMPLATE = 'https://aiplatform.{location}.rep.googleapis.com';
const VERTEX_GLOBAL_HOST = 'https://aiplatform.googleapis.com';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isVertexFamilyTemplate(template: string): boolean {
  const trimmed = stripTrailingSlash(template);
  return trimmed === VERTEX_REGIONAL_TEMPLATE || trimmed === VERTEX_MULTIREGION_TEMPLATE;
}

function isAzureOpenAIFamilyTemplate(template: string): boolean {
  return /^https:\/\/\{resource\}\.(openai|cognitiveservices)\.azure\.com\/openai(?:\/v1)?$/.test(stripTrailingSlash(template));
}

function vertexPathAllowed(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return path === '' || path === '/v1' || path === '/v1beta';
}

function recognizeVertexLocation(endpoint: string): string | null {
  const url = parseHttpUrl(endpoint);
  if (!url || url.protocol !== 'https:' || url.search || url.hash || !vertexPathAllowed(url.pathname)) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'aiplatform.googleapis.com') return 'global';
  const multi = /^aiplatform\.(us|eu)\.rep\.googleapis\.com$/.exec(host);
  if (multi) return multi[1];
  const prefixed = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(host);
  if (!prefixed) return null;
  const location = prefixed[1];
  if (location === 'global' || VERTEX_MULTIREGION.test(location) || GCP_REGION.test(location)) return location;
  return null;
}

function officialVertexEndpoint(location: string): string {
  if (location === 'global') return VERTEX_GLOBAL_HOST;
  if (VERTEX_MULTIREGION.test(location)) return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

function recognizeAzureBinding(endpoint: string): { resource: string; host: string; path: string } | null {
  const url = parseHttpUrl(endpoint);
  if (!url || url.protocol !== 'https:' || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const matched = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.(openai\.azure\.com|cognitiveservices\.azure\.com)$/.exec(host);
  if (!matched || !AZURE_RESOURCE.test(matched[1])) return null;
  const path = stripTrailingSlash(url.pathname);
  if (path !== '/openai' && path !== '/openai/v1') return null;
  return { resource: matched[1], host: matched[2], path };
}

function azureShapeFromTemplate(template: string): { host: string; path: string } {
  const url = new URL(stripTrailingSlash(template).replace('{resource}', 'resource'));
  return { host: url.hostname.slice('resource.'.length), path: url.pathname };
}

function genericBindings(template: string, endpoint: string): Record<string, string> | null {
  if (!template.includes('{')) return stripTrailingSlash(template) === stripTrailingSlash(endpoint) ? {} : null;
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

/** Only declared account/location placeholders bind. Official host aliases stay explicit; no cross-origin guessing. */
export function providerEndpointBindings(template: string, endpoint: string): Record<string, string> | null {
  if (isVertexFamilyTemplate(template)) {
    const location = recognizeVertexLocation(endpoint);
    return location ? { location } : null;
  }
  if (isAzureOpenAIFamilyTemplate(template)) {
    const recognized = recognizeAzureBinding(endpoint);
    return recognized ? { resource: recognized.resource } : null;
  }
  return genericBindings(template, endpoint);
}

export function bindProviderEndpoint(
  template: string,
  bindings: Record<string, string>,
  sourceEndpoint?: string,
): string {
  if (isVertexFamilyTemplate(template) && bindings.location) return officialVertexEndpoint(bindings.location);
  if (isAzureOpenAIFamilyTemplate(template) && bindings.resource) {
    const fromSource = sourceEndpoint ? recognizeAzureBinding(sourceEndpoint) : null;
    const fallback = azureShapeFromTemplate(template);
    return `https://${bindings.resource}.${fromSource?.host ?? fallback.host}${fromSource?.path ?? fallback.path}`;
  }
  return template.replace(token, (source, name) => bindings[name] ?? source);
}

export function canonicalProviderEndpoint(template: string, endpoint: string): string | null {
  const bindings = providerEndpointBindings(template, endpoint);
  return bindings ? bindProviderEndpoint(template, bindings, endpoint) : null;
}

/** Only declared account/location placeholders are substituted. No cross-origin URL guessing. */
export function bindProviderPresetRuntime(runtime: ProviderPresetRuntime, endpoint: string): ProviderPresetRuntime {
  const bindings = providerEndpointBindings(runtime.baseUrl, endpoint);
  const resolved = bindings ? bindProviderEndpoint(runtime.baseUrl, bindings, endpoint) : endpoint;
  const names = bindings ?? {};
  return { ...runtime, baseUrl: resolved,
    ...(runtime.modelsUrl ? { modelsUrl: bindProviderEndpoint(runtime.modelsUrl, names, endpoint) } : {}),
    models: runtime.models.map(model => ({ ...model, ...(model.route ? { route: {
      ...model.route, baseUrl: bindProviderEndpoint(model.route.baseUrl, names, endpoint),
    } } : {}) })),
    ...(runtime.modelDiscovery ? { modelDiscovery: runtime.modelDiscovery.map(source => ({ ...source,
      baseUrl: bindProviderEndpoint(source.baseUrl, names, endpoint),
      ...(source.modelsUrl ? { modelsUrl: bindProviderEndpoint(source.modelsUrl, names, endpoint) } : {}),
    })) } : {}),
  };
}
