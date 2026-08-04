export type UtilityModelTransport =
  | 'codex-responses'
  | 'litellm-chat-completions';

export type UtilityModelAuthKind = 'codex' | 'api-key';

export type UtilityModelSettingsTab = 'api-keys' | 'connections' | 'providers';

export type UtilityModelPricing = {
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens: number;
};

export type UtilityModelProfile = {
  id: string;
  model: string;
  transport: UtilityModelTransport;
  auth: UtilityModelAuthKind;
  settingsTab: UtilityModelSettingsTab;
  pricing?: UtilityModelPricing;
  missingCredentialMessage: string;
};

export const DEFAULT_UTILITY_MODEL_PROVIDER_KIND = 'codex-gpt-5.4-mini';
export const DEFAULT_UTILITY_MODEL = 'gpt-5.4-mini';

// Default lightweight-model candidate pool, highest priority first when no
// runtime-specific policy is applied. Voice input refinement may reorder this
// built-in pool after credential readiness is known.
export const DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN = [
  'codex-gpt-5.4-mini',
  'litellm-gpt-5.4-mini',
  'litellm-kimi-k2.6',
  'litellm-deepseek-v4-flash',
] as const;

export const UTILITY_MODEL_PROFILES = {
  'codex-gpt-5.4-mini': {
    id: 'codex-gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    transport: 'codex-responses',
    auth: 'codex',
    settingsTab: 'providers',
    pricing: {
      inputUsdPerMillionTokens: 0.6,
      cachedInputUsdPerMillionTokens: 0.06,
      outputUsdPerMillionTokens: 2.4,
    },
    missingCredentialMessage: 'Codex ChatGPT login is required for lightweight model tasks.',
  },
  'codex-gpt-5.4-nano': {
    id: 'codex-gpt-5.4-nano',
    model: 'gpt-5.4-nano',
    transport: 'codex-responses',
    auth: 'codex',
    settingsTab: 'providers',
    missingCredentialMessage: 'Codex ChatGPT login is required for lightweight model tasks.',
  },
  'litellm-gpt-5.4-mini': {
    id: 'litellm-gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    pricing: {
      inputUsdPerMillionTokens: 0.6,
      cachedInputUsdPerMillionTokens: 0.06,
      outputUsdPerMillionTokens: 2.4,
    },
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-gpt-5.4-nano': {
    id: 'litellm-gpt-5.4-nano',
    model: 'gpt-5.4-nano',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-deepseek-v4-flash': {
    id: 'litellm-deepseek-v4-flash',
    model: 'deepseek/deepseek-v4-flash',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-qwen3.6-plus': {
    id: 'litellm-qwen3.6-plus',
    model: 'qwen/qwen3.6-plus',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-qwen3.7-max': {
    id: 'litellm-qwen3.7-max',
    model: 'qwen/qwen3.7-max',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-glm-5.1': {
    id: 'litellm-glm-5.1',
    model: 'z-ai/glm-5.1',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
  'litellm-kimi-k2.6': {
    id: 'litellm-kimi-k2.6',
    model: 'moonshotai/kimi-k2.6',
    transport: 'litellm-chat-completions',
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for LiteLLM lightweight model tasks.',
  },
} as const satisfies Record<string, UtilityModelProfile>;

export type UtilityModelProviderKind = keyof typeof UTILITY_MODEL_PROFILES;

export function getUtilityModelProfile(provider: UtilityModelProviderKind): UtilityModelProfile {
  return UTILITY_MODEL_PROFILES[provider];
}

export function getUtilityModelProfiles(): UtilityModelProfile[] {
  return Object.values(UTILITY_MODEL_PROFILES);
}

export function isUtilityModelProviderKind(value: string): value is UtilityModelProviderKind {
  return value in UTILITY_MODEL_PROFILES;
}

const UTILITY_MODEL_PROVIDER_ALIASES: Record<string, UtilityModelProviderKind> = {
  '': DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  codex: DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  'codex-gpt-5.4-mini': 'codex-gpt-5.4-mini',
  'codex-gpt-5.4-nano': 'codex-gpt-5.4-nano',
  litellm: 'litellm-gpt-5.4-mini',
  'xd-litellm': 'litellm-gpt-5.4-mini',
  'litellm-gpt-5.4-mini': 'litellm-gpt-5.4-mini',
  'litellm-gpt-5.4-nano': 'litellm-gpt-5.4-nano',
  'deepseek-v4-flash': 'litellm-deepseek-v4-flash',
  'litellm-deepseek-v4-flash': 'litellm-deepseek-v4-flash',
  'qwen3.6-plus': 'litellm-qwen3.6-plus',
  'qwen/qwen3.6-plus': 'litellm-qwen3.6-plus',
  'litellm-qwen3.6-plus': 'litellm-qwen3.6-plus',
  'qwen3.7-max': 'litellm-qwen3.7-max',
  'qwen/qwen3.7-max': 'litellm-qwen3.7-max',
  'litellm-qwen3.7-max': 'litellm-qwen3.7-max',
  'glm-5.1': 'litellm-glm-5.1',
  'z-ai/glm-5.1': 'litellm-glm-5.1',
  'litellm-glm-5.1': 'litellm-glm-5.1',
  'kimi-k2.6': 'litellm-kimi-k2.6',
  'moonshotai/kimi-k2.6': 'litellm-kimi-k2.6',
  'litellm-kimi-k2.6': 'litellm-kimi-k2.6',
};

export function resolveUtilityModelProviderKindAlias(value: string): UtilityModelProviderKind | null {
  const normalized = value.trim().toLowerCase();
  return UTILITY_MODEL_PROVIDER_ALIASES[normalized]
    ?? (isUtilityModelProviderKind(normalized) ? normalized : null);
}

export function estimateUtilityModelCostUsd(
  profile: UtilityModelProfile,
  usage: { promptTokens?: number; cachedTokens?: number; completionTokens?: number },
): number {
  const pricing = profile.pricing;
  if (!pricing) return 0;
  const promptTokens = normalizeTokenCount(usage.promptTokens);
  const cachedTokens = Math.min(normalizeTokenCount(usage.cachedTokens), promptTokens);
  const uncachedInputTokens = Math.max(0, promptTokens - cachedTokens);
  const completionTokens = normalizeTokenCount(usage.completionTokens);
  return (
    (uncachedInputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens
    + (cachedTokens / 1_000_000) * (pricing.cachedInputUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens)
    + (completionTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}

function normalizeTokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? value : 0;
}

/**
 * 快问快答(插件 cindy.text.oneshot)可钉的后端清单。
 *
 * 与图像/视频的"钉后端"同一口径:每一项就是一组**供应商 × 模型**。这里带上
 * 传输通道当后缀——`gpt-5.4-mini` 同时经 Codex 订阅和网关提供,只写模型名会
 * 出现两行同名项、用户选不中(GhostErrandPrefs 踩过同一个坑)。后缀用中立的
 * 通道名而非中文,避免在 shared 层塞 UI 文案。
 */
export function utilityModelPinOptions(): Array<{ id: string; label: string }> {
  return Object.values(UTILITY_MODEL_PROFILES).map((profile) => ({
    id: profile.id,
    label: `${profile.model} · ${utilityTransportLabel(profile.transport)}`,
  }));
}

export function utilityTransportLabel(transport: UtilityModelTransport): string {
  return transport === 'codex-responses' ? 'Codex' : 'Gateway';
}
