/**
 * Built-in provider model-list refresh protocol shared by main, preload, and renderer.
 *
 * Custom providers keep their existing endpoint-driven additions-only refresh flow.
 */
export const BUILTIN_REFRESHABLE_PROVIDER_IDS = ['xd', 'anthropic', 'openai', 'xai'] as const;

export type BuiltinRefreshableProviderId = (typeof BUILTIN_REFRESHABLE_PROVIDER_IDS)[number];

export function isBuiltinRefreshableProviderId(
  value: unknown,
): value is BuiltinRefreshableProviderId {
  return (
    typeof value === 'string' &&
    (BUILTIN_REFRESHABLE_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export interface ProviderModelRefreshResult {
  ok: true;
  providerId: BuiltinRefreshableProviderId;
}
