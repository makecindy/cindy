import { isLoopbackProviderUrl, isModelVisible } from '@cindy/model-providers';
import {
  officialRealtimeProtocol,
  realtimeSystemVoices,
  type RealtimeVoiceModel,
  type RealtimeVoiceSelection,
  type RealtimeProtocol,
} from '../../shared/realtimeVoice.js';
import { voiceModelKey } from '../../shared/voiceConversation.js';
import type { SpeechCatalogDeps } from './models.js';

export type RealtimeConnection = {
  url: string;
  headers: Record<string, string>;
  protocol: RealtimeProtocol;
};
function apiBase(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (url.protocol === 'http:' && !isLoopbackProviderUrl(raw)) return;
    return url;
  } catch {
    return;
  }
}

type RealtimeRoute = Pick<RealtimeVoiceSelection, 'agent' | 'providerId' | 'modelId' | 'protocol'>;

function bindings(deps: SpeechCatalogDeps, selection?: RealtimeRoute) {
  const result: { model: RealtimeVoiceModel; connection?: RealtimeConnection }[] = [];
  for (const provider of deps.catalog.providers) {
    if (
      provider.source !== 'user' ||
      provider.auth.native ||
      provider.auth.method !== 'apiKey' ||
      (selection && selection.providerId !== provider.id)
    )
      continue;
    for (const media of provider.audioModels ?? []) {
      if (
        media.mode !== 'realtime' ||
        media.disabled ||
        deps.disabled(provider.id, media.id) ||
        (media.availability !== undefined && media.availability !== 'available')
      )
        continue;
      if (
        media.modalities &&
        (!media.modalities.input.includes('audio') || !media.modalities.output.includes('audio'))
      )
        continue;
      const agent = media.sourceAgent;
      if (!agent || (selection && (selection.agent !== agent || selection.modelId !== media.id)))
        continue;
      const route = provider.routing[agent];
      const configured = provider.models[agent]?.find((m) => m.id === media.id);
      if (
        !route ||
        route.disabled ||
        route.headerOverrideState === 'unknown' ||
        !configured ||
        route.authStrategy !== 'api-key-header'
      )
        continue;
      const owner = apiBase(route.upstream);
      const base = apiBase(configured.route?.baseUrl ?? route.upstream);
      if (!base || !owner || base.origin !== owner.origin) continue;
      const fixed = officialRealtimeProtocol(base, media.id);
      // Known official conversational models have documented audio I/O. Unknown
      // proxies must explicitly declare both modalities as well as their protocol.
      if (!fixed && !media.modalities) continue;
      // Official services cannot be reinterpreted as compatible proxies. In particular
      // Coding Plan, US/unsupported regions and Qwen Omni are not this adapter.
      const official =
        base.hostname === 'api.openai.com' || base.hostname.endsWith('.aliyuncs.com');
      if (official && !fixed) continue;
      const protocol = fixed ?? selection?.protocol;
      const key = deps.readKey(provider.id, agent)?.trim();
      if (!key) continue;
      const headers: Record<string, string> = {};
      const excluded =
        /^(authorization|proxy-authorization|cookie|host|connection|content-type|content-length|upgrade|sec-websocket-.*|x-api-key|api-key|xi-api-key|openai-beta|chatgpt-account-id|openai-account-id|originator|session_id)$/i;
      for (const [name, value] of Object.entries(route.headerOverride ?? {}))
        if (!excluded.test(name)) headers[name.toLowerCase()] = value;
      for (const name of route.headerDelete ?? []) delete headers[name.toLowerCase()];
      headers.authorization = `Bearer ${key}`;
      if (fixed === 'qwen-audio-realtime') base.pathname = '/api-ws/v1/realtime';
      else base.pathname = `${base.pathname.replace(/\/+$/, '') || '/v1'}/realtime`;
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      base.searchParams.set('model', media.id);
      result.push({
        model: {
          id: media.id,
          name: media.name,
          providerId: provider.id,
          providerName: provider.name,
          agent,
          protocol: fixed,
          protocolLocked: !!fixed,
          ...(fixed === 'qwen-audio-realtime' ? {
            systemVoices: realtimeSystemVoices(fixed, media.id, base.href),
            hasCustomVoiceCatalog: !base.hostname.startsWith('token-plan.'),
          } : {}),
          pickerVisible: isModelVisible(
            deps.visibilityOverride?.(agent, provider.id, media.id),
            media.defaultEnabled,
          ),
        },
        connection: protocol ? { url: base.toString(), headers, protocol } : undefined,
      });
    }
  }
  return result;
}
export function realtimeModels(deps: SpeechCatalogDeps): RealtimeVoiceModel[] {
  return bindings(deps).map((b) => b.model);
}
export function resolveRealtimeConnection(
  deps: SpeechCatalogDeps,
  selection: RealtimeRoute,
): RealtimeConnection {
  const binding = bindings(deps, selection).find(
    (b) => voiceModelKey(b.model) === voiceModelKey(selection),
  );
  if (!binding?.connection) throw new Error('realtime_model_unavailable');
  return binding.connection;
}

/** Never move a BYOK credential to another origin or query an arbitrary WS proxy. */
export function realtimeCustomVoiceConnection(deps: SpeechCatalogDeps, route: RealtimeRoute) {
  const connection = resolveRealtimeConnection(deps, route);
  const url = new URL(connection.url);
  if (url.protocol !== 'wss:') throw new Error('voice_catalog_unavailable');
  url.protocol = 'https:';
  if (officialRealtimeProtocol(url, route.modelId) !== 'qwen-audio-realtime' || url.hostname.startsWith('token-plan.'))
    throw new Error('voice_catalog_unavailable');
  return { baseUrl: url.origin + '/api/v1', protocol: 'qwen-audio-realtime' as const, headers: connection.headers };
}
