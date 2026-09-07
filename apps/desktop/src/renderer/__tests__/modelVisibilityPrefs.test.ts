/**
 * modelVisibilityPrefs.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelVisibilityPrefs.ts 的核心约定:
 *   1. 新配置首次目录初始化；已初始化或既有配置不因目录默认改变
 *   2. set override 覆盖目录默认(把默认开的关掉 / 把默认关的打开)
 *   3. set/get 往返 + owner-scoped localStorage 持久化(模拟 app 重启)
 *   4. 按 (agent, providerId, modelId) 分槽:同名模型在 cc / codex 互不覆盖
 *   5. setManyVisibility 批量(全部关 / 全部开)写显式 override
 *   6. 跨 agent 的一次用户操作原子落盘，失败不留下部分状态
 *   7. 同值写入短路(不抛)
 *   8. 旧全局 key 只由 Main 仲裁出的首个 owner 认领,新账号默认隔离
 *   9. schema 损坏 / 脏数据 → 不猜测开启未知模型
 *  10. main 镜像同步异步失败时不产生未处理 rejection
 *
 * 项目 vitest env=node,无 window。沿用 providerModelMemory.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { unifiedModelEntries, type ProviderView } from '@cindy/model-providers';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;
const syncModelVisibility = vi.fn(async () => undefined);
const logToMain = vi.fn();
let ownerClaim: {
  dataOwnerId: string | null;
  ownerGeneration: number;
  canWriteOwnerScoped: boolean;
  claimed: boolean;
  claimedByOtherOwner?: boolean;
  canInitialize: boolean;
};

function setOwnerClaim(
  dataOwnerId: string | null,
  ownerGeneration: number,
  claimed = true,
  canInitialize = true,
  claimedByOtherOwner = false,
  canWriteOwnerScoped = true,
): void {
  ownerClaim = {
    dataOwnerId,
    ownerGeneration,
    canWriteOwnerScoped,
    claimed,
    claimedByOtherOwner,
    canInitialize,
  };
}

beforeEach(() => {
  memStorage = new MemLocalStorage();
  syncModelVisibility.mockClear();
  logToMain.mockClear();
  setOwnerClaim('owner-a', 1);
  vi.stubGlobal('window', {
    localStorage: memStorage,
    electronAPI: {
      logToMain,
      maker: {
        syncModelVisibility,
        claimLegacyModelVisibilityOwner: () => ownerClaim,
      },
    },
  });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/modelVisibilityPrefs');
}

async function loadModuleForOwner(
  ownerId: string | null = 'owner-a',
  ownerGeneration = 1,
  mode: 'signed-out' | 'local' | 'cloud' = 'cloud',
) {
  const module = await loadModule();
  module.setModelVisibilityOwner(ownerId, ownerGeneration, mode);
  return module;
}

describe('modelVisibilityPrefs store', () => {
  it('无 override:跟随目录默认值(缺省=开 / false=关 / true=开)', async () => {
    const { isModelEnabled } = await loadModuleForOwner();
    // defaultEnabled 缺省 → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
    // defaultEnabled: true → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'a', defaultEnabled: true })).toBe(true);
    // defaultEnabled: false → 默认关(目录把它标成默认隐藏)
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(false);
  });

  it('set override 覆盖目录默认:默认开的关掉、默认关的打开', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    // 默认开 → 用户关
    setModelVisibility('claude-code', 'xd', 'claude-opus-4-8', false);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false);
    // 默认关(defaultEnabled:false)→ 用户开
    setModelVisibility('claude-code', 'xd', 'b', true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
  });

  it('set/get 往返 + 跨重启持久化', async () => {
    const m1 = await loadModuleForOwner();
    m1.setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(m1.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);

    vi.resetModules();
    const m2 = await loadModuleForOwner();
    expect(m2.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
  });

  it('按 (agent, providerId, modelId) 分槽:同名 gpt-5.5 在 cc / codex 互不覆盖', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    setModelVisibility('codex', 'xd', 'gpt-5.5', true);
    setModelVisibility('claude-code', 'xd', 'gpt-5.5', false); // cc 下关掉
    // codex 已开启的配置不受影响
    expect(isModelEnabled('claude-code', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true);
  });

  it('同一来源不同 provider 互不影响(xd vs openai)', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    setModelVisibility('codex', 'openai', 'gpt-5.5', true);
    setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
  });

  it('setManyVisibility:全部关 → 全部开,写显式 override(含目录默认关的也被打开)', async () => {
    const { isModelEnabled, setManyVisibility } = await loadModuleForOwner();
    const ids = ['claude-opus-4-8', 'claude-sonnet-4-6', 'b'];
    setManyVisibility('claude-code', 'xd', ids, false);
    for (const id of ids) {
      expect(isModelEnabled('claude-code', 'xd', { id })).toBe(false);
    }
    setManyVisibility('claude-code', 'xd', ids, true);
    // 即便 'b' 目录默认是关,「全部开启」也把它显式打开
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
  });

  it('setModelVisibilities:跨 agent 一次落盘并同时更新全部目标', async () => {
    const module = await loadModuleForOwner();
    const setItem = vi.spyOn(memStorage, 'setItem');

    expect(
      module.setModelVisibilities(
        'xd',
        [
          { agent: 'claude-code', modelId: 'claude-sonnet-4-6' },
          { agent: 'codex', modelId: 'gpt-5.6' },
        ],
        false,
      ),
    ).toBe(true);

    expect(
      setItem.mock.calls.filter(([key]) => key === 'xdt:modelVisibilityPrefs:v1.owner.owner-a'),
    ).toHaveLength(1);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(false);
    setItem.mockRestore();
  });

  it('setModelVisibilities:落盘失败不部分提交，按同一方向重试可整体成功', async () => {
    const module = await loadModuleForOwner();
    const storageKey = 'xdt:modelVisibilityPrefs:v1.owner.owner-a';
    const rawBeforeFailure = memStorage.getItem(storageKey);
    const mirrorCallsBeforeFailure = syncModelVisibility.mock.calls.length;
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('injected storage failure');
    });
    const targets = [
      { agent: 'claude-code' as const, modelId: 'claude-sonnet-4-6' },
      { agent: 'codex' as const, modelId: 'gpt-5.6' },
    ];

    expect(module.setModelVisibilities('xd', targets, false)).toBe(false);
    expect(memStorage.getItem(storageKey)).toBe(rawBeforeFailure);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(true);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenCalledTimes(mirrorCallsBeforeFailure);

    expect(module.setModelVisibilities('xd', targets, false)).toBe(true);
    expect(module.isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'xd', { id: 'gpt-5.6' })).toBe(false);
    setItem.mockRestore();
  });

  it('同值写入短路:不抛,值保持', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    expect(setModelVisibility('codex', 'openai', 'gpt-5.4', false)).toBe(true);
    expect(setModelVisibility('codex', 'openai', 'gpt-5.4', false)).toBe(true);
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.4' })).toBe(false);
  });

  it('空 providerId / modelId 入参被忽略', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    setModelVisibility('claude-code', '', 'x', false);
    setModelVisibility('claude-code', 'xd', '', false);
    // 都没写进去 → 仍跟随默认(开)
    expect(isModelEnabled('claude-code', 'xd', { id: 'x' })).toBe(true);
  });

  it('首个已认领 owner 导入旧全局 override，切换到新账号后默认隔离', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    const module = await loadModuleForOwner('owner-a', 1);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );

    setOwnerClaim('owner-b', 2, false, false, true);
    module.setModelVisibilityOwner('owner-b', 2, 'cloud');

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-b')).toBeNull();
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-b', 2, {}, expect.objectContaining({ pending: true }));

    setOwnerClaim('owner-a', 3, true, true);
    module.setModelVisibilityOwner('owner-a', 3, 'cloud');
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
  });

  it('已归属但非独占时保存新 override，恢复独占后合并旧值且新值优先', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({
        'codex:openai:gpt-5.6': false,
        'codex:openai:gpt-5.5': true,
      }),
    );
    setOwnerClaim('owner-a', 1, true, false);
    const module = await loadModuleForOwner();

    module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.5': false }),
    );

    setOwnerClaim('owner-a', 1, true, true);
    module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
    expect(memStorage.getItem(
      'xdt:modelVisibilityPrefs:v1.migration-complete.owner.owner-a',
    )).toBe('1');
  });

  it('旧 key 尚未认领时仍允许稳定 owner 写自己的隔离 key', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('owner-a', 1, false, false);
    const module = await loadModuleForOwner();

    expect(module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);

    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.5': false }),
    );
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1')).toBe(
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);

    setOwnerClaim('owner-a', 1, true, true);
    expect(module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(true);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
  });

  it('当前 owner 会话尚未稳定时继续阻止写入', async () => {
    setOwnerClaim('owner-a', 1, false, false, false, false);
    const module = await loadModuleForOwner();

    expect(module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBeNull();
    expect(logToMain).toHaveBeenCalledWith(
      'warn',
      'ModelVisibilityPrefs',
      expect.stringContaining('owner-write-not-ready'),
    );
  });

  it('owner-scoped 存储失败时返回失败并保持旧状态', async () => {
    const module = await loadModuleForOwner();
    const mirrorCallsBeforeFailure = syncModelVisibility.mock.calls.length;
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('injected storage failure');
    });

    expect(module.setModelVisibility('codex', 'openai', 'gpt-5.5', false)).toBe(false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenCalledTimes(mirrorCallsBeforeFailure);
    expect(logToMain).toHaveBeenCalledWith(
      'warn',
      'ModelVisibilityPrefs',
      expect.stringContaining('storage-write-failed'),
    );
    setItem.mockRestore();
  });

  it('已有 owner-scoped override 优先，迁移不会覆盖', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1.owner.owner-a',
      JSON.stringify({ 'codex:openai:gpt-5.6': true }),
    );

    const module = await loadModuleForOwner();

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
  });

  it('未登录时不写 override，并将空镜像推给 Main 清除前账号状态', async () => {
    const module = await loadModuleForOwner();
    module.setModelVisibility('codex', 'openai', 'gpt-5.6', false);

    module.setModelVisibilityOwner(null, 2, 'signed-out');
    module.setModelVisibility('codex', 'openai', 'gpt-5.6', false);

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(true);
    expect(syncModelVisibility).toHaveBeenLastCalledWith(null, 2, {});
  });

  it('retries a failed mirror sync and cancels old snapshots after a newer switch', async () => {
    vi.useFakeTimers();
    try {
      syncModelVisibility.mockRejectedValueOnce(new Error('handler not registered'));
      const prefs = await loadModuleForOwner();
      await vi.advanceTimersByTimeAsync(250);
      expect(syncModelVisibility).toHaveBeenCalledTimes(2);
      syncModelVisibility.mockRejectedValueOnce(new Error('temporary failure'));
      prefs.setModelVisibility('pi', 'xd', 'a', true);
      await Promise.resolve();
      prefs.setModelVisibility('pi', 'xd', 'a', false);
      const count = syncModelVisibility.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(syncModelVisibility).toHaveBeenCalledTimes(count);
      expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-a', 1,
        { 'pi:xd:a': false }, expect.anything());
    } finally { vi.useRealTimers(); }
  });

  it('本地 profile 认领历史全局 key 并迁移到自己的 namespace', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('local-v1', 1);
    const module = await loadModuleForOwner('local-v1', 1, 'local');

    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.6' })).toBe(false);
    module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(false);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1')).not.toBeNull();
  });

  it('旧配置损坏时不把未知模型自动开启', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false);
  });

  it('脏数据条目(value 非 boolean)被过滤', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({
        'claude-code:xd:claude-opus-4-8': false, // 合法
        'claude-code:xd:claude-sonnet-4-6': 'nope', // 非 boolean → 丢弃
        'codex:xd:gpt-5.5': 1, // 非 boolean → 丢弃
      }),
    );
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false); // 合法 override 生效
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(false); // 无有效旧开关，不自动开启
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false); // 无有效旧开关，不自动开启
  });
});


it('restoring model visibility deletes overrides and follows future online defaults', async () => {
  const prefs = await loadModuleForOwner();
  const target = { agent: 'claude-code' as const, modelId: 'chatgpt/gpt-6' };
  prefs.setModelVisibility(target.agent, 'openai', target.modelId, true);
  expect(prefs.isModelVisibilityCustomized(target.agent, 'openai', target.modelId)).toBe(true);
  expect(prefs.resetModelVisibilities('openai', [target])).toBe(true);
  expect(prefs.isModelVisibilityCustomized(target.agent, 'openai', target.modelId)).toBe(false);
  expect(prefs.isModelEnabled(target.agent, 'openai', { id: target.modelId, defaultEnabled: false })).toBe(false);
  expect(prefs.isModelEnabled(target.agent, 'openai', { id: target.modelId, defaultEnabled: true })).toBe(true);
});


describe('compact model defaults upgrade', () => {
  const scopedKey = 'xdt:modelVisibilityPrefs:v1.owner.owner-a';
  const markerKey = 'xdt:modelVisibilityPrefs:v1.initialization.owner.owner-a';
  const provider = {
    id: 'xd', name: 'Cindy AI', connected: true, source: 'builtin',
    agents: ['claude-code', 'codex', 'pi'], auth: { method: 'token' },
    routing: {
      'claude-code': { modelPrefixes: ['chatgpt/'], wireProtocol: 'anthropic-messages' },
      codex: { wireProtocol: 'openai-responses' },
      pi: { wireProtocol: 'openai-responses' },
    },
    models: Object.fromEntries(['claude-code', 'codex', 'pi'].map((agent) => [agent,
      ['fable-5', 'fable-5-1', 'gemini'].map((id) => ({
        id: agent === 'claude-code' ? `chatgpt/${id}` : id,
        name: id, contextWindow: 200000, efforts: [], defaultEffort: null,
        defaultEnabled: agent === 'pi' && id !== 'fable-5',
        nativeApi: 'google-generative-ai',
      })),
    ])),
  } as unknown as ProviderView;

  async function upgrade(ownerId = 'owner-a', generation = 1, snapshot = provider) {
    const memory = await import('@/state/providerModelMemory');
    const engines = await import('@/state/modelEnginePrefs');
    const favorites = await import('@/state/modelFavorites');
    memory.setProviderModelMemoryOwner(ownerId);
    engines.setModelEnginePrefsOwner(ownerId);
    favorites.setModelFavoritesOwner(ownerId);
    const prefs = await loadModuleForOwner(ownerId, generation);
    prefs.migrateModelVisibilityDefaults(ownerId, generation, [snapshot]);
    return prefs;
  }

  it('keeps new-user defaults and does not manufacture compatibility selections', async () => {
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', provider.models['claude-code']![2]!)).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', provider.models.pi![2]!)).toBe(true);
    expect(JSON.parse(memStorage.getItem(scopedKey)!)).toEqual({});
  });

  it('preserves old on/off switches without enabling history, favorites, or new defaults', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({
      'claude-code:xd:chatgpt/fable-5': true,
      'claude-code:xd:chatgpt/fable-5-1': false,
    }));
    memStorage.setItem('xdt:providerModelMemory:v2:owner-a', JSON.stringify({
      'codex:xd': { lastModel: 'fable-5', effortByModel: {} },
    }));
    memStorage.setItem('xdt:modelEnginePrefs:v1:owner-a', JSON.stringify({ 'xd:gemini': { agent: 'cc' } }));
    const favorites = await import('@/state/modelFavorites');
    favorites.setModelFavoritesOwner('owner-a');
    favorites.addModelFavorite({ providerId: 'xd', modelId: 'fable-5', agent: 'pi' });
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5', defaultEnabled: false })).toBe(true);
    for (const agent of provider.agents) {
      for (const model of provider.models[agent]!) {
        if (agent === 'claude-code' && model.id === 'chatgpt/fable-5') continue;
        expect(prefs.isModelEnabled(agent, 'xd', { ...model, defaultEnabled: true })).toBe(false);
      }
    }
    const entries = unifiedModelEntries({ providers: [provider], isVisible: (pid, model, agent) => prefs.isModelEnabled(agent, pid, model) });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.candidates).toEqual(['claude-code']);
    expect(entries[0]!.capabilities['claude-code']?.protocolMode).toBe('compatibility');
  });

  it('does not initialize an existing owner even when its override map is empty', async () => {
    memStorage.setItem(scopedKey, '{}');
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
  });

  it('freezes a new profile initial defaults and keeps later additions off across restart', async () => {
    const prefs = await upgrade();
    const changed = {
      ...provider,
      models: { ...provider.models, pi: [
        ...provider.models.pi!.map((model) => ({ ...model, defaultEnabled: !model.defaultEnabled })),
        { ...provider.models.pi![0]!, id: 'brand-new', defaultEnabled: true },
      ] },
    };
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [changed]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelVisibilityCustomized('pi', 'xd', 'gemini')).toBe(false);
    vi.resetModules();
    const restarted = await upgrade('owner-a', 1, changed);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(true);
  });

  it('preserves manually disabled defaults and allows manually enabling a new model', async () => {
    const prefs = await upgrade();
    prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    prefs.setModelVisibility('codex', 'xd', 'brand-new', true);
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
    expect(prefs.isModelEnabled('codex', 'xd', { id: 'brand-new', defaultEnabled: false })).toBe(true);
  });

  it('Restore defaults applies only to explicitly named routes, including future online defaults', async () => {
    const prefs = await upgrade();
    prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    expect(prefs.resetModelVisibilities('xd', [{ agent: 'pi', modelId: 'gemini' }])).toBe(true);
    vi.resetModules();
    const restarted = await upgrade();
    expect(restarted.isModelVisibilityCustomized('pi', 'xd', 'gemini')).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: false })).toBe(false);
    expect(restarted.isModelEnabled('pi', 'xd', { id: 'brand-new', defaultEnabled: true })).toBe(false);
  });

  it.each(['claude-code', 'codex'] as const)('late %s routes preserve explicit switches but never auto-enable missing switches', async (agent) => {
    const wireId = agent === 'claude-code' ? 'chatgpt/fable-5' : 'fable-5';
    memStorage.setItem(scopedKey, JSON.stringify({ [`${agent}:xd:${wireId}`]: true }));
    const partial = { ...provider, models: { pi: provider.models.pi, 'claude-code': [], codex: [] } };
    await upgrade('owner-a', 1, partial);
    vi.resetModules();
    const prefs = await upgrade();
    expect(prefs.isModelEnabled(agent, 'xd', { id: wireId, defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled(agent, 'xd', { id: 'new-late-model', defaultEnabled: true })).toBe(false);
  });

  it('maps only declared same-engine switches without replacing versions or restoring a reset alias', async () => {
    memStorage.setItem(scopedKey, JSON.stringify({ 'claude-code:xd:fable-5': true }));
    const prefs = await upgrade();
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5', defaultEnabled: false })).toBe(true);
    expect(prefs.isModelEnabled('claude-code', 'xd', { id: 'chatgpt/fable-5-1', defaultEnabled: true })).toBe(false);
    expect(prefs.resetModelVisibilities('xd', [{ agent: 'claude-code', modelId: 'chatgpt/fable-5' }])).toBe(true);
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelVisibilityCustomized('claude-code', 'xd', 'chatgpt/fable-5')).toBe(false);
  });

  it('waits for legacy ownership before initialization and preserves off switches on retry', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'claude-code:xd:chatgpt/gemini': false }));
    setOwnerClaim('owner-a', 1, true, false);
    const prefs = await upgrade();
    expect(memStorage.getItem(markerKey)).toBeNull();
    setOwnerClaim('owner-a', 1);
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
    expect(memStorage.getItem(markerKey)).not.toBeNull();
  });

  it('isolates owner baselines and rejects stale owner generations', async () => {
    const first = await upgrade();
    first.setModelVisibility('pi', 'xd', 'gemini', false);
    setOwnerClaim('owner-b', 2, false, false, true);
    const prefs = await upgrade('owner-b', 2);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(true);
    const before = memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-b');
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    prefs.migrateModelVisibilityDefaults('owner-b', 1, [provider]);
    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.initialization.owner.owner-b')).toBe(before);
  });

  it.each([false, true])('retains fresh initialization through pending writes, unless legacy data exists (%s)', async (hasLegacy) => {
    if (hasLegacy) memStorage.setItem('xdt:modelVisibilityPrefs:v1', JSON.stringify({ 'pi:xd:fable-5': false }));
    setOwnerClaim('owner-a', 1, true, false);
    const prefs = await upgrade();
    prefs.setModelVisibility('pi', 'xd', 'fable-5-1', false);
    expect(memStorage.getItem(markerKey)).toBeNull();
    setOwnerClaim('owner-a', 1);
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(!hasLegacy);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'fable-5-1', defaultEnabled: true })).toBe(false);
  });

  it('retries a baseline write failure without overwriting a newer explicit off switch', async () => {
    const original = memStorage.setItem.bind(memStorage);
    const spy = vi.spyOn(memStorage, 'setItem').mockImplementation((key, value) => {
      if (key === markerKey) throw new Error('storage full');
      original(key, value);
    });
    const prefs = await upgrade();
    expect(memStorage.getItem(markerKey)).toBeNull();
    spy.mockRestore();
    prefs.setModelVisibility('pi', 'xd', 'gemini', false);
    prefs.migrateModelVisibilityDefaults('owner-a', 1, [provider]);
    expect(prefs.isModelEnabled('pi', 'xd', { id: 'gemini', defaultEnabled: true })).toBe(false);
  });
});
