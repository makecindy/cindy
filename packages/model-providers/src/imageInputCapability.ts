/**
 * Image container capabilities of remote model routes.
 *
 * This is deliberately fail-closed: a provider that has no declaration here
 * receives PNG/JPEG only. Provider-specific declarations live in this module's
 * keyed records so callers do not maintain a second vendor list.
 */

export interface ImageRouteIdentity {
  providerId?: string;
  modelId?: string;
}

type ImageInputCapability = 'webp' | 'png-jpeg';

// Add provider declarations here in key order; model-family rules below cover
// gateways and BYOK names without registering every gateway as a provider.
const PROVIDER_CAPABILITIES: Readonly<Record<string, ImageInputCapability>> = {
  'anthropic': 'webp',
  'bytedance': 'webp',
  'deepseek': 'webp',
  'doubao': 'webp',
  'gemini': 'webp',
  'google': 'webp',
  'kimi': 'webp',
  'minimax': 'webp',
  'mistral': 'webp',
  'moonshot': 'webp',
  'moonshotai': 'webp',
  'openai': 'webp',
  'qwen': 'webp',
  'seed': 'webp',
  'xai': 'png-jpeg',
  'z-ai': 'png-jpeg',
  'zai': 'png-jpeg',
  'zhipu': 'png-jpeg',
  'zhipu-coding-plan-cn': 'png-jpeg',
  'zhipu-glm-cn': 'png-jpeg',
  'zhipu-glm-global': 'png-jpeg',
};

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/^\//, '');
}

/** Whether the selected upstream accepts image/webp input. Unknown is false. */
export function acceptsWebpImageInput(route: ImageRouteIdentity): boolean {
  const provider = normalize(route.providerId);
  const model = normalize(route.modelId);
  if (!provider && !model) return false;

  // Exact identity or a delimiter-separated preset suffix, never arbitrary
  // startsWith ("openai-impostor" is still only a heuristic, not authorization).
  const identity = Object.keys(PROVIDER_CAPABILITIES).find((key) => provider === key || provider.startsWith(`${key}-`));
  const namespace = model.split('/').at(-2);
  const providerCapability = identity === undefined ? undefined : PROVIDER_CAPABILITIES[identity];
  const namespaceCapability = namespace === undefined ? undefined : PROVIDER_CAPABILITIES[namespace];
  if (providerCapability === 'png-jpeg' || namespaceCapability === 'png-jpeg') return false;

  const family = model.split('/').at(-1) ?? '';
  if (/^(?:glm-|grok-)/.test(family)) return false;
  if (/^(?:gpt-|o\d+(?:$|[-.])|chatgpt|claude-|gemini-|deepseek|qwen|kimi|moonshot|minimax|abab|doubao|seed|mistral|pixtral)/.test(family)) return true;
  return namespaceCapability === 'webp' || providerCapability === 'webp';
}
