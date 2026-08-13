import { describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import {
  resolveIOSSimulatorCapabilityLossCleanupScope,
  resolveIOSSimulatorPluginAccess,
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

describe('iOS Simulator capability-loss cleanup scope', () => {
  it('retries an active Host after an earlier disable cleanup failed', () => {
    const scope = resolveIOSSimulatorCapabilityLossCleanupScope({
      wasEnabled: false,
      retryIfHostActive: true,
      hostRuntimeActive: true,
      hasActiveProvider: false,
      hasEnabledProviderForProject: () => false,
    });

    expect(scope).toEqual({});
  });

  it('does not retry when the capability was already disabled and no Host remains', () => {
    expect(
      resolveIOSSimulatorCapabilityLossCleanupScope({
        wasEnabled: false,
        retryIfHostActive: true,
        hostRuntimeActive: false,
        hasActiveProvider: false,
        hasEnabledProviderForProject: () => false,
      }),
    ).toBeNull();
  });

  it('cleans only projects that lost their last effective provider', () => {
    expect(
      resolveIOSSimulatorCapabilityLossCleanupScope({
        wasEnabled: true,
        retryIfHostActive: false,
        hostRuntimeActive: true,
        hasActiveProvider: true,
        projectWorkingDirs: ['/project-a', '/project-b'],
        hasEnabledProviderForProject: (workingDir) => workingDir === '/project-b',
      }),
    ).toEqual({ projectWorkingDirs: ['/project-a'] });
  });

  it('evaluates provider access per binding when the mutation has no project scope', () => {
    const scope = resolveIOSSimulatorCapabilityLossCleanupScope({
      wasEnabled: true,
      retryIfHostActive: false,
      hostRuntimeActive: true,
      hasActiveProvider: true,
      hasEnabledProviderForProject: (workingDir) => workingDir === '/project-b',
    });

    expect(scope?.shouldReleaseProject?.('/project-a')).toBe(true);
    expect(scope?.shouldReleaseProject?.('/project-b')).toBe(false);
  });

  it('keeps the last-provider cleanup unscoped so pending creates are reconciled', () => {
    expect(
      resolveIOSSimulatorCapabilityLossCleanupScope({
        wasEnabled: true,
        retryIfHostActive: false,
        hostRuntimeActive: true,
        hasActiveProvider: false,
        hasEnabledProviderForProject: () => false,
      }),
    ).toEqual({});
  });
});
