/**
 * Shim: openclaw/plugin-sdk/plugin-config-runtime.
 *
 * Upstream resolves which OpenClaw plugins are enabled. The standalone browser
 * runtime has no plugin system — the browser plugin is always the active
 * subject — so `normalizePluginsConfig` passes through and
 * `resolveEffectiveEnableState` honors `enabledByDefault` (default true).
 * Plugin gating in Cindy happens one layer up in the MCP provider registry.
 */
export function normalizePluginsConfig<T>(config: T): T {
  return config;
}

export interface EffectiveEnableStateParams {
  id: string;
  origin?: string;
  config?: unknown;
  rootConfig?: unknown;
  enabledByDefault?: boolean;
}

export function resolveEffectiveEnableState(params: EffectiveEnableStateParams): {
  enabled: boolean;
} {
  return { enabled: params.enabledByDefault ?? true };
}
