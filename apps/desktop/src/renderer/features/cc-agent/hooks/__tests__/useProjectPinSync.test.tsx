// @vitest-environment jsdom
/**
 * Test value: the sidebar's pinned-project set and pin toggles across computers
 * (`useProjectPinSync`, the entry `CCAgentSidebarUpper` uses for menus, rail and Pinned).
 * Regression: a project pinned on one computer never appeared pinned on another; controllers
 * only wrote their own list. Minimal failing inputs: a legacy `project:device:` pin that must be
 * handed to its host once; a host-owned project unpinned elsewhere that must leave the Pinned
 * set; a toggle that must reach the owning desktop instead of a local-only pin. Unit tier (jsdom
 * hook render, in-memory device-link fake); the store's own fences live in remoteProjectPins.test.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { remoteProjectPins } from '@/features/device-link/remoteProjectPins';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';
import type { SidebarSettingsSnapshot } from '../../../../../shared/sidebarSettings';
import { ProjectPinHostUnavailableError, useProjectPinSync } from '../useProjectPinSync';

const OWNER_STAMP: DataOwnerPushStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const HOST_STAMP = { dataOwnerId: 'owner-a', ownerGeneration: 3 };
const hostPins = (projectKeys: string[]) => ({ available: true, projectKeys, ownerStamp: HOST_STAMP });

type HostsListener = (deviceIds: string[], ownerStamp: DataOwnerPushStamp) => void;
let hostsListeners: HostsListener[] = [];
let pinHostDeviceIds: string[] = [];
const invoke = vi.fn();
const markProjectPinHost = vi.fn();

function snapshot(): SidebarSettingsSnapshot {
  return {
    ...OWNER_STAMP,
    pinnedOrderIsAuthoritative: true,
    pinnedOrder: [],
    hiddenProjectKeys: [],
    hiddenMainViewGhostIds: [],
    projectPinHostDeviceIds: pinHostDeviceIds,
  };
}

function renderPinSync(manualPinnedOrder: string[], knownProjectKeys: string[] = []) {
  const promotePin = vi.fn().mockResolvedValue(undefined);
  const removePin = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() =>
    useProjectPinSync({
      initialSnapshot: snapshot(),
      manualPinnedOrder,
      knownProjectKeys,
      promotePin,
      removePin,
    }),
  );
  return { ...view, promotePin, removePin };
}

async function hostReports(deviceId: string, value: unknown): Promise<void> {
  invoke.mockResolvedValueOnce(value);
  await remoteProjectPins.refresh(deviceId, () => true);
}

beforeEach(() => {
  hostsListeners = [];
  pinHostDeviceIds = [];
  invoke.mockReset();
  markProjectPinHost.mockReset();
  remoteProjectPins.clear();
  setDataOwnerGeneration('owner-a', 1);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    deviceLink: { invoke },
    sidebarSettings: {
      loadSnapshot: snapshot,
      markProjectPinHost,
      onProjectPinHostsChanged: (listener: HostsListener) => {
        hostsListeners.push(listener);
        return () => {
          hostsListeners = hostsListeners.filter((entry) => entry !== listener);
        };
      },
    },
  };
});

afterEach(() => {
  // Unmount before clearing the module store so the clear does not re-render a live hook.
  cleanup();
  remoteProjectPins.clear();
  setDataOwnerGeneration(null, 0);
});

describe('useProjectPinSync', () => {
  it('hands this computer\'s older pins to a desktop that now owns project pins, once', async () => {
    await hostReports('host-a', hostPins(['local:/repo/shared']));
    invoke.mockResolvedValueOnce(hostPins(['local:/repo/legacy', 'local:/repo/shared']));
    markProjectPinHost.mockImplementation(async (deviceId: string) => {
      pinHostDeviceIds = [deviceId];
      for (const listener of hostsListeners) listener([deviceId], OWNER_STAMP);
      return [deviceId];
    });

    const { result } = renderPinSync(['project:device:host-a:/repo/legacy', 'project:local:/mine']);
    // Before the handoff completes, the local legacy pin keeps showing (no flicker).
    expect([...result.current.pinnedProjectKeys].sort()).toEqual([
      'device:host-a:/repo/legacy',
      'device:host-a:/repo/shared',
      'local:/mine',
    ]);

    await waitFor(() => expect(markProjectPinHost).toHaveBeenCalledWith('host-a', OWNER_STAMP));
    expect(invoke).toHaveBeenCalledWith('host-a', 'sidebar-settings:apply-project-pins', [
      { ...HOST_STAMP, projectKeys: ['local:/repo/legacy'], pinned: true },
    ]);
    expect([...result.current.pinnedProjectKeys].sort()).toEqual([
      'device:host-a:/repo/legacy',
      'device:host-a:/repo/shared',
      'local:/mine',
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('lets the owning desktop decide and prunes ranking entries it no longer pins', async () => {
    pinHostDeviceIds = ['host-a'];
    await hostReports('host-a', hostPins(['local:/repo/still', 'local:/repo/pinned-elsewhere']));
    const { result, removePin } = renderPinSync([
      'project:device:host-a:/repo/unpinned-elsewhere',
      'project:device:host-a:/repo/still',
    ]);

    expect([...result.current.pinnedProjectKeys].sort()).toEqual([
      'device:host-a:/repo/pinned-elsewhere',
      'device:host-a:/repo/still',
    ]);
    await waitFor(() =>
      expect(removePin).toHaveBeenCalledWith('project:device:host-a:/repo/unpinned-elsewhere'),
    );
    expect(removePin).toHaveBeenCalledTimes(1);
    // A desktop that already owns its pins gets no second handoff.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('matches a Windows host\'s pins without case and shows the sidebar\'s own spelling', async () => {
    pinHostDeviceIds = ['host-w'];
    // The host pinned its folder-picker spelling; its sessions (and this sidebar) use another case.
    await hostReports('host-w', hostPins(['local:c:/work/proj']));
    const { result, removePin } = renderPinSync(
      ['project:device:host-w:C:/Work/Proj'],
      ['device:host-w:C:/Work/Proj'],
    );

    expect([...result.current.pinnedProjectKeys]).toEqual(['device:host-w:C:/Work/Proj']);
    await act(async () => {});
    expect(removePin).not.toHaveBeenCalled();
  });

  it('routes toggles to the owning desktop and never invents a local pin for an unreachable one', async () => {
    pinHostDeviceIds = ['host-a', 'host-b'];
    await hostReports('host-a', hostPins([]));
    invoke.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] sidebar-settings:get-project-pins'));
    await remoteProjectPins.refresh('host-c', () => true);
    const { result, promotePin, removePin } = renderPinSync(['project:local:/mine']);

    invoke.mockResolvedValueOnce(hostPins(['local:/repo/x']));
    await act(() => result.current.toggleProjectPin('device:host-a:/repo/x', false));
    expect(invoke).toHaveBeenLastCalledWith('host-a', 'sidebar-settings:apply-project-pins', [
      { ...HOST_STAMP, projectKeys: ['local:/repo/x'], pinned: true },
    ]);
    expect(promotePin).toHaveBeenCalledWith('project:device:host-a:/repo/x');
    expect(result.current.pinnedProjectKeys.has('device:host-a:/repo/x')).toBe(true);

    // host-b owns its pins but has not reported in this run: no local-only pin.
    await expect(result.current.toggleProjectPin('device:host-b:/repo/y', false)).rejects.toBeInstanceOf(
      ProjectPinHostUnavailableError,
    );
    expect(promotePin).not.toHaveBeenCalledWith('project:device:host-b:/repo/y');

    // An older desktop without the channel, and this computer's own project, stay local.
    await act(() => result.current.toggleProjectPin('device:host-c:/repo/z', false));
    expect(promotePin).toHaveBeenCalledWith('project:device:host-c:/repo/z');
    await act(() => result.current.toggleProjectPin('local:/mine', true));
    expect(removePin).toHaveBeenCalledWith('project:local:/mine');
  });
});
