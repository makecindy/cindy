/**
 * Shim: openclaw/plugin-sdk/runtime-config-snapshot.
 *
 * Upstream reads a live global config singleton. We expose a host-settable
 * in-memory config (seeded by Cindy: browser profiles, ssrf policy, ports).
 * Defaults to an empty config so the runtime starts with built-in defaults.
 */
import type { OpenClawConfig } from './config-contracts.js';

let current: OpenClawConfig = {};

/** Host hook: install the effective browser runtime config. */
export function setBrowserRuntimeConfig(config: OpenClawConfig): void {
  current = config ?? {};
}

export function getRuntimeConfig(): OpenClawConfig {
  return current;
}

export function getRuntimeConfigSnapshot(): OpenClawConfig {
  return current;
}

/**
 * Upstream returns the disk-source-backed config snapshot, or null when none is
 * loaded. We hold the host-injected config purely in memory (no disk source), so
 * there is no separate "source" snapshot — return null so the only caller
 * (`loadBrowserConfigForRuntimeRefresh`) falls through to `getRuntimeConfig()`, i.e.
 * the live host config.
 *
 * ⚠️ This MUST return OpenClawConfig | null (not a `{ config, source }` wrapper):
 * the caller does `getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig()` and then
 * reads `.browser` off the result. A truthy wrapper silently shadowed the real
 * config (its `.browser` is undefined), so the dispatcher fell back to the vendored
 * DEFAULT profiles ("openclaw"/"user") and ALL host config (profiles, default
 * profile name, ssrf, ports) was ignored.
 */
export function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null {
  return null;
}
