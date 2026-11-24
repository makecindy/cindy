import { isLoopbackProviderUrl, type AgentKind, type MediaCapability, type Provider, type ProviderMediaModel, type ProviderVideoApi } from '@cindy/model-providers';
import { withProviderAppAttribution } from '../maker-host/provider-app-attribution.js';
import { supportsMediaCapability } from '../cindy-media/mediaCapabilities.js';
import { createHash } from 'node:crypto';
import type { MediaGuideTarget } from '../cindy-media/localGuideStore.js';

export function isCustomMediaGuideProvider(provider: Provider): boolean {
  return provider.source === 'user' && !provider.auth.native && ['apiKey', 'none'].includes(provider.auth.method);
}

/** Native media belongs to its provider account, not a chat runtime. Keep one
 * canonical key in the existing store; custom HTTP connections retain their keys. */
export function mediaGuideTarget(provider: Provider | undefined, target: MediaGuideTarget): MediaGuideTarget {
  return provider && !isCustomMediaGuideProvider(provider) ? { ...target, agent: 'pi' } : target;
}

export function mediaGuideModel(provider: Provider | undefined, target: MediaGuideTarget) {
  if (!provider || provider.id === 'xd') return undefined;
  const declared = provider.models[target.agent]?.find(model => model.id === target.modelId);
  if (isCustomMediaGuideProvider(provider)) return declared;
  const image = provider.imageModels?.find(model => model.id === target.modelId);
  const video = provider.videoModels?.find(model => model.id === target.modelId);
  const model = image ?? video;
  return model ? { ...model, mode: image ? 'image_generation' as const : 'video_generation' as const,
    modalities: model.modalities ?? { input: ['text', 'image'], output: [image ? 'image' : 'video'] } } : declared;
}

export function mediaGuideScope(provider: Provider | undefined, target: MediaGuideTarget): string | null {
  const model = mediaGuideModel(provider, target);
  if (!provider || !model || !['image_generation', 'video_generation'].includes(model.mode ?? '')) return null;
  if (!isCustomMediaGuideProvider(provider))
    return createHash('sha256').update(JSON.stringify(['native-media', provider.id, model.id, provider.auth])).digest('hex');
  const route = provider.routing[target.agent];
  const declared = provider.models[target.agent]?.find(candidate => candidate.id === target.modelId);
  if (!route) return null;
  return createHash('sha256').update(JSON.stringify([target, declared?.route?.baseUrl ?? route.upstream,
    route.authStrategy, declared?.route?.wireProtocol ?? route.wireProtocol])).digest('hex');
}

export interface CustomMediaConnection { agent: AgentKind; baseUrl: string; headers: Record<string, string>; videoApi?: ProviderVideoApi; }
export interface CustomMediaConnectionOptions { getProvider(): Provider | undefined; readApiKey(agent: AgentKind): string | null; isOwnerBoundaryPending(): boolean; }

export function customMediaAgents(provider: Provider, model: ProviderMediaModel, capabilities: readonly MediaCapability[] = []): AgentKind[] {
  return (model.sourceAgents ?? (model.sourceAgent ? [model.sourceAgent] : [])).filter(agent => {
    const route = provider.routing[agent];
    const member = provider.models[agent]?.find(candidate => candidate.id === model.id && candidate.mode === model.mode);
    return !!route && !route.disabled && !!member && !member.disabled &&
      capabilities.every(capability => supportsMediaCapability(member.modalities ?? {
        input: ['text'], output: [model.mode === 'image_generation' ? 'image' : 'video'],
      }, capability));
  });
}

export function customMediaGuideProtocol(provider: Provider | undefined, modelId: string, agent: AgentKind): string | undefined {
  const route = provider?.routing[agent];
  const mode = provider?.models[agent]?.find(model => model.id === modelId)?.mode;
  if (mode === 'image_generation') return route?.imageApi === 'openai-images' ? 'openai' : undefined;
  return mode === 'video_generation' ? route?.videoApi : undefined;
}

/** Preserve gateway path prefixes, accepting either an API origin or a /v1 base. */
function mediaBaseUrl(raw: string, preservePath = false): string | null {
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = preservePath || path.endsWith('/v1') ? path : `${path}/v1`;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Explicit API-key/loopback connections only; native subscription auth stays in its channel. */
export function isCustomImageProvider(provider: Provider): boolean {
  return (
    provider.source === 'user' &&
    !provider.auth.native &&
    (provider.auth.method === 'apiKey' || provider.auth.method === 'none') &&
    (provider.imageModels?.length ?? 0) > 0 &&
    Object.values(provider.routing).some((route) => route?.imageApi === 'openai-images')
  );
}

export function resolveCustomMediaConnection(
  opts: CustomMediaConnectionOptions,
  modelId: string,
  kind: 'image' | 'video' = 'image',
  selection?: { guideDriven?: true; agent: AgentKind },
): CustomMediaConnection | null {
  const provider = opts.getProvider();
  if (opts.isOwnerBoundaryPending() || !provider) return null;
  const guideDriven = selection?.guideDriven === true;
  if (guideDriven ? provider.source !== 'user' || !!provider.auth.native || !['apiKey', 'none'].includes(provider.auth.method)
    : !(kind === 'image' ? isCustomImageProvider(provider) : isCustomVideoProvider(provider))) return null;
  const media = (kind === 'image' ? provider.imageModels : provider.videoModels)?.find((model) => model.id === modelId);
  // Never borrow another runtime's credentials when the model's own route is missing.
  const agent = selection?.agent ?? media?.sourceAgent;
  if (!agent) return null;
  const route = provider.routing[agent];
  const model = provider.models[agent]?.find((model) => model.id === modelId);
  if (
    !route ||
    route.disabled ||
    (!guideDriven && (kind === 'image' ? route.imageApi !== 'openai-images' : !route.videoApi)) ||
    !model ||
    (selection && model.mode !== (kind === 'image' ? 'image_generation' : 'video_generation')) ||
    route.headerOverrideState === 'unknown'
  )
    return null;
  const upstream = model.route?.baseUrl ?? route.upstream;
  const v1BaseUrl = mediaBaseUrl(upstream, guideDriven);
  // MiniMax video paths are versioned at the API root (/v2/...), not under /v1.
  const baseUrl = !guideDriven && kind === 'video' && route.videoApi === 'minimax-videos' ? v1BaseUrl?.replace(/\/v1$/, '') : v1BaseUrl;
  if (!baseUrl || !mediaBaseUrl(route.upstream)) return null;
  // Model overrides must stay within the credential owner's origin.
  if (new URL(upstream).origin !== new URL(route.upstream).origin) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(withProviderAppAttribution(baseUrl, route.headerOverride, {}, route.headerDelete))) {
    // Authentication belongs to this connection. Multipart boundaries, host and
    // body length are generated by fetch, never inherited from chat headers.
    const lower = name.toLowerCase();
    if (
      [
        'authorization',
        'x-api-key',
        'api-key',
        'cookie',
        'host',
        'content-type',
        'content-length',
        'connection',
        'chatgpt-account-id',
        'openai-account-id',
        'openai-beta',
        'originator',
        'session_id',
      ].includes(lower)
    )
      continue;
    headers[lower] = value;
  }
  for (const name of route.headerDelete ?? []) delete headers[name.toLowerCase()];
  if (provider.auth.method === 'none') {
    if (route.authStrategy !== 'none' || !isLoopbackProviderUrl(baseUrl)) return null;
  } else {
    if (route.authStrategy !== 'api-key-header') return null;
    const key = opts.readApiKey(agent)?.trim();
    if (!key) return null;
    headers.authorization = `Bearer ${key}`;
    if (guideDriven) {
      // Reuse only this runtime's existing managed authentication configuration.
      // A Guide can neither supply these values nor choose another key owner.
      const configured = new Headers(route.headerOverride);
      const protocol = model.route?.wireProtocol ?? route.wireProtocol;
      if (configured.has('api-key')) headers['api-key'] = configured.get('api-key')!;
      if (configured.has('x-api-key') || protocol === 'anthropic-messages') headers['x-api-key'] = key;
      if (configured.has('x-goog-api-key') || protocol === 'google-generative-ai') headers['x-goog-api-key'] = key;
    }
  }
  return { agent, baseUrl, headers, ...(kind === 'video' ? { videoApi: route.videoApi } : {}) };
}

export function isCustomVideoProvider(provider: Provider): boolean {
  return provider.source === 'user' && !provider.auth.native &&
    (provider.auth.method === 'apiKey' || provider.auth.method === 'none') &&
    (provider.videoModels?.length ?? 0) > 0 &&
    Object.values(provider.routing).some(route => route?.videoApi !== undefined);
}
