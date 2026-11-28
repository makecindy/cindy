import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInstanceConfig: vi.fn(), peek: vi.fn(), boundary: vi.fn(), getUser: vi.fn(), getDevice: vi.fn(),
  getToken: vi.fn(), getRealm: vi.fn(), getEndpoint: vi.fn(), onAuth: vi.fn(), onSettings: vi.fn(),
  read: vi.fn(), project: vi.fn(), createPublisher: vi.fn(), fetch: vi.fn(),
  start: vi.fn(), stop: vi.fn(), request: vi.fn(), stopAuth: vi.fn(), stopSettings: vi.fn(),
  readV2: vi.fn(), publicIds: { models: new Set<string>(), providers: new Set<string>() },
}));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }));
vi.mock('../../authManager.js', () => ({ getAccessToken: mocks.getToken, getCurrentUserId: mocks.getUser,
  getDeviceId: mocks.getDevice, getActiveAuthRealm: mocks.getRealm, onAuthStateChange: mocks.onAuth }));
vi.mock('../../appSessionState.js', () => ({ peekCommittedAppSession: mocks.peek, isAppSessionBoundaryPending: mocks.boundary }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpointForRealm: mocks.getEndpoint }));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: mocks.getInstanceConfig }));
vi.mock('../index.js', () => ({ readHostSettings: mocks.read, onHostSettingsChanged: mocks.onSettings }));
vi.mock('../snapshotProjection.js', () => ({ projectSettingsSnapshot: mocks.project }));
vi.mock('../readSnapshot.js', () => ({ readSettingsSnapshotV2: mocks.readV2 }));
vi.mock('../publicIdentifiers.js', () => ({ getSettingsPublicIdentifiers: () => mocks.publicIds }));
vi.mock('../snapshotPublisher.js', async importOriginal => ({
  ...await importOriginal<typeof import('../snapshotPublisher.js')>(), createSettingsSnapshotPublisher: mocks.createPublisher,
}));
import { getCloudSettingsSnapshotContext, startCloudSettingsSnapshotPublisher } from '../snapshotRuntime.js';

type PublisherDependencies = Parameters<typeof import('../snapshotPublisher.js').createSettingsSnapshotPublisher>[0];
function capturedDependencies(): PublisherDependencies { return mocks.createPublisher.mock.calls[0][0]; }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getInstanceConfig.mockReturnValue({ authProtocol: 'resource-v1', membershipId: 'owner-example', deviceId: 'device-example' });
  mocks.peek.mockReturnValue({ mode: 'cloud', dataOwnerId: 'owner-example', generation: 7 });
  mocks.boundary.mockReturnValue(false);
  mocks.getUser.mockReturnValue('owner-example'); mocks.getDevice.mockReturnValue('device-example');
  mocks.getToken.mockReturnValue('test-invalid-access-token'); mocks.getRealm.mockReturnValue('cn');
  mocks.getEndpoint.mockReturnValue('https://cis.example.invalid/api');
  mocks.onAuth.mockReturnValue(mocks.stopAuth); mocks.onSettings.mockReturnValue(mocks.stopSettings);
  mocks.readV2.mockReturnValue({ fields: {}, collections: {} });
  mocks.createPublisher.mockReturnValue({ start: mocks.start, stop: mocks.stop, requestPublish: mocks.request });
  mocks.read.mockReturnValue({ ownerStamp: { dataOwnerId: 'owner-example', ownerGeneration: 7 } });
  mocks.project.mockReturnValue({ fakeProjection: true });
});
afterEach(() => vi.restoreAllMocks());

describe('实例快照运行期接线', () => {
  it('使用现有就绪 AT、精确 owner/device/realm 和 generation，不含 RT', () => {
    expect(getCloudSettingsSnapshotContext()).toEqual({
      scopeKey: '["owner-example",7,"cn","device-example"]',
      baseUrl: 'https://cis.example.invalid/api', accessToken: 'test-invalid-access-token',
    });
    expect(mocks.getEndpoint).toHaveBeenCalledWith('cn', 'cloudInstanceApiBaseUrl');
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([null, { authProtocol: 'instance-v1' }])('普通或旧协议 Host 不上报、不订阅', instance => {
    mocks.getInstanceConfig.mockReturnValue(instance);
    expect(getCloudSettingsSnapshotContext()).toBeNull();
    startCloudSettingsSnapshotPublisher()();
    expect(mocks.createPublisher).not.toHaveBeenCalled();
    expect(mocks.onAuth).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it.each([
    () => mocks.boundary.mockReturnValue(true),
    () => mocks.peek.mockReturnValue(null),
    () => mocks.peek.mockReturnValue({ mode: 'local', dataOwnerId: 'owner-example', generation: 7 }),
    () => mocks.peek.mockReturnValue({ mode: 'cloud', dataOwnerId: 'other-owner', generation: 7 }),
    () => mocks.getUser.mockReturnValue('other-owner'),
    () => mocks.getDevice.mockReturnValue('other-device'),
    () => mocks.getToken.mockReturnValue(null),
    () => mocks.getEndpoint.mockReturnValue(''),
    () => mocks.getEndpoint.mockReturnValue('http://cis.example.invalid'),
    () => mocks.getEndpoint.mockImplementation(() => { throw new Error('端点未初始化'); }),
  ])('身份不稳定、不匹配、未就绪或缺端点时拒绝', change => {
    change(); expect(getCloudSettingsSnapshotContext()).toBeNull(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it('启动、身份/设置变化、退出接线完整且退出幂等', async () => {
    const stop = startCloudSettingsSnapshotPublisher();
    expect(mocks.start).toHaveBeenCalledOnce();
    mocks.onAuth.mock.calls[0][0](); mocks.onSettings.mock.calls[0][0]();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    const deps = capturedDependencies();
    expect(deps.getContext()).not.toBeNull();
    expect(deps.readDomains()).toEqual({ fakeProjection: true });
    expect(mocks.project).toHaveBeenCalledWith(mocks.read.mock.results[0].value, mocks.publicIds);
    expect(deps.readV2?.()).toEqual({ fields: {}, collections: {} });
    expect(mocks.readV2).toHaveBeenCalledOnce();
    const init = { method: 'POST', credentials: 'omit' as const };
    await deps.fetch('https://cis.example.invalid/api', init);
    expect(mocks.fetch).toHaveBeenCalledWith('https://cis.example.invalid/api', init);
    stop(); stop();
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.stopAuth).toHaveBeenCalledOnce();
    expect(mocks.stopSettings).toHaveBeenCalledOnce();
  });
  it.each([null, { dataOwnerId: 'other-owner', ownerGeneration: 7 }, { dataOwnerId: 'owner-example', ownerGeneration: 8 }])(
    '读取设置的 owner stamp 不一致时不投影', ownerStamp => {
      startCloudSettingsSnapshotPublisher(); mocks.read.mockReturnValue({ ownerStamp });
      expect(() => capturedDependencies().readDomains()).toThrow('SETTINGS_OWNER_CHANGED');
      expect(mocks.project).not.toHaveBeenCalled();
    },
  );
  it('设置读取中进入账号边界时不投影', () => {
    startCloudSettingsSnapshotPublisher();
    mocks.read.mockImplementation(() => {
      mocks.boundary.mockReturnValue(true);
      return { ownerStamp: { dataOwnerId: 'owner-example', ownerGeneration: 7 } };
    });
    expect(() => capturedDependencies().readDomains()).toThrow('SETTINGS_OWNER_CHANGED');
    expect(mocks.project).not.toHaveBeenCalled();
  });
  it('token 更新不变 scope，owner generation 和 realm 变化会变 scope', () => {
    const scope = getCloudSettingsSnapshotContext()?.scopeKey;
    mocks.getToken.mockReturnValue('test-invalid-new-access-token');
    expect(getCloudSettingsSnapshotContext()?.scopeKey).toBe(scope);
    mocks.peek.mockReturnValue({ mode: 'cloud', dataOwnerId: 'owner-example', generation: 8 });
    expect(getCloudSettingsSnapshotContext()?.scopeKey).not.toBe(scope);
    mocks.peek.mockReturnValue({ mode: 'cloud', dataOwnerId: 'owner-example', generation: 7 });
    mocks.getRealm.mockReturnValue('global');
    expect(getCloudSettingsSnapshotContext()?.scopeKey).not.toBe(scope);
  });
});
