/**
 * Platform-neutral 「允许被远程调用」logic for plugin-provided task engines
 * (docs/plans/acp-plugin-bridge.md, third phase). Shared by Desktop and Node Host.
 */
import { getPluginHarnessRegistry, type PluginHarness } from '../cindy-brain/pluginHarnesses.js';
import {
  isPluginEngineModelDisabled,
  PLUGIN_ENGINE_DEFAULT_MODEL,
  pluginEngineKeyFromProviderId,
  pluginEngineProviderId,
} from '../../shared/pluginEngines.js';
import { readPluginEnginePrefs } from './plugin-engine-prefs-store.js';

export interface PluginEngineRemoteUse {
  /** The plugin says this engine can serve a task whose files are on another computer. */
  supported: boolean;
  /** The user opened this engine for remote invocation. */
  enabled: boolean;
  /** The plugin also isolates sharer-local config/skills (`guestWorkspace`) for cross-account sharing. */
  shareSupported: boolean;
}

export interface PluginEngineRemoteUseStorePorts {
  isRemoteProviderInvocationAllowed(providerId: string): boolean;
  setRemoteProviderInvocationEnabled(providerId: string, enabled: boolean): Promise<void>;
}

/**
 * The engine can run right now: its plugin does not report it unavailable and the user has not
 * turned it off in Settings → Model providers (plugin-engine-prefs-store). Turning it off keeps
 * the remote-use switch as it was, so turning it on again restores what was opened.
 */
function isPluginEngineUsable(harness: Pick<PluginHarness, 'key' | 'availability'>): boolean {
  return harness.availability.state !== 'unavailable' && readPluginEnginePrefs(harness.key).suspended !== true;
}

/**
 * The user turned this model of the engine off in Settings → Model providers. Such a model is not
 * in the list other computers read; this is the check on the computer that runs the engine, for a
 * request that names it anyway (a choice saved before it was turned off).
 */
export function isPluginEngineModelTurnedOff(
  providerId: string | null | undefined,
  model = PLUGIN_ENGINE_DEFAULT_MODEL,
): boolean {
  const key = pluginEngineKeyFromProviderId(providerId);
  return !!key && isPluginEngineModelDisabled(model, readPluginEnginePrefs(key).disabledModels);
}

export function createPluginEngineRemoteUse(ports: PluginEngineRemoteUseStorePorts) {
  function pluginEngineRemoteUse(
    harness: Pick<PluginHarness, 'key' | 'remoteWorkspace' | 'guestWorkspace'>,
  ): PluginEngineRemoteUse {
    const supported = harness.remoteWorkspace === true;
    const shareSupported = supported && harness.guestWorkspace === true;
    // A switch left on from before the plugin dropped the mode must not read as usable.
    return {
      supported,
      enabled: supported && ports.isRemoteProviderInvocationAllowed(pluginEngineProviderId(harness.key)),
      shareSupported,
    };
  }

  /** The engine named by a task `providerId` can run a task of another computer right now. */
  function isPluginEngineOfferedRemotely(providerId: string | null | undefined): boolean {
    const key = pluginEngineKeyFromProviderId(providerId);
    if (!key) return false;
    const harness = getPluginHarnessRegistry().list().find((item) => item.key === key);
    return !!harness && isPluginEngineUsable(harness) && pluginEngineRemoteUse(harness).enabled;
  }

  /**
   * The engine named by a task `providerId` can serve a cross-account shared friend right now:
   * listed, not unavailable, remote use enabled, and `guestWorkspace` published by the plugin.
   */
  function isPluginEngineOfferedToGuests(providerId: string | null | undefined): boolean {
    const key = pluginEngineKeyFromProviderId(providerId);
    if (!key) return false;
    const harness = getPluginHarnessRegistry().list().find((item) => item.key === key);
    return !!harness
      && isPluginEngineUsable(harness)
      && harness.guestWorkspace === true
      && pluginEngineRemoteUse(harness).enabled;
  }

  /** Any engine is currently offered to the owner's other computers. */
  function hasPluginEngineOfferedRemotely(): boolean {
    return getPluginHarnessRegistry().list().some((harness) =>
      isPluginEngineUsable(harness) && pluginEngineRemoteUse(harness).enabled);
  }

  /**
   * Opens or closes one engine for remote use. Opening needs an engine this computer lists and whose
   * plugin offers the mode; closing always works, also for an engine that is no longer listed.
   */
  async function setPluginEngineRemoteUse(key: string, enabled: boolean): Promise<PluginEngineRemoteUse> {
    const providerId = pluginEngineProviderId(key);
    if (!pluginEngineKeyFromProviderId(providerId) || providerId.length > 256) throw new Error('Unknown plugin engine');
    const harness = getPluginHarnessRegistry().list().find((item) => item.key === key);
    if (enabled) {
      if (!harness) throw new Error('The plugin that provides this engine is disabled or removed');
      if (!harness.remoteWorkspace) {
        throw new Error('[PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED] This plugin engine can only run tasks on this computer');
      }
    }
    await ports.setRemoteProviderInvocationEnabled(providerId, enabled);
    return harness ? pluginEngineRemoteUse(harness) : { supported: false, enabled: false, shareSupported: false };
  }

  return {
    pluginEngineRemoteUse,
    isPluginEngineOfferedRemotely,
    isPluginEngineOfferedToGuests,
    isPluginEngineModelTurnedOff,
    hasPluginEngineOfferedRemotely,
    setPluginEngineRemoteUse,
  };
}
