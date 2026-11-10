/** Lightweight model for Codex with ChatGPT sign-in. API-key providers have their own defaults. */
export const CODEX_SUBSCRIPTION_UTILITY_MODEL = 'gpt-6-luna';

/** Old Cindy catalogs can also carry the Claude wire prefix in their OpenAI titleModel. */
export function resolveCodexSubscriptionUtilityModel(model: string): string {
  return model === 'gpt-5.4-mini' || model === 'chatgpt/gpt-5.4-mini' ? CODEX_SUBSCRIPTION_UTILITY_MODEL : model;
}
