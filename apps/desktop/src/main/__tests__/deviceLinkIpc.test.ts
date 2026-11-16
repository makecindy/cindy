/**
 * device-link IPC handler 业务体单测(内存 harness 直接调 handler body,不起 Electron)。
 * 覆盖:参数校验、ServerApiError → IpcError 映射、settings normalize。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { createProviderGroupDirectory } from '../provider-group/directory';

const capabilities = vi.hoisted(() => ({ canUseDeviceLink: true }));
const metadataOwner = vi.hoisted(() => ({ key: 'directory-owner-a' }));
const dataPath = vi.hoisted(() => ({ available: vi.fn<(deviceId: string) => boolean>(() => false) }));
vi.mock('../appSessionState.js', async importOriginal => ({
  ...await importOriginal<typeof import('../appSessionState.js')>(), activeOwnerScopeKey: () => metadataOwner.key,
}));
vi.mock('../clientEndpointsService.js', async importOriginal => ({
  ...await importOriginal<typeof import('../clientEndpointsService.js')>(),
  getClientEndpoint: () => 'https://continuity.test.invalid',
}));

// Transport windows are outside this in-memory IPC handler harness.
vi.mock('../device-link/filePeer', () => ({
  tryUploadPeerAttachment: vi.fn(async () => null),
}));

// electron / serverApiClient / device-link host 全部替换为测试替身,
// 只测 handler 纯函数体
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp' },
}));
vi.mock('../serverApiClient.desktop', () => {
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
  getDeviceLinkPeerLinks: () => ({ links: [], relayRttMs: null }),
  hasOfflineDirectPath: () => false,
  isDeviceDataPathAvailable: dataPath.available,
  getDirectDataDeviceIds: () => [],
  getDeviceLinkConnectionIssue: () => null,
  isDeviceLinkStandby: () => false,
  getUnresponsiveDeviceIds: () => [],
  setKeepAwakeEnabled: vi.fn(),
  providerShareHostInvoke: vi.fn(),
  revokeController: vi.fn(),
  restoreController: vi.fn(),
  beginControllerDisplayNameDirectoryRefresh: () => 1,
  isLatestControllerDisplayNameDirectoryRefresh: () => true,
  waitForNewerControllerDisplayNameDirectoryRefresh: vi.fn(async () => {}),
  isPeerControlAvailable: () => true,
  getPeerControlState: () => ({ online: true, available: true, disabled: false }),
  isPresenceFreshAfterRequest: () => false,
  forgetPeerControlState: () => {},
  clearDeviceResponsiveness: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  broadcast: vi.fn(),
  applyControllerPresenceListSnapshot: vi.fn(),
  captureControllerDisplayNameRequestEpoch: () => 0,
  captureControllerPresenceRequestEpoch: () => 0,
  readControllerDisplayNameFreshnessSince: () => ({
    changedAfterRequest: false,
    authoritativeName: null,
  }),
}));
vi.mock('../device-link/index', () => ({
  getDeviceLinkStatus: () => 'online',
  getDeviceLinkPeerLinks: () => ({ links: [], relayRttMs: null }),
  hasOfflineDirectPath: () => false,
  isDeviceDataPathAvailable: dataPath.available,
  clearDeviceResponsiveness: vi.fn(),
  getDirectDataDeviceIds: () => [],
  getDeviceLinkConnectionIssue: () => null,
  isDeviceLinkStandby: () => false,
  getUnresponsiveDeviceIds: () => [],
  setKeepAwakeEnabled: vi.fn(),
  providerShareHostInvoke: vi.fn(),
  revokeController: vi.fn(),
  setControllerModelUse: vi.fn(),
  restoreController: vi.fn(),
  beginControllerDisplayNameDirectoryRefresh: () => 1,
  isLatestControllerDisplayNameDirectoryRefresh: () => true,
  waitForNewerControllerDisplayNameDirectoryRefresh: vi.fn(async () => {}),
  isPeerControlAvailable: () => true,
  getPeerControlState: () => ({ online: true, available: true, disabled: false }),
  isPresenceFreshAfterRequest: () => false,
  forgetPeerControlState: () => {},
  setRemoteControlEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  broadcast: vi.fn(),
  applyControllerPresenceListSnapshot: vi.fn(),
  applyControllerDisplayNameListSnapshot: vi.fn(),
  captureControllerDisplayNameRequestEpoch: () => 0,
  captureControllerPresenceRequestEpoch: () => 0,
  readControllerDisplayNameFreshnessSince: () => ({
    changedAfterRequest: false,
    authoritativeName: null,
  }),
}));
vi.mock('../device-link/dispatch.desktop', () => ({
  getActiveControllers: () => [],
}));
vi.mock('../device-link/settings-store.desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-link/settings-store.desktop')>();
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
  defaultDeps,
  __resetDeviceListCoalescingForTests,
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
import { DeviceLinkError, PLUGIN_OAUTH_CHANNEL, PLUGIN_SECRET_LOCAL_CHANNEL } from '@cindy/device-link';
import { MCP_APPS_INVOKE } from '../../shared/mcpApps.js';
import { invokeWithClosedLinkRecovery } from '../device-link/linkRecovery';
import { ServerApiError } from '../serverApiClient.desktop';
import { createIpcError } from '../../shared/ipc-errors';
import { ReviewArtifactAuthorizationError } from '../reviewer/reviewArtifactAuthorization';
import {
  __testing as settingsTesting,
  normalizeCachedDeviceName,
} from '../device-link/settings-store.desktop';
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
    getPeerLinks: vi.fn(() => ({ links: [], relayRttMs: null })),
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
    setModelUse: vi.fn(),
    setDeviceControlEnabled: vi.fn(async () => []),
    clearDeviceResponsiveness: vi.fn(),
    broadcast: vi.fn(),
    readLastKnownDeviceNames: vi.fn(() => ({})),
    rememberLastKnownDeviceName: vi.fn(async () => false),
    forgetLastKnownDeviceName: vi.fn(async () => false),
    applyControllerDisplayNameListSnapshot: vi.fn(),
    applyControllerPresenceListSnapshot: vi.fn(),
    beginControllerDisplayNameDirectoryRefresh: vi.fn(() => 1),
    captureControllerDisplayNameRequestEpoch: vi.fn(() => 0),
    captureControllerPresenceRequestEpoch: vi.fn(() => 0),
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
  it.each([PLUGIN_OAUTH_CHANNEL, PLUGIN_SECRET_LOCAL_CHANNEL])('never forwards %s from the generic Renderer tunnel', async channel => {
    const deps = makeDeps();
    await expect(handleInvoke(deps, 'cloud', channel, [{ op: 'capabilities' }])).rejects.toThrow('PERMISSION_DENIED');
    expect(deps.invoke).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    refcountTesting.reset(); // 多窗口订阅引用计数:每个用例独立
    capabilities.canUseDeviceLink = true;
    metadataOwner.key = 'directory-owner-a';
    __resetDeviceListCoalescingForTests(); // /devices 合并窗口:不让上一用例的在途请求漏到下一个
    vi.restoreAllMocks();
    dataPath.available.mockReset().mockReturnValue(false);
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
      modelUseRevokedControllers: [],
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

  // 启动 / 重连时侧栏、切换栏、设置页、main 在同一拍里各发一次 /devices。同一在途请求
  // 300ms 内的后来者共用它(目录快照是同一时刻的);请求结束后的新调用才再次发请求。
  it('listDevices:同一拍里的并发调用共用一个在途请求,结束后再调才重新发', async () => {
    __resetDeviceListCoalescingForTests();
    let resolveFirst: ((value: { devices: unknown[] }) => void) | undefined;
    const apiFetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ devices: [] });
    const deps = makeDeps({ apiFetch });
    const first = handleListDevices(deps);
    const second = handleListDevices(deps);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    resolveFirst?.({ devices: [] });
    await expect(first).resolves.toEqual({ devices: [],
      displayBudget: { remainingMs: expect.any(Number) } });
    await expect(second).resolves.toEqual({ devices: [],
      displayBudget: { remainingMs: expect.any(Number) } });
    await handleListDevices(deps);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  // A directory read that consumes its whole display window (sleep / clock jump
  // / one clock crossing) returns remainingMs 0. That is an expired source, not
  // an old endpoint without a stamp: the field must survive so the consumer can
  // retire the rows instead of showing them as an unlimited legacy directory.
  it('listDevices:零剩余预算按已过期下发，不退化成旧端无字段', async () => {
    __resetDeviceListCoalescingForTests();
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    try {
      let resolveFetch!: (value: { devices: unknown[] }) => void;
      const response = new Promise<{ devices: unknown[] }>((resolve) => { resolveFetch = resolve; });
      const apiFetch: DeviceLinkIpcDeps['apiFetch'] = async <T>() => (await response) as T;
      const deps = makeDeps({ apiFetch });
      const pending = handleListDevices(deps);
      vi.setSystemTime(Date.now() + 30 * 60_000 + 1);
      resolveFetch({ devices: [] });
      await expect(pending).resolves.toMatchObject({ displayBudget: { remainingMs: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review (#8381): a refresh issued right after a rename / delete must not join a list
  it('listDevices:短断沿用目录但不伪造在线状态，直连仍可用，明确撤权不得回退', async () => {
    const device = { deviceId: 'dev-1', name: 'Member', online: true, remoteControlEnabled: true };
    const apiFetch = vi.fn().mockResolvedValueOnce({ devices: [device] })
      .mockRejectedValueOnce(new ServerApiError('UNAVAILABLE', 503, 'temporarily unavailable'))
      .mockRejectedValueOnce(new ServerApiError('PERMISSION_DENIED', 403, 'denied'))
      .mockRejectedValueOnce(new ServerApiError('UNAVAILABLE', 503, 'temporarily unavailable'));
    const deps = makeDeps({ apiFetch, hasOfflineDirectPath: () => true });
    await expect(handleListDevices(deps)).resolves.not.toHaveProperty('stale');
    const stale = await handleListDevices(deps);
    expect(stale).toMatchObject({
      devices: [{ deviceId: 'dev-1', online: true }], stale: true,
    });
    expect(stale.displayBudget?.remainingMs).toBeGreaterThan(0);
    await expect(handleListDevices(deps)).rejects.toThrow('denied');
    await expect(handleListDevices(deps)).rejects.toThrow('temporarily unavailable');
  });


  // Integration: a stale REST directory row is marked online only through the
  // target's current verified data path; the real provider-group directory
  // consumer then sees that M as controllable while the neighbour stays offline.
  it('listDevices: verified target data path survives a transient REST failure into the group directory', async () => {
    const member = {
      deviceId: 'member', name: 'Member', platform: 'darwin', appVersion: '1.0.0',
      lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true,
      controlEnabled: true, isSelf: false,
    };
    const neighbour = { ...member, deviceId: 'neighbour', name: 'Neighbour' };
    const apiFetch = vi.fn()
      .mockResolvedValueOnce({ devices: [member, neighbour] })
      .mockRejectedValueOnce(new ServerApiError('SERVICE_UNAVAILABLE', 503, 'temporarily unavailable'));
    const deps = makeDeps({ apiFetch, isDeviceDataPathAvailable: deviceId => deviceId === 'member' });
    await handleListDevices(deps);
    const listed = await handleListDevices(deps);
    expect(listed.devices).toMatchObject([
      { deviceId: 'member', online: true },
      { deviceId: 'neighbour', online: false },
    ]);
    const provider = {
      id: 'provider', name: 'Provider', agents: ['claude-code'], connected: true,
      models: { 'claude-code': [] }, routing: { 'claude-code': {} },
    } as unknown as ProviderView;
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [],
      localDeviceName: () => 'Local',
      listDevices: async () => listed.devices,
      readDeviceProviders: async () => [provider],
      listReceivedShares: () => [],
      isMobilePlatform: platform => platform === 'ios' || platform === 'android',
      now: () => 0,
    });
    const config = { strategy: 'least' as const, autoSwitch: true,
      members: [{ key: 'device:member:provider', kind: 'device' as const,
        agentDeviceId: 'member', providerId: 'provider', limit: 1, weight: 1, paused: false }] };
    const resolved = await directory.resolveMembers('provider', config);
    expect(resolved[0]).toMatchObject({ member: { agentDeviceId: 'member' }, state: 'ok' });
  });

  // A fresh REST answer is the directory authority. The verified-path helper
  // only rescues a bounded stale row; it must not turn a current offline row
  // into an available member.
  it('listDevices: a fresh server row keeps online=false even when a data path is verified', async () => {
    const member = {
      deviceId: 'member', name: 'Member', platform: 'darwin', appVersion: '1.0.0',
      lastSeenAt: null, online: false, busy: false, remoteControlEnabled: true,
      controlEnabled: true, isSelf: false,
    };
    const deps = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({ devices: [member] }),
      isDeviceDataPathAvailable: () => true,
    });
    const listed = await handleListDevices(deps);
    expect(listed.devices).toMatchObject([{ deviceId: 'member', online: false }]);
  });
  // R1: bootstrap-electron.ts constructs registerDeviceLinkIpc() with
  // defaultDeps(); the stale projection must use the imported production helper.
  it('listDevices: defaultDeps binds the index data-path helper into the stale projection', async () => {
    const member = {
      deviceId: 'member', name: 'Member', platform: 'darwin', appVersion: '1.0.0',
      lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true,
      controlEnabled: true, isSelf: false,
    };
    const neighbour = { ...member, deviceId: 'neighbour', name: 'Neighbour' };
    dataPath.available.mockImplementation(deviceId => deviceId === 'member');
    const production = defaultDeps();
    expect(production.isDeviceDataPathAvailable).toBe(dataPath.available);
    const apiFetch = vi.fn()
      .mockResolvedValueOnce({ devices: [member, neighbour] })
      .mockRejectedValueOnce(new ServerApiError('SERVICE_UNAVAILABLE', 503, 'temporarily unavailable'));
    const deps: DeviceLinkIpcDeps = {
      ...production,
      apiFetch,
      readLastKnownDeviceNames: vi.fn(() => ({})),
      rememberLastKnownDeviceName: vi.fn(async () => false),
      forgetLastKnownDeviceName: vi.fn(async () => false),
    };
    await handleListDevices(deps);
    const listed = await handleListDevices(deps);
    expect(listed.devices).toMatchObject([
      { deviceId: 'member', online: true },
      { deviceId: 'neighbour', online: false },
    ]);
  });
  it.each(['success', 'failure'])('listDevices:账号切换后旧请求的 %s 不得跟随新账号结果', async outcome => {
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const apiFetch = vi.fn().mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }))
      .mockResolvedValue({ devices: [{ deviceId: 'owner-b-only', name: 'B', online: true, remoteControlEnabled: true }] });
    const deps = makeDeps({ apiFetch });
    const old = handleListDevices(deps); void old.catch(() => undefined);
    metadataOwner.key = 'directory-owner-b';
    expect(await handleListDevices(deps)).toMatchObject({ devices: [{ deviceId: 'owner-b-only' }] });
    if (outcome === 'success') resolve({ devices: [] }); else reject(new ServerApiError('UNAVAILABLE', 503, 'network down'));
    await expect(old).rejects.toThrow('account changed');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('删除设备成功后终止其保留链路，目录里的手机或单纯离线不会被误关闭', async () => {
    const apiFetch = vi.fn().mockResolvedValueOnce({ devices: [
      { deviceId: 'phone', name: 'Phone', online: true, remoteControlEnabled: false, platform: 'ios' },
      { deviceId: 'signaling-offline', name: 'Member', online: false, remoteControlEnabled: true },
    ] }).mockResolvedValueOnce({ deviceId: 'removed', deleted: true });
    const closeLink = vi.fn();
    const deps = makeDeps({ apiFetch, closeLink, hasOfflineDirectPath: () => true });
    await handleListDevices(deps); expect(closeLink).not.toHaveBeenCalled();
    await handleDeleteDevice(deps, 'removed');
    expect(closeLink.mock.calls.map(([deviceId]) => deviceId)).toEqual(['removed']);
  });

  // Review (#8381): a refresh issued right after a rename / delete must not join a list
  // request sent before it, or the removed device / old name comes back until the next poll.
  it.each(['rename', 'delete'] as const)('listDevices:%s 成功后的刷新不复用改动前的在途请求', async (op) => {
    let resolveFirst: ((value: { devices: unknown[] }) => void) | undefined;
    const apiFetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ deviceId: 'dev-1', name: 'New', deleted: true, devices: [] });
    const deps = makeDeps({ apiFetch });
    const before = handleListDevices(deps);
    if (op === 'rename') await handleRenameDevice(deps, 'dev-1', 'New');
    else await handleDeleteDevice(deps, 'dev-1');
    const after = handleListDevices(deps);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    resolveFirst?.({ devices: [] });
    await Promise.all([before, after]);
  });

  it.each(['rename', 'delete'] as const)('listDevices:%s 会使变更前发出的在途响应失效且不安装旧目录', async (op) => {
    let resolveOld: ((value: { devices: unknown[] }) => void) | undefined;
    const fresh = { deviceId: 'dev-1', name: 'New', online: true, remoteControlEnabled: true };
    const apiFetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(op === 'rename' ? { deviceId: 'dev-1', name: 'New' } : { deviceId: 'dev-1', deleted: true })
      .mockResolvedValue({ devices: [fresh] });
    const deps = makeDeps({ apiFetch });
    const old = handleListDevices(deps);
    if (op === 'rename') await handleRenameDevice(deps, 'dev-1', 'New');
    else await handleDeleteDevice(deps, 'dev-1');
    resolveOld?.({ devices: [{ ...fresh, name: 'Old' }] });
    await expect(old).resolves.toMatchObject({ devices: [{ name: 'New' }] });
    expect(deps.applyControllerDisplayNameListSnapshot).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'New' })], expect.anything());
    expect(deps.applyControllerDisplayNameListSnapshot).not.toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'Old' })], expect.anything());
  });

  // Unit: relay presence is not the group data-path state. Projection may keep
  // an authenticated path online and control-ready, but must not grant local control.
  it('listDevices: projects a retained group path as control-ready without granting local control or reviving other devices', async () => {
    const deps = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({ devices: ['executor', 'explicitly-off', 'fresh-off', 'phone', 'other'].map(deviceId => ({
        deviceId, name: deviceId, online: deviceId === 'fresh-off', remoteControlEnabled: false, isSelf: false,
        platform: deviceId === 'phone' ? 'ios' : 'darwin',
      })) }),
      hasOfflineDirectPath: id => id !== 'other',
      isPeerControlAvailable: id => id !== 'explicitly-off',
      getState: () => ({ ...makeDeps().getState(), disabledControlDeviceIds: ['executor'] }),
    });
    await expect(handleListDevices(deps)).resolves.toMatchObject({ devices: [
      { deviceId: 'executor', online: true, remoteControlEnabled: true, controlEnabled: false },
      { deviceId: 'explicitly-off', online: true, remoteControlEnabled: false, controlEnabled: true },
      // A fresh online row's false is explicit, even while a direct path is retained.
      { deviceId: 'fresh-off', online: true, remoteControlEnabled: false, controlEnabled: true },
      { deviceId: 'phone', online: true, remoteControlEnabled: false, controlEnabled: true },
      { deviceId: 'other', online: false, remoteControlEnabled: false, controlEnabled: true },
    ] });
  });


  it('retained list projection keeps a same-account group member routable through the production directory', async () => {
    const deps = makeDeps({
      apiFetch: vi.fn().mockResolvedValue({ devices: [{
        deviceId: 'executor', name: 'Executor', platform: 'darwin', appVersion: '1',
        online: false, remoteControlEnabled: false, busy: false, isSelf: false,
      }] }),
      hasOfflineDirectPath: id => id === 'executor',
      isPeerControlAvailable: () => true,
    });
    const { devices } = await handleListDevices(deps);
    const provider = { id: 'anthropic', name: 'Anthropic', agents: ['claude-code'], connected: true,
      models: { 'claude-code': [] }, routing: { 'claude-code': {} } } as unknown as ProviderView;
    const readDeviceProviders = vi.fn(async () => [provider]);
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [provider],
      localDeviceName: () => 'Owner',
      listDevices: async () => devices,
      readDeviceProviders,
      listReceivedShares: () => [],
      isMobilePlatform: platform => platform === 'ios' || platform === 'android',
      now: () => 0,
    });
    const resolved = await directory.resolveMembers('anthropic', { strategy: 'least', autoSwitch: true,
      members: [{ key: 'member', kind: 'device', agentDeviceId: 'executor', providerId: 'anthropic',
        limit: 1, weight: 1, paused: false }] });
    expect(resolved[0].state).toBe('ok');
    expect(readDeviceProviders).toHaveBeenCalledWith('executor', undefined);
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

  // Test value
  // - Production entry/observable result: handleListDevices; a directory outage must not
  //   turn an old snapshot into a fresh last-known-name write for the next cold start.
  // - Rule: bounded read continuity may serve the stale directory, but stale online/name
  //   fields are not authoritative (provider-groups short-outage section).
  // - Coverage gap: existing name tests cover fresh responses and superseded in-flight
  //   responses, but not the 30-minute stale continuation.
  // - Minimal failing input: a fresh read caches "旧目录名", then a 503 returns that stale row.
  // - Tier: unit (in-memory IPC harness), same file as the other listDevices cases.
  it('listDevices: stale directory does not rewrite the last-known name cache', async () => {
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
    const rememberLastKnownDeviceName = vi.fn(async () => true);
    const forgetLastKnownDeviceName = vi.fn(async () => true);
    const applyControllerPresenceListSnapshot = vi.fn();
    let offline = false;
    let lastKnownNames: Record<string, string> = { 'dev-1': '旧名字' };
    const apiFetch: DeviceLinkIpcDeps['apiFetch'] = async <T>() => {
      if (offline) throw new ServerApiError('SERVICE_UNAVAILABLE', 503, 'off');
      return { devices: [device('旧目录名')] } as T;
    };
    const deps = makeDeps({
      apiFetch,
      readLastKnownDeviceNames: vi.fn(() => lastKnownNames),
      rememberLastKnownDeviceName,
      forgetLastKnownDeviceName,
      applyControllerPresenceListSnapshot,
    });
    await expect(handleListDevices(deps)).resolves.toMatchObject({ devices: [{ name: '旧目录名' }] });
    expect(rememberLastKnownDeviceName).toHaveBeenCalledWith('dev-1', '旧目录名');
    expect(applyControllerPresenceListSnapshot).toHaveBeenCalledTimes(1);
    rememberLastKnownDeviceName.mockClear();
    forgetLastKnownDeviceName.mockClear();
    applyControllerPresenceListSnapshot.mockClear();
    // Simulate a newer last-known name arriving after the fresh directory read.
    lastKnownNames = { 'dev-1': '新名字' };
    offline = true;
    await expect(handleListDevices(deps)).resolves.toMatchObject({ devices: [{ name: '旧目录名' }] });
    expect(rememberLastKnownDeviceName).not.toHaveBeenCalled();
    expect(forgetLastKnownDeviceName).not.toHaveBeenCalled();
    // The bounded stale projection is display-only; it must not feed the
    // presence/control-enabled adapter or clear a newer explicit control gate.
    expect(applyControllerPresenceListSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['旧数据库名', '新数据库名', '新数据库名'],
    ['', '新数据库名', '新数据库名'],
    ['旧数据库名', null, 'Host.local'],
  ] as const)(
    'listDevices:被后台目录淘汰的旧响应(%s)等待后返回当前权威名(%s)',
    async (name, authoritativeName, expectedName) => {
      const applyControllerDisplayNameListSnapshot = vi.fn();
      const applyControllerPresenceListSnapshot = vi.fn();
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
        applyControllerPresenceListSnapshot,
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
      expect(applyControllerPresenceListSnapshot).not.toHaveBeenCalled();
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
      const applyControllerPresenceListSnapshot = vi.fn();
      const deps = makeDeps({
        apiFetch,
        rememberLastKnownDeviceName,
        forgetLastKnownDeviceName,
        applyControllerDisplayNameListSnapshot,
        applyControllerPresenceListSnapshot,
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

      // 两次调用间隔超过合并窗口(否则会共用同一在途请求,见上面的合并用例)。
      vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1_000);
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
      expect(applyControllerPresenceListSnapshot).toHaveBeenCalledTimes(1);
      expect(applyControllerPresenceListSnapshot).toHaveBeenCalledWith(
        [expect.objectContaining({ deviceId: 'dev-1', online: true, platform: 'darwin' })],
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
      displayBudget: { remainingMs: expect.any(Number) },
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
      displayBudget: { remainingMs: expect.any(Number) },
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
      displayBudget: { remainingMs: expect.any(Number) },
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

  it('keeps background admission local and preserves the remote argument list', async () => {
    const deps = makeDeps({ invoke: vi.fn().mockResolvedValue({ ok: true, result: [] }) });
    const args = [200, 'active'];
    await handleInvoke(deps, 'dev-2', 'local-db:sessions:list', args, { background: true });
    expect(deps.invoke).toHaveBeenCalledWith('dev-2', 'local-db:sessions:list', args, { background: true });
    await handleInvoke(deps, 'dev-2', 'local-db:sessions:list', args, { background: 'true' });
    expect(deps.invoke).toHaveBeenLastCalledWith('dev-2', 'local-db:sessions:list', args);
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

  it('invoke:本地传输背压 → DEVICE_LINK_BUSY', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockRejectedValue(new DeviceLinkError('BACKPRESSURE', 'buffer full')),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', [])).rejects.toThrowError(
      /\[DEVICE_LINK_BUSY\]/,
    );
  });

  it('invoke: remote admission backpressure remains busy rather than disconnected', async () => {
    const deps = makeDeps({
      invoke: vi.fn().mockResolvedValue({
        ok: false, error: { code: 'BACKPRESSURE', message: 'remote invoke execution queue is full' },
      }),
    });
    await expect(handleInvoke(deps, 'dev-2', 'local-db:task-tags:execute', []))
      .rejects.toMatchObject({ code: 'DEVICE_LINK_BUSY' });
  });

  it('invoke: a second peer reset stops retrying and becomes a disconnected IPC error', async () => {
    const reset = new DeviceLinkError('PEER_RESET', 'peer reset during read');
    reset.inFlight = true;
    const invoke = vi.fn().mockRejectedValue(reset);
    const reopen = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ invoke: () => invokeWithClosedLinkRecovery(invoke, reopen) });
    await expect(handleInvoke(deps, 'dev-2', 'local-db:messages:list', ['session'])).rejects.toMatchObject({
      code: 'DEVICE_LINK_NOT_CONNECTED', message: '[DEVICE_LINK_NOT_CONNECTED] peer reset during read',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('invoke: a peer reset result envelope uses the same IPC mapping', async () => {
    const deps = makeDeps({ invoke: vi.fn().mockResolvedValue({
      ok: false, error: { code: 'PEER_RESET', message: 'peer reset' },
    }) });
    await expect(handleInvoke(deps, 'dev-2', 'local-db:messages:list', ['session'])).rejects.toMatchObject({
      code: 'DEVICE_LINK_NOT_CONNECTED', message: '[DEVICE_LINK_NOT_CONNECTED] peer reset',
    });
  });

  it('invoke:Review 授权/校验拒绝保留原错误码,不再误标为媒体传输失败', async () => {
    // 回归:maker:review:start 与附件上传共用 rewriteOutboundMedia, 其 PERMISSION_DENIED
    // (凭证/密钥附件拒绝)、INVALID_PARAMS(整批请求校验)与用户取消授权对话框
    // (ReviewArtifactAuthorizationError)曾被 catch 一律折叠成
    // DEVICE_LINK_MEDIA_TRANSFER_FAILED —— 消费端会把"有意拒绝"当可重试传输故障。
    const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
    for (const rejection of [
      createIpcError('PERMISSION_DENIED', 'Review refused a credential or key attachment'),
      createIpcError('INVALID_PARAMS', 'review attachments must be an array'),
      Object.assign(new ReviewArtifactAuthorizationError('Review of external artifacts was cancelled')),
    ]) {
      const deps = makeDeps({
        invoke,
        rewriteOutboundMedia: vi.fn().mockRejectedValue(rejection),
      });
      await expect(handleInvoke(deps, 'dev-2', 'maker:review:start', [{ sourceSessionId: 's' }]))
        .rejects.toThrowError(rejection instanceof ReviewArtifactAuthorizationError
          ? /\[PERMISSION_DENIED\] Review of external artifacts was cancelled/
          : new RegExp(`\\[${rejection.code}\\]`));
      expect(invoke).not.toHaveBeenCalled();
    }
    // 真传输失败(普通 Error)仍折叠为 MEDIA_TRANSFER_FAILED。
    const deps = makeDeps({
      invoke,
      rewriteOutboundMedia: vi.fn().mockRejectedValue(new Error('OSS PUT 失败 (403)')),
    });
    await expect(handleInvoke(deps, 'dev-2', 'maker:review:start', [{ sourceSessionId: 's' }]))
      .rejects.toThrowError(/\[DEVICE_LINK_MEDIA_TRANSFER_FAILED\]/);
    expect(invoke).not.toHaveBeenCalled();
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

  // #6530: preserve the source-access classification at the actual send boundary.
  it('keeps attachment access guidance and does not dispatch a partial message', async () => {
    const invoke = vi.fn();
    const error = createIpcError('DEVICE_LINK_MEDIA_ACCESS_DENIED', 'Cannot read the source attachment.');
    const deps = makeDeps({ invoke, rewriteOutboundMedia: vi.fn().mockRejectedValue(error) });
    await expect(handleInvoke(deps, 'dev-2', 'maker:send', ['s', {}])).rejects.toBe(error);
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
  it.each(['open', 'message', 'poll', 'context', 'authorize-link', 'teardown'])(
    'forbids the general Renderer bridge from bypassing remote App frame authentication: %s', async (op) => {
      const deps = makeDeps();
      await expect(handleInvoke(deps, 'dev-2', MCP_APPS_INVOKE, ['task', { op, viewId: 'forged' }]))
        .rejects.toThrow('MCP_APP_FRAME_REQUIRED');
      expect(deps.invoke).not.toHaveBeenCalled();
    },
  );

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
      /\[DEVICE_LINK_BUSY\]/,
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

  // #8979 r4523117284 / unit: renderer ACK reuse depends on Main retaining the
  // newer registration. Existing single-request failures miss this ordering.
  it.each(['throw', 'result'])('旧 subscribe 迟到失败不撤销恢复后的新订阅 (%s)', async failure => {
    let failOld!: () => void;
    const old = new Promise<Awaited<ReturnType<DeviceLinkIpcDeps['subscribe']>>>((resolve, reject) => {
      failOld = () => failure === 'throw'
        ? reject(new DeviceLinkError('INVOKE_TIMEOUT', 'old request'))
        : resolve({ ok: false, error: { code: 'INVOKE_TIMEOUT', message: 'old request' } });
    });
    const deps = makeDeps({ subscribe: vi.fn().mockReturnValueOnce(old)
      .mockResolvedValue({ ok: true, result: { ok: true } }) });
    const oldResult = handleSubscribe(deps, 'dev-2', ['session:s1'], 1).catch(error => error);
    handleCloseLink(deps, 'dev-2');
    await handleSubscribe(deps, 'dev-2', ['session:s1'], 1);
    await handleSubscribe(deps, 'dev-2', ['session:s1'], 2);
    failOld();
    expect(await oldResult).toBeInstanceOf(Error);
    expect(refcountTesting.refCount('dev-2', 'session:s1')).toBe(2);
    expect(refcountTesting.snapshotSubscriptions('dev-2')).toEqual([{ deviceId: 'dev-2', topics: ['session:s1'] }]);
    await handleUnsubscribe(deps, 'dev-2', ['session:s1'], 2);
    expect(deps.unsubscribe).not.toHaveBeenCalled();
    await handleUnsubscribe(deps, 'dev-2', ['session:s1'], 1);
    expect(deps.unsubscribe).toHaveBeenCalledExactlyOnceWith('dev-2', ['session:s1']);
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
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({})).toEqual({
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({ remoteControlEnabled: 'true' })).toEqual({
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: {},
    });
    expect(settingsTesting.normalize({ remoteControlEnabled: true })).toEqual({
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: true,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
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
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
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
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
      remoteDesktopEnabled: false,
      remoteControlEnabled: false,
      keepAwake: false,
      revokedControllers: [],
      modelUseRevokedControllers: [],
      disabledControlDeviceIds: [],
      lastKnownDeviceNames: { 'dev-1': 'MacBook Pro' },
    });
  });
});
