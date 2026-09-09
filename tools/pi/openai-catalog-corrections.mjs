// Explicit Astra support for the pinned Pi runtime, verified 2026-09-05.
// API contract: https://developers.openai.com/api/docs/models/gpt-6-astra
// Subscription window: Codex 0.153.0 model metadata (272K default, 872K maximum).
// Keep the transports separate; public API cache compatibility lives in cindy-bridge.
export function applyAstraCatalogAdditions(providers) {
  const cost = {
    input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
  };
  for (const [provider, api, baseUrl, contextWindow] of [
    ['openai', 'openai-responses', 'https://api.openai.com/v1', 1050000],
    ['openai-codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api', 272000],
  ]) {
    const rows = providers[provider] ?? [];
    // Newer upstream metadata wins when the native catalog learns this model.
    if (rows.some((model) => model.id === 'gpt-6-astra')) continue;
    providers[provider] = [...rows, {
      id: 'gpt-6-astra', name: 'GPT-6 Astra', provider, api, baseUrl,
      reasoning: true, input: ['text', 'image'], cost: structuredClone(cost),
      contextWindow, maxTokens: 128000,
      thinkingLevelMap: { off: 'low', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    }];
  }
  return providers;
}
