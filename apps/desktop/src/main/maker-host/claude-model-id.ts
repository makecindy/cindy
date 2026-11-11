import type { Provider } from '@cindy/model-providers';

/**
 * cc appends `[1m]` to select the 1M window; custom upstreams don't list that alias, so bare-ID
 * gateways reject it (#7792). Restore the configured ID; IDs the user configured with `[1m]` and
 * models the Provider doesn't list pass through.
 */
export function configuredCustomModelId(provider: Provider, wireModel: string): string | null {
  if (!wireModel.endsWith('[1m]')) return null;
  const ids = provider.models['claude-code']?.map(model => model.id) ?? [];
  if (ids.includes(wireModel)) return null;
  const bare = wireModel.slice(0, -'[1m]'.length);
  return ids.includes(bare) ? bare : null;
}

/**
 * Per-model routes are keyed by the configured ID, so a 1M request still hits that model's own
 * endpoint/protocol. claude-code only.
 */
export function routeLookupModelId(provider: Provider | undefined, wireModel: string): string {
  return provider?.source === 'user' ? configuredCustomModelId(provider, wireModel) ?? wireModel : wireModel;
}
