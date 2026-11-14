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

const PROVIDER_CAPABILITIES: Readonly<Record<string, ImageInputCapability>> = {
  anthropic: 'webp',
  deepseek: 'webp',
  google: 'webp',
  gemini: 'webp',
  kimi: 'webp',
  moonshot: 'webp',
  moonshotai: 'webp',
  minimax: 'webp',
  mistral: 'webp',
  openai: 'webp',
  qwen: 'webp',
  seed: 'webp',
  doubao: 'webp',
  'zhipu-glm-cn': 'png-jpeg',
  'zhipu-glm-global': 'png-jpeg',
  'zhipu-coding-plan-cn': 'png-jpeg',
  xai: 'png-jpeg',
};

const WEBP_PROVIDER_PREFIXES = [
  'anthropic', 'deepseek', 'google', 'gemini', 'kimi', 'moonshot', 'minimax',
  'mistral', 'openai', 'qwen', 'seed', 'doubao', 'bytedance',
] as const;

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/^\//, '');
}

/** Whether the selected upstream accepts image/webp input. Unknown is false. */
export function acceptsWebpImageInput(route: ImageRouteIdentity): boolean {
  const provider = normalize(route.providerId);
  const model = normalize(route.modelId);
  if (!provider && !model) return false;

  // Explicitly rejected vendors win even when a gateway prefixes their model.
  if (provider === 'xai' || provider.startsWith('zhipu') || provider === 'z-ai'
    || model.startsWith('xai/') || model.startsWith('z-ai/')) return false;
  const declared = PROVIDER_CAPABILITIES[provider];
  if (declared) return declared === 'webp';
  if (WEBP_PROVIDER_PREFIXES.some((prefix) => provider.startsWith(prefix))) return true;

  // Direct model references retain the provider namespace after custom routes.
  const prefix = model.split('/', 1)[0];
  return prefix.length > 0 && PROVIDER_CAPABILITIES[prefix] === 'webp';
}

