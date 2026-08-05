import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRemoteNewMakerDefaults,
  getWorkerDefaultsFromNewMaker,
  setNewMakerDraftCache,
  setProviderModelMemoryCache,
  type NewMakerDraftSnapshot,
} from '../newMakerDefaultsCache.js';

// 模块级单例缓存,无 reset 导出 —— 每个用例先 set 一份已知快照再断言。
function seed(snapshot: NewMakerDraftSnapshot): void {
  setNewMakerDraftCache(snapshot);
}

describe('getRemoteNewMakerDefaults (device-link 远程草稿镜像)', () => {
  beforeEach(() => {
    seed({
      lastByVendor: {
        cc: {
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          permissionMode: 'bypassPermissions',
          providerId: 'anthropic',
        },
        codex: { model: 'gpt-5.4', effort: 'high' },
      },
      fastModeByModel: { 'claude-opus-4-8': true },
      effortByModel: { 'claude-opus-4-8': 'high' },
    });
  });

  it('返回该 vendor 当前草稿的完整选择(model/effort/fast/permission/source)+ 整张 per-model 记忆表', () => {
    expect(getRemoteNewMakerDefaults('claude-code')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'xhigh', // 优先 lastByVendor.effort(当前激活档),而非 effortByModel 切换记忆
      fastMode: true,
      permissionMode: 'bypassPermissions',
      providerId: 'anthropic',
      effortByModel: { 'claude-opus-4-8': 'high' }, // 整表透传,供控制端切模型还原
      fastModeByModel: { 'claude-opus-4-8': true },
    });
  });

  it('codex vendor 缺 permission/source → 带 undefined / null,不串 cc 的值;两张 map 跨 vendor 整表透传', () => {
    expect(getRemoteNewMakerDefaults('codex')).toEqual({
      model: 'gpt-5.4',
      effort: 'high',
      fastMode: false, // fastModeByModel 无 gpt-5.4 → false
      permissionMode: undefined,
      providerId: null,
      effortByModel: { 'claude-opus-4-8': 'high' }, // map 不按 vendor 过滤,按 model id 区分
      fastModeByModel: { 'claude-opus-4-8': true },
    });
  });

  it('effort 缺 lastByVendor 值时退回 effortByModel', () => {
    seed({
      lastByVendor: { cc: { model: 'claude-opus-4-8' } },
      fastModeByModel: {},
      effortByModel: { 'claude-opus-4-8': 'high' },
    });
    expect(getRemoteNewMakerDefaults('claude-code').effort).toBe('high');
  });

  it('该 vendor 无草稿 model → 返回空对象(控制端按 capabilities 默认兜底)', () => {
    seed({ lastByVendor: {}, fastModeByModel: {}, effortByModel: {} });
    expect(getRemoteNewMakerDefaults('claude-code')).toEqual({});
  });

  it('providerModelMemory 镜像就绪时随返回(device-link 草稿列表行的真实读源)', () => {
    setProviderModelMemoryCache({
      'claude-code:anthropic': { effortByModel: { 'claude-opus-4-8': 'low' }, fastByModel: { 'claude-opus-4-8': true } },
    });
    expect(getRemoteNewMakerDefaults('claude-code').providerModelMemory).toEqual({
      'claude-code:anthropic': { effortByModel: { 'claude-opus-4-8': 'low' }, fastByModel: { 'claude-opus-4-8': true } },
    });
    // 跨 vendor 整表透传(key 带 agent 前缀,控制端按需过滤)
    expect(getRemoteNewMakerDefaults('codex').providerModelMemory).toBeDefined();
  });

  it('collab worker 默认读取会保留 model/effort/fast/provider 路由组合', () => {
    seed({
      lastByVendor: { cc: { model: 'claude-opus-4-8', effort: 'high', permissionMode: 'acceptEdits', providerId: 'xd' } },
      fastModeByModel: { 'claude-opus-4-8': true },
      effortByModel: {},
    });
    expect(getWorkerDefaultsFromNewMaker('claude-code')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
      fastMode: true,
      providerId: 'xd',
    });
  });
});
