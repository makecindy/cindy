import { describe, expect, it, vi } from 'vitest';
import type { MachineStatus } from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { countMachineRunningTasks, listMachines, type MachineDirectoryDeps } from '../directory.js';

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
  readSsh: async () => '',
  isSshKeyKnown: async () => true,
  probeTimeoutMs: 5,
});
const byId = async (input: MachineDirectoryDeps) =>
  Object.fromEntries((await listMachines(input)).computers.map(item => [item.deviceId, item.availability]));

describe('list_machines directory', () => {
  it('still reports this computer and SSH when the account device list cannot be read', async () => {
    const ssh = { kind: 'ssh' as const, id: 'nas', hostname: 'nas.local', port: 22, user: 'me', connection: 'disconnected' };
    const unreachable = { ...ssh, availability: 'unreachable', os: null, arch: null, status: null, errorCode: 'SSH_CONNECT_FAILED' };
    const result = await listMachines({
      ...deps([], async () => status),
      listDevices: async () => { throw new Error('UNAUTHORIZED'); },
      listSsh: async () => [ssh],
      readSsh: async () => { throw new Error('[SSH_CONNECT_FAILED] refused'); },
    });
    expect(result.computersError).toBe('UNAUTHORIZED');
    expect(result.computers.map(item => [item.name, item.isSelf, item.availability, item.status?.cpu.logicalCores]))
      .toEqual([['this-mac', true, 'available', 16]]);
    expect(result.ssh).toEqual([unreachable]);
    const stuck = await listMachines({ ...deps([], async () => status), listDevices: () => new Promise(() => {}) });
    expect(stuck.computersError).toBe('[INVOKE_TIMEOUT]');
    expect(stuck.computers.map(item => item.availability)).toEqual(['available']);
    const badConfig = await listMachines({ ...deps([], async () => status), sshConfigProblem: () => 'SSH_CONFIG_UNREADABLE:parse' });
    expect(badConfig).toMatchObject({ ssh: [], sshError: 'SSH_CONFIG_UNREADABLE:parse' });
  });

  it('reads the live status of this computer and of reachable ones, and leaves phones out', async () => {
    const { computers } = await listMachines(deps([
      device({ deviceId: 'self', isSelf: true }),
      device({ deviceId: 'mini', name: 'Production builder', selfName: 'Mac mini' }),
      device({ deviceId: 'phone', platform: 'ios' }),
    ], async () => status));
    expect(computers[1]?.name).toBe('Production builder');
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
      device({ deviceId: 'older' }),
      device({ deviceId: 'broken' }),
    ], async (id) => { throw new Error(id === 'old' ? '[CHANNEL_NOT_ALLOWED] x' : id === 'older' ? '[UNSUPPORTED_CAPABILITY] x' : '[DEVICE_OFFLINE] x'); }))).toEqual({
      self: 'available', off: 'offline', closed: 'remote_control_off', 'mine-off': 'control_off', old: 'update_required', older: 'update_required', broken: 'unreachable',
    });
  });

  it('does not let one stuck computer hold up the others', async () => {
    const invokeStatus = vi.fn((id: string) => id === 'stuck' ? new Promise(() => undefined) : Promise.resolve(status));
    expect(await byId(deps([device({ deviceId: 'self', isSelf: true }), device({ deviceId: 'stuck' }), device({ deviceId: 'ok' })], invokeStatus)))
      .toEqual({ self: 'available', stuck: 'unreachable', ok: 'available' });
  });

  it('reads each SSH host without one stuck or foreign host holding up the rest', async () => {
    const host = (id: string) => ({ kind: 'ssh' as const, id, hostname: id, port: 22, user: 'me', connection: 'disconnected' });
    const { ssh } = await listMachines({
      ...deps([], async () => status),
      listSsh: async () => [host('nas'), host('stuck'), host('windows')],
      readSsh: (id) => id === 'stuck' ? new Promise(() => undefined)
        : Promise.resolve(id === 'nas' ? 'os=Linux\narch=x86_64\ncores=4\nMemTotal: 1024 kB\nMemAvailable: 512 kB\nload=0.02\ndisk=100 40\n' : 'not recognized'),
    });
    expect(ssh.map(item => [item.id, item.availability, item.status?.memory.availableBytes])).toEqual([
      ['nas', 'reachable', 512 * 1024], ['stuck', 'unreachable', undefined], ['windows', 'unreadable', undefined],
    ]);
    expect(ssh[0]!.status?.disk).toEqual({ freeBytes: 40 * 1024, totalBytes: 100 * 1024 });
  });

  it('never connects to a host whose key was not trusted before, and reports a changed key as such', async () => {
    const host = (id: string, hostname = id) => ({ kind: 'ssh' as const, id, hostname, port: 22, user: 'me', connection: 'disconnected' });
    const readSsh = vi.fn(async (id: string): Promise<string> => { throw new Error(id === 'router' ? '[SSH_HOST_KEY_MISMATCH] changed' : '[SSH_CONNECT_FAILED] refused'); });
    const { ssh } = await listMachines({
      ...deps([], async () => status),
      listSsh: async () => [host('new'), host('router'), host('mac', 'mini'), host('mini-1221', 'mini')],
      readSsh,
      isSshKeyKnown: async (hostname) => hostname !== 'new',
    });
    expect(ssh.map(item => [item.id, item.availability, item.sameAddressAs])).toEqual([
      ['new', 'unverified', undefined], ['router', 'host_key_changed', undefined],
      ['mac', 'unreachable', ['mini-1221']], ['mini-1221', 'unreachable', ['mac']],
    ]);
    expect(readSsh).not.toHaveBeenCalledWith('new');
  });

  it('says so when SSH hosts could not be read instead of reporting none', async () => {
    const result = await listMachines({ ...deps([], async () => status), listSsh: async () => { throw new Error('pool down'); } });
    expect(result.ssh).toEqual([]);
    expect(result.sshError).toBe('pool down');
  });

  it('counts running tasks where they run, even when their provider cannot be told', async () => {
    const route = (id: string, over = {}) => ({ id, agentKind: 'claude-code' as const, model: 'native-model', providerId: null, agentDeviceId: null, remoteHostId: null, ...over });
    expect(await countMachineRunningTasks({
      listTurnRunningSessions: () => ['here', 'other-computer', 'ssh'],
      readSessionRoutes: async () => [route('here'), route('other-computer', { agentDeviceId: 'b' }), route('ssh', { remoteHostId: 'nas' })],
      hostRunningProviders: () => ['openai'],
      applicationRunningProviders: () => [],
    })).toBe(2);
  });
});
