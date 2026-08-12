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
 * Whether the shell guard that blocks external `simctl` / `Simulator.app` use
 * should still apply.
 *
 * That guard exists to protect the ownership, admission, viewer and cleanup
 * contracts of Cindy's *embedded* simulator. With no plugin there is no embedded
 * simulator to protect, and blocking the user's own Xcode tooling — while
 * pointing them at a `cindy_ios_simulator` tool that this gate has just removed
 * — is a dead end rather than a boundary.
 *
 * The runtime condition is the safety half: a simulator instance booted while
 * the plugin was enabled stays Cindy-owned after it is disabled, and a shell
 * `simctl shutdown` would then race Cindy's own cleanup. `hostRuntimeActive` is
 * deliberately coarser than "an instance is live" because the Host exposes no
 * synchronous instance snapshot, and erring toward keeping the guard on is the
 * safe direction.
 */
export function shouldEnforceIOSSimulatorShellPolicy(state: {
  pluginAccessAllowed: boolean;
  hostRuntimeActive: boolean;
}): boolean {
  return state.pluginAccessAllowed || state.hostRuntimeActive;
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
        "Cindy's embedded iOS Simulator requires the iOS Simulator plugin. Ask the user to open Plugins → Marketplace, install “iOS Simulator”, and enable it. Do not retry until the plugin is installed.",
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
        'The iOS Simulator plugin is disabled for the current project. Ask the user to enable it for this working directory before retrying.',
      data: pluginActionData('disabled-in-workdir', 'enable-plugin', workdirDisabled),
    };
  }

  const disabled = sessionCandidates[0];
  if (disabled) {
    return {
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
      message:
        'The iOS Simulator plugin is installed but disabled. Ask the user to enable it on the Plugins page before retrying.',
      data: pluginActionData('disabled', 'enable-plugin', disabled),
    };
  }

  return {
    allowed: false,
    errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
    message:
      'The installed iOS Simulator plugin is unavailable in the current Cindy session. Ask the user to open the Plugins page and make the plugin available before retrying.',
    data: pluginActionData('session-unavailable', 'enable-plugin', candidates[0]),
  };
}
