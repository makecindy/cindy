/**
 * modelFavorites.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelFavorites.ts 的核心约定(统一模型选择器 M2):
 *   1. 默认空列表(不预置任何「推荐收藏」)
 *   2. add 返回独立锚点 uid + 同步落盘 + 跨重启恢复
 *   3. 去重:providerId+modelId+agent+effort+fast 全同 → 复用已有 uid;有一维不同 → 另一条副本
 *   4. update 就地改本条(effort 传 null = 清除回落推荐档),remove 按 uid 删且 uid 不复用
 *   5. sanitize:形状非法条目丢弃、uid 缺失 / 重复补齐、effort 非法只丢字段
 *   6. providerId 拒绝保留位 '*'(MODEL_PRESET_SLOT_ID)
 *   7. dataOwnerId 分区隔离
 *   8. storage 事件跨窗口重读,迟到旧事件不回滚
 *   9. 落盘失败静默吞,内存态仍生效
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts 的最小 localStorage stub。
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
  keys(): string[] {
    return Array.from(this.store.keys());
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
  return await import('@/state/modelFavorites');
}

const OPUS = { providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' } as const;

describe('modelFavorites store', () => {
  it('默认空列表,不预置任何条目', async () => {
    const m = await loadModule();
    expect(m.listModelFavorites()).toEqual([]);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it('add:返回锚点 uid + 同步落盘 + 跨重启恢复', async () => {
    const m1 = await loadModule();
    const uid = m1.addModelFavorite({ ...OPUS, effort: 'high', fast: true });
    expect(uid).toBeTruthy();
    expect(m1.listModelFavorites()).toEqual([
      { uid, providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc', effort: 'high', fast: true },
    ]);
    expect(m1.getModelFavorite(uid)?.effort).toBe('high');
    // 同步写:调用返回时已落盘。
    expect(JSON.parse(memStorage.getItem(m1.__STORAGE_KEY) ?? 'null')).toMatchObject({
      uidSeq: 2,
      items: [{ uid, effort: 'high', fast: true }],
    });

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.listModelFavorites()).toHaveLength(1);
    expect(m2.getModelFavorite(uid)).toMatchObject({ agent: 'cc', effort: 'high', fast: true });
  });

  it('add:effort / fast 缺省不写「等于默认」的快照', async () => {
    const m = await loadModule();
    const uid = m.addModelFavorite({ ...OPUS, fast: undefined as never });
    const item = m.getModelFavorite(uid);
    expect(item).toEqual({ uid, providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' });
    expect('effort' in (item ?? {})).toBe(false);
    expect('fast' in (item ?? {})).toBe(false);
  });

  it('去重:完全相同的配置复用已有 uid;任一维不同则另建副本', async () => {
    const m = await loadModule();
    const first = m.addModelFavorite({ ...OPUS, effort: 'high' });
    const same = m.addModelFavorite({ ...OPUS, effort: 'high' });
    expect(same).toBe(first);
    expect(m.listModelFavorites()).toHaveLength(1);

    // 深度不同 → 同模型的另一份副本(收藏是配置副本,不是模型星标)。
    const lower = m.addModelFavorite({ ...OPUS, effort: 'low' });
    expect(lower).not.toBe(first);
    // 引擎不同。
    const pi = m.addModelFavorite({ ...OPUS, agent: 'pi', effort: 'high' });
    // Fast 不同。
    const fast = m.addModelFavorite({ ...OPUS, effort: 'high', fast: true });
    // 「跟随推荐档」(effort 缺省)与显式 high 是两种配置。
    const inherited = m.addModelFavorite({ ...OPUS });
    expect(new Set([first, lower, pi, fast, inherited]).size).toBe(5);
    expect(m.listModelFavorites()).toHaveLength(5);
  });

  it('add:非法入参不落盘', async () => {
    const m = await loadModule();
    expect(m.addModelFavorite({ ...OPUS, providerId: '' })).toBe('');
    expect(m.addModelFavorite({ ...OPUS, modelId: '  ' })).toBe('');
    expect(m.addModelFavorite({ ...OPUS, agent: 'orca' as never })).toBe('');
    expect(m.listModelFavorites()).toEqual([]);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it("providerId 保留位 '*' 被拒绝(读写两侧)", async () => {
    const m = await loadModule();
    expect(m.addModelFavorite({ ...OPUS, providerId: '*' })).toBe('');
    expect(m.listModelFavorites()).toEqual([]);

    // 手写进 localStorage 的 '*' 条目在加载时也要被丢掉。
    vi.resetModules();
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        uidSeq: 3,
        items: [
          { uid: 'fav-1', providerId: '*', modelId: 'claude-opus-4-8', agent: 'cc' },
          { uid: 'fav-2', providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' },
        ],
      }),
    );
    const m2 = await loadModule();
    expect(m2.listModelFavorites()).toEqual([
      { uid: 'fav-2', providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' },
    ]);
  });

  it('add:effort 非法只丢该字段,条目仍建(调用层回落推荐档)', async () => {
    const m = await loadModule();
    // 显示文案 / 过期档名不得落盘(规格明写的「Maximum 混中文」教训)。
    const uid = m.addModelFavorite({ ...OPUS, effort: '最大' as never });
    expect(m.getModelFavorite(uid)).toEqual({
      uid,
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      agent: 'cc',
    });
  });

  it('update:就地改本条(引擎 / 深度 / Fast),不影响其它条目', async () => {
    const m = await loadModule();
    const a = m.addModelFavorite({ ...OPUS, effort: 'high' });
    const b = m.addModelFavorite({ ...OPUS, effort: 'low' });

    m.updateModelFavorite(a, { agent: 'pi', effort: 'max', fast: true });
    expect(m.getModelFavorite(a)).toEqual({
      uid: a,
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      agent: 'pi',
      effort: 'max',
      fast: true,
    });
    expect(m.getModelFavorite(b)).toMatchObject({ agent: 'cc', effort: 'low' });

    // effort: null = 清除(回落推荐档);fast: false = 关闭即缺省。
    m.updateModelFavorite(a, { effort: null, fast: false });
    const updated = m.getModelFavorite(a);
    expect('effort' in (updated ?? {})).toBe(false);
    expect('fast' in (updated ?? {})).toBe(false);

    // 顺序保持(收藏区按添加顺序展示)。
    expect(m.listModelFavorites().map((item) => item.uid)).toEqual([a, b]);
  });

  it('update:非法 effort 按清除处理;未知 uid / 无变化短路', async () => {
    const m = await loadModule();
    const uid = m.addModelFavorite({ ...OPUS, effort: 'high' });
    const seen = vi.fn();
    m.subscribeModelFavorites(seen);

    m.updateModelFavorite(uid, { effort: 'Maximum' as never });
    expect('effort' in (m.getModelFavorite(uid) ?? {})).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);

    // 无实际变化 → 不落盘不通知。
    m.updateModelFavorite(uid, { agent: 'cc' });
    expect(seen).toHaveBeenCalledTimes(1);
    // 未知 uid → no-op。
    m.updateModelFavorite('fav-999', { effort: 'low' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(m.listModelFavorites()).toHaveLength(1);
  });

  it('remove:按 uid 删除,uid 序号不回收', async () => {
    const m = await loadModule();
    const a = m.addModelFavorite({ ...OPUS, effort: 'high' });
    const b = m.addModelFavorite({ ...OPUS, effort: 'low' });
    m.removeModelFavorite(a);
    expect(m.listModelFavorites().map((item) => item.uid)).toEqual([b]);
    expect(m.getModelFavorite(a)).toBeUndefined();

    // 删掉后再加一条:不得复用刚释放的锚点(旧选中态 / hover 绑定会误命中)。
    const c = m.addModelFavorite({ ...OPUS, effort: 'high' });
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);

    // 未知 uid → no-op。
    const before = m.listModelFavorites();
    m.removeModelFavorite('fav-999');
    expect(m.listModelFavorites()).toBe(before);
  });

  it('sanitize:形状非法条目丢弃,合法条目保留', async () => {
    const { __STORAGE_KEY } = await loadModule();
    vi.resetModules();
    memStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({
        uidSeq: 5,
        items: [
          { uid: 'fav-1', providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' },
          null,
          'not-an-object',
          { uid: 'fav-2', providerId: 'anthropic', agent: 'cc' }, // 缺 modelId
          { uid: 'fav-3', providerId: 'xd', modelId: 'gpt-5.5', agent: 'orca' }, // 退役引擎
          { uid: 'fav-4', providerId: 'xd', modelId: 'gpt-5.5' }, // 缺 agent
          { uid: 'fav-5', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex', effort: 'super' },
        ],
      }),
    );
    const m = await loadModule();
    expect(m.listModelFavorites()).toEqual([
      { uid: 'fav-1', providerId: 'anthropic', modelId: 'claude-opus-4-8', agent: 'cc' },
      // effort 非法 → 只丢字段,条目留下。
      { uid: 'fav-5', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' },
    ]);
  });

  it('sanitize:补齐缺失 / 重复的 uid,且新 uid 不与既有锚点相撞', async () => {
    const { __STORAGE_KEY } = await loadModule();
    vi.resetModules();
    memStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({
        uidSeq: 1, // 落后于实际条目 —— 必须被抬高
        items: [
          { uid: 'fav-7', providerId: 'xd', modelId: 'a', agent: 'cc' },
          { providerId: 'xd', modelId: 'b', agent: 'cc' }, // 缺 uid
          { uid: 'fav-7', providerId: 'xd', modelId: 'c', agent: 'cc' }, // 重复 uid
          { uid: '', providerId: 'xd', modelId: 'd', agent: 'cc' }, // 空 uid
        ],
      }),
    );
    const m = await loadModule();
    const uids = m.listModelFavorites().map((item) => item.uid);
    expect(uids[0]).toBe('fav-7');
    expect(new Set(uids).size).toBe(4);
    expect(m.listModelFavorites().map((item) => item.modelId)).toEqual(['a', 'b', 'c', 'd']);

    // 补齐后新增条目继续不撞锚点。
    const next = m.addModelFavorite({ providerId: 'xd', modelId: 'e', agent: 'cc' });
    expect(uids).not.toContain(next);
  });

  it('sanitize:整份 JSON 非对象 / items 非数组 / 解析失败 → 空列表,不抛', async () => {
    const { __STORAGE_KEY } = await loadModule();

    vi.resetModules();
    memStorage.setItem(__STORAGE_KEY, '[1,2,3]');
    expect((await loadModule()).listModelFavorites()).toEqual([]);

    vi.resetModules();
    memStorage.setItem(__STORAGE_KEY, JSON.stringify({ uidSeq: 'x', items: 'nope' }));
    expect((await loadModule()).listModelFavorites()).toEqual([]);

    vi.resetModules();
    memStorage.setItem(__STORAGE_KEY, '{ broken json');
    expect((await loadModule()).listModelFavorites()).toEqual([]);
  });

  it('dataOwnerId 分区:两个账号各读各的收藏', async () => {
    const m = await loadModule();
    m.setModelFavoritesOwner('owner-a');
    const a = m.addModelFavorite({ ...OPUS, effort: 'high' });

    m.setModelFavoritesOwner('owner-b');
    expect(m.listModelFavorites()).toEqual([]);
    m.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' });
    expect(m.listModelFavorites().map((item) => item.modelId)).toEqual(['gpt-5.5']);

    m.setModelFavoritesOwner('owner-a');
    // uid 是**桶内**锚点(两个账号的第一条都叫 fav-1,互不可见,不需要全局唯一);
    // 切回来后看到的必须是本账号那条,而不是另一账号的模型。
    expect(m.listModelFavorites().map((item) => item.uid)).toEqual([a]);
    expect(m.listModelFavorites().map((item) => item.modelId)).toEqual(['claude-opus-4-8']);

    expect(memStorage.keys().sort()).toEqual([
      `${m.__STORAGE_KEY}:owner-a`,
      `${m.__STORAGE_KEY}:owner-b`,
    ]);
    // 未登录(null)用裸 key,同样是独立桶。
    m.setModelFavoritesOwner(null);
    expect(m.listModelFavorites()).toEqual([]);
  });

  it('切换 owner 通知订阅者,同一 owner 重复设置短路', async () => {
    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeModelFavorites(seen);
    m.setModelFavoritesOwner('owner-a');
    expect(seen).toHaveBeenCalledTimes(1);
    m.setModelFavoritesOwner('owner-a');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('storage 事件:重读共享真相,迟到的旧事件不回滚本窗口新值', async () => {
    let onStorage: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      localStorage: memStorage,
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'storage' && typeof listener === 'function') {
          onStorage = listener as (event: StorageEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
    vi.resetModules();

    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeModelFavorites(seen);

    const serialized = JSON.stringify({
      uidSeq: 2,
      items: [{ uid: 'fav-1', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex', effort: 'high' }],
    });
    memStorage.setItem(m.__STORAGE_KEY, serialized);
    onStorage?.({ key: m.__STORAGE_KEY, newValue: serialized } as StorageEvent);
    expect(m.listModelFavorites()).toEqual([
      { uid: 'fav-1', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex', effort: 'high' },
    ]);
    expect(seen).toHaveBeenCalledTimes(1);

    // 迟到旧事件:payload 是旧值,localStorage 已是新值 → 重读后无变化,不回滚。
    seen.mockClear();
    onStorage?.({
      key: m.__STORAGE_KEY,
      newValue: JSON.stringify({ uidSeq: 1, items: [] }),
    } as StorageEvent);
    expect(m.listModelFavorites()).toHaveLength(1);
    expect(seen).not.toHaveBeenCalled();

    // 别的 key 不理会。
    onStorage?.({ key: `${m.__STORAGE_KEY}:owner-b`, newValue: '{}' } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
  });

  it('storage 事件:seeded 单独变化也要同步(否则本窗口会重复投种子收藏)', async () => {
    let onStorage: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('window', {
      localStorage: memStorage,
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'storage' && typeof listener === 'function') {
          onStorage = listener as (event: StorageEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
    vi.resetModules();

    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeModelFavorites(seen);
    // 本窗口先有一条用户收藏(seeded 未置位)。
    m.addModelFavorite({ ...OPUS });
    seen.mockClear();

    // 另一个窗口跑了 seedDefaultFavorite 的「已有收藏 → 只落标记」分支:items / uidSeq
    // 一字未动,只多了 seeded。漏比这一位的话本窗口缓存永远停在未置位,下次自己再投一遍。
    const shared = JSON.parse(memStorage.getItem(m.__STORAGE_KEY)!) as Record<string, unknown>;
    memStorage.setItem(m.__STORAGE_KEY, JSON.stringify({ ...shared, seeded: true }));
    onStorage?.({ key: m.__STORAGE_KEY } as StorageEvent);
    expect(seen).toHaveBeenCalledTimes(1);

    m.seedDefaultFavorite({ providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' });
    expect(m.listModelFavorites().map((item) => item.modelId)).toEqual([OPUS.modelId]);
  });

  it('落盘失败静默吞,内存态仍生效', async () => {
    const m = await loadModule();
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    let uid = '';
    expect(() => {
      uid = m.addModelFavorite({ ...OPUS, effort: 'high' });
    }).not.toThrow();
    expect(m.getModelFavorite(uid)).toMatchObject({ effort: 'high' });
    setItem.mockRestore();
  });

  it('无 window(SSR / 非 renderer 环境)时读写不抛', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const m = await loadModule();
    let uid = '';
    expect(() => {
      uid = m.addModelFavorite({ ...OPUS });
    }).not.toThrow();
    expect(m.getModelFavorite(uid)).toBeDefined();
  });

  describe('seedDefaultFavorite(官方默认推荐的一次性种子收藏)', () => {
    const SEED = { providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' } as const;

    it('收藏为空且从未投放 → 投放一条,即列表首条', async () => {
      const m = await loadModule();
      m.seedDefaultFavorite({ ...SEED });
      const items = m.listModelFavorites();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject(SEED);
    });

    it('取消种子收藏后不复种(seeded 标记落盘,跨重启仍生效)', async () => {
      let m = await loadModule();
      m.seedDefaultFavorite({ ...SEED });
      const uid = m.listModelFavorites()[0]!.uid;
      m.removeModelFavorite(uid);
      // 同一进程内重投 → no-op。
      m.seedDefaultFavorite({ ...SEED });
      expect(m.listModelFavorites()).toEqual([]);
      // 模拟重启(重新加载模块,读同一 localStorage)→ 仍不复种。
      vi.resetModules();
      m = await loadModule();
      m.seedDefaultFavorite({ ...SEED });
      expect(m.listModelFavorites()).toEqual([]);
    });

    it('已有收藏的用户不投放,只落标记(不动用户整理过的列表)', async () => {
      const m = await loadModule();
      m.addModelFavorite({ ...OPUS });
      m.seedDefaultFavorite({ ...SEED });
      const items = m.listModelFavorites();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject(OPUS);
      // 用户随后清空收藏,也不再补种(标记已落)。
      m.removeModelFavorite(items[0]!.uid);
      m.seedDefaultFavorite({ ...SEED });
      expect(m.listModelFavorites()).toEqual([]);
    });

    it('后续普通增删不清 seeded 标记(add 落盘后重投仍 no-op)', async () => {
      const m = await loadModule();
      m.seedDefaultFavorite({ ...SEED });
      m.addModelFavorite({ ...OPUS });
      const seedUid = m.listModelFavorites()[0]!.uid;
      m.removeModelFavorite(seedUid);
      m.seedDefaultFavorite({ ...SEED });
      expect(m.listModelFavorites().map((item) => item.modelId)).toEqual([OPUS.modelId]);
    });

    it('非法配置 no-op 且不落标记(下次合法投放仍生效)', async () => {
      const m = await loadModule();
      m.seedDefaultFavorite({ providerId: '', modelId: 'x', agent: 'codex' });
      expect(m.listModelFavorites()).toEqual([]);
      m.seedDefaultFavorite({ ...SEED });
      expect(m.listModelFavorites()).toHaveLength(1);
    });
  });
});
