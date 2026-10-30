import {
  isQwenHttpModel,
  isQwenAudioHttpModel,
  isCosyVoiceHttpModel,
} from '../../shared/speechProtocols.js';
import {
  BUNDLED_CATALOG,
  isLoopbackProviderUrl,
  isModelVisible,
  providerOAuthContract,
  resolveModelNativeApi,
  type AgentKind,
  type Catalog,
  type OAuthProviderDescriptor,
  type ProviderMediaModel,
} from '@cindy/model-providers';
import {
  voiceModelKey,
  isSpeechSpeedSupported,
  type SpeechProtocol,
  type VoiceConversationModel,
  type SpeechModelSelection,
  type VoiceConversationSelection,
} from '../../shared/voiceConversation.js';
import { gatewayReferenceSpeechVoices, referenceSpeechVoices } from '../../shared/speechVoices.js';
import type { SpeechConnection } from './speech.js';
import { openRouterSpeechBaseUrl } from './openrouter.js';

export type SpeechCatalogDeps = {
  catalog: Catalog;
  gatewayAllowed: boolean;
  disabled(providerId: string, modelId: string): boolean;
  visibilityOverride?(agent: AgentKind, providerId: string, modelId: string): boolean | undefined;
  gatewayConnection(): { baseUrl: string; apiKey: string };
  readKey(providerId: string, agent: AgentKind): string | null;
  readOAuthToken?(providerId: string, oauth: OAuthProviderDescriptor): string | null;
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
  // Family rules describe chat protocols. Pass the discovered mode so a new
  // media model cannot inherit one; explicit route declarations still win.
  const declared =
    model.nativeApi !== undefined
      ? model.nativeApi
      : resolveModelNativeApi(catalog.modelRegistry, providerId, model.id, model.mode);
  return declared !== undefined
    ? declared
    : resolveModelNativeApi(BUNDLED_CATALOG.modelRegistry, providerId, model.id, model.mode);
}

/** The provider endpoint owns the adapter. Alibaba exposes different APIs on its
 * platform: also require a documented model/region pair, never a brand prefix. */
function endpointProtocol(base: URL, modelId: string): SpeechProtocol | null {
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
  if (
    ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) &&
    isQwenHttpModel(modelId)
  )
    return 'qwen-tts';
  const workspace = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.exec(
    base.hostname,
  );
  if (
    workspace &&
    (isQwenAudioHttpModel(modelId) ||
      (workspace[1] === 'cn-beijing' && isCosyVoiceHttpModel(modelId)))
  )
    return 'dashscope-tts';
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
      // Display preferences affect the picker, independently of route admission.
      // BYOK media keeps the runtime that owns both its key and display override.
      const pickerVisible = isModelVisible(
        media.sourceAgent ? deps.visibilityOverride?.(media.sourceAgent, provider.id, media.id) : undefined,
        media.defaultEnabled,
      );
      const declared = nativeProtocol(deps.catalog, provider.id, media);
      if (provider.id === 'xd') {
        if (
          !deps.gatewayAllowed ||
          media.availability !== 'available' ||
          (declared !== undefined && declared !== 'openai-audio-speech')
        )
          continue;
        const connection = deps.gatewayConnection();
        const base = apiBase(connection.baseUrl);
        if (!connection.apiKey || !base) continue;
        // Server credentials carry the deployment base shared by chat/media.
        // Version only Gateway TTS; BYOK keeps its explicitly configured API prefix.
        if (!base.pathname.endsWith('/v1'))
          base.pathname = `${base.pathname.replace(/\/+$/, '')}/v1`;
        result.push({
          model: {
            id: media.id,
            ...(pickerVisible ? {} : { pickerVisible: false }),
            name: media.name,
            providerId: 'xd',
            providerName: provider.name,
            protocol: 'openai',
            defaultVoice:
              gatewayReferenceSpeechVoices(media.id)[0]?.id ??
              referenceSpeechVoices(media.id, 'openai')[0] ??
              '',
          },
          connection: {
            baseUrl: base.toString().replace(/\/+$/, ''),
            protocol: 'openai',
            headers: { authorization: `Bearer ${connection.apiKey}` },
          },
        });
        continue;
      }
      const oauth = provider.auth.method === 'oauth' ? provider.auth.oauth : undefined;
      const openRouterOAuth = !!oauth && providerOAuthContract(oauth) === 'openrouter';
      if (
        provider.source !== 'user' ||
        provider.auth.native ||
        (!['apiKey', 'none'].includes(provider.auth.method) && !openRouterOAuth)
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
      const openRouterBase = openRouterSpeechBaseUrl(base.toString());
      const fixedProtocol = openRouterBase ? 'openai' : endpointProtocol(base, media.id);
      const detectedProtocol =
        fixedProtocol ?? (declared === 'openai-audio-speech' ? 'openai' : null);
      // A saved override cannot turn an official endpoint into another provider's API.
      // Custom proxies retain explicit choices, including for null/unverified metadata.
      const protocol = fixedProtocol ?? selection?.protocol ?? detectedProtocol;
      // Official native adapters use their documented origin endpoint. Compatible
      // OpenAI proxies keep the configured prefix (including a non-/v1 API base).
      const nativeBase =
        protocol === 'qwen-tts' || protocol === 'dashscope-tts' ? '/api/v1' : '/v1';
      if (openRouterBase) base.href = openRouterBase;
      else if (fixedProtocol && fixedProtocol !== 'openai') base.pathname = nativeBase;
      else if (!base.pathname || base.pathname === '/') base.pathname = nativeBase;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(route.headerOverride ?? {})) {
        const lower = name.toLowerCase();
        if (openRouterBase && ['anthropic-version', 'anthropic-beta'].includes(lower)) continue;
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
      } else if (provider.auth.method === 'oauth') {
        // OpenRouter PKCE issues an API key into the generic OAuth store. Admit
        // only that contract on its official API; subscription OAuth stays excluded.
        if (!openRouterOAuth || !oauth || !openRouterBase ||
            !openRouterSpeechBaseUrl(ownerBase.toString()) || route.authStrategy !== 'oauth-token') continue;
        const token = deps.readOAuthToken?.(provider.id, oauth)?.trim();
        if (!token) continue;
        headers.authorization = `Bearer ${token}`;
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
          ...(pickerVisible ? {} : { pickerVisible: false }),
          name: media.name,
          providerId: provider.id,
          providerName: provider.name,
          agent,
          protocol: detectedProtocol ?? undefined,
          protocolLocked: !!fixedProtocol,
          // OpenRouter's voices come from supported_voices, not vendor references.
          defaultVoice: openRouterBase
            ? '' : referenceSpeechVoices(media.id, protocol ?? undefined)[0] ?? '',
          ...(openRouterBase ? { speedRange: null } : {}),
        },
        connection: protocol
          ? {
              baseUrl: base.toString().replace(/\/+$/, ''), headers, protocol,
              // OpenRouter speed is model/provider-dependent. Keep the provider
              // default until its route advertises a verified range; many reject overrides.
              ...(openRouterBase ? { speedRange: null } : {}),
            }
          : null,
      });
    }
  }
  return result;
}

/** Admitted routes include hidden saved choices; pickerVisible only controls discovery UI.
 * Registry entries alone never add catalog membership or grant a credential. */
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
  if (
    'speed' in selection &&
    !isSpeechSpeedSupported(
      selection.modelId, binding.connection.protocol, selection.speed, binding.connection.speedRange,
    )
  )
    throw new Error('invalid_speech_speed');
  return binding.connection;
}
