import {
  BUNDLED_CATALOG,
  buildUserProvider,
  findBaseModel,
  type AgentKind,
  type Catalog,
  type CustomProviderConfig,
  type ModelMetadata,
  type ProviderPreset,
  type ProviderRuntimeModelConfig,
  type ProviderView,
} from '@cindy/model-providers';

export type SpeechService = 'minimax' | 'elevenlabs' | 'openai' | 'bailian';

/** Onboarding references only: no account entitlement or synthesis probe is implied. */
const references: Record<Exclude<SpeechService, 'bailian'>, string[]> = {
  minimax: ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-02-turbo'],
  elevenlabs: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'],
  openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
};

const bailianTokenPlanHosts = [
  'token-plan.cn-beijing.maas.aliyuncs.com',
  'token-plan.ap-southeast-1.maas.aliyuncs.com',
];
const bailianWorkspaceHost = /^(?!token-plan\.)[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/;

function bailianReferences(hostname: string): string[] {
  // Match the native HTTP endpoint/model scope in #6660. Public DashScope uses
  // Qwen3's multimodal API; CosyVoice's HTTP API requires a Beijing workspace.
  // These suggestions neither rewrite the connection nor prove account access.
  if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(hostname))
    return ['qwen3-tts-flash'];
  // Token Plan has its own model scope; it isn't a workspace. Its documented
  // Beijing TTS model uses the existing DashScope HTTP adapter, not CosyVoice.
  // https://help.aliyun.com/zh/model-studio/token-plan-multimodal-gen
  if (hostname === 'token-plan.cn-beijing.maas.aliyuncs.com')
    return ['qwen-audio-3.0-tts-plus'];
  const region = bailianWorkspaceHost.exec(hostname)?.[1];
  if (region === 'cn-beijing') return ['cosyvoice-v3-flash', 'cosyvoice-v3-plus'];
  if (region === 'ap-southeast-1') return ['qwen-audio-3.0-tts-flash', 'qwen-audio-3.0-tts-plus'];
  // The US endpoint has no verified native TTS binding; discovery/manual entry
  // stays available without a guessed default or recommended reference model.
  return [];
}

export function speechServiceForUrl(value: string): SpeechService | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const path = url.pathname.replace(/\/+$/, '');
    if (
      [
        'api.minimax.io',
        'api.minimax.cn',
        'api.minimaxi.com',
        'api.minimax.chat',
        'api-uw.minimax.io',
      ].includes(url.hostname) &&
      ['', '/v1', '/anthropic'].includes(path)
    )
      return 'minimax';
    if (url.hostname === 'api.elevenlabs.io' && ['', '/v1'].includes(path)) return 'elevenlabs';
    if (url.hostname === 'api.openai.com' && ['', '/v1'].includes(path)) return 'openai';
    if (
      ([
        'dashscope.aliyuncs.com',
        'dashscope-intl.aliyuncs.com',
        'dashscope-us.aliyuncs.com',
      ].includes(url.hostname) ||
        bailianTokenPlanHosts.includes(url.hostname) ||
        bailianWorkspaceHost.test(url.hostname)) &&
      ['/api/v1', '/compatible-mode/v1'].includes(path)
    )
      return 'bailian';
  } catch {
    /* Invalid/unrecognized endpoints keep the manual connection flow. */
  }
}

export function isSpeechModel(model: {
  id: string;
  mode?: string;
  discoveredMetadata?: ModelMetadata;
}): boolean {
  return (
    (model.mode ??
      model.discoveredMetadata?.mode ??
      findBaseModel(BUNDLED_CATALOG.modelRegistry, model.id)?.defaults.mode) === 'audio_speech'
  );
}

export function speechReferenceModels(baseUrl: string): ProviderRuntimeModelConfig[] {
  const service = speechServiceForUrl(baseUrl);
  if (!service) return [];
  const ids =
    service === 'bailian' ? bailianReferences(new URL(baseUrl).hostname) : references[service];
  // Names/capabilities remain owned by the shared Registry. This list only orders
  // a few setup suggestions; adding one is an explicit user membership decision.
  return ids.flatMap((id, index) => {
    const base = findBaseModel(BUNDLED_CATALOG.modelRegistry, id);
    return base?.defaults.mode === 'audio_speech'
      ? [{ id, name: base.defaults.name ?? id, defaultEnabled: index === 0 }]
      : [];
  });
}

export function speechSetupTarget(runtimes: ProviderPreset['runtimes']) {
  for (const agent of ['codex', 'pi', 'claude-code'] as const) {
    const runtime = runtimes[agent];
    const service = runtime && speechServiceForUrl(runtime.baseUrl);
    if (service) return { agent, service };
  }
}

/** These are local connection forms, like OFFICIAL_API_PRESETS, not Registry entries. */
export const SPEECH_API_PRESETS: ProviderPreset[] = [
  {
    id: 'elevenlabs-api',
    name: 'ElevenLabs',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    runtimes: {
      codex: { baseUrl: 'https://api.elevenlabs.io/v1', wireProtocol: 'openai-chat', models: [] },
    },
  },
  ...(['global', 'cn'] as const).map((region): ProviderPreset => ({
    id: `aliyun-bailian-api-${region}`,
    name: region === 'cn' ? '阿里云百炼 API（中国大陆）' : '阿里云百炼 API',
    nameEn:
      region === 'cn'
        ? 'Alibaba Cloud Model Studio API (Mainland China)'
        : 'Alibaba Cloud Model Studio API',
    nameZhTW: region === 'cn' ? '阿里雲百煉 API（中國大陸）' : '阿里雲百煉 API',
    regionHint: region,
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    runtimes: {
      codex: {
        baseUrl: `https://${region === 'cn' ? 'dashscope' : 'dashscope-intl'}.aliyuncs.com/compatible-mode/v1`,
        wireProtocol: 'openai-chat',
        baseUrlEditable: true,
        models: [{ id: 'qwen-plus', name: 'Qwen Plus' }],
      },
    },
  })),
];

export function withSpeechApiPresets(presets: ProviderPreset[]): ProviderPreset[] {
  return [
    ...presets,
    ...SPEECH_API_PRESETS.filter((fallback) => {
      const target = speechSetupTarget(fallback.runtimes)!;
      const origin = new URL(fallback.runtimes[target.agent]!.baseUrl).origin;
      return !presets.some((existing) => {
        if (existing.id === fallback.id) return true;
        // Prefer the server's official connection form even when it has a newer ID.
        // Coding/Token Plan endpoints are distinct and must not suppress API access.
        const existingTarget = speechSetupTarget(existing.runtimes);
        return (
          existingTarget?.service === target.service &&
          new URL(existing.runtimes[existingTarget.agent]!.baseUrl).origin === origin
        );
      });
    }),
  ];
}

export function providerSpeechSetup(
  provider: ProviderView,
): { agent: AgentKind; service: SpeechService } | undefined {
  if (provider.source !== 'user' || provider.suspended || provider.auth.method !== 'apiKey') return;
  for (const agent of ['codex', 'pi', 'claude-code'] as const) {
    const route = provider.routing[agent];
    if (!route || route.disabled) continue;
    const service = speechServiceForUrl(route.upstream);
    if (!service) continue;
    return { agent, service };
  }
}

/** Manual refresh only: suggest one reference after successful catalog discovery. */
export function missingSpeechReference(
  provider: ProviderView,
  config: CustomProviderConfig,
  refreshedAgents: ReadonlySet<AgentKind>,
  catalog: Pick<Catalog, 'modelRegistry' | 'presets'>,
): { agent: AgentKind; model: ProviderRuntimeModelConfig } | undefined {
  const target = providerSpeechSetup(provider);
  if (!target || !refreshedAgents.has(target.agent)) return;
  const models = Object.values(config.runtimes).flatMap(runtime => runtime?.models ?? []);
  // Hidden speech is still a saved choice. Never fill a different runtime or
  // override discovery/user classification of an existing reference ID.
  // Reproject after discovery: new IDs are absent from the previous ProviderView,
  // and current Registry defaults must not be persisted as discovery/user fields.
  const projected = buildUserProvider(config, catalog);
  if (provider.audioModels?.some(model => model.mode === 'audio_speech') ||
    projected.audioModels?.some(model => model.mode === 'audio_speech')) return;
  const runtime = config.runtimes[target.agent];
  if (!runtime) return;
  const model = speechReferenceModels(runtime.baseUrl).find(reference => reference.defaultEnabled);
  if (!model || models.some(existing => existing.id === model.id)) return;
  // Bundled references only nominate an ID. Resolve the unsaved candidate with
  // the same active Registry/preset layers that will classify it after saving.
  const candidate = buildUserProvider({ ...config, runtimes: { ...config.runtimes,
    [target.agent]: { ...runtime, models: [...runtime.models, model] },
  } }, catalog);
  if (!candidate.audioModels?.some(entry => entry.id === model.id &&
    entry.sourceAgent === target.agent && entry.mode === 'audio_speech')) return;
  return { agent: target.agent, model };
}

/** Merge under Main's mutation queue, preserving concurrent edits and all existing models. */
export function appendSpeechModels(
  current: CustomProviderConfig,
  request: CustomProviderConfig,
  presets: ProviderPreset[] = [],
): CustomProviderConfig {
  if ((current.auth?.method ?? 'apiKey') !== 'apiKey')
    throw new Error('api_key_connection_required');
  const next = structuredClone(current);
  // Compare the current effective route with the dialog's projected snapshot.
  // Do not reapply presets to the snapshot: that would hide a genuinely stale URL.
  // Append to the stored config below without persisting derived preset fields.
  const currentRouting = buildUserProvider(current, { presets }).routing;
  const requestedRouting = buildUserProvider(request).routing;
  const known = new Set(
    Object.values(next.runtimes).flatMap(
      (runtime) => runtime?.models.map((model) => model.id) ?? [],
    ),
  );
  for (const [key, draft] of Object.entries(request.runtimes)) {
    const agent = key as AgentKind;
    const runtime = next.runtimes[agent];
    if (
      !draft ||
      !runtime ||
      currentRouting[agent]?.upstream !== requestedRouting[agent]?.upstream ||
      currentRouting[agent]?.wireProtocol !== requestedRouting[agent]?.wireProtocol ||
      currentRouting[agent]?.requestPath !== requestedRouting[agent]?.requestPath ||
      currentRouting[agent]?.modelsUrl !== requestedRouting[agent]?.modelsUrl
    )
      throw new Error('connection_changed');
    for (const model of draft.models) {
      if (!isSpeechModel(model)) throw new Error('speech_model_required');
      if (known.has(model.id)) continue;
      runtime.models.push(structuredClone(model));
      known.add(model.id);
    }
  }
  return next;
}
