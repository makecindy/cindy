import type { IOSSimulatorMcpAccessDecision } from '@cindy/mcps';

import type { InstalledGhost } from '../../shared/ghost.js';

export interface IOSSimulatorPluginGateDeps {
  isAvailableForActiveSession(ghostId: string): boolean;
  isDisabledForWorkdir(ghostId: string, workingDir: string | null): boolean;
}

const REQUIRED_PLUGIN_ID = 'ios-simulator';
const REQUIRED_PLUGIN_NAME = 'iOS Simulator';

function pluginActionData(
  reason: 'not-installed' | 'disabled' | 'disabled-in-workdir' | 'session-unavailable',
  action: 'install-plugin' | 'enable-plugin',
  ghost?: InstalledGhost,
): Record<string, unknown> {
  return {
    reason,
    action,
    pluginId: ghost?.manifest.id ?? REQUIRED_PLUGIN_ID,
    pluginName: ghost?.manifest.name ?? REQUIRED_PLUGIN_NAME,
  };
}

/**
 * Resolve the live product gate for Cindy's Host-owned iOS Simulator.
 *
 * The gateway remains discoverable so an Agent can explain how to install or
 * enable the plugin, but every lifecycle/input/media call must re-evaluate this
 * decision immediately before reaching the Host runtime.
 */
export function resolveIOSSimulatorPluginAccess(
  ghosts: readonly InstalledGhost[],
  workingDir: string | null,
  deps: IOSSimulatorPluginGateDeps,
): IOSSimulatorMcpAccessDecision {
  const candidates = ghosts.filter((ghost) => ghost.manifest.slots.includes('ios-simulator'));
  if (candidates.length === 0) {
    return {
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
      message:
        "Cindy's embedded iOS Simulator requires the iOS Simulator plugin. The embedded route is unavailable until the user installs and enables “iOS Simulator” from Plugins → Marketplace; other iOS workflows are unaffected.",
      data: pluginActionData('not-installed', 'install-plugin'),
    };
  }

  const sessionCandidates = candidates.filter((ghost) =>
    deps.isAvailableForActiveSession(ghost.manifest.id),
  );
  const enabledCandidates = sessionCandidates.filter((ghost) => ghost.enabled === true);
  const available = enabledCandidates.find(
    (ghost) => !deps.isDisabledForWorkdir(ghost.manifest.id, workingDir),
  );
  if (available) return { allowed: true };

  const workdirDisabled = enabledCandidates[0];
  if (workdirDisabled) {
    return {
      allowed: false,
      errorCode: 'IOS_SIMULATOR_DISABLED',
      message:
        'The embedded iOS Simulator plugin is disabled for the current project. Enable it for this working directory before retrying the embedded tool; other iOS workflows are unaffected.',
      data: pluginActionData('disabled-in-workdir', 'enable-plugin', workdirDisabled),
    };
  }

  const disabled = sessionCandidates[0];
  if (disabled) {
    return {
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
      message:
        'The embedded iOS Simulator plugin is installed but disabled. Enable it on the Plugins page before retrying the embedded tool; other iOS workflows are unaffected.',
      data: pluginActionData('disabled', 'enable-plugin', disabled),
    };
  }

  return {
    allowed: false,
    errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
    message:
      'The installed embedded iOS Simulator plugin is unavailable in the current Cindy session. Make it available from the Plugins page before retrying the embedded tool; other iOS workflows are unaffected.',
    data: pluginActionData('session-unavailable', 'enable-plugin', candidates[0]),
  };
}
