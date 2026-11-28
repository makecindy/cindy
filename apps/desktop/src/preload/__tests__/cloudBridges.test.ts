import { describe, expect, it, vi } from 'vitest';

// Unit: the preload's cloud bridges and the launch argument Main gives only the main window.
const invoke = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }));
import { cloudWindowBridges } from '../cloudBridges';
import { createCloudWindowArgument, readCloudWindowRole } from '../../shared/cloudWindow';
import { CLOUD_CLIENT_CHANNELS } from '../../shared/cloudSettingsChannels';

describe('cloud window bridges', () => {
  it('gives a window without the main window argument no cloud bridge', () => {
    expect(cloudWindowBridges(['electron', '--some-other=1'])).toEqual({});
    expect(readCloudWindowRole(['--cindy-cloud-window=unknown'])).toBeNull();
  });

  it.each([false, true])('gives the main window the bridges, hostOwned=%s on a managed cloud instance', (instance) => {
    const bridges = cloudWindowBridges(['electron', createCloudWindowArgument({ instance })]);
    expect(bridges.hostSettings).toEqual({ hostOwned: instance });
    expect(Object.keys(bridges.cloudSettings!).sort()).toEqual(Object.keys(CLOUD_CLIENT_CHANNELS).sort());
    void bridges.cloudSettings!.instanceAccess({});
    expect(invoke).toHaveBeenCalledWith(CLOUD_CLIENT_CHANNELS.instanceAccess, {});
    expect(Object.keys(bridges.cloudLoginWindow!).sort()).toEqual(['onCompleted', 'open']);
  });
});
