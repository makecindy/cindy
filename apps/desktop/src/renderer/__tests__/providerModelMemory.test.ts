/**
 * providerModelMemory.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/providerModelMemory.ts 的核心约定:
 *   1. 默认无记录 → getProviderModelChoice 返回 undefined
 *   2. set/get 往返 + localStorage 持久化(模拟 app 重启后恢复)
 *   3. 同一 agent/model 跨来源共享,不同 agent 仍隔离
 *   4. 同值写入短路(不抛,值保持)
 *   5. 空 providerId / model / effort 入参被静默忽略
 *   6. schema 损坏的 localStorage → 静默回退空表,不抛
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  private writesFail = false;
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.writesFail) throw new Error('simulated localStorage write failure');
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
  setWritesFail(writesFail: boolean): void {
    this.writesFail = writesFail;
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/providerModelMemory');
}

describe('providerModelMemory store', () => {
  it('默认无记录:getProviderModelChoice 返回 undefined', async () => {
    const { getProviderModelChoice, hasAnyProviderModelOverride } = await loadModule();
    expect(getProviderModelChoice('claude-code', 'xd')).toBeUndefined();
    expect(getProviderModelChoice('codex', 'openai')).toBeUndefined();
    expect(hasAnyProviderModelOverride()).toBe(false);
  });

  it('仅有 effort 或 Fast 记忆也视为既有模型自定义', async () => {
    const effortMemory = await loadModule();
    effortMemory.setProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(effortMemory.hasAnyProviderModelOverride()).toBe(true);

    effortMemory.__resetForTest();
    effortMemory.setProviderModelFast('codex', 'openai', 'gpt-5.6-sol', false);
    expect(effortMemory.hasAnyProviderModelOverride()).toBe(true);
  });

  it('按 dataOwnerId 隔离 override，旧全局快照只由首个 owner 认领', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v2',
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: '',
          effortByModel: { 'claude-opus-4-8': 'high' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    expect(m.hasAnyProviderModelOverride()).toBe(true);
    expect(memStorage.getItem('xdt:providerModelMemory:v2')).toBeNull();

    m.setProviderModelMemoryOwner('owner-b');
    expect(m.hasAnyProviderModelOverride()).toBe(false);
    m.setProviderModelFast('codex', 'openai', 'gpt-5.6-sol', false);
    expect(m.hasAnyProviderModelOverride()).toBe(true);

    m.setProviderModelMemoryOwner('owner-a');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelFast('codex', 'openai', 'gpt-5.6-sol')).toBeUndefined();
  });

  it('同 owner 的外部写入刷新空缓存并通知订阅者，其他 owner 事件不串入', async () => {
    let onStorage: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      localStorage: memStorage,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'storage') onStorage = listener as (event: StorageEvent) => void;
      },
      removeEventListener: vi.fn(),
    });
    vi.resetModules();

    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    expect(m.hasAnyProviderModelOverride()).toBe(false); // 窗口 B 先以空缓存启动。
    const seen = vi.fn();
    m.subscribeProviderModelMemory(seen);

    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'codex:openai': {
          lastModel: '',
          effortByModel: { 'gpt-5.6-sol': 'xhigh' },
          fastByModel: { 'gpt-5.6-sol': true },
          thinkingByModel: {},
        },
      }),
    );
    onStorage?.({ key: ownerAKey, newValue: '{ stale event payload }' } as StorageEvent);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(m.hasAnyProviderModelOverride()).toBe(true);
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.6-sol')).toBe('xhigh');
    expect(m.getProviderModelFast('codex', 'openai', 'gpt-5.6-sol')).toBe(true);

    // 相同持久化真相的迟到事件不应重复 bump modelPresetVersion。
    onStorage?.({ key: ownerAKey, newValue: '{ older payload }' } as StorageEvent);
    onStorage?.({
      key: ownerAKey,
      storageArea: {} as Storage,
    } as StorageEvent);
    expect(seen).toHaveBeenCalledTimes(1);

    memStorage.setItem(
      `${m.__STORAGE_KEY}:owner-b`,
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: '',
          effortByModel: { 'claude-opus-4-8': 'low' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );
    onStorage?.({ key: `${m.__STORAGE_KEY}:owner-b` } as StorageEvent);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();

    // owner 已切换后，旧 owner 的迟到事件不能刷新新 owner 缓存。
    m.setProviderModelMemoryOwner('owner-c');
    seen.mockClear();
    onStorage?.({ key: ownerAKey } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
    expect(m.hasAnyProviderModelOverride()).toBe(false);
  });

  it('写入前重读 owner 分区，不用空缓存覆盖外部 effort/Fast', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    expect(m.hasAnyProviderModelOverride()).toBe(false); // 窗口 B 的旧缓存。

    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: '',
          effortByModel: { 'claude-opus-4-8': 'high' },
          fastByModel: { 'claude-opus-4-8': true },
          thinkingByModel: {},
        },
      }),
    );

    // storage 事件尚未送达时，窗口 B 又写另一条；整表写回仍须保留窗口 A 的两项 override。
    m.setProviderModelThinking('pi', 'xd', 'glm-5.3-flash', true);
    const persisted = JSON.parse(memStorage.getItem(ownerAKey) ?? '{}') as Record<
      string,
      {
        effortByModel: Record<string, string>;
        fastByModel: Record<string, boolean>;
        thinkingByModel: Record<string, boolean>;
      }
    >;
    expect(persisted['claude-code:anthropic']?.effortByModel['claude-opus-4-8']).toBe('high');
    expect(persisted['claude-code:anthropic']?.fastByModel['claude-opus-4-8']).toBe(true);
    expect(persisted['pi:xd']?.thinkingByModel['glm-5.3-flash']).toBe(true);
  });

  it('写前读到外部同值时也刷新本窗口缓存和订阅者', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    expect(m.hasAnyProviderModelOverride()).toBe(false);
    const seen = vi.fn();
    m.subscribeProviderModelMemory(seen);

    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'codex:openai': {
          lastModel: '',
          effortByModel: { 'gpt-5.6-sol': 'xhigh' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );

    // storage 事件尚未到达；同值写虽无需再落盘，但 freshMap 已看到的真相必须立即被采纳。
    m.setProviderModelEffort('codex', 'openai', 'gpt-5.6-sol', 'xhigh');
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.6-sol')).toBe('xhigh');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('写盘失败后继续保留当前 owner 的新 override，可写时完整补落盘', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: '',
          effortByModel: { 'claude-opus-4-8': 'medium' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );

    memStorage.setWritesFail(true);
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    m.setProviderModelEffort('codex', 'openai', 'gpt-5.6-sol', 'xhigh');
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.6-sol')).toBe('xhigh');

    memStorage.setWritesFail(false);
    // 窗口 A 在 B 写盘失败期间成功写入另一项；B 恢复后必须在这份新盘面上重放自己的 op。
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: '',
          effortByModel: { 'claude-opus-4-8': 'medium' },
          fastByModel: {},
          thinkingByModel: {},
        },
        'claude-code:xd': {
          lastModel: '',
          effortByModel: { 'claude-haiku-4-5': 'low' },
          fastByModel: {},
          thinkingByModel: {},
        },
        'codex:openai': {
          lastModel: 'gpt-5.5',
          effortByModel: { 'gpt-5.5': 'medium' },
          fastByModel: {},
          thinkingByModel: {},
        },
        'codex:*': {
          lastModel: '',
          effortByModel: {},
          fastByModel: { 'gpt-5.6-sol': false },
          thinkingByModel: {},
        },
      }),
    );
    m.setProviderModelThinking('pi', 'xd', 'glm-5.3-flash', true);
    const persisted = JSON.parse(memStorage.getItem(ownerAKey) ?? '{}') as Record<
      string,
      {
        effortByModel: Record<string, string>;
        fastByModel: Record<string, boolean>;
        thinkingByModel: Record<string, boolean>;
      }
    >;
    expect(persisted['claude-code:anthropic']?.effortByModel['claude-opus-4-8']).toBe('medium');
    expect(persisted['claude-code:anthropic']?.fastByModel['claude-opus-4-8']).toBe(true);
    expect(persisted['claude-code:xd']?.effortByModel['claude-haiku-4-5']).toBe('low');
    expect(persisted['codex:openai']?.effortByModel['gpt-5.6-sol']).toBe('xhigh');
    expect(persisted['codex:openai']?.effortByModel['gpt-5.5']).toBe('medium');
    expect((persisted['codex:openai'] as { lastModel?: string })?.lastModel).toBe('gpt-5.5');
    expect(persisted['codex:*']?.fastByModel['gpt-5.6-sol']).toBe(false);
    expect(persisted['pi:xd']?.thinkingByModel['glm-5.3-flash']).toBe(true);
  });

  it('写盘失败的旧操作不覆盖另一窗口后来写入的同字段', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;

    memStorage.setWritesFail(true);
    m.setProviderModelFast('codex', 'openai', 'gpt-5.6-sol', true);

    memStorage.setWritesFail(false);
    // 窗口 A 后来明确把同一字段设为 false；B 的旧 pending=true 恢复时必须退休。
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'codex:openai': {
          lastModel: '',
          effortByModel: {},
          fastByModel: { 'gpt-5.6-sol': false },
          thinkingByModel: {},
        },
      }),
    );
    m.setProviderModelThinking('pi', 'xd', 'glm-5.3-flash', true);

    const persisted = JSON.parse(memStorage.getItem(ownerAKey) ?? '{}') as Record<
      string,
      { fastByModel: Record<string, boolean> }
    >;
    expect(persisted['codex:openai']?.fastByModel['gpt-5.6-sol']).toBe(false);
  });

  it('选模写盘失败后再调 effort，不会丢失独立的 lastModel 意图', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');

    memStorage.setWritesFail(true);
    m.setProviderModelChoice('codex', 'openai', 'gpt-5.6-sol', 'high');
    m.setProviderModelEffort('codex', 'openai', 'gpt-5.6-sol', 'xhigh');

    memStorage.setWritesFail(false);
    m.setProviderModelThinking('pi', 'xd', 'glm-5.3-flash', true);
    expect(m.getProviderModelChoice('codex', 'openai')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('冲突退休的旧 lastModel 基线不阻断后来更新的本地选模', async () => {
    const m = await loadModule();
    m.setProviderModelMemoryOwner('owner-a');
    const ownerAKey = `${m.__STORAGE_KEY}:owner-a`;
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'codex:openai': {
          lastModel: 'model-x',
          effortByModel: { 'model-x': 'medium' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );

    memStorage.setWritesFail(true);
    m.setProviderModelChoice('codex', 'openai', 'model-a', 'high');

    memStorage.setWritesFail(false);
    memStorage.setItem(
      ownerAKey,
      JSON.stringify({
        'codex:openai': {
          lastModel: 'model-c',
          effortByModel: { 'model-c': 'low' },
          fastByModel: {},
          thinkingByModel: {},
        },
      }),
    );
    memStorage.setWritesFail(true);
    m.setProviderModelChoice('codex', 'openai', 'model-b', 'xhigh');

    memStorage.setWritesFail(false);
    m.setProviderModelThinking('pi', 'xd', 'glm-5.3-flash', true);
    expect(m.getProviderModelChoice('codex', 'openai')).toEqual({
      model: 'model-b',
      effort: 'xhigh',
    });
  });

  it('set/get 往返 + 跨重启持久化', async () => {
    const m1 = await loadModule();
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m1.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    // 模拟 app 重启(重置模块缓存后重新从 localStorage 加载)
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
  });

  it('按 (agent, providerId) 分槽:xd 在 cc / codex 下互不覆盖', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'xd', 'claude-sonnet-4-6', 'medium');
    m.setProviderModelChoice('codex', 'xd', 'gpt-5.4', 'high');
    expect(m.getProviderModelChoice('claude-code', 'xd')).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    });
    expect(m.getProviderModelChoice('codex', 'xd')).toEqual({
      model: 'gpt-5.4',
      effort: 'high',
    });
  });

  it('覆盖写:同一槽再次写入用新值', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'xd', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'xd', 'claude-haiku-4-5', 'low');
    expect(m.getProviderModelChoice('claude-code', 'xd')).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
  });

  it('同值写入短路:值保持不变,不抛', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('codex', 'openai', 'gpt-5.4', 'high');
    expect(() => m.setProviderModelChoice('codex', 'openai', 'gpt-5.4', 'high')).not.toThrow();
    expect(m.getProviderModelChoice('codex', 'openai')).toEqual({
      model: 'gpt-5.4',
      effort: 'high',
    });
  });

  it('空 providerId / model / effort 入参被忽略', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', '', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', '', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', '');
    expect(m.getProviderModelChoice('claude-code', '')).toBeUndefined();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toBeUndefined();
  });

  it('schema 损坏的 localStorage → 静默回退空表,不抛', async () => {
    memStorage.setItem('xdt:providerModelMemory:v2', '{ not valid json');
    vi.resetModules();
    const { getProviderModelChoice } = await loadModule();
    expect(getProviderModelChoice('claude-code', 'anthropic')).toBeUndefined();
  });
});

describe('providerModelMemory v2 —— (agent, model) 全局 effort + provider lastModel', () => {
  it('同一来源不同模型各记各的 effort,lastModel 切换不覆盖旧模型 effort', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-haiku-4-5', 'low');
    // opus 的 high 不因后写 haiku 而丢失
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-haiku-4-5')).toBe('low');
    // getProviderModelChoice 返回该来源 lastModel + 其 effort
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
  });

  it('不同来源的同 model id effort 互不串', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m.getProviderModelEffort('claude-code', 'xd', 'claude-opus-4-8')).toBeUndefined();
    m.setProviderModelChoice('claude-code', 'xd', 'claude-opus-4-8', 'medium');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'xd', 'claude-opus-4-8')).toBe('medium');
  });

  it('只编辑非选中模型的 effort 不会篡改该来源 lastModel', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-sonnet-4-6', 'medium');
    m.setProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
    });
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'xd', 'claude-opus-4-8')).toBeUndefined();
  });

  it('getProviderModelEffort:未记录模型 / 空参 / 其它来源 → undefined', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('codex', 'openai', 'gpt-5.5', 'high');
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('high');
    expect(m.getProviderModelEffort('codex', 'openai', 'unknown-model')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', '', 'gpt-5.5')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'openai', '')).toBeUndefined();
  });

  it('snapshot 只含真实 provider 槽', async () => {
    const m = await loadModule();
    m.setProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8', 'xhigh');
    m.setProviderModelFast('claude-code', 'xd', 'claude-opus-4-8', true);
    expect(m.snapshotForSeed()['claude-code:anthropic']?.effortByModel).toEqual({
      'claude-opus-4-8': 'xhigh',
    });
    expect(m.snapshotForSeed()['claude-code:xd']?.fastByModel).toEqual({
      'claude-opus-4-8': true,
    });
    expect(m.snapshotForSeed()['claude-code:*']).toBeUndefined();
  });

  it('snapshot 带上思考开关', async () => {
    const m = await loadModule();
    m.setProviderModelThinking('pi', 'cindy-local-ollama', 'qwen3.8:27b-mxfp8', false);
    expect(m.snapshotForSeed()['pi:cindy-local-ollama']?.thinkingByModel).toEqual({
      'qwen3.8:27b-mxfp8': false,
    });
  });

  it('多模型 effort 跨重启持久化(v2)', async () => {
    const m1 = await loadModule();
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m1.setProviderModelChoice('claude-code', 'anthropic', 'claude-haiku-4-5', 'low');
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m2.getProviderModelEffort('claude-code', 'anthropic', 'claude-haiku-4-5')).toBe('low');
  });

  it('迁移历史 v1 单槽 → v2(lastModel + 该模型 effort 都可恢复)', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v1',
      JSON.stringify({
        'claude-code:anthropic': { model: 'claude-opus-4-8', effort: 'xhigh' },
        'codex:openai': { model: 'gpt-5.5', effort: 'medium' },
      }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'xhigh',
    });
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('xhigh');
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('medium');
  });

  it('v2 在场时忽略 v1(不回退迁移)', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v2',
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: 'claude-opus-4-8',
          effortByModel: { 'claude-opus-4-8': 'high' },
        },
      }),
    );
    memStorage.setItem(
      'xdt:providerModelMemory:v1',
      JSON.stringify({ 'claude-code:anthropic': { model: 'claude-haiku-4-5', effort: 'low' } }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelChoice('claude-code', 'anthropic')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
    });
  });

  it('v2 脏数据:非法 effort 条目过滤 / effortByModel 空槽丢弃 / 缺 lastModel 仍可查 effort', async () => {
    memStorage.setItem(
      'xdt:providerModelMemory:v2',
      JSON.stringify({
        'claude-code:anthropic': {
          lastModel: 'claude-opus-4-8',
          effortByModel: { 'claude-opus-4-8': 'high', bad: 42 }, // bad 非 string → 过滤
        },
        'claude-code:xd': { lastModel: 'x', effortByModel: {} }, // 空 effortByModel → 整槽丢弃
        'codex:openai': { effortByModel: { 'gpt-5.5': 'medium' } }, // 无 lastModel:effort 可查,choice undefined
      }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'bad')).toBeUndefined();
    expect(m.getProviderModelChoice('claude-code', 'xd')).toBeUndefined();
    expect(m.getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('medium');
    expect(m.getProviderModelChoice('codex', 'openai')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fast 与 effort 同维度:per-(agent, model) 全局共享。providerId 只保留 capability / 旧 v2 回退用途。
// ---------------------------------------------------------------------------
describe('providerModelMemory —— (agent, model) fast 全局预设', () => {
  it('同一 model id 的 fast 按来源隔离', async () => {
    const m = await loadModule();
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    expect(m.getProviderModelFast('claude-code', 'xd', 'claude-opus-4-8')).toBeUndefined();
    m.setProviderModelFast('claude-code', 'xd', 'claude-opus-4-8', false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
    expect(m.getProviderModelFast('claude-code', 'xd', 'claude-opus-4-8')).toBe(false);
  });

  it('fast 写入不动同槽 effort / lastModel;effort 写入不动 fast', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    // 两者并存,互不覆盖
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
    // 再写 effort,fast 保持
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'low');
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
  });

  it('getProviderModelFast:未记录模型 / 空参 → undefined,显式 false 跨来源保留', async () => {
    const m = await loadModule();
    m.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(false);
    expect(m.getProviderModelFast('claude-code', 'anthropic', 'unknown-model')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', 'xd', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', '', 'claude-opus-4-8')).toBeUndefined();
    expect(m.getProviderModelFast('claude-code', 'anthropic', '')).toBeUndefined();
  });

  it('fast 跨重启持久化(v2)', async () => {
    const m1 = await loadModule();
    m1.setProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8', true);
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getProviderModelFast('claude-code', 'anthropic', 'claude-opus-4-8')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 「恢复推荐 / 回落默认」= **删记忆键**,不是把这一版的目录默认快照写回去
// (2026-08-17 review H3)。记忆表是 override 表:表里没有该键 ⇒ 跟随当前版本的默认。
// 写快照会把用户钉死在旧默认上 —— 服务端之后改了推荐档,点过「恢复推荐」的人吃不到。
// ---------------------------------------------------------------------------
describe('providerModelMemory —— clear:恢复推荐删键(不写默认快照)', () => {
  it('clearEffort 把全局槽与来源兼容副本两处一起删掉(只删一处会被另一处顶回来)', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('claude-code', 'anthropic', 'claude-opus-4-8', 'high');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBe('high');

    m.clearProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8');
    expect(m.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8')).toBeUndefined();
    // 落盘里两个槽都不再有这个模型键 —— 留一份「等于当前默认」的快照就是把默认固化成用户配置。
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}') as Record<
      string,
      { effortByModel: Record<string, string> }
    >;
    expect(persisted['claude-code:*']?.effortByModel['claude-opus-4-8']).toBeUndefined();
    expect(persisted['claude-code:anthropic']?.effortByModel['claude-opus-4-8']).toBeUndefined();

    // 重启后仍是「无记录 ⇒ 跟随目录默认」。
    vi.resetModules();
    const m2 = await loadModule();
    expect(
      m2.getProviderModelEffort('claude-code', 'anthropic', 'claude-opus-4-8'),
    ).toBeUndefined();
  });

  it('clearFast 同理;删的是键而不是写一份显式 false', async () => {
    const m = await loadModule();
    m.setProviderModelFast('codex', 'xd', 'gpt-5.5', true);
    expect(m.getProviderModelFast('codex', 'xd', 'gpt-5.5')).toBe(true);
    m.clearProviderModelFast('codex', 'xd', 'gpt-5.5');
    // undefined(而不是 false):调用层按「缺省即关」解释,但不会被钉在这一版的默认上。
    expect(m.getProviderModelFast('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}') as Record<
      string,
      { fastByModel: Record<string, boolean> }
    >;
    expect('gpt-5.5' in (persisted['codex:*']?.fastByModel ?? {})).toBe(false);
    expect('gpt-5.5' in (persisted['codex:xd']?.fastByModel ?? {})).toBe(false);
  });

  it('clear 只删点名那个模型键,不动同槽其它模型 / 另一维 / lastModel', async () => {
    const m = await loadModule();
    m.setProviderModelChoice('codex', 'xd', 'gpt-5.5', 'high');
    m.setProviderModelEffort('codex', 'xd', 'deepseek-v4-pro', 'low');
    m.setProviderModelFast('codex', 'xd', 'gpt-5.5', true);

    m.clearProviderModelEffort('codex', 'xd', 'gpt-5.5');
    expect(m.getProviderModelEffort('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    // 同槽另一个模型的深度、同模型的 Fast 都不受影响。
    expect(m.getProviderModelEffort('codex', 'xd', 'deepseek-v4-pro')).toBe('low');
    expect(m.getProviderModelFast('codex', 'xd', 'gpt-5.5')).toBe(true);
    // lastModel 仍在(切来源时的落点 hint 不该被「恢复推荐」顺手抹掉)。
    expect(m.getProviderModelChoice('codex', 'xd')).toBeUndefined(); // 该模型已无 effort
    m.setProviderModelEffort('codex', 'xd', 'gpt-5.5', 'low');
    expect(m.getProviderModelChoice('codex', 'xd')).toEqual({ model: 'gpt-5.5', effort: 'low' });
  });

  it('无记录 / 非法入参 → 静默短路,不落盘不通知', async () => {
    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeProviderModelMemory(seen);
    m.clearProviderModelEffort('codex', 'xd', 'gpt-5.5');
    m.clearProviderModelFast('codex', 'xd', 'gpt-5.5');
    m.clearProviderModelEffort('codex', '', 'gpt-5.5');
    m.clearProviderModelEffort('codex', '*', 'gpt-5.5');
    m.clearProviderModelFast('codex', 'xd', '');
    expect(seen).not.toHaveBeenCalled();
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });
});
