/**
 * modelVisibilityPrefs.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelVisibilityPrefs.ts 的核心约定:
 *   1. 无 override → 跟随目录默认值(defaultEnabled 缺省=开 / =false 默认关 / =true 默认开)
 *   2. set override 覆盖目录默认(把默认开的关掉 / 把默认关的打开)
 *   3. set/get 往返 + owner-scoped localStorage 持久化(模拟 app 重启)
 *   4. 按 (agent, providerId, modelId) 分槽:同名模型在 cc / codex 互不覆盖
 *   5. setManyVisibility 批量(全部关 / 全部开)写显式 override
 *   6. 同值写入短路(不抛)
 *   7. 旧全局 key 只由 Main 仲裁出的首个 owner 认领,新账号默认隔离
 *   8. schema 损坏 / 脏数据 → 静默回退,跟随目录默认
 *   9. main 镜像同步异步失败时不产生未处理 rejection
 *
 * 项目 vitest env=node,无 window。沿用 providerModelMemory.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
let ownerClaim: {
  dataOwnerId: string | null;
  ownerGeneration: number;
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
): void {
  ownerClaim = {
    dataOwnerId,
    ownerGeneration,
    claimed,
    claimedByOtherOwner,
    canInitialize,
  };
}

beforeEach(() => {
  memStorage = new MemLocalStorage();
  syncModelVisibility.mockClear();
  setOwnerClaim('owner-a', 1);
  vi.stubGlobal('window', {
    localStorage: memStorage,
    electronAPI: {
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
    setModelVisibility('claude-code', 'xd', 'gpt-5.5', false); // cc 下关掉
    // codex 下不受影响,仍跟随默认(开)
    expect(isModelEnabled('claude-code', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true);
  });

  it('同一来源不同 provider 互不影响(xd vs openai)', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
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

  it('同值写入短路:不抛,值保持', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModuleForOwner();
    setModelVisibility('codex', 'openai', 'gpt-5.4', false);
    expect(() => setModelVisibility('codex', 'openai', 'gpt-5.4', false)).not.toThrow();
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
    expect(syncModelVisibility).toHaveBeenLastCalledWith('owner-b', 2, {});

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

  it('旧 key 尚未归属任何账号时继续阻止写入，避免抢占未知 owner 的迁移输入', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({ 'codex:openai:gpt-5.6': false }),
    );
    setOwnerClaim('owner-a', 1, false, false);
    const module = await loadModuleForOwner();

    module.setModelVisibility('codex', 'openai', 'gpt-5.5', false);

    expect(memStorage.getItem('xdt:modelVisibilityPrefs:v1.owner.owner-a')).toBeNull();
    expect(module.isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
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

  it('main 镜像同步异步失败时静默降级', async () => {
    syncModelVisibility.mockRejectedValueOnce(new Error('handler not registered'));

    await loadModuleForOwner();
    await Promise.resolve();

    expect(syncModelVisibility).toHaveBeenCalledWith('owner-a', 1, {});
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

  it('schema 损坏的 localStorage → 静默回退,跟随目录默认', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    const { isModelEnabled } = await loadModuleForOwner();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
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
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(true); // 脏数据丢弃 → 默认开
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true); // 脏数据丢弃 → 默认开
  });
});
