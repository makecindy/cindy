export const PI_PROVIDER_PRESET_IDS: Record<string, string> = {
  anthropic: 'anthropic-api', openai: 'openai-api', xai: 'xai-api', google: 'google-gemini-api',
  'openai-codex': 'openai', 'minimax-cn': 'minimax-cn', minimax: 'minimax-global',
  moonshotai: 'moonshot-kimi-global', 'moonshotai-cn': 'moonshot-kimi-cn',
  'kimi-coding': 'moonshot-kimi-code', zai: 'zai-coding-plan-global',
  'zai-coding-cn': 'zhipu-coding-plan-cn', xiaomi: 'xiaomi-mimo-api-cn',
  'xiaomi-token-plan-cn': 'xiaomi-mimo-token-plan-cn',
  'qwen-token-plan-cn': 'aliyun-bailian-token-plan-cn',
};

export function sourceProviderForPreset(presetId: string): string {
  return Object.entries(PI_PROVIDER_PRESET_IDS).find(([, id]) => id === presetId)?.[0]
    ?? (presetId.startsWith('amazon-bedrock-') ? 'amazon-bedrock' : presetId);
}
