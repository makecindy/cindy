import { describe, expect, it, vi } from 'vitest';

import {
  applyControllerPresenceDirectorySnapshot,
  createControllerPresenceFreshnessTracker,
  isVerifiedControllerDataPath,
  markControllerPresenceFresh,
  resolveControllerPresence,
  resetControllerPresenceFreshness,
} from '../device-link/controllerPresenceDirectory';

function createHarness() {
  const freshness = createControllerPresenceFreshnessTracker();
  const onlineByDevice = new Map<string, boolean>();
  const platformByDevice = new Map<string, string>();
  const nameByDevice = new Map<string, string>();
  const exchanged = vi.fn();
  const confirmed = vi.fn();
  const refused = vi.fn();
  const evidence = vi.fn();

  return {
    freshness,
    onlineByDevice,
    platformByDevice,
    nameByDevice,
    exchanged,
    confirmed,
    refused,
    evidence,
    markPresence(deviceId: string, online: boolean, platform: string) {
      markControllerPresenceFresh(freshness, deviceId);
      onlineByDevice.set(deviceId, online);
      platformByDevice.set(deviceId, platform);
    },
    apply(
      devices: Parameters<typeof applyControllerPresenceDirectorySnapshot>[0]['devices'],
      requestEpoch = freshness.epoch,
    ) {
      applyControllerPresenceDirectorySnapshot({
        devices,
        requestEpoch,
        selfDeviceId: 'self-device',
        freshness,
        getOnline: (deviceId) => onlineByDevice.get(deviceId),
        setOnline: (deviceId, online) => onlineByDevice.set(deviceId, online),
        forgetOnline: (deviceId) => onlineByDevice.delete(deviceId),
        setPlatform: (deviceId, platform) => {
          if (platform) platformByDevice.set(deviceId, platform);
          else platformByDevice.delete(deviceId);
        },
        setName: (deviceId, name) => nameByDevice.set(deviceId, name),
        shouldNotifyPeerOnline: ({ online, platform }) =>
          online &&
          platform !== null &&
          ['darwin', 'win32', 'linux', 'ios', 'android'].includes(platform),
        onPeerBecameOnline: exchanged,
        onPeerControlEnabled: confirmed,
        onPeerControlDisabled: refused,
        onPeerControlEvidence: evidence,
      });
    },
  };
}

describe('controller presence directory snapshot', () => {
  // Unit: group RPC availability outlives transient relay loss only on a
  // bounded, already-authenticated path. Only an online false bit is a fresh
  // control-off; offline rows mask the flag and must keep verified availability.
  it.each([
    ['keeps a known usable group path', { online: false, remoteControlEnabled: true }, true, true,
      { directOnline: true, online: true, available: true }],
    ['does not revive a relay-only peer', { online: false, remoteControlEnabled: true }, false, true,
      { directOnline: false, online: false, available: false }],
    ['honors an explicit online control-off report', { online: true, remoteControlEnabled: false }, true, true,
      { directOnline: false, online: true, available: false }],
    ['keeps an offline mask available only from prior verified control', { online: false, remoteControlEnabled: false }, true, true,
      { directOnline: true, online: true, available: true }],
    ['keeps a previously refused peer unavailable while offline', { online: false, remoteControlEnabled: false }, true, false,
      { directOnline: true, online: true, available: false }],
    // An authenticated, reliable direct path was accepted while control was enabled;
    // unknown in-memory availability is not an explicit refusal.
    ['treats an authenticated retained path as prior control evidence', { online: false, remoteControlEnabled: true }, true, undefined,
      { directOnline: true, online: true, available: true }],
    ['allows a freshly controllable peer to recover', { online: true, remoteControlEnabled: true }, false, false,
      { directOnline: false, online: true, available: true }],
  ] as const)('%s', (_name, snapshot, retained, previous, expected) => {
    expect(resolveControllerPresence(snapshot, retained, previous)).toEqual(expected);
  });


  // A stale REST directory may claim online only from the target's current,
  // authenticated data path; unknown/false presence, explicit denial, local
  // opt-out and incomplete link readiness stay conservative.
  it.each([
    ['healthy relay data path', { linkStatus: 'online' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: true, revoked: false, locallyDisabled: false }, true],
    ['unknown presence', { linkStatus: 'online' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: undefined, revoked: false, locallyDisabled: false }, false],
    ['explicit control-off', { linkStatus: 'online' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: false, revoked: false, locallyDisabled: false }, false],
    ['incomplete link handshake', { linkStatus: 'online' as const, linkReady: false, offlineDirect: false,
      presenceAvailable: true, revoked: false, locallyDisabled: false }, false],
    ['connecting without retained direct', { linkStatus: 'connecting' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: true, revoked: false, locallyDisabled: false }, false],
    ['retained offline direct path', { linkStatus: 'connecting' as const, linkReady: true, offlineDirect: true,
      presenceAvailable: true, revoked: false, locallyDisabled: false }, true],
    ['revoked target', { linkStatus: 'online' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: true, revoked: true, locallyDisabled: false }, false],
    ['locally disabled target', { linkStatus: 'online' as const, linkReady: true, offlineDirect: false,
      presenceAvailable: true, revoked: false, locallyDisabled: true }, false],
  ] as const)('%s', (_name, proof, expected) => {
    expect(isVerifiedControllerDataPath(proof)).toBe(expected);
  });

  it('separates raw online control evidence from the retained display projection', () => {
    const h = createHarness();
    h.apply([
      { deviceId: 'enabled', online: true, remoteControlEnabled: true, platform: 'darwin' },
      { deviceId: 'disabled', online: true, remoteControlEnabled: false, platform: 'darwin' },
      { deviceId: 'offline', online: false, remoteControlEnabled: false, platform: 'darwin' },
    ]);
    expect(h.confirmed).toHaveBeenCalledWith('enabled');
    expect(h.refused).toHaveBeenCalledWith('disabled');
    expect(h.evidence).toHaveBeenCalledWith('enabled', { online: true, enabled: true });
    expect(h.evidence).toHaveBeenCalledWith('disabled', { online: true, enabled: false });
    expect(h.evidence).toHaveBeenCalledWith('offline', { online: false });
  });

  it('reports positive control evidence only for an online, enabled directory row', () => {
    const h = createHarness();
    h.apply([{ deviceId: 'peer-desktop', online: true, remoteControlEnabled: true, platform: 'darwin' }]);
    expect(h.confirmed).toHaveBeenCalledExactlyOnceWith('peer-desktop');
    h.apply([{ deviceId: 'peer-desktop', online: true, remoteControlEnabled: false, platform: 'darwin' }]);
    h.apply([{ deviceId: 'peer-desktop', online: false, remoteControlEnabled: true, platform: 'darwin' }]);
    expect(h.confirmed).toHaveBeenCalledTimes(1);
  });

  it('冷启动时从目录初始化已在线桌面并触发一次词典握手', () => {
    const h = createHarness();

    h.apply([
      {
        deviceId: 'peer-desktop',
        name: 'Database Name',
        selfName: 'MacBook Pro',
        online: true,
        platform: 'darwin',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
    expect(h.nameByDevice.get('peer-desktop')).toBe('MacBook Pro');
    expect(h.exchanged).toHaveBeenCalledWith('peer-desktop', 'darwin');
  });

  it('排除本机和离线设备，桌面与手机重复目录都不重复制造上线边沿', () => {
    const h = createHarness();
    const devices = [
      { deviceId: 'self-device', online: true, platform: 'darwin', isSelf: true },
      { deviceId: 'peer-phone', online: true, platform: 'ios', isSelf: false },
      { deviceId: 'peer-offline', online: false, platform: 'win32', isSelf: false },
      { deviceId: 'peer-desktop', online: true, platform: 'linux', isSelf: false },
    ];

    h.apply(devices);
    h.apply(devices);

    expect(h.exchanged).toHaveBeenCalledTimes(2);
    expect(h.exchanged).toHaveBeenCalledWith('peer-phone', 'ios');
    expect(h.exchanged).toHaveBeenCalledWith('peer-desktop', 'linux');
    expect(h.onlineByDevice.get('peer-phone')).toBe(true);
    expect(h.onlineByDevice.get('peer-offline')).toBe(false);
    expect(h.onlineByDevice.has('self-device')).toBe(false);
  });

  it('请求期间到达的实时 presence 优先，不被在途旧目录覆盖', () => {
    const h = createHarness();
    const requestEpoch = h.freshness.epoch;

    markControllerPresenceFresh(h.freshness, 'peer-desktop');
    h.onlineByDevice.set('peer-desktop', false);
    h.platformByDevice.set('peer-desktop', 'win32');
    h.nameByDevice.set('peer-desktop', 'Live Name');
    h.apply(
      [
        {
          deviceId: 'peer-desktop',
          name: 'Stale Name',
          online: true,
          platform: 'darwin',
          isSelf: false,
        },
      ],
      requestEpoch,
    );

    expect(h.onlineByDevice.get('peer-desktop')).toBe(false);
    expect(h.platformByDevice.get('peer-desktop')).toBe('win32');
    expect(h.nameByDevice.get('peer-desktop')).toBe('Live Name');
    expect(h.exchanged).not.toHaveBeenCalled();
  });

  it('首次看到的在线目录项缺平台时保持未知，让后续真实 presence 仍能触发上线', () => {
    const h = createHarness();

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: null,
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.has('peer-desktop')).toBe(false);
    expect(h.platformByDevice.has('peer-desktop')).toBe(false);
    expect(h.exchanged).not.toHaveBeenCalled();
  });

  it('在线目录项的平台不受支持时保持未知，后续规范平台仍能形成上线边沿', () => {
    const h = createHarness();

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: 'legacy-desktop',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.has('peer-desktop')).toBe(false);
    expect(h.platformByDevice.has('peer-desktop')).toBe(false);
    expect(h.exchanged).not.toHaveBeenCalled();

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: 'darwin',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
    expect(h.exchanged).toHaveBeenCalledWith('peer-desktop', 'darwin');
  });

  it.each([null, 'legacy-desktop'])(
    '后续在线目录项平台为 %s 时保留可信状态，明确离线后再清除',
    (incompletePlatform) => {
      const h = createHarness();

      h.apply([
        {
          deviceId: 'peer-desktop',
          online: true,
          platform: 'darwin',
          isSelf: false,
        },
      ]);
      h.apply([
        {
          deviceId: 'peer-desktop',
          online: true,
          platform: incompletePlatform,
          isSelf: false,
        },
      ]);

      expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
      expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
      expect(h.exchanged).toHaveBeenCalledTimes(1);

      h.apply([
        {
          deviceId: 'peer-desktop',
          online: false,
          platform: incompletePlatform,
          isSelf: false,
        },
      ]);

      expect(h.onlineByDevice.get('peer-desktop')).toBe(false);
      expect(h.platformByDevice.has('peer-desktop')).toBe(false);
      expect(h.exchanged).toHaveBeenCalledTimes(1);
    },
  );

  it('在线目录项缺平台时不清除实时 presence 已确认的在线状态与平台', () => {
    const h = createHarness();
    h.markPresence('peer-desktop', true, 'darwin');

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: null,
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
    expect(h.exchanged).not.toHaveBeenCalled();
  });

  it('目录离线快照不把实时 presence 已确认的在线设备降级', () => {
    const h = createHarness();
    h.markPresence('peer-desktop', true, 'darwin');

    h.apply([
      {
        deviceId: 'peer-desktop',
        selfName: 'Directory Name',
        online: false,
        platform: 'win32',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
    expect(h.nameByDevice.get('peer-desktop')).toBe('Directory Name');
    expect(h.exchanged).not.toHaveBeenCalled();
  });

  it('目录在线快照不把实时 presence 已确认的离线设备升级', () => {
    const h = createHarness();
    h.markPresence('peer-desktop', false, 'win32');

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: 'darwin',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(false);
    expect(h.platformByDevice.get('peer-desktop')).toBe('win32');
    expect(h.exchanged).not.toHaveBeenCalled();
  });

  it('实时 presence 到达前，后续目录快照持续更新状态并只在上线边沿握手', () => {
    const h = createHarness();

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: false,
        platform: 'win32',
        isSelf: false,
      },
    ]);
    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: 'darwin',
        isSelf: false,
      },
    ]);
    h.apply([
      {
        deviceId: 'peer-desktop',
        online: true,
        platform: 'darwin',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.platformByDevice.get('peer-desktop')).toBe('darwin');
    expect(h.exchanged).toHaveBeenCalledTimes(1);
    expect(h.exchanged).toHaveBeenCalledWith('peer-desktop', 'darwin');

    h.apply([
      {
        deviceId: 'peer-desktop',
        online: false,
        platform: 'win32',
        isSelf: false,
      },
    ]);

    expect(h.onlineByDevice.get('peer-desktop')).toBe(false);
    expect(h.platformByDevice.get('peer-desktop')).toBe('win32');
    expect(h.exchanged).toHaveBeenCalledTimes(1);
  });

  it('连接代重置后允许新目录重新初始化同一设备', () => {
    const h = createHarness();
    const oldRequestEpoch = h.freshness.epoch;
    markControllerPresenceFresh(h.freshness, 'peer-desktop');
    resetControllerPresenceFreshness(h.freshness);

    h.apply(
      [
        {
          deviceId: 'peer-desktop',
          online: true,
          platform: 'darwin',
          isSelf: false,
        },
      ],
      oldRequestEpoch + 2,
    );

    expect(h.onlineByDevice.get('peer-desktop')).toBe(true);
    expect(h.exchanged).toHaveBeenCalledWith('peer-desktop', 'darwin');
  });
});
