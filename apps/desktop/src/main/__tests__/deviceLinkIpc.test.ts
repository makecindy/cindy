/**
 * device-link IPC handler 业务体单测(内存 harness 直接调 handler body,不起 Electron)。
 * 覆盖:参数校验、ServerApiError → IpcError 映射、settings normalize。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capabilities = vi.hoisted(() => ({ canUseDeviceLink: true }));

// electron / serverApiClient / device-link host 全部替换为测试替身,
// 只测 handler 纯函数体
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp' },
}));
vi.mock('../serverApiClient', () => {
  class ServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ServerApiError, serverApiFetch: vi.fn() };
});
vi.mock('./index', () => ({
  getDeviceLinkStatus: () => 'online',
  clearDeviceResponsiveness: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  broadcast: vi.fn(),
  captureControllerDisplayNameRequestEpoch: () => 0,
  readControllerDisplayNameFreshnessSince: () => ({
    changedAfterRequest: false,
    authoritativeName: null,
  }),
}));
vi.mock('../device-link/index', () => ({
  getDeviceLinkStatus: () => 'online',
  setRemoteControlEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  broadcast: vi.fn(),
  captureControllerDisplayNameRequestEpoch: () => 0,
  readControllerDisplayNameFreshnessSince: () => ({
    changedAfterRequest: false,
    authoritativeName: null,
  }),
}));
vi.mock('../device-link/dispatch', () => ({
  getActiveControllers: () => [],
}));
vi.mock('../device-link/settings-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-link/settings-store')>();
  return {
    ...actual,
    readDeviceLinkSettings: () => ({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    }),
  };
});
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../appCapabilities.js', () => ({
  getAppCapabilities: () => ({
    canUseDeviceLink: capabilities.canUseDeviceLink,
  }),
}));

import {
  handleGetState,
  handleSetEnabled,
  handleSetKeepAwake,
  handleSetDeviceControlEnabled,
  handleListDevices,
  handleRenameDevice,
  handleDeleteDevice,
  handleOpenLink,
  handleCloseLink,
  handleInvoke,
  handleSubscribe,
  handleUnsubscribe,
  handleRevoke,
  handleRestore,
  retryUnsubscribeAfterWindowGone,
  type DeviceLinkIpcDeps,
} from '../device-link/ipc';
import { DeviceLinkError } from '@cindy/device-link';
import { ServerApiError } from '../serverApiClient';
import {
  __testing as settingsTesting,
  normalizeCachedDeviceName,
} from '../device-link/settings-store';
import { __testing as refcountTesting } from '../device-link/subscriptionRefcount';
import {
  applyControllerDisplayNamePresence,
  createControllerDisplayNameFreshnessTracker,
  getControllerDisplayNameFreshnessSince,
  resetControllerDisplayNameFreshness,
} from '../device-link/controllerDisplayNameFreshness';

function makeDeps(overrides?: Partial<DeviceLinkIpcDeps>): DeviceLinkIpcDeps {
  return {
    getState: () => ({
      remoteControlEnabled: true,
      keepAwake: false,
      linkStatus: 'online',
      connectionIssue: null,
      standby: false,
      controlledBy: [],
      revokedControllers: [],
      disabledControlDeviceIds: [],
      unresponsiveDeviceIds: [],
    }),
    setEnabled: vi.fn(),
    setKeepAwake: vi.fn(),
    apiFetch: vi.fn().mockResolvedValue({ devices: [] }),
    openLink: vi.fn().mockResolvedValue({ appVersion: '1.0.0', allowlistHash: 'abc' }),
    closeLink: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, result: null }),
    subscribe: vi.fn().mockResolvedValue({ ok: true, result: { ok: true } }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true, result: { ok: true } }),
    disconnectAll: vi.fn(),
    revoke: vi.fn(),
    restore: vi.fn(),
    setDeviceControlEnabled: vi.fn(async () => []),
    clearDeviceResponsiveness: vi.fn(),
    broadcast: vi.fn(),
    readLastKnownDeviceNames: vi.fn(() => ({})),
    rememberLastKnownDeviceName: vi.fn(async () => false),
    forgetLastKnownDeviceName: vi.fn(async () => false),
    applyControllerDisplayNameListSnapshot: vi.fn(),
    beginControllerDisplayNameDirectoryRefresh: vi.fn(() => 1),
    captureControllerDisplayNameRequestEpoch: vi.fn(() => 0),
    isLatestControllerDisplayNameDirectoryRefresh: vi.fn(() => true),
    waitForNewerControllerDisplayNameDirectoryRefresh: vi.fn(async () => {}),
    readControllerDisplayNameFreshnessSince: vi.fn(() => ({
      changedAfterRequest: false,
      authoritativeName: null,
    })),
    ...overrides,
  };
}

describe('device-link IPC handlers', () => {
  beforeEach(() => {
    refcountTesting.reset(); // 多窗口订阅引用计数:每个用例独立
    capabilities.canUseDeviceLink = true;
  });

  it('getState 透传 deps 状态', () => {
    expect(handleGetState(makeDeps())).toEqual({
      remoteControlEnabled: true,
      keepAwake: false,
      linkStatus: 'online',
      connectionIssue: null,
      standby: false,
      controlledBy: [],
      revokedControllers: [],
      disabledControlDeviceIds: [],
      unresponsiveDeviceIds: [],
    });
  });

  it('getState 透传待命状态', () => {
    const deps = makeDeps({
      getState: () => ({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'stopped',
        connectionIssue: null,
        standby: true,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      }),
    });
    expect(handleGetState(deps).standby).toBe(true);
  });

  it('getState: local/signed-out sessions only expose keepAwake', () => {
    capabilities.canUseDeviceLink = false;
    const deps = makeDeps({
      getState: () => ({
        remoteControlEnabled: true,
        keepAwake: true,
        linkStatus: 'online',
        connectionIssue: {
          kind: 'auth-failed',
          closeCode: 401,
          detail: 'account state',
          at: 123,
        },
        standby: false,
        controlledBy: [{ deviceId: 'controller-1', name: 'Other device' }],
        revokedControllers: ['revoked-1'],
        disabledControlDeviceIds: ['disabled-1'],
        unresponsiveDeviceIds: ['unresponsive-1'],
      }),
    });

    expect(handleGetState(deps)).toEqual({
      remoteControlEnabled: false,
      keepAwake: true,
      linkStatus: 'stopped',
      connectionIssue: null,
      standby: false,
      controlledBy: [],
      revokedControllers: [],
      disabledControlDeviceIds: [],
      unresponsiveDeviceIds: [],
    });
  });

  it('setEnabled:布尔校验 + 调 deps', async () => {
    const deps = makeDeps();
    await expect(handleSetEnabled(deps, true)).resolves.toEqual({ remoteControlEnabled: true });
    expect(deps.setEnabled).toHaveBeenCalledWith(true);

    await expect(handleSetEnabled(deps, 'yes')).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleSetEnabled(deps, undefined)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });

  it('setKeepAwake:布尔校验 + 调 deps', async () => {
    const deps = makeDeps();
    await expect(handleSetKeepAwake(deps, true)).resolves.toEqual({ keepAwake: true });
    expect(deps.setKeepAwake).toHaveBeenCalledWith(true);

    // 关闭开关的正向路径:透传 false + 返回 { keepAwake: false }
    await expect(handleSetKeepAwake(deps, false)).resolves.toEqual({ keepAwake: false });
    expect(deps.setKeepAwake).toHaveBeenCalledWith(false);

    await expect(handleSetKeepAwake(deps, 'yes')).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleSetKeepAwake(deps, undefined)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });

  it('setDeviceControlEnabled:维护本机控制偏好,关闭时断开该设备 link 并广播', async () => {
    const deps = makeDeps({
      setDeviceControlEnabled: vi.fn(async () => ['dev-1']),
    });
    await expect(handleSetDeviceControlEnabled(deps, ' dev-1 ', false)).resolves.toEqual({
      deviceId: 'dev-1',
      enabled: false,
      disabledControlDeviceIds: ['dev-1'],
    });
    expect(deps.setDeviceControlEnabled).toHaveBeenCalledWith('dev-1', false);
    expect(deps.clearDeviceResponsiveness).toHaveBeenCalledWith('dev-1');
    expect(deps.closeLink).toHaveBeenCalledWith('dev-1');
    expect(deps.broadcast).toHaveBeenCalledWith('device-link:control-target-changed', {
      deviceId: 'dev-1',
      enabled: false,
      disabledControlDeviceIds: ['dev-1'],
    });
  });

  it('setDeviceControlEnabled:开启时只更新偏好,不主动 closeLink', async () => {
    const deps = makeDeps();
    await expect(handleSetDeviceControlEnabled(deps, 'dev-1', true)).resolves.toEqual({
      deviceId: 'dev-1',
      enabled: true,
      disabledControlDeviceIds: [],
    });
    expect(deps.closeLink).not.toHaveBeenCalled();
    expect(deps.clearDeviceResponsiveness).not.toHaveBeenCalled();
    await expect(handleSetDeviceControlEnabled(deps, '', true)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleSetDeviceControlEnabled(deps, 'dev-1', 'yes')).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });

  it('listDevices:503 → DEVICE_LINK_UNAVAILABLE,网络错(status 0)同样', async () => {
    const deps503 = makeDeps({
      apiFetch: vi.fn().mockRejectedValue(new ServerApiError('SERVICE_UNAVAILABLE', 503, 'off')),
    });
    await expect(handleListDevices(deps503)).rejects.toThrowError(/\[DEVICE_LINK_UNAVAILABLE\]/);

    const depsNet = makeDeps({
      apiFetch: vi.fn().mockRejectedValue(new ServerApiError('NETWORK_ERROR', 0, 'net down')),
    });
    await expect(handleListDevices(depsNet)).rejects.toThrowError(/\[DEVICE_LINK_UNAVAILABLE\]/);
  });

  it.each([
    ['旧数据库名', '新数据库名', '新数据库名'],
    ['', '新数据库名', '新数据库名'],
    ['旧数据库名', null, 'Host.local'],
  ] as const)(
    'listDevices:被后台目录淘汰的旧响应(%s)等待后返回当前权威名(%s)',
    async (name, authoritativeName, expectedName) => {
      const applyControllerDisplayNameListSnapshot = vi.fn();
      const rememberLastKnownDeviceName = vi.fn(async () => true);
      const forgetLastKnownDeviceName = vi.fn(async () => true);
      const waitForNewerControllerDisplayNameDirectoryRefresh = vi.fn(async () => {});
      const deps = makeDeps({
        apiFetch: vi.fn().mockResolvedValue({
          devices: [
            {
              deviceId: 'dev-1',
              name,
              selfName: 'Host.local',
              platform: 'darwin',
              lastSeenAt: '2026-06-23T00:00:00.000Z',
              online: true,
              busy: false,
              remoteControlEnabled: true,
              controlEnabled: true,
              isSelf: false,
            },
          ],
        }),
        applyControllerDisplayNameListSnapshot,
        rememberLastKnownDeviceName,
        forgetLastKnownDeviceName,
        beginControllerDisplayNameDirectoryRefresh: vi.fn(() => 1),
        isLatestControllerDisplayNameDirectoryRefresh: vi.fn(() => false),
        waitForNewerControllerDisplayNameDirectoryRefresh,
        readControllerDisplayNameFreshnessSince: vi.fn(() => ({
          changedAfterRequest: false,
          authoritativeName,
        })),
      });

      await expect(handleListDevices(deps)).resolves.toMatchObject({
        devices: [{ name: expectedName }],
      });

      expect(waitForNewerControllerDisplayNameDirectoryRefresh).toHaveBeenCalledWith(1);
      expect(applyControllerDisplayNameListSnapshot).not.toHaveBeenCalled();
      expect(rememberLastKnownDeviceName).not.toHaveBeenCalled();
      expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
    },
  );

  it.each(['旧目录名', ''] as const)(
    'listDevices:并发请求中新响应先返回时，晚到旧响应(%s)跟随新结果且不回写缓存',
    async (oldName) => {
      const resolvers: Array<(value: unknown) => void> = [];
      const apiFetch: DeviceLinkIpcDeps['apiFetch'] = <T>() =>
        new Promise<T>((resolve) => {
          resolvers.push((value) => resolve(value as T));
        });
      const rememberLastKnownDeviceName = vi.fn(async () => true);
      const forgetLastKnownDeviceName = vi.fn(async () => true);
      const applyControllerDisplayNameListSnapshot = vi.fn();
      const deps = makeDeps({
        apiFetch,
        rememberLastKnownDeviceName,
        forgetLastKnownDeviceName,
        applyControllerDisplayNameListSnapshot,
      });
      const device = (name: string) => ({
        deviceId: 'dev-1',
        name,
        selfName: 'Host.local',
        platform: 'darwin',
        lastSeenAt: '2026-06-23T00:00:00.000Z',
        online: true,
        busy: false,
        remoteControlEnabled: true,
        controlEnabled: true,
        isSelf: false,
      });

      const oldRequest = handleListDevices(deps);
      const newRequest = handleListDevices(deps);
      resolvers[1]?.({ devices: [device('新数据库名')] });
      await expect(newRequest).resolves.toMatchObject({
        devices: [{ name: '新数据库名' }],
      });
      resolvers[0]?.({ devices: [device(oldName)] });
      await expect(oldRequest).resolves.toMatchObject({
        devices: [{ name: '新数据库名' }],
      });

      expect(rememberLastKnownDeviceName).toHaveBeenCalledTimes(1);
      expect(rememberLastKnownDeviceName).toHaveBeenCalledWith('dev-1', '新数据库名');
      expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
      expect(applyControllerDisplayNameListSnapshot).toHaveBeenCalledTimes(1);
      expect(applyControllerDisplayNameListSnapshot).toHaveBeenCalledWith(
        [expect.objectContaining({ deviceId: 'dev-1', name: '新数据库名' })],
        0,
      );
    },
  );

  it('listDevices:缓存服务端返回的有效设备名', async () => {
    const rememberLastKnownDeviceName = vi.fn(async () => true);
    const deps = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({
        devices: [
          {
            deviceId: 'dev-1',
            name: 'MacBook Pro',
            selfName: 'Carol-MacBook-Pro',
            deviceInfo: { cpuLabel: 'Apple M3 Pro', memoryGb: 36 },
            platform: 'darwin',
            appVersion: '1.0.0-test',
            lastSeenAt: '2026-06-23T00:00:00.000Z',
            online: true,
            busy: false,
            remoteControlEnabled: true,
            controlEnabled: true,
            isSelf: false,
          },
        ],
      }),
      readLastKnownDeviceNames: vi.fn(() => ({})),
      rememberLastKnownDeviceName,
    });

    await expect(handleListDevices(deps)).resolves.toEqual({
      devices: [
        {
          deviceId: 'dev-1',
          name: 'MacBook Pro',
          selfName: 'Carol-MacBook-Pro',
          deviceInfo: { cpuLabel: 'Apple M3 Pro', memoryGb: 36 },
          platform: 'darwin',
          appVersion: '1.0.0-test',
          lastSeenAt: '2026-06-23T00:00:00.000Z',
          online: true,
          busy: false,
          remoteControlEnabled: true,
          controlEnabled: true,
          isSelf: false,
        },
      ],
    });
    expect(rememberLastKnownDeviceName).toHaveBeenCalledWith('dev-1', 'MacBook Pro');
  });

  it.each(['unknown', 'no'])('listDevices:离线设备返回 %s 时用本地 last-known 名字补齐', async (name) => {
    const deps = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({
        devices: [
          {
            deviceId: 'dev-1',
            name,
            platform: 'darwin',
            lastSeenAt: '2026-06-23T00:00:00.000Z',
            online: false,
            busy: false,
            remoteControlEnabled: false,
            controlEnabled: true,
            isSelf: false,
          },
        ],
      }),
      readLastKnownDeviceNames: vi.fn(() => ({ 'dev-1': 'MacBook Pro' })),
      rememberLastKnownDeviceName: vi.fn(async () => false),
    });

    await expect(handleListDevices(deps)).resolves.toEqual({
      devices: [
        {
          deviceId: 'dev-1',
          name: 'MacBook Pro',
          platform: 'darwin',
          lastSeenAt: '2026-06-23T00:00:00.000Z',
          online: false,
          busy: false,
          remoteControlEnabled: false,
          controlEnabled: true,
          isSelf: false,
        },
      ],
    });
  });

  it.each([
    ['unknown', 'Host.local', 'Host.local'],
    ['no', null, '12345678'],
  ] as const)(
    'listDevices:目录占位名 %s 无缓存时回退 selfName/设备短 ID(%s)',
    async (name, selfName, expectedName) => {
      const deps = makeDeps({
        apiFetch: vi.fn().mockResolvedValue({
          devices: [
            {
              deviceId: '1234567890abcdef',
              name,
              selfName,
              platform: 'darwin',
              lastSeenAt: '2026-06-23T00:00:00.000Z',
              online: false,
              busy: false,
              remoteControlEnabled: false,
              controlEnabled: true,
              isSelf: false,
            },
          ],
        }),
        readLastKnownDeviceNames: vi.fn(() => ({})),
      });

      const result = await handleListDevices(deps);
      expect(result.devices[0]?.name).toBe(expectedName);
      expect(deps.rememberLastKnownDeviceName).not.toHaveBeenCalled();
      expect(deps.forgetLastKnownDeviceName).not.toHaveBeenCalled();
    },
  );

  it('listDevices:断线重连后的新 presence 阻止断线前旧列表响应删除名称', async () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    applyControllerDisplayNamePresence({
      deviceId: 'dev-1',
      name: '断线前名称',
      selfName: 'Host.local',
      freshness,
      normalizeName: normalizeCachedDeviceName,
      setDisplayName: vi.fn(),
      setFallbackDisplayName: vi.fn(),
      rememberName: vi.fn(),
      forgetName: vi.fn(),
    });
    const rememberLastKnownDeviceName = vi.fn(async () => true);
    const forgetLastKnownDeviceName = vi.fn(async () => true);
    const apiFetch: DeviceLinkIpcDeps['apiFetch'] = async <T>() => {
      resetControllerDisplayNameFreshness(freshness);
      applyControllerDisplayNamePresence({
        deviceId: 'dev-1',
        name: '重连后名称',
        selfName: 'Host.local',
        freshness,
        normalizeName: normalizeCachedDeviceName,
        setDisplayName: vi.fn(),
        setFallbackDisplayName: vi.fn(),
        rememberName: vi.fn(),
        forgetName: vi.fn(),
      });
      return {
        devices: [
          {
            deviceId: 'dev-1',
            name: '',
            selfName: 'Host.local',
            platform: 'darwin',
            lastSeenAt: '2026-06-23T00:00:00.000Z',
            online: true,
            busy: false,
            remoteControlEnabled: true,
            controlEnabled: true,
            isSelf: false,
          },
        ],
      } as T;
    };
    const deps = makeDeps({
      apiFetch,
      rememberLastKnownDeviceName,
      forgetLastKnownDeviceName,
      captureControllerDisplayNameRequestEpoch: () => freshness.epoch,
      readControllerDisplayNameFreshnessSince: (deviceId, requestEpoch) =>
        getControllerDisplayNameFreshnessSince(freshness, deviceId, requestEpoch),
    });

    const result = await handleListDevices(deps);
    expect(result.devices[0]?.name).toBe('重连后名称');
    expect(rememberLastKnownDeviceName).not.toHaveBeenCalled();
    expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
  });

  it('listDevices:仅发生 relay reset 时仍采用并缓存有效数据库展示名', async () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const rememberLastKnownDeviceName = vi.fn(async () => true);
    const forgetLastKnownDeviceName = vi.fn(async () => true);
    const apiFetch: DeviceLinkIpcDeps['apiFetch'] = async <T>() => {
      resetControllerDisplayNameFreshness(freshness);
      return {
        devices: [
          {
            deviceId: 'dev-1',
            name: '数据库展示名',
            selfName: 'Host.local',
            platform: 'darwin',
            lastSeenAt: '2026-06-23T00:00:00.000Z',
            online: false,
            busy: false,
            remoteControlEnabled: true,
            controlEnabled: true,
            isSelf: false,
          },
        ],
      } as T;
    };
    const deps = makeDeps({
      apiFetch,
      rememberLastKnownDeviceName,
      forgetLastKnownDeviceName,
      captureControllerDisplayNameRequestEpoch: () => freshness.epoch,
      readControllerDisplayNameFreshnessSince: (deviceId, requestEpoch) =>
        getControllerDisplayNameFreshnessSince(freshness, deviceId, requestEpoch),
    });

    const result = await handleListDevices(deps);
    expect(result.devices[0]?.name).toBe('数据库展示名');
    expect(rememberLastKnownDeviceName).toHaveBeenCalledWith('dev-1', '数据库展示名');
    expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
  });

  it.each([
    ['旧目录名', '新数据库名', 'remember', '新数据库名'],
    ['', '新数据库名', 'forget', '新数据库名'],
    ['旧目录名', '', 'remember', 'Host.local'],
  ] as const)(
    'listDevices:旧目录 %s 在 presence(%s) 后不得触发 %s，并返回当前名称',
    async (directoryName, presenceName, _mutation, expectedName) => {
      const freshness = createControllerDisplayNameFreshnessTracker();
      const rememberLastKnownDeviceName = vi.fn(async () => true);
      const forgetLastKnownDeviceName = vi.fn(async () => true);
      const apiFetch: DeviceLinkIpcDeps['apiFetch'] = async <T>() => {
        applyControllerDisplayNamePresence({
          deviceId: 'dev-1',
          name: presenceName,
          selfName: 'Host.local',
          freshness,
          normalizeName: (value) => normalizeCachedDeviceName(value),
          setDisplayName: vi.fn(),
          setFallbackDisplayName: vi.fn(),
          rememberName: vi.fn(),
          forgetName: vi.fn(),
        });
        return {
          devices: [
            {
              deviceId: 'dev-1',
              name: directoryName,
              selfName: 'Host.local',
              platform: 'darwin',
              lastSeenAt: '2026-06-23T00:00:00.000Z',
              online: true,
              busy: false,
              remoteControlEnabled: true,
              controlEnabled: true,
              isSelf: false,
            },
          ],
        } as T;
      };
      const deps = makeDeps({
        apiFetch,
        rememberLastKnownDeviceName,
        forgetLastKnownDeviceName,
        captureControllerDisplayNameRequestEpoch: () => freshness.epoch,
        readControllerDisplayNameFreshnessSince: (deviceId, requestEpoch) =>
          getControllerDisplayNameFreshnessSince(freshness, deviceId, requestEpoch),
      });

      const result = await handleListDevices(deps);
      expect(result.devices[0]?.name).toBe(expectedName);
      expect(rememberLastKnownDeviceName).not.toHaveBeenCalled();
      expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Host.local', 'Host.local'],
    [null, '12345678'],
  ] as const)(
    'listDevices:数据库空名清除 last-known，并回退 selfName/设备短 ID(%s)',
    async (selfName, expectedName) => {
      const forgetLastKnownDeviceName = vi.fn(async () => true);
      const rememberLastKnownDeviceName = vi.fn(async () => false);
      const deps = makeDeps({
        apiFetch: vi.fn().mockResolvedValue({
          devices: [
            {
              deviceId: '1234567890abcdef',
              name: '',
              selfName,
              platform: 'darwin',
              lastSeenAt: '2026-06-23T00:00:00.000Z',
              online: false,
              busy: false,
              remoteControlEnabled: false,
              controlEnabled: true,
              isSelf: false,
            },
          ],
        }),
        readLastKnownDeviceNames: vi.fn(() => ({ '1234567890abcdef': '旧缓存名' })),
        rememberLastKnownDeviceName,
        forgetLastKnownDeviceName,
      });

      const result = await handleListDevices(deps);
      expect(result.devices[0]?.name).toBe(expectedName);
      expect(forgetLastKnownDeviceName).toHaveBeenCalledWith('1234567890abcdef');
      expect(rememberLastKnownDeviceName).not.toHaveBeenCalled();
    },
  );

  it('listDevices:按本机 disabledControlDeviceIds 合成 controlEnabled=false', async () => {
    const deps = makeDeps({
      getState: () => ({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: ['dev-1'],
        unresponsiveDeviceIds: [],
      }),
      apiFetch: vi.fn().mockResolvedValue({
        devices: [
          {
            deviceId: 'dev-1',
            name: 'MacBook Pro',
            platform: 'darwin',
            lastSeenAt: '2026-06-23T00:00:00.000Z',
            online: true,
            busy: false,
            remoteControlEnabled: true,
            isSelf: false,
          },
        ],
      }),
    });

    await expect(handleListDevices(deps)).resolves.toEqual({
      devices: [
        {
          deviceId: 'dev-1',
          name: 'MacBook Pro',
          platform: 'darwin',
          lastSeenAt: '2026-06-23T00:00:00.000Z',
          online: true,
          busy: false,
          remoteControlEnabled: true,
          controlEnabled: false,
          isSelf: false,
        },
      ],
    });
  });

  it('renameDevice:参数校验 + 404/400/409 映射', async () => {
    const deps = makeDeps();
    await expect(handleRenameDevice(deps, '', 'x')).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleRenameDevice(deps, 'dev-1', '  ')).rejects.toThrowError(/\[INVALID_PARAMS\]/);

    const deps404 = makeDeps({
      apiFetch: vi.fn().mockRejectedValue(new ServerApiError('NOT_FOUND', 404, 'gone')),
    });
    await expect(handleRenameDevice(deps404, 'dev-1', 'New')).rejects.toThrowError(/\[NOT_FOUND\]/);

    const ok = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({ deviceId: 'dev-1', name: 'New' }),
    });
    await expect(handleRenameDevice(ok, 'dev-1', 'New')).resolves.toEqual({
      deviceId: 'dev-1',
      name: 'New',
    });

    const resetApiFetch = vi.fn().mockResolvedValue({ deviceId: 'dev-1', name: 'Carol-MacBook-Pro', manualName: null });
    await expect(handleRenameDevice(makeDeps({ apiFetch: resetApiFetch }), 'dev-1', null)).resolves.toEqual({
      deviceId: 'dev-1',
      name: 'Carol-MacBook-Pro',
      manualName: null,
    });
    expect(resetApiFetch).toHaveBeenCalledWith('/api/device-link/devices/dev-1', {
      method: 'PATCH',
      body: { name: null },
    });
  });

  it('deleteDevice:在线 409 → ALREADY_EXISTS 映射(renderer 据此提示)', async () => {
    const deps409 = makeDeps({
      apiFetch: vi.fn().mockRejectedValue(new ServerApiError('CONFLICT', 409, 'online')),
    });
    await expect(handleDeleteDevice(deps409, 'dev-1')).rejects.toThrowError(/\[ALREADY_EXISTS\]/);
    await expect(handleDeleteDevice(makeDeps(), 42)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });
});

describe('device-link controller handlers', () => {
  it('openLink:参数校验 + DeviceLinkError 映射到 IpcError', async () => {
    await expect(handleOpenLink(makeDeps(), '')).rejects.toThrowError(/\[INVALID_PARAMS\]/);

    const offline = makeDeps({
      openLink: vi.fn().mockRejectedValue(new DeviceLinkError('DEVICE_OFFLINE', 'gone')),
    });
    await expect(handleOpenLink(offline, 'dev-2')).rejects.toThrowError(
      /\[DEVICE_LINK_DEVICE_OFFLINE\]/,
    );
  });

  it('openLink/invoke/subscribe:本机已关闭控制的目标直接拦截,不发远程调用且不标记为被撤权', async () => {
    const deps = makeDeps({
      getState: () => ({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: ['dev-2'],
        unresponsiveDeviceIds: [],
      }),
    });

    await expect(handleOpenLink(deps, 'dev-2')).rejects.toThrowError(
      /\[DEVICE_LINK_CONTROL_DISABLED\]/,
    );
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', [])).rejects.toThrowError(
      /\[DEVICE_LINK_CONTROL_DISABLED\]/,
    );
    await expect(handleSubscribe(deps, 'dev-2', ['sessions'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_CONTROL_DISABLED\]/,
    );
    expect(deps.openLink).not.toHaveBeenCalled();
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(deps.subscribe).not.toHaveBeenCalled();
  });

  it('invoke:成功直接返回 result(语义同本地 IPC)', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockResolvedValue({ ok: true, result: ['s1', 's2'] }),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:list-active', [])).resolves.toEqual([
      's1',
      's2',
    ]);
  });

  it('invoke:CHANNEL_NOT_ALLOWED → 映射 IpcError', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED', message: 'nope' },
      }),
    });
    await expect(handleInvoke(deps, 'dev-2', 'shell:open', [])).rejects.toThrowError(
      /\[DEVICE_LINK_CHANNEL_NOT_ALLOWED\]/,
    );
  });

  it('invoke:被控端 IPC_ERROR 原样透传 [CODE] message(renderer 自行解码)', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'IPC_ERROR', message: '[SESSION_RUNNING] busy' },
      }),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', [])).rejects.toThrowError(
      /\[SESSION_RUNNING\] busy/,
    );
  });

  it('invoke:超时 DeviceLinkError → DEVICE_LINK_TIMEOUT', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockRejectedValue(new DeviceLinkError('INVOKE_TIMEOUT', 'slow')),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', [])).rejects.toThrowError(
      /\[DEVICE_LINK_TIMEOUT\]/,
    );
  });

  it('invoke:本地传输背压 → DEVICE_LINK_NOT_CONNECTED', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockRejectedValue(new DeviceLinkError('BACKPRESSURE', 'buffer full')),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', [])).rejects.toThrowError(
      /\[DEVICE_LINK_NOT_CONNECTED\]/,
    );
  });

  it('invoke:出方向附件改写失败 → DEVICE_LINK_MEDIA_TRANSFER_FAILED,不发 invoke(整条不发)', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
    const deps = makeDeps({
      invoke,
      rewriteOutboundMedia: vi.fn().mockRejectedValue(new Error('OSS PUT 失败 (403)')),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', ['s', {}])).rejects.toThrowError(
      /\[DEVICE_LINK_MEDIA_TRANSFER_FAILED\]/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invoke:出方向改写成功 → 改写后的 args 才发给 invoke', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
    const rewritten = ['s', { type: 'user', content: [{ type: 'image', path: 'cindy-oss-attach://m/xxx' }] }];
    const deps = makeDeps({
      invoke,
      rewriteOutboundMedia: vi.fn().mockResolvedValue(rewritten),
    });
    await handleInvoke(deps, 'dev-2', 'maker:send', ['s', { type: 'user', content: [] }]);
    expect(invoke).toHaveBeenCalledWith('dev-2', 'maker:send', rewritten);
  });

  it('invoke:附件改写期间关闭目标控制 → 改写后重新拦截,不发 invoke', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
    let disabled = false;
    const deps = makeDeps({
      getState: () => ({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: disabled ? ['dev-2'] : [],
        unresponsiveDeviceIds: [],
      }),
      invoke,
      rewriteOutboundMedia: vi.fn().mockImplementation(async (_channel, args) => {
        disabled = true;
        return args as unknown[];
      }),
    });

    await expect(handleInvoke(deps, 'dev-2', 'maker:send', ['s', {}])).rejects.toThrowError(
      /\[DEVICE_LINK_CONTROL_DISABLED\]/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invoke:参数校验', async () => {
    await expect(handleInvoke(makeDeps(), '', 'maker:send', [])).rejects.toThrowError(
      /\[INVALID_PARAMS\]/,
    );
    await expect(handleInvoke(makeDeps(), 'dev-2', '', [])).rejects.toThrowError(
      /\[INVALID_PARAMS\]/,
    );
  });

  it('subscribe:校验 + 成功 + 转发 topics', async () => {
    const deps = makeDeps();
    await expect(handleSubscribe(deps, 'dev-2', ['sessions'], 1)).resolves.toEqual({ ok: true });
    expect(deps.subscribe).toHaveBeenCalledWith('dev-2', ['sessions']);
    // 非法参数
    await expect(handleSubscribe(deps, '', ['sessions'], 1)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleSubscribe(deps, 'dev-2', [], 1)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleSubscribe(deps, 'dev-2', 'sessions', 1)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });

  it('subscribe:老被控端 CHANNEL_NOT_ALLOWED → 映射 IpcError(控制端据此回退 poll)', async () => {
    const deps = makeDeps({
      subscribe: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED', message: 'nope' },
      }),
    });
    await expect(handleSubscribe(deps, 'dev-2', ['sessions'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_CHANNEL_NOT_ALLOWED\]/,
    );
  });

  it('unsubscribe:校验 + 转发 topics', async () => {
    const deps = makeDeps();
    await expect(handleUnsubscribe(deps, 'dev-2', ['session:s1'], 1)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).toHaveBeenCalledWith('dev-2', ['session:s1']);
    await expect(handleUnsubscribe(deps, 'dev-2', [], 1)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
  });

  it('多窗口引用计数:两窗口订阅同 topic,前一窗口 unsubscribe 不向 relay 发帧,后一窗口才发', async () => {
    const deps = makeDeps();
    await handleSubscribe(deps, 'dev-2', ['sessions'], 1); // 窗口 1
    await handleSubscribe(deps, 'dev-2', ['sessions'], 2); // 窗口 2
    expect(deps.subscribe).toHaveBeenCalledTimes(2); // subscribe 幂等总转发

    // 窗口 1 取消:窗口 2 还在用 → 不向 relay 发 unsubscribe,但 handler 仍返回 ok
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 1)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).not.toHaveBeenCalled();

    // 窗口 2 取消:最后一个 → 真正向 relay 发 unsubscribe
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 2)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).toHaveBeenCalledWith('dev-2', ['sessions']);
  });

  it('unsubscribe 失败恢复引用:relay 退订失败后引用仍在,后续 unsubscribe 重试转发(防推送泄漏)', async () => {
    const deps = makeDeps({
      unsubscribe: vi
        .fn()
        .mockRejectedValueOnce(new DeviceLinkError('INVOKE_TIMEOUT', 'slow'))
        .mockResolvedValue({ ok: true, result: { ok: true } }),
    });
    await handleSubscribe(deps, 'dev-2', ['sessions'], 1);
    // 第一次:relay 退订超时 → 抛错,但引用被恢复(不能默默丢掉退订意图)
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_TIMEOUT\]/,
    );
    expect(deps.unsubscribe).toHaveBeenCalledTimes(1);
    // 第二次(重试):引用还在 → 再次向 relay 转发并成功
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 1)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe 本地背压时恢复引用，避免未发送的退订意图丢失', async () => {
    const deps = makeDeps({
      unsubscribe: vi
        .fn()
        .mockRejectedValueOnce(new DeviceLinkError('BACKPRESSURE', 'buffer full'))
        .mockResolvedValue({ ok: true, result: { ok: true } }),
    });
    await handleSubscribe(deps, 'dev-2', ['sessions'], 1);
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_NOT_CONNECTED\]/,
    );
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 1)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('CLOSE_LINK 清空该设备订阅引用与熔断状态:恢复事件不再带幽灵引用重建刚关的链路', async () => {
    // 引用表是 ws-online / presence 翻转 / 熔断恢复全部重放入口共用的需求信号。
    // 显式断开若不清引用,close 后任一恢复事件都会经按需建链把链路建回来
    // (被控端在 link 关闭时已丢弃订阅,控制端账本必须对齐)。
    const deps = makeDeps();
    await handleSubscribe(deps, 'dev-2', ['session:s1'], 1);
    expect(refcountTesting.refCount('dev-2', 'session:s1')).toBe(1);
    handleCloseLink(deps, 'dev-2');
    expect(deps.closeLink).toHaveBeenCalledWith('dev-2');
    expect(deps.clearDeviceResponsiveness).toHaveBeenCalledWith('dev-2');
    expect(refcountTesting.refCount('dev-2', 'session:s1')).toBe(0);
  });

  it('unsubscribe 链路已断(NOT_CONNECTED)→ 不恢复引用(link-close clearController 兜底,避免 phantom ref)', async () => {
    // 断连期间组件卸载切会话:relay 发不出 unsubscribe → 抛 NOT_CONNECTED。被控端 link-close 会
    // clearController 清掉本控制端整张订阅表,远端不残留订阅 → 引用应**真正释放**(不恢复)。
    const deps = makeDeps({
      unsubscribe: vi.fn().mockRejectedValue(new DeviceLinkError('NOT_CONNECTED', 'down')),
    });
    await handleSubscribe(deps, 'dev-2', ['session:s1'], 1);
    await expect(handleUnsubscribe(deps, 'dev-2', ['session:s1'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_NOT_CONNECTED\]/,
    );
    // 关键:引用降到 0、不留 phantom ref —— 否则后续别的窗口对同 topic 的 unsubscribe 被计数吞掉,
    // 被控端 reconnect 后对已无 UI 订阅者的 topic 继续推送(推送泄漏)。
    expect(refcountTesting.refCount('dev-2', 'session:s1')).toBe(0);
  });

  it('unsubscribe 终态结果(ACCESS_REVOKED / REMOTE_DISABLED)→ 不恢复引用(被控端已清订阅表,避免 phantom ref)', async () => {
    // 被控端撤销 / 关被控后会清掉本控制端整张订阅表,远端无存活订阅 → 这类 !ok 结果是终态,
    // 恢复引用只会留下 phantom ref 阻断别窗口真实退订。
    for (const code of ['ACCESS_REVOKED', 'REMOTE_DISABLED']) {
      refcountTesting.reset();
      const deps = makeDeps({
        unsubscribe: vi.fn().mockResolvedValue({ ok: false, error: { code, message: 'x' } }),
      });
      await handleSubscribe(deps, 'dev-2', ['session:s1'], 1);
      await expect(handleUnsubscribe(deps, 'dev-2', ['session:s1'], 1)).rejects.toThrow();
      expect(refcountTesting.refCount('dev-2', 'session:s1')).toBe(0); // 不留 phantom ref
    }
  });

  it('[New-C] subscribe 在途时同窗口 unsubscribe 先跑 → subscribe 回来不留 phantom ref', async () => {
    // deps.subscribe 卡在 in-flight,期间同窗口 unsubscribe 先完成;subscribe 回来后不得留下
    // 永不释放的 phantom ref(record-before-await 保证 unsubscribe 期间能看到并降零)。
    let resolveSub!: (v: { ok: true; result: { ok: true } }) => void;
    const subP = new Promise<{ ok: true; result: { ok: true } }>((r) => (resolveSub = r));
    const deps = makeDeps({
      subscribe: vi.fn().mockReturnValue(subP),
      unsubscribe: vi.fn().mockResolvedValue({ ok: true, result: { ok: true } }),
    });
    const subPromise = handleSubscribe(deps, 'dev-2', ['sessions'], 1); // 窗口 1 订阅,卡 in-flight
    await handleUnsubscribe(deps, 'dev-2', ['sessions'], 1); // 在途期间窗口 1 退订
    expect(deps.unsubscribe).toHaveBeenCalledWith('dev-2', ['sessions']); // 看得到 ref → 真转发退订
    resolveSub({ ok: true, result: { ok: true } });
    await subPromise;
    // 关键:无残留 phantom ref(否则后续真实订阅者的 unsubscribe 不转发 → 推送泄漏)。
    expect(refcountTesting.refCount('dev-2', 'sessions')).toBe(0);
  });

  it('订阅失败不留残留 ref:失败窗口不计数,后续成功窗口 unsubscribe 仍正常转发', async () => {
    // 窗口 1 订阅失败(ACCESS_REVOKED):handler 抛错,且**不应**记引用计数。
    const deps = makeDeps({
      subscribe: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'ACCESS_REVOKED', message: 'revoked' } })
        .mockResolvedValue({ ok: true, result: { ok: true } }),
    });
    await expect(handleSubscribe(deps, 'dev-2', ['sessions'], 1)).rejects.toThrowError(
      /\[DEVICE_LINK_ACCESS_REVOKED\]/,
    );

    // 窗口 2 订阅成功 → 记 ref(count=1;窗口 1 的失败订阅没留残留)。
    await handleSubscribe(deps, 'dev-2', ['sessions'], 2);

    // 窗口 2 取消:它是唯一持有者 → 必须真正向 relay 转发 unsubscribe。
    // 若窗口 1 的失败订阅残留了 ref,这里计数非零会被吞掉,被控端将继续推送(回归点)。
    await expect(handleUnsubscribe(deps, 'dev-2', ['sessions'], 2)).resolves.toEqual({ ok: true });
    expect(deps.unsubscribe).toHaveBeenCalledWith('dev-2', ['sessions']);
  });
});

describe('[New-D] retryUnsubscribeAfterWindowGone — 窗口销毁后退订有限重试', () => {
  const noSleep = () => Promise.resolve();

  it('首次抛错后重试,成功即停', async () => {
    const unsub = vi
      .fn()
      .mockRejectedValueOnce(new DeviceLinkError('INVOKE_TIMEOUT', 'slow'))
      .mockResolvedValue({ ok: true, result: { ok: true } });
    await retryUnsubscribeAfterWindowGone(unsub, 'dev-2', ['session:s1'], { sleep: noSleep });
    expect(unsub).toHaveBeenCalledTimes(2);
  });

  it('返回 !ok 也算失败继续重试', async () => {
    const unsub = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'NOT_CONNECTED', message: 'x' } })
      .mockResolvedValue({ ok: true, result: { ok: true } });
    await retryUnsubscribeAfterWindowGone(unsub, 'dev-2', ['session:s1'], { sleep: noSleep });
    expect(unsub).toHaveBeenCalledTimes(2);
  });

  it('全程失败用尽 attempts 后不抛(best-effort,link-close 兜底)', async () => {
    const unsub = vi.fn().mockRejectedValue(new DeviceLinkError('NOT_CONNECTED', 'down'));
    await expect(
      retryUnsubscribeAfterWindowGone(unsub, 'dev-2', ['session:s1'], { attempts: 3, sleep: noSleep }),
    ).resolves.toBeUndefined();
    expect(unsub).toHaveBeenCalledTimes(3);
  });
});

describe('device-link revoke / restore handlers', () => {
  it('revoke:校验 deviceId + 调 deps.revoke', async () => {
    const deps = makeDeps();
    await expect(handleRevoke(deps, 'dev-x')).resolves.toEqual({ ok: true });
    expect(deps.revoke).toHaveBeenCalledWith('dev-x');
  });
  it('restore:校验 deviceId + 调 deps.restore', async () => {
    const deps = makeDeps();
    await expect(handleRestore(deps, 'dev-x')).resolves.toEqual({ ok: true });
    expect(deps.restore).toHaveBeenCalledWith('dev-x');
  });
  it('空 / 非法 deviceId → INVALID_PARAMS,不调 deps', async () => {
    const deps = makeDeps();
    await expect(handleRevoke(deps, '')).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    await expect(handleRestore(deps, 42)).rejects.toThrowError(/\[INVALID_PARAMS\]/);
    expect(deps.revoke).not.toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
  });
});

describe('device-link settings normalize', () => {
  it('非法输入回落默认值,布尔严格校验', () => {
    expect(settingsTesting.normalize(null)).toEqual({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({})).toEqual({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({ remoteControlEnabled: 'true' })).toEqual({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({ remoteControlEnabled: true })).toEqual({
      remoteControlEnabled: true,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
  });

  it('disabledControlDeviceIds 只保留非空去重字符串', () => {
    expect(
      settingsTesting.normalize({
        disabledControlDeviceIds: [' dev-1 ', 'dev-1', '', 42, 'dev-2'],
      }),
    ).toEqual({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: ['dev-1', 'dev-2'],
      lastKnownDeviceNames: {},
    });
  });

  it('lastKnownDeviceNames 只保留非空字符串名', () => {
    expect(
      settingsTesting.normalize({
        lastKnownDeviceNames: {
          'dev-1': ' MacBook Pro ',
          'dev-2': '',
          'dev-3': 123,
          '': 'No Id',
        },
      }),
    ).toEqual({
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: { 'dev-1': 'MacBook Pro' },
    });
  });
});
