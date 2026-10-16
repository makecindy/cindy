import {
  BUNDLED_CATALOG,
  isLoopbackProviderUrl,
  resolveModelNativeApi,
  type AgentKind,
  type Catalog,
  type ProviderMediaModel,
} from '@cindy/model-providers';
import {
  voiceModelKey,
  type SpeechProtocol,
  type VoiceConversationModel,
  type SpeechModelSelection,
  type VoiceConversationSelection,
} from '../../shared/voiceConversation.js';
import { referenceSpeechVoices } from '../../shared/speechVoices.js';
import type { SpeechConnection } from './speech.js';

export type SpeechCatalogDeps = {
  catalog: Catalog;
  gatewayAllowed: boolean;
  disabled(providerId: string, modelId: string): boolean;
  gatewayConnection(): { baseUrl: string; apiKey: string };
  readKey(providerId: string, agent: AgentKind): string | null;
};
type Binding = { model: VoiceConversationModel; connection: SpeechConnection | null };

function apiBase(raw: string): URL | null {
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
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

/**
 * Future Registry protocol/parameter metadata must describe the actual provider/model
 * route, not a model family. Coordinate server declarations, client validation and the
 * bundled copy; metadata alone neither installs an executor nor grants model access.
 * Preserve undefined/null and explicit user-choice semantics during that migration.
 * See docs/product-rules/companion-voice-mode.md, "后续扩展计划".
 */
function nativeProtocol(catalog: Catalog, providerId: string, model: ProviderMediaModel) {
  const declared =
    model.nativeApi !== undefined
      ? model.nativeApi
      : resolveModelNativeApi(catalog.modelRegistry, providerId, model.id);
  return declared !== undefined
    ? declared
    : resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, providerId, model.id);
}

/** Official endpoints fix the adapter, independently of model names or catalog metadata. */
function endpointProtocol(base: URL): SpeechProtocol | null {
  if (base.protocol !== 'https:' || base.port) return null;
  if (base.hostname === 'api.elevenlabs.io') return 'elevenlabs';
  if (
    [
      'api.minimax.io',
      'api.minimax.cn',
      'api.minimaxi.com',
      'api.minimax.chat',
      'api-uw.minimax.io',
    ].includes(base.hostname)
  )
    return 'minimax';
  if (base.hostname === 'api.openai.com') return 'openai';
  return null;
}

function bindings(deps: SpeechCatalogDeps, selection?: SpeechModelSelection): Binding[] {
  const result: Binding[] = [];
  for (const provider of deps.catalog.providers) {
    if (selection && provider.id !== (selection.providerId ?? 'xd')) continue;
    for (const media of provider.audioModels ?? []) {
      if (selection && media.id !== selection.modelId) continue;
      if (
        media.mode !== 'audio_speech' ||
        media.disabled ||
        deps.disabled(provider.id, media.id) ||
        (media.availability !== undefined && media.availability !== 'available')
      )
        continue;
      const declared = nativeProtocol(deps.catalog, provider.id, media);
      if (provider.id === 'xd') {
        if (
          !deps.gatewayAllowed ||
          media.availability !== 'available' ||
          (declared !== undefined && declared !== 'openai-audio-speech')
        )
          continue;
        const connection = deps.gatewayConnection();
        if (!connection.apiKey || !apiBase(connection.baseUrl)) continue;
        result.push({
          model: {
            id: media.id,
            name: media.name,
            providerId: 'xd',
            providerName: provider.name,
            protocol: 'openai',
            defaultVoice: referenceSpeechVoices(media.id, 'openai')[0] ?? '',
          },
          connection: {
            baseUrl: connection.baseUrl,
            protocol: 'openai',
            headers: { authorization: `Bearer ${connection.apiKey}` },
          },
        });
        continue;
      }
      if (
        provider.source !== 'user' ||
        provider.auth.native ||
        !['apiKey', 'none'].includes(provider.auth.method)
      )
        continue;
      const agent = media.sourceAgent;
      if (!agent) continue;
      const route = provider.routing[agent];
      const model = provider.models[agent]?.find((entry) => entry.id === media.id);
      if (!route || route.disabled || route.headerOverrideState === 'unknown' || !model) continue;
      const base = apiBase(model.route?.baseUrl ?? route.upstream);
      const ownerBase = apiBase(route.upstream);
      if (!base || !ownerBase || base.origin !== ownerBase.origin) continue;
      const fixedProtocol = endpointProtocol(base);
      const detectedProtocol =
        fixedProtocol ?? (declared === 'openai-audio-speech' ? 'openai' : null);
      // A saved override cannot turn an official endpoint into another provider's API.
      // Custom proxies retain explicit choices, including for null/unverified metadata.
      const protocol = fixedProtocol ?? selection?.protocol ?? detectedProtocol;
      // Official native adapters use their documented origin endpoint. Compatible
      // OpenAI proxies keep the configured prefix (including a non-/v1 API base).
      if (fixedProtocol && fixedProtocol !== 'openai') base.pathname = '/v1';
      else if (!base.pathname || base.pathname === '/') base.pathname = '/v1';
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(route.headerOverride ?? {})) {
        const lower = name.toLowerCase();
        if (
          [
            'authorization',
            'x-api-key',
            'xi-api-key',
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
        if (route.authStrategy !== 'none' || !isLoopbackProviderUrl(base.toString())) continue;
      } else {
        if (route.authStrategy !== 'api-key-header') continue;
        const key = deps.readKey(provider.id, agent)?.trim();
        if (!key) continue;
        headers[protocol === 'elevenlabs' ? 'xi-api-key' : 'authorization'] =
          protocol === 'elevenlabs' ? key : `Bearer ${key}`;
      }
      result.push({
        model: {
          id: media.id,
          name: media.name,
          providerId: provider.id,
          providerName: provider.name,
          agent,
          protocol: detectedProtocol ?? undefined,
          protocolLocked: !!fixedProtocol,
          defaultVoice: referenceSpeechVoices(media.id, protocol ?? undefined)[0] ?? '',
        },
        connection: protocol
          ? { baseUrl: base.toString().replace(/\/+$/, ''), headers, protocol }
          : null,
      });
    }
  }
  return result;
}

/** Registry entries alone never add catalog membership or grant a credential. */
export function speechModels(deps: SpeechCatalogDeps): VoiceConversationModel[] {
  return bindings(deps).map((binding) => binding.model);
}
export function resolveSpeechConnection(
  deps: SpeechCatalogDeps,
  selection: SpeechModelSelection | VoiceConversationSelection,
): SpeechConnection {
  const binding = bindings(deps, selection).find(
    (entry) => voiceModelKey(entry.model) === voiceModelKey(selection),
  );
  if (!binding?.connection) throw new Error('model_unavailable');
  return binding.connection;
}
