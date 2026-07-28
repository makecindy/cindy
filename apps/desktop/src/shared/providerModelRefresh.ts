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

/** Renderer 只能上报明确的用户界面时机；前台恢复由 Main 自己判断。 */
export const PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS = [
  'providers-open',
  'model-selector-open',
] as const;

export type ProviderModelAutoRefreshRendererTrigger =
  (typeof PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS)[number];

export type ProviderModelAutoRefreshTrigger =
  | ProviderModelAutoRefreshRendererTrigger
  | 'foreground'
  | 'system-resume'
  | 'screen-unlock';

export function isProviderModelAutoRefreshRendererTrigger(
  value: unknown,
): value is ProviderModelAutoRefreshRendererTrigger {
  return (
    typeof value === 'string' &&
    (PROVIDER_MODEL_AUTO_REFRESH_RENDERER_TRIGGERS as readonly string[]).includes(value)
  );
}

export interface ProviderModelAutoRefreshResult {
  ok: true;
}
