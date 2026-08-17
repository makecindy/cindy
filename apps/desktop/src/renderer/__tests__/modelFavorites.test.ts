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
 *  10. 跨 renderer **并发**写:同步乐观写 + Web Locks 串行权威重放(2026-08-17 review H1)
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts 的最小 localStorage stub。
 * node 的 globalThis.navigator 没有 locks,所以除并发那一组外全部走「锁不可用 → 跳过重放」
 * 的退化路径 —— 整份用例同时也是那条退化路径的回归。
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

/**
 * `navigator.locks` 的最小串行队列 polyfill(node env 没有 Web Locks)。
 * 同名锁按请求顺序排队,回调跑完才轮到下一个 —— 与浏览器的互斥语义一致,足以验证
 * 「两个窗口的重放互相排队」。
 */
class MemLockManager {
  private chains = new Map<string, Promise<void>>();
  request(name: string, cb: () => unknown): Promise<void> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const run = prev.then(async () => {
      await cb();
    }, async () => {
      await cb();
    });
    const settled = run.catch(() => {});
    this.chains.set(name, settled);
    return run;
  }
  /** 等所有排队的重放跑完(重放里可能再排队,故 drain 几轮)。 */
  async settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.all([...this.chains.values()]);
      await Promise.resolve();
    }
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

  it('多窗口交错写入:另一窗口刚加的收藏不被本窗口的陈旧缓存覆盖', async () => {
    const m = await loadModule();
    const mine = m.addModelFavorite({ ...OPUS, effort: 'high' });
    expect(mine).toBe('fav-1');

    // 另一个窗口加了一条(共享 localStorage),**storage 事件还没送到本窗口** —— 本窗口
    // 缓存此刻只有 fav-1。
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        uidSeq: 3,
        items: [
          { uid: 'fav-1', ...OPUS, effort: 'high' },
          { uid: 'fav-2', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' },
        ],
      }),
    );

    // 本窗口继续加第三条:必须落在新鲜基底上 —— 两笔都在,且 uid 单调不复用 fav-2。
    const later = m.addModelFavorite({ ...OPUS, effort: 'low' });
    expect(later).toBe('fav-3');
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}');
    expect(persisted.items.map((i: { uid: string }) => i.uid)).toEqual([
      'fav-1',
      'fav-2',
      'fav-3',
    ]);
    expect(persisted.uidSeq).toBe(4);
  });

  it('多窗口交错:去重按新鲜基底判(另一窗口已存的同配置不再堆一条)', async () => {
    const m = await loadModule();
    m.addModelFavorite({ ...OPUS, effort: 'high' });
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        uidSeq: 3,
        items: [
          { uid: 'fav-1', ...OPUS, effort: 'high' },
          { uid: 'fav-2', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' },
        ],
      }),
    );
    // 与另一窗口那条完全相同的配置 → 复用它的 uid,不新建。
    expect(m.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' })).toBe(
      'fav-2',
    );
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}');
    expect(persisted.items).toHaveLength(2);
  });

  it('多窗口交错:删除 / 编辑不抹掉另一窗口刚加的条目', async () => {
    const m = await loadModule();
    m.addModelFavorite({ ...OPUS, effort: 'high' });
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        uidSeq: 3,
        items: [
          { uid: 'fav-1', ...OPUS, effort: 'high' },
          { uid: 'fav-2', providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' },
        ],
      }),
    );
    m.updateModelFavorite('fav-1', { effort: 'low' });
    let persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}');
    expect(persisted.items).toHaveLength(2);
    expect(persisted.items[0].effort).toBe('low');

    m.removeModelFavorite('fav-1');
    persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}');
    expect(persisted.items.map((i: { uid: string }) => i.uid)).toEqual(['fav-2']);
  });

  it('多窗口交错:另一窗口投放的 seeded 标记不被本窗口的写入抹掉', async () => {
    const m = await loadModule();
    m.addModelFavorite({ ...OPUS });
    // 另一个窗口投放了种子收藏(它那边落下 seeded 标记),事件还没到。
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        uidSeq: 3,
        items: [
          { uid: 'fav-1', ...OPUS },
          { uid: 'fav-2', providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' },
        ],
        seeded: true,
      }),
    );
    m.addModelFavorite({ ...OPUS, effort: 'low' });
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}');
    // 标记还在 → 本窗口不会再投一遍种子(否则用户看到重复的种子收藏)。
    expect(persisted.seeded).toBe(true);
    expect(persisted.items).toHaveLength(3);
    m.seedDefaultFavorite({ providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' });
    expect(
      JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}').items,
    ).toHaveLength(3);
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

/**
 * 跨 renderer **并发**写(2026-08-17 review H1)。
 *
 * 上一轮只把写路径的基底换成「写前重读 localStorage」,那只修得了「另一窗口先写完、
 * storage 事件还没到」那一路。这里锁的是真正的交错:两个窗口**都在对方写回之前**读了同一份
 * 旧快照 —— 此时后写者的整表写回必然覆盖先写者(丢新增 / 丢编辑),删除与编辑交错时已删
 * 条目还会复活。修法是同步乐观写之后,在同源 Web Locks 里**串行重放同一个 op**。
 *
 * 两个「窗口」= 同一 localStorage 上的两份模块实例(Electron 每个 renderer 有独立模块实例)。
 * 交错用「让某一次 getItem 返回旧快照」精确复现,不靠时序碰运气。
 */
describe('modelFavorites store · 跨 renderer 并发写', () => {
  let locks: MemLockManager;

  beforeEach(() => {
    locks = new MemLockManager();
    vi.stubGlobal('navigator', { locks });
  });

  /** 两份模块实例(= 两个 renderer),共享同一个 localStorage stub。 */
  async function loadTwoWindows() {
    vi.resetModules();
    const a = await import('@/state/modelFavorites');
    vi.resetModules();
    const b = await import('@/state/modelFavorites');
    return { a, b };
  }

  /**
   * 「对方还没写回时读到的旧快照」——**空表也要给出显式序列化值**,不能传 null:
   * freshState 把 `getItem === null` 解释成「storage 不可读」并退回内存缓存(私密窗口 /
   * 写满时的既有兜底),那条路径读不出旧表。
   */
  const EMPTY_RAW = JSON.stringify({ uidSeq: 1, items: [] });

  /** 让**下一次** getItem 返回 `raw`,模拟「对方还没写回时读到的旧快照」。 */
  function withStaleRead<T>(raw: string, run: () => T): T {
    const spy = vi.spyOn(memStorage, 'getItem').mockImplementationOnce(() => raw);
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  function persisted(key: string): { uidSeq: number; items: ModelFavoriteRow[]; seeded?: true } {
    return JSON.parse(memStorage.getItem(key) ?? '{}');
  }
  interface ModelFavoriteRow {
    uid: string;
    providerId: string;
    modelId: string;
    agent: string;
    effort?: string;
    fast?: true;
  }

  it('双窗口并发新增:后写者的整表覆盖被重放补回,两条都在', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    // A 先写(此刻 storage 为空)。
    const uidA = a.addModelFavorite({ ...OPUS, effort: 'high' });
    expect(uidA).toBe('fav-1');
    // B 在 A 写回**之前**就读了快照(空表),于是它的整表写回把 A 那条抹掉 —— 这正是病灶。
    const uidB = withStaleRead(EMPTY_RAW, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    expect(uidB).toBe('fav-1');
    expect(persisted(key).items).toHaveLength(1);

    // 锁内重放:各自把自己的 op 叠在对方已落盘的结果上。
    await locks.settle();
    const items = persisted(key).items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.modelId).sort()).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    // 锚点不复用:抢到同一个 fav-1 时后重放的那条顺延到下一个空位。
    expect(new Set(items.map((i) => i.uid)).size).toBe(2);
    // 两个窗口的内存态都收敛到同一份。
    expect(a.listModelFavorites()).toHaveLength(2);
    expect(b.listModelFavorites()).toHaveLength(2);
  });

  it('A 编辑 + B 删除交错:条目最终不存在(整表写回不再让已删条目复活)', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;
    a.addModelFavorite({ ...OPUS, effort: 'high' }); // fav-1
    a.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }); // fav-2
    await locks.settle();
    const before = memStorage.getItem(key);

    // B 删掉 fav-1。
    b.removeModelFavorite('fav-1');
    // A 拿**删除之前**的快照编辑同一条 → 同步整表写回把它复活。
    withStaleRead(before!, () => a.updateModelFavorite('fav-1', { effort: 'low' }));
    expect(persisted(key).items.map((i) => i.uid)).toEqual(['fav-1', 'fav-2']);

    await locks.settle();
    // 重放:B 的 remove 施加在最新表上;A 的 update 落在「已删」状态上是 no-op。
    expect(persisted(key).items.map((i) => i.uid)).toEqual(['fav-2']);
    expect(a.getModelFavorite('fav-1')).toBeUndefined();
    expect(b.getModelFavorite('fav-1')).toBeUndefined();
  });

  it('B 删除 + A 新增交错:新增保留,删除也不被顶回来', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;
    a.addModelFavorite({ ...OPUS, effort: 'high' }); // fav-1
    await locks.settle();
    const before = memStorage.getItem(key);

    b.removeModelFavorite('fav-1');
    withStaleRead(before!, () =>
      a.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    await locks.settle();

    const items = persisted(key).items;
    expect(items.map((i) => i.modelId)).toEqual(['gpt-5.5']);
    expect(a.listModelFavorites().map((item) => item.modelId)).toEqual(['gpt-5.5']);
    expect(b.listModelFavorites().map((item) => item.modelId)).toEqual(['gpt-5.5']);
  });

  it('种子收藏并发:标记只落一次,另一窗口同时新增的收藏不被吞', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    // B 先加了一条用户收藏,A 同时(拿空表快照)投放种子。
    const uidB = b.addModelFavorite({ ...OPUS });
    withStaleRead(EMPTY_RAW, () =>
      a.seedDefaultFavorite({ providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' }),
    );
    await locks.settle();

    const state = persisted(key);
    expect(state.seeded).toBe(true);
    expect(state.items.map((i) => i.modelId).sort()).toEqual([
      'claude-opus-4-8',
      'deepseek-v4-pro',
    ]);
    expect(b.getModelFavorite(uidB) ?? b.listModelFavorites().find((i) => i.modelId === OPUS.modelId))
      .toBeTruthy();

    // 标记已落 → 任一窗口再投都是 no-op(不出现重复种子)。
    a.seedDefaultFavorite({ providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' });
    b.seedDefaultFavorite({ providerId: 'xd', modelId: 'deepseek-v4-pro', agent: 'codex' });
    await locks.settle();
    expect(persisted(key).items).toHaveLength(2);
  });

  it('重放与 storage 事件不互相回滚:迟到的旧事件仍被重读挡下', async () => {
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
    const a = await import('@/state/modelFavorites');
    vi.resetModules();
    const b = await import('@/state/modelFavorites');

    a.addModelFavorite({ ...OPUS, effort: 'high' });
    const stale = memStorage.getItem(a.__STORAGE_KEY);
    withStaleRead(stale!, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    await locks.settle();
    expect(a.listModelFavorites()).toHaveLength(2);

    // 重放落完之后才送到的旧事件(payload 是旧值)→ 监听器重读真相,不回滚。
    const seen = vi.fn();
    a.subscribeModelFavorites(seen);
    onStorage?.({ key: a.__STORAGE_KEY, newValue: stale } as StorageEvent);
    expect(a.listModelFavorites()).toHaveLength(2);
    expect(seen).not.toHaveBeenCalled();
  });

  it('navigator.locks 不可用时跳过重放,行为退回「重读基底 + 整表写回」', async () => {
    vi.stubGlobal('navigator', {});
    vi.resetModules();
    const m = await import('@/state/modelFavorites');
    const uid = m.addModelFavorite({ ...OPUS, effort: 'high' });
    expect(uid).toBe('fav-1');
    expect(m.listModelFavorites()).toHaveLength(1);
    expect(() => m.removeModelFavorite(uid)).not.toThrow();
    expect(m.listModelFavorites()).toEqual([]);
  });
});
