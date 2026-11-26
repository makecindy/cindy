/**
 * Provider ids of plugin engines: `acp-plugin:<plugin instance>:<engine id>` is the engine's own
 * provider; `…~<8 lowercase letters or digits>` is a separate provider the user took one of its
 * accounts out into (subscription-account-pools.md 插件引擎的账号). Engine ids never contain `~`, so
 * an older Cindy reads a taken-out provider as an engine it does not know and refuses it.
 */
import { randomBytes } from 'node:crypto';

import { ACP_PLUGIN_PROVIDER_PREFIX } from '@cindy/maker-core';

import { ENGINE_KEY_RE, PROVIDER_SUFFIX_RE } from './store.js';

export interface PluginEngineProviderRef {
  providerId: string;
  /** `<plugin instance>:<engine id>`, the registry key. */
  engineKey: string;
  ghostId: string;
  harnessId: string;
  /** Null for the engine's own provider. */
  suffix: string | null;
}

export function parsePluginEngineProviderId(providerId: unknown): PluginEngineProviderRef | null {
  if (typeof providerId !== 'string' || providerId.length > 300 || !providerId.startsWith(ACP_PLUGIN_PROVIDER_PREFIX)) return null;
  const raw = providerId.slice(ACP_PLUGIN_PROVIDER_PREFIX.length);
  const tilde = raw.lastIndexOf('~');
  const engineKey = tilde < 0 ? raw : raw.slice(0, tilde);
  const suffix = tilde < 0 ? null : raw.slice(tilde + 1);
  if (!ENGINE_KEY_RE.test(engineKey) || (suffix !== null && !PROVIDER_SUFFIX_RE.test(suffix))) return null;
  const separator = engineKey.lastIndexOf(':');
  return { providerId, engineKey, ghostId: engineKey.slice(0, separator), harnessId: engineKey.slice(separator + 1), suffix };
}

export function pluginEngineProviderId(engineKey: string, suffix: string | null = null): string {
  return `${ACP_PLUGIN_PROVIDER_PREFIX}${engineKey}${suffix ? `~${suffix}` : ''}`;
}

export function newPluginEngineProviderSuffix(taken: ReadonlySet<string>): string {
  for (;;) {
    const suffix = Array.from(randomBytes(8), (byte) => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
    if (!taken.has(suffix)) return suffix;
  }
}
