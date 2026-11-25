import { GLM_API_BASE, GLM_REALTIME_FLASH, hasGlmFlashDiscovery, isGlmPresetRoute } from '../../shared/glmRealtimeDiscovery.js';
import { realtimeSocketUrl, realtimeHeaders } from './realtimeProtocol.js';
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
      const candidates = media.id === GLM_REALTIME_FLASH ? provider.agents : [media.sourceAgent];
      for (const agent of candidates) {
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
        const glmPreset = media.id === GLM_REALTIME_FLASH && isGlmPresetRoute(owner.href, configured.catalogPresetId)
          && isGlmPresetRoute(base.href, configured.catalogPresetId);
        const voiceBase = glmPreset ? new URL(GLM_API_BASE) : base;
        const fixed = officialRealtimeProtocol(voiceBase, media.id);
        if (agent !== media.sourceAgent && fixed !== 'glm-realtime') continue;
        if (fixed === 'glm-realtime' && (
          (!glmPreset && officialRealtimeProtocol(owner, media.id) !== fixed) ||
          (configured.catalogPresetId && configured.catalogPresetId !== 'zhipu-glm-cn') ||
          configured.mode !== 'realtime' || (configured.availability && configured.availability !== 'available') ||
          !hasGlmFlashDiscovery(configured.userModelConfig) || configured.userModelConfig?.missingUpstream
        )) continue;
        // Known official conversational models have documented audio I/O. Unknown
        // proxies must explicitly declare both modalities as well as their protocol.
        if (!fixed && !media.modalities) continue;
        // Official services cannot be reinterpreted as compatible proxies. In particular
        // Coding Plan, US/unsupported regions and Qwen Omni are not this adapter.
        const official =
          base.hostname === 'open.bigmodel.cn' || base.hostname === 'api.openai.com' || base.hostname.endsWith('.aliyuncs.com');
        if (official && !fixed) continue;
        const protocol = fixed ?? selection?.protocol;
        if (protocol === 'glm-realtime' && !fixed) continue;
        const key = deps.readKey(provider.id, agent)?.trim();
        if (!key) continue;
        const headers = realtimeHeaders(key, glmPreset ? undefined : route.headerOverride, route.headerDelete);
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
              agent === media.sourceAgent ? media.defaultEnabled : configured.defaultEnabled,
            ),
          },
          connection: protocol ? { url: realtimeSocketUrl(voiceBase, media.id, fixed), headers, protocol } : undefined,
        });
        break;
      }
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
