import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
      ...overrides,
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

  it('falls back to the persisted remoteHostId when config is missing', () => {
    expect(resolveRemoteProjectMachineIdentity(remoteProject, [])?.displayLabel).toBe('gpu-box');
  });

  it('shows a device-link friendly name and keeps the stable device id visible', () => {
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
      detail: 'device-123',
      displayLabel: 'Office Mac · device-123',
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
