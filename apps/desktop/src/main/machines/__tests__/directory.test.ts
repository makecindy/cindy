import { describe, expect, it, vi } from 'vitest';
import type { MachineStatus } from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { listMachines, type MachineDirectoryDeps } from '../directory.js';

const status: MachineStatus = {
  capturedAt: '2026-11-02T00:00:00.000Z',
  cpu: { logicalCores: 16, busyPercent: 20, loadAverage1m: 3 },
  memory: { totalBytes: 64, availableBytes: 40 },
  disk: { freeBytes: 15, totalBytes: 100 },
  idleSeconds: 5,
  onBattery: false,
  runningTasks: 2,
};
const device = (over: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView => ({
  deviceId: 'd', name: 'd', platform: 'darwin', appVersion: '1', lastSeenAt: null, online: true, busy: false,
  remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...over,
});
const deps = (devices: DeviceLinkDeviceView[], invokeStatus: MachineDirectoryDeps['invokeStatus']): MachineDirectoryDeps => ({
  listDevices: async () => devices,
  invokeStatus,
  readLocal: async () => status,
  selfName: () => 'this-mac',
  listSsh: async () => [],
  probeTimeoutMs: 5,
});
const byId = async (input: MachineDirectoryDeps) =>
  Object.fromEntries((await listMachines(input)).computers.map(item => [item.deviceId, item.availability]));

describe('list_machines directory', () => {
  it('still reports this computer and SSH when the account device list cannot be read', async () => {
    const ssh = { kind: 'ssh' as const, id: 'nas', hostname: 'nas.local', port: 22, user: 'me', connection: 'disconnected' };
    const result = await listMachines({
      ...deps([], async () => status),
      listDevices: async () => { throw new Error('UNAUTHORIZED'); },
      listSsh: async () => [ssh],
    });
    expect(result.computersError).toBe('UNAUTHORIZED');
    expect(result.computers.map(item => [item.name, item.isSelf, item.availability, item.status?.cpu.logicalCores]))
      .toEqual([['this-mac', true, 'available', 16]]);
    expect(result.ssh).toEqual([ssh]);
  });

  it('reads the live status of this computer and of reachable ones, and leaves phones out', async () => {
    const { computers } = await listMachines(deps([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'mini' }),
      device({ deviceId: 'phone', platform: 'ios' }),
    ], async () => status));
    expect(computers.map(item => [item.deviceId, item.availability, item.status?.memory.availableBytes]))
      .toEqual([['self', 'available', 40], ['mini', 'available', 40]]);
  });

  it('keeps every computer it cannot read in the list, with the reason', async () => {
    expect(await byId(deps([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'off', online: false }),
      device({ deviceId: 'closed', remoteControlEnabled: false }),
      device({ deviceId: 'mine-off', controlEnabled: false }),
      device({ deviceId: 'old' }),
      device({ deviceId: 'broken' }),
    ], async (id) => { throw new Error(id === 'old' ? '[CHANNEL_NOT_ALLOWED] x' : '[DEVICE_OFFLINE] x'); }))).toEqual({
      self: 'available', off: 'offline', closed: 'remote_control_off', 'mine-off': 'control_off', old: 'update_required', broken: 'unreachable',
    });
  });

  it('does not let one stuck computer hold up the others', async () => {
    const invokeStatus = vi.fn((id: string) => id === 'stuck' ? new Promise(() => undefined) : Promise.resolve(status));
    expect(await byId(deps([device({ deviceId: 'self', isSelf: true }), device({ deviceId: 'stuck' }), device({ deviceId: 'ok' })], invokeStatus)))
      .toEqual({ self: 'available', stuck: 'unreachable', ok: 'available' });
  });

  it('says so when SSH hosts could not be read instead of reporting none', async () => {
    const result = await listMachines({ ...deps([], async () => status), listSsh: async () => { throw new Error('pool down'); } });
    expect(result.ssh).toEqual([]);
    expect(result.sshError).toBe('pool down');
  });
});
