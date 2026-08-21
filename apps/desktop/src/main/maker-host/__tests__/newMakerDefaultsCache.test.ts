import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRemoteNewMakerDefaults,
  getRemoteNewMakerDefaultsByVendor,
  getThinkingEnabledFromMemory,
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
      worktreeEnabled: false, // 旧 renderer 快照缺字段 → false 兜底
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
      worktreeEnabled: false,
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

  it('该 vendor 无草稿 model → 只回 vendor 无关字段(控制端按 capabilities 默认兜底)', () => {
    seed({ lastByVendor: {}, fastModeByModel: {}, effortByModel: {} });
    expect(getRemoteNewMakerDefaults('claude-code')).toEqual({ worktreeEnabled: false });
  });

  it('worktreeEnabled 勾选记忆:vendor 无关,该 vendor 无草稿 model 的早返回也必须携带', () => {
    // 空草稿的工作端上手机/控制端也要能读到勾选态,否则永远播种不出 ON。
    seed({ lastByVendor: {}, fastModeByModel: {}, effortByModel: {}, worktreeEnabled: true });
    expect(getRemoteNewMakerDefaults('claude-code')).toEqual({ worktreeEnabled: true });
    expect(getRemoteNewMakerDefaults('codex')).toEqual({ worktreeEnabled: true });
  });

  it('镜像每个 vendor 的显式模型选择状态，供控制端决定是否应用区域默认', () => {
    seed({
      lastByVendor: {
        cc: { model: 'claude-opus-4-8' },
        pi: { model: 'claude-sonnet-4-6' },
      },
      modelChosenByVendor: { cc: false, pi: true },
      fastModeByModel: {},
      effortByModel: {},
    });

    expect(getRemoteNewMakerDefaults('claude-code')).toMatchObject({
      model: 'claude-opus-4-8',
      modelChosenByUser: false,
    });
    expect(getRemoteNewMakerDefaults('pi')).toMatchObject({
      model: 'claude-sonnet-4-6',
      modelChosenByUser: true,
    });
  });

  it('草稿变更广播快照始终包含 claude-code、codex、pi 三个槽', () => {
    seed({
      lastByVendor: { pi: { model: 'claude-sonnet-4-6' } },
      modelChosenByVendor: { pi: false },
      fastModeByModel: {},
      effortByModel: {},
    });

    const snapshot = getRemoteNewMakerDefaultsByVendor();
    expect(Object.keys(snapshot)).toEqual(['claudeCode', 'codex', 'pi']);
    expect(snapshot.pi).toMatchObject({
      model: 'claude-sonnet-4-6',
      modelChosenByUser: false,
    });
  });

  it('reads thinkingEnabled from the provider model memory mirror', () => {
    setProviderModelMemoryCache({
      'pi:cindy-local-ollama': {
        effortByModel: {},
        fastByModel: {},
        thinkingByModel: { 'qwen3.8:27b-mxfp8': false },
      },
    });
    expect(
      getThinkingEnabledFromMemory('pi', 'cindy-local-ollama', 'qwen3.8:27b-mxfp8'),
    ).toBe(false);
    expect(getThinkingEnabledFromMemory('pi', 'cindy-local-ollama', 'gpt-oss:20b')).toBeUndefined();
    expect(getThinkingEnabledFromMemory('pi', null, 'qwen3.8:27b-mxfp8')).toBeUndefined();
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
