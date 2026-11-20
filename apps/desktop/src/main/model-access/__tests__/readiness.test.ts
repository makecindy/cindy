// 测试价值
// - 生产入口与可观察结果:noteModelAccessSyncState(credentialsSync 的 onStatusChange 唯一调用方)
//   → isModelAccessTransientlyUnavailable();cindy 槽据此决定插件收到的是临时失败还是 NO_CANDIDATE。
// - Bug／规则依据:#7730 review。重试预算用完进入 failed 时本地 key 保留、可在设置页重试,
//   旧实现只把 syncing 当临时状态,failed 会让插件收到"未登录、不要重试"。
// - 现有覆盖缺口:credentialsSync.test.ts 只测状态机,不经过这层映射;cindySlot.test.ts 注入的是布尔值。
// - 最小失败输入:noteModelAccessSyncState('failed') 后读到 false。
// - tier:unit(纯内存状态,依赖的 Electron 模块已 mock)。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: false }),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => undefined }),
}));

import { isModelAccessTransientlyUnavailable, noteModelAccessSyncState } from '../readiness.js';

describe('model-access readiness: 凭证暂时不可用', () => {
  it.each([
    ['syncing', true],
    ['failed', true],
    ['ok', false],
    ['idle', false],
    ['disabled', false],
    ['unsupported', false],
  ] as const)('同步状态 %s → 暂时不可用=%s', (state, transient) => {
    noteModelAccessSyncState(state);
    expect(isModelAccessTransientlyUnavailable()).toBe(transient);
  });
});
