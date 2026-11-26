import {
  BUNDLED_CATALOG,
  availableModelInterfaces,
  isMimoTokenPlanPreset,
  providerOAuthContract,
  providerPresetOAuthRuntimes,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

// These presets are purchased allowances, not the same manufacturers' metered APIs.
const planPresets = new Set([
  'moonshot-kimi-code',
  'aliyun-bailian-coding', 'aliyun-bailian-token-plan-cn', 'aliyun-bailian-token-plan-team-cn',
  'qwen-token-plan', 'qwen-token-plan-individual',
  'zhipu-coding-plan-cn', 'zai-coding-plan-global',
  'volcengine-agent-plan', 'volcengine-coding-plan', 'tencentcloud-coding-plan',
  'opencode-go',
]);

const endpointKey = (url: string) => url.replace(/\/+$/, '');
// https://www.kimi.com/code/docs/kimi-code/models.html#模型总览
// These are the product maxima, not an entitlement for the signed-in tier.
const kimiCodeMaxContext = new Map([
  ['k3.1-pro', 1_048_576], ['k3.1-pro-highspeed', 1_048_576], ['k3', 1_048_576],
  ['k3-256k', 262_144], ['kimi-for-coding', 1_048_576], ['kimi-for-coding-highspeed', 262_144],
]);
const kimiCodeEndpoints = new Set(['https://api.kimi.com/coding', 'https://api.kimi.com/coding/v1',
  'https://api.kimi.ai/coding', 'https://api.kimi.ai/coding/v1']);

/** Read-only model facts, before public catalog defaults are merged into the runtime model. */
export function subscriptionPlanModelDetails(provider: ProviderView, agent: AgentKind, model: CatalogModel) {
  const routing = provider.routing?.[agent];
  if (!routing?.upstream) return undefined;
  // Presets can seed explicit model routes through their provider catalog.
  const configuredRoute = model.userModelConfig?.route;
  const modelRoute = configuredRoute ?? model.route;
  const endpoint = endpointKey(modelRoute?.baseUrl ?? routing.upstream);
  const configuredPreset = routing.usagePresetId ?? model.catalogPresetId;
  const oauth = provider.auth?.method === 'oauth' ? provider.auth.oauth : undefined;
  const isMiniMaxSubscription = oauth !== undefined && providerOAuthContract(oauth) === 'minimax';
  const presets = BUNDLED_CATALOG.presets ?? [];
  const candidates = presets.flatMap(preset => {
    const miniMax = isMiniMaxSubscription && (preset.id === 'minimax-cn' || preset.id === 'minimax-global');
    if (!miniMax && !planPresets.has(preset.id) && !isMimoTokenPlanPreset(preset)) return [];
    const runtime = (miniMax ? providerPresetOAuthRuntimes(preset) : preset.runtimes)[agent];
    if (!runtime) return [];
    const presetEndpoint = endpointKey(runtime.baseUrl);
    const presetModelRoute = runtime.models.find(item => item.id === model.id)?.route;
    const seededRoute = configuredRoute && presetModelRoute
      && endpointKey(configuredRoute.baseUrl) === endpointKey(presetModelRoute.baseUrl)
      && configuredRoute.wireProtocol === presetModelRoute.wireProtocol
      && configuredRoute.requestPath === presetModelRoute.requestPath;
    const followsPreset = configuredPreset === preset.id && presetEndpoint === endpointKey(routing.upstream)
      && (configuredRoute === undefined || seededRoute);
    // A saved connection may use a declared transport directly. Only an explicit
    // plan identity can disambiguate that URL from another product's interface.
    const declaredInterface = configuredPreset === preset.id && availableModelInterfaces(
      BUNDLED_CATALOG.modelRegistry, preset.id, model.id, endpoint, agent,
    ).some(({ route }) => endpointKey(route.baseUrl) === endpoint
      && route.wireProtocol === (modelRoute?.wireProtocol ?? routing.wireProtocol)
      && route.requestPath === (modelRoute ? modelRoute.requestPath : routing.requestPath));
    if (presetEndpoint !== endpoint && !followsPreset && !declaredInterface &&
        !(preset.id === 'moonshot-kimi-code' && kimiCodeEndpoints.has(endpoint))) return [];
    // GLM's Messages endpoint is also used by its metered API preset.
    if (!miniMax && configuredPreset !== preset.id && presets.some(other =>
      other.id !== preset.id && !planPresets.has(other.id) && !isMimoTokenPlanPreset(other)
      && endpointKey(other.runtimes[agent]?.baseUrl ?? '') === endpoint
    )) return [];
    return [{ preset, runtime, miniMax }];
  });
  if (!candidates.length) return undefined;
  const candidate = candidates.find(({ preset }) => preset.id === configuredPreset)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  // MiniMax's shared API/plan preset is not in itself a subscription declaration.
  const declared = candidate?.miniMax ? undefined : candidate?.runtime.models.find(item => item.id === model.id);
  const reported = model.userModelConfig?.discoveredMetadata;
  const isKimiCode = candidate?.preset.id === 'moonshot-kimi-code';
  const kimiProductMax = isKimiCode ? kimiCodeMaxContext.get(model.id) : undefined;
  return {
    contextWindow: reported?.contextWindow ?? declared?.contextWindow,
    contextWindowMax: reported?.contextWindowMax ?? kimiProductMax ?? declared?.contextWindowMax,
    // The Kimi Code table documents context, not maximum generated output.
    maxOutput: reported?.maxOutputTokens ?? (isKimiCode ? undefined : declared?.maxOutputTokens),
    imageInput: reported?.supportsImageInput ?? (kimiProductMax !== undefined ? true : declared?.supportsImageInput),
    modalities: reported?.modalities ?? (kimiProductMax !== undefined ? {
      input: model.id === 'k3-256k' ? ['text', 'image'] : ['text', 'image', 'video'], output: [],
    } : declared?.modalities),
    fast: reported?.supportsFastMode ?? declared?.supportsFastMode,
    ultrafast: model.userModelConfig?.supportsUltrafastMode,
  };
}
