/**
 * 测试价值
 * - 生产入口与可观察结果：插件模型缓存调用真实 readWorkerAgentLocations；失败时省略 locations，重试显示当前设备；同账号并发读取只发一次设备查询
 * - Bug／规则依据：makecindy/cindy#7452 SC1；makecindy/cindy#7472 Greptile 的失败位置缓存与并发重复请求；plugin-agent-models.md §4.0.3a
 * - 现有覆盖缺口：原用例只验证降级列表，没有覆盖插件缓存失败恢复或同账号并发合并
 * - 最小失败输入：同账号两个并发读取，handleListDevices 先拒绝、重试再返回一台远程电脑
 * - tier：unit
 * - 实测耗时：4.02 s（修复后单文件运行，macOS arm64）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

const io = vi.hoisted(() => ({
  handleListDevices: vi.fn(),
  getReceivedShares: vi.fn(() => [] as Array<{
    shareId: string;
    status: 'active' | 'paused';
    providerLabel: string;
    memberId?: string;
    providerId?: string;
    owner: { displayName: string; region?: 'global' | 'cn' };
  }>),
  providerShareAgentDeviceId: vi.fn((id: string) => `share:${id}`),
}));

vi.mock('../../device-link/ipc.js', () => ({
  handleListDevices: io.handleListDevices,
  defaultDeps: vi.fn(() => ({})),
}));
vi.mock('../../device-link/providerShareGuest.js', () => ({
  getReceivedShares: io.getReceivedShares,
  providerShareAgentDeviceId: io.providerShareAgentDeviceId,
}));

import { listWorkerAgentLocations, readWorkerAgentLocations } from '../workerAgentLocations.js';
import { createGhostAgentModelsCache } from '../../cindy-brain/ghostAgentModels.js';

function device(overrides: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'mac-mini',
    name: 'Mac mini',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...overrides,
  };
}

describe('listWorkerAgentLocations', () => {
  beforeEach(() => {
    io.handleListDevices.mockReset();
    io.getReceivedShares.mockReset();
    io.providerShareAgentDeviceId.mockClear();
    io.handleListDevices.mockResolvedValue({ devices: [] });
    io.getReceivedShares.mockReturnValue([]);
  });

  // #8028 / unit: only the same-account controlled picker requests favorite identity.
  // Existing plugin/model-list callers must not receive extra membership metadata.
  it('projects minimal favorite identity only when explicitly requested', async () => {
    io.getReceivedShares.mockReturnValue([{ shareId: 's1', memberId: 'm1', providerId: 'p1',
      status: 'active', providerLabel: 'Provider', owner: { displayName: 'Owner', region: 'global' } }]);
    const identity = { shareId: 's1', memberId: 'm1', providerId: 'p1', owner: { region: 'global' } };
    expect((await readWorkerAgentLocations({ favoriteSources: true })).locations).toEqual([
      { agentDeviceId: 'share:s1', name: 'Provider · Owner', favoriteSource: identity },
    ]);
    expect((await readWorkerAgentLocations()).locations).toEqual([
      { agentDeviceId: 'share:s1', name: 'Provider · Owner' },
    ]);
  });

  it('lists online remote-control computers and active shares, excluding this computer', async () => {
    io.handleListDevices.mockResolvedValue({
      devices: [
        device({}),
        device({ deviceId: 'self', name: 'This Mac', isSelf: true }),
        device({ deviceId: 'offline', name: 'Offline', online: false }),
        device({ deviceId: 'phone', name: 'iPhone', platform: 'ios' }),
      ],
    });
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
      { shareId: 's2', status: 'paused', providerLabel: 'Paused', owner: { displayName: 'Bob' } },
    ]);
    await expect(listWorkerAgentLocations()).resolves.toEqual([
      { agentDeviceId: 'mac-mini', name: 'Mac mini' },
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
  });

  it('omits computers when the device list fails and still returns active shares', async () => {
    io.handleListDevices.mockRejectedValue(new Error('cloud down'));
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
    ]);
    await expect(listWorkerAgentLocations()).resolves.toEqual([
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
  });

  it('does not cache fallback locations after a failed device read and recovers on retry', async () => {
    const cache = createGhostAgentModelsCache();
    io.handleListDevices
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValueOnce({ devices: [device({})] });
    io.getReceivedShares.mockReturnValue([
      { shareId: 's1', status: 'active', providerLabel: 'Claude API', owner: { displayName: 'Ann' } },
    ]);

    await expect(cache.locations('owner', readWorkerAgentLocations)).resolves.toBeUndefined();
    await expect(cache.locations('owner', readWorkerAgentLocations)).resolves.toEqual([
      { agentDeviceId: 'mac-mini', name: 'Mac mini' },
      { agentDeviceId: 'share:s1', name: 'Claude API · Ann' },
    ]);
    expect(io.handleListDevices).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight location read for the same owner and retries after failure', async () => {
    const cache = createGhostAgentModelsCache();
    io.handleListDevices
      .mockRejectedValueOnce(new Error('cloud down'))
      .mockResolvedValueOnce({ devices: [device({})] });

    const first = cache.locations('owner', readWorkerAgentLocations);
    const second = cache.locations('owner', readWorkerAgentLocations);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(io.handleListDevices).toHaveBeenCalledTimes(1);

    await expect(cache.locations('owner', readWorkerAgentLocations)).resolves.toEqual([
      { agentDeviceId: 'mac-mini', name: 'Mac mini' },
    ]);
    expect(io.handleListDevices).toHaveBeenCalledTimes(2);
  });
});
