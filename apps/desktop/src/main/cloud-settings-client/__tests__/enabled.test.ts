import { beforeEach, expect, it, vi } from 'vitest';

// Unit: the one switch that decides whether this app starts any cloud instance code.
const state = vi.hoisted(() => ({ configured: false, instance: null as object | null }));
vi.mock('../../clientEndpointsService', () => ({
  isCloudInstanceServiceConfigured: () => state.configured,
}));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => state.instance }));
import { cloudInstancesEnabled, cloudWindowArguments } from '../enabled';
import { cloudWindowBridges } from '../../../preload/cloudBridges';
vi.mock('electron', () => ({ ipcRenderer: {} }));

beforeEach(() => Object.assign(state, { configured: false, instance: null }));

it('is off without a cloud instance service, and the main window gets no cloud bridge', () => {
  expect(cloudInstancesEnabled()).toBe(false);
  expect(cloudWindowArguments()).toEqual([]);
  expect(cloudWindowBridges(cloudWindowArguments())).toEqual({});
});

it.each([
  ['a configured client', { configured: true }, false],
  ['a managed cloud instance', { instance: {} }, true],
])('is on for %s', (_label, change, hostOwned) => {
  Object.assign(state, change);
  expect(cloudInstancesEnabled()).toBe(true);
  expect(cloudWindowBridges(cloudWindowArguments())).toMatchObject({
    cloudSettings: expect.anything(),
    hostSettings: { hostOwned },
  });
});
