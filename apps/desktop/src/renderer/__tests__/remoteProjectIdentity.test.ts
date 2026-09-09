import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectAmbiguousDeviceNames,
  projectDisplayLabelWithMachine,
  resolveRemoteProjectMachineIdentity,
} from '@/features/cc-agent/lib/remoteProjectIdentity';
import { remoteSshHostsStore } from '@/lib/remoteSshHostsStore';

function sshHost(
  id: string,
  overrides: Partial<RemoteHostSnapshot['config']> = {},
): RemoteHostSnapshot {
  return {
    config: {
      id,
      hostname: '10.0.0.8',
      port: 22,
      user: 'alice',
      authMethod: 'agent',
      source: 'ssh-config',
      managedByCindy: false,
      ...overrides,
      identityFileConfigured: overrides.identityFileConfigured ?? false,
    },
    status: 'ready',
    statusChangedAt: 0,
    autoConnect: false,
    agentProxy: null,
    agentProxyTunnel: null,
  };
}

const remoteProject = {
  scope: 'remote' as const,
  remoteHostId: 'gpu-box',
  deviceLinkDeviceId: null,
  deviceLinkDeviceName: null,
};

describe('resolveRemoteProjectMachineIdentity', () => {
  it('shows the SSH alias together with user and hostname', () => {
    expect(resolveRemoteProjectMachineIdentity(remoteProject, [sshHost('gpu-box')])).toEqual({
      kind: 'ssh',
      label: 'gpu-box',
      detail: 'alice@10.0.0.8',
      displayLabel: 'gpu-box · alice@10.0.0.8',
    });
  });

  it('includes a non-default SSH port', () => {
    const identity = resolveRemoteProjectMachineIdentity(remoteProject, [
      sshHost('gpu-box', { hostname: 'example.test', port: 2202, user: 'root' }),
    ]);
    expect(identity?.displayLabel).toBe('gpu-box · root@example.test:2202');
  });

  it('shows a custom display name while retaining the SSH alias', () => {
    const identity = resolveRemoteProjectMachineIdentity(remoteProject, [
      sshHost('gpu-box', { displayName: 'Build box' }),
    ]);
    expect(identity?.displayLabel).toBe('Build box (gpu-box) · alice@10.0.0.8');
  });

  it('falls back to the persisted remoteHostId when config is missing', () => {
    expect(resolveRemoteProjectMachineIdentity(remoteProject, [])?.displayLabel).toBe('gpu-box');
  });

  // 2026-08-12 用户裁决:设备 ID 是机器指纹哈希,对用户没有可读意义,默认不显示;
  // 只有两台设备撞名、光看名字分不出来时才附上消歧。
  it('shows only the device-link friendly name when the name is unambiguous', () => {
    const identity = resolveRemoteProjectMachineIdentity(
      {
        scope: 'remote',
        remoteHostId: null,
        deviceLinkDeviceId: 'device-123',
        deviceLinkDeviceName: 'Office Mac',
      },
      [],
    );
    expect(identity).toEqual({
      kind: 'device-link',
      label: 'Office Mac',
      detail: null,
      displayLabel: 'Office Mac',
    });
  });

  it('appends the device id only for names shared by more than one device', () => {
    const identity = resolveRemoteProjectMachineIdentity(
      {
        scope: 'remote',
        remoteHostId: null,
        deviceLinkDeviceId: 'device-123',
        deviceLinkDeviceName: 'Office Mac',
      },
      [],
      { ambiguousDeviceNames: new Set(['office mac']) },
    );
    expect(identity).toEqual({
      kind: 'device-link',
      label: 'Office Mac',
      detail: 'device-123',
      displayLabel: 'Office Mac · device-123',
    });
  });

  it('falls back to the device id as the label when no device name resolved', () => {
    const identity = resolveRemoteProjectMachineIdentity(
      {
        scope: 'remote',
        remoteHostId: null,
        deviceLinkDeviceId: 'device-123',
        deviceLinkDeviceName: null,
      },
      [],
    );
    // 名字拿不到时 label 已经是 ID 本身,detail 不再重复一遍。
    expect(identity).toEqual({
      kind: 'device-link',
      label: 'device-123',
      detail: null,
      displayLabel: 'device-123',
    });
  });

  it('does not add a machine identity to local projects', () => {
    expect(
      resolveRemoteProjectMachineIdentity(
        {
          scope: 'local',
          remoteHostId: null,
          deviceLinkDeviceId: null,
          deviceLinkDeviceName: null,
        },
        [sshHost('gpu-box')],
      ),
    ).toBeNull();
  });
});

describe('collectAmbiguousDeviceNames', () => {
  const project = (deviceLinkDeviceId: string | null, deviceLinkDeviceName: string | null) => ({
    deviceLinkDeviceId,
    deviceLinkDeviceName,
  });

  it('flags a name only when it maps to more than one device id', () => {
    const ambiguous = collectAmbiguousDeviceNames([
      project('device-a', 'Dash Macbook Pro'),
      project('device-b', 'Dash Macbook Pro'),
      project('device-c', 'Office Mac'),
    ]);
    expect(ambiguous.has('dash macbook pro')).toBe(true);
    expect(ambiguous.has('office mac')).toBe(false);
  });

  it('does not flag several projects that live on the same device', () => {
    const ambiguous = collectAmbiguousDeviceNames([
      project('device-a', 'Dash Macbook Pro'),
      project('device-a', 'Dash Macbook Pro'),
    ]);
    expect(ambiguous.size).toBe(0);
  });

  it('compares names case-insensitively and ignores surrounding whitespace', () => {
    const ambiguous = collectAmbiguousDeviceNames([
      project('device-a', ' Dash Macbook Pro'),
      project('device-b', 'dash macbook pro '),
    ]);
    expect([...ambiguous]).toEqual(['dash macbook pro']);
  });

  it('skips entries without a device id or without a resolved name', () => {
    const ambiguous = collectAmbiguousDeviceNames([
      project(null, 'Dash Macbook Pro'),
      project('device-b', null),
      project('device-c', '   '),
    ]);
    expect(ambiguous.size).toBe(0);
  });
});

describe('projectDisplayLabelWithMachine', () => {
  it('serializes the enriched identity for locked search filters', () => {
    expect(
      projectDisplayLabelWithMachine({
        ...remoteProject,
        displayName: 'cindy-moved',
        remoteMachineIdentity: resolveRemoteProjectMachineIdentity(remoteProject, [
          sshHost('gpu-box'),
        ]),
      }),
    ).toBe('cindy-moved (gpu-box · alice@10.0.0.8)');
  });
});

describe('remoteSshHostsStore', () => {
  afterEach(() => {
    remoteSshHostsStore.reset();
    vi.unstubAllGlobals();
  });

  it('publishes a full registry replacement after settings mutations', () => {
    const subscriber = vi.fn();
    const unsubscribe = remoteSshHostsStore.subscribe(subscriber);
    const host = sshHost('gpu-box');

    remoteSshHostsStore.replace([host]);

    expect(remoteSshHostsStore.get()).toEqual([host]);
    expect(subscriber).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('does not let an older in-flight list overwrite a settings replacement', async () => {
    let resolveList!: (value: { hosts: RemoteHostSnapshot[] }) => void;
    const list = vi.fn(
      () =>
        new Promise<{ hosts: RemoteHostSnapshot[] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.stubGlobal('window', { electronAPI: { remoteSsh: { list } } });

    const ensurePromise = remoteSshHostsStore.ensure();
    expect(list).toHaveBeenCalledOnce();
    const freshHost = sshHost('fresh-host');
    remoteSshHostsStore.replace([freshHost]);
    resolveList({ hosts: [sshHost('stale-host')] });
    await ensurePromise;

    expect(remoteSshHostsStore.get()).toEqual([freshHost]);
  });

  it('removes a deleted host from the shared snapshot', () => {
    remoteSshHostsStore.replace([sshHost('keep'), sshHost('remove')]);

    remoteSshHostsStore.remove('remove');

    expect(remoteSshHostsStore.get()?.map((host) => host.config.id)).toEqual(['keep']);
  });
});
