import { describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import {
  resolveIOSSimulatorPluginAccess,
  shouldEnforceIOSSimulatorShellPolicy,
} from '../iosSimulatorPluginGate.js';

function ghost(id: string, enabled: boolean, slots: string[] = ['ios-simulator']): InstalledGhost {
  return {
    enabled,
    manifest: { id, name: id, slots },
  } as unknown as InstalledGhost;
}

function resolve(
  ghosts: InstalledGhost[],
  options: { unavailableIds?: string[]; disabledInWorkdirIds?: string[] } = {},
) {
  return resolveIOSSimulatorPluginAccess(ghosts, '/repo', {
    isAvailableForActiveSession: (id) => !options.unavailableIds?.includes(id),
    isDisabledForWorkdir: (id) => options.disabledInWorkdirIds?.includes(id) === true,
  });
}

describe('iOS Simulator plugin Host gate', () => {
  it('returns an actionable install result when no provider is installed', () => {
    expect(resolve([])).toEqual({
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
      message: expect.stringContaining('Plugins → Marketplace'),
      data: expect.objectContaining({
        reason: 'not-installed',
        action: 'install-plugin',
        pluginId: 'ios-simulator',
      }),
    });
  });

  it('distinguishes a sleeping plugin from a project-scoped disable', () => {
    expect(resolve([ghost('ios-simulator', false)])).toMatchObject({
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_DISABLED',
      data: { reason: 'disabled', action: 'enable-plugin' },
    });
    expect(
      resolve([ghost('ios-simulator', true)], {
        disabledInWorkdirIds: ['ios-simulator'],
      }),
    ).toMatchObject({
      allowed: false,
      errorCode: 'IOS_SIMULATOR_DISABLED',
      data: { reason: 'disabled-in-workdir', action: 'enable-plugin' },
    });
  });

  it('allows any enabled, session-available provider declaring the Host slot', () => {
    expect(resolve([ghost('replacement-provider', true)])).toEqual({ allowed: true });
    expect(
      resolve([ghost('unavailable-provider', true), ghost('replacement-provider', true)], {
        unavailableIds: ['unavailable-provider'],
      }),
    ).toEqual({ allowed: true });
  });

  it('does not treat an unrelated enabled plugin as a capability provider', () => {
    expect(resolve([ghost('ordinary-plugin', true, ['skill'])])).toMatchObject({
      allowed: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
    });
  });
});

describe('embedded Simulator shell guard scope', () => {
  it('applies while the plugin grants access', () => {
    expect(
      shouldEnforceIOSSimulatorShellPolicy({
        pluginAccessAllowed: true,
        hostRuntimeActive: false,
      }),
    ).toBe(true);
  });

  it('stops blocking the user own Xcode tooling once the capability is gated off', () => {
    // Without the plugin there is no embedded simulator to protect, and the
    // denial would point at a cindy_ios_simulator tool the gate has removed.
    expect(
      shouldEnforceIOSSimulatorShellPolicy({
        pluginAccessAllowed: false,
        hostRuntimeActive: false,
      }),
    ).toBe(false);
  });

  it('keeps protecting a runtime this process already installed', () => {
    // An instance booted while the plugin was enabled stays Cindy-owned after a
    // disable, so a shell shutdown would race Cindy's own cleanup.
    expect(
      shouldEnforceIOSSimulatorShellPolicy({
        pluginAccessAllowed: false,
        hostRuntimeActive: true,
      }),
    ).toBe(true);
  });
});
