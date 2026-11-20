/**
 * 「允许被远程调用」for plugin-provided task engines (docs/plans/acp-plugin-bridge.md, third phase).
 *
 * A plugin engine can run a task of the owner's other computer when three things hold on the
 * computer that has the plugin:
 *  - the plugin published `remoteWorkspace` for the engine (it switches the agent's own file and
 *    command tools off for such a task, so all of that work goes back to the task's computer);
 *  - the engine is listed (plugin enabled and approved) and not reported unavailable;
 *  - the user opened it for remote use. The switch lives in the same per-account store as an
 *    ordinary provider's switch, keyed by the engine's task `providerId` (`acp-plugin:…`), off by
 *    default.
 *
 * Only computers of the same account get this: shared users and provider groups never see plugin
 * engines (the remote-agent host refuses them before it reaches this module).
 */
import { getPluginHarnessRegistry, type PluginHarness } from '../cindy-brain/pluginHarnesses.js';
import { pluginEngineKeyFromProviderId, pluginEngineProviderId } from '../../shared/pluginEngines.js';
import { isRemoteProviderInvocationAllowed, setRemoteProviderInvocationEnabled } from './remote-provider-access-store.js';

export interface PluginEngineRemoteUse {
  /** The plugin says this engine can serve a task whose files are on another computer. */
  supported: boolean;
  /** The user opened this engine for the owner's other computers. */
  enabled: boolean;
}

export function pluginEngineRemoteUse(harness: Pick<PluginHarness, 'key' | 'remoteWorkspace'>): PluginEngineRemoteUse {
  const supported = harness.remoteWorkspace === true;
  // A switch left on from before the plugin dropped the mode must not read as usable.
  return { supported, enabled: supported && isRemoteProviderInvocationAllowed(pluginEngineProviderId(harness.key)) };
}

/** The engine named by a task `providerId` can run a task of another computer right now. */
export function isPluginEngineOfferedRemotely(providerId: string | null | undefined): boolean {
  const key = pluginEngineKeyFromProviderId(providerId);
  if (!key) return false;
  const harness = getPluginHarnessRegistry().list().find((item) => item.key === key);
  return !!harness && harness.availability.state !== 'unavailable' && pluginEngineRemoteUse(harness).enabled;
}

/** Any engine is currently offered to the owner's other computers. */
export function hasPluginEngineOfferedRemotely(): boolean {
  return getPluginHarnessRegistry().list().some((harness) =>
    harness.availability.state !== 'unavailable' && pluginEngineRemoteUse(harness).enabled);
}

/**
 * Opens or closes one engine for remote use. Opening needs an engine this computer lists and whose
 * plugin offers the mode; closing always works, also for an engine that is no longer listed.
 */
export async function setPluginEngineRemoteUse(key: string, enabled: boolean): Promise<PluginEngineRemoteUse> {
  const providerId = pluginEngineProviderId(key);
  if (!pluginEngineKeyFromProviderId(providerId) || providerId.length > 256) throw new Error('Unknown plugin engine');
  const harness = getPluginHarnessRegistry().list().find((item) => item.key === key);
  if (enabled) {
    if (!harness) throw new Error('The plugin that provides this engine is disabled or removed');
    if (!harness.remoteWorkspace) {
      throw new Error('[PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED] This plugin engine can only run tasks on this computer');
    }
  }
  await setRemoteProviderInvocationEnabled(providerId, enabled);
  return harness ? pluginEngineRemoteUse(harness) : { supported: false, enabled: false };
}
