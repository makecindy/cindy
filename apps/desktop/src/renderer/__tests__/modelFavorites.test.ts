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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  /**
   * 落盘广播钩子(只有事件驱动调和那几个用例会装):把 setItem 变成一条送达所有窗口的
   * storage 事件。默认不装 = 与改动前的用例行为一致。
   */
  onWrite: ((key: string) => void) | null = null;
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
    this.onWrite?.(k);
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

/**
 * 「两个 renderer + 真实 storage 事件」的最小总线:一个 window stub 收下**所有**模块实例
 * 注册的监听器,每次落盘后异步广播一条事件给全部监听器。
 *
 * 广播刻意也送回写入方自己(真实浏览器不回送):本窗收到自己的写入后只会多跑一轮
 * 「无差异 → 不写」的调和,顺带把「调和不会自激成写风暴」也锁进用例里。
 */
function installStorageBus(): void {
  const handlers: Array<(event: StorageEvent) => void> = [];
  vi.stubGlobal('window', {
    localStorage: memStorage,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'storage' && typeof listener === 'function') {
        handlers.push(listener as (event: StorageEvent) => void);
      }
    },
    removeEventListener: vi.fn(),
  });
  memStorage.onWrite = (key: string) => {
    queueMicrotask(() => {
      for (const handler of handlers) handler({ key } as StorageEvent);
    });
  };
}

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
 * 跨 renderer **并发**写(2026-08-17 review H1 / K1 / K2)。
 *
 * 「写前重读 localStorage」只修得了「另一窗口先写完、storage 事件还没到」那一路。这里锁的是
 * 真正的交错:两个窗口**都在对方写回之前**读了同一份旧快照 —— 此时后写者的整表写回必然
 * 覆盖先写者(丢新增 / 丢编辑),删除与编辑交错时已删条目还会复活。修法是同步乐观写之后,
 * 把 op 记进会话 op-log,并在同源 Web Locks 里**把整条 log 重放**到该 key 的最新状态上;
 * storage 事件也会再次触发调和,于是「别窗用锁前旧基底做的迟到覆盖」也能被补回(K2)。
 *
 * 两个「窗口」= 同一 localStorage 上的两份模块实例(Electron 每个 renderer 有独立模块实例)。
 * 交错用「让某一次 getItem 返回旧快照」精确复现,不靠时序碰运气。
 */
describe('modelFavorites store · 跨 renderer 并发写', () => {
  let locks: MemLockManager;
  let clockOffset = 0;
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    locks = new MemLockManager();
    vi.stubGlobal('navigator', { locks });
    clockOffset = 0;
    const realNow = Date.now.bind(Date);
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
    memStorage.onWrite = null;
  });

  /**
   * 把上一步的动作推出 op-log 的**并发窗口**。
   *
   * 调和只对「并发交错」负责:别窗用旧基底做的迟到覆盖是毫秒级就落地的(那笔 setItem 早在
   * 路上)。而「用户在另一个窗口里看见这条收藏、然后把它删掉」要等事件往返 + 人的反应,
   * 量级是秒 —— 那是用户的新动作,本窗不该再把自己的旧 op 断言回去。下面几个用例演的正是
   * 后者(先在 A 里加,过一会儿在 B 里删),所以显式把时钟推过窗口。
   */
  function afterConcurrencyWindow(): void {
    clockOffset += 30_000;
  }

  /** 反复排空锁队列 + 微任务,直到事件驱动的调和自己收敛。 */
  async function settleAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await locks.settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

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
    // 这两条是「上一段时间里加的」——B 的删除是用户看到它们之后做的新动作,不是并发交错。
    afterConcurrencyWindow();

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
    // 同上:B 的删除是用户随后做的新动作(A 那条 add 早已离开并发窗口),
    // A 只有这次新增该被断言 —— 它不该顺手把 B 删掉的那条也一起断言回来。
    afterConcurrencyWindow();

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

  /**
   * K1(2026-08-17 review 第四轮):调和回调执行**前**用户登出 / 切号时,上一版会因为
   * 「当前 storageKey ≠ 捕获的 key」整个放弃 —— 旧分区的并发丢写永远没人再合并。
   * 现在调和按**捕获的 key** 自洽运行,与当前 active owner 无关。
   */
  it('K1 owner 切走不放弃调和:旧分区的并发丢写照样合并', async () => {
    const { a, b } = await loadTwoWindows();
    a.setModelFavoritesOwner('owner-a');
    b.setModelFavoritesOwner('owner-a');
    const key = `${a.__STORAGE_KEY}:owner-a`;

    a.addModelFavorite({ ...OPUS, effort: 'high' });
    // B 在 A 写回之前读了空表 → 整表写回把 A 那条抹掉。
    withStaleRead(EMPTY_RAW, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    // 调和还在锁队列里排着,用户就登出了(A 的 active 分区变成裸 key)。
    a.setModelFavoritesOwner(null);
    await settleAll();

    // 旧分区里两条都在 —— A 的收藏没有因为「它登出了」而永久丢失。
    const items = persisted(key).items;
    expect(items.map((i) => i.modelId).sort()).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    // 而且调和绝不把旧分区的内容灌进当前(未登录)分区的内存态。
    expect(a.listModelFavorites()).toEqual([]);
  });

  /**
   * K2(2026-08-17 review 第四轮):B 在**申请锁之前**就拿旧基底 persist 了 ——
   * 顺序是「B 读旧基底 → A 同步写 + 锁内调和跑完 → B 才 persist 并申请锁」,于是 B 的调和
   * 只看到自己刚覆盖出来的状态,A 的 op 一次性重放无从恢复。现在 B 的落盘会以 storage 事件
   * 到达 A,A 随即把自己的整条 op-log 重新断言到最新状态上。
   */
  it('K2 锁前旧基底的迟到覆盖:事件调和把被抹掉的 op 补回,随后静默', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    // ① B 先读旧基底(空表)——用一个只在**这一刻**生效的旧快照精确复现。
    const staleBase = EMPTY_RAW;
    // ② A 走完整条链路:同步写 + 锁内调和。
    a.addModelFavorite({ ...OPUS, effort: 'high' });
    await settleAll();
    expect(persisted(key).items).toHaveLength(1);

    // ③ B 这才 persist(基底是 ① 的旧快照)→ A 那条被整表覆盖掉。
    withStaleRead(staleBase, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    expect(persisted(key).items.map((i) => i.modelId)).toEqual(['gpt-5.5']);

    // ④ 事件驱动的调和:A 收到 B 的落盘事件 → 在锁里把自己的 op 重新断言。
    await settleAll();
    const items = persisted(key).items;
    expect(items.map((i) => i.modelId).sort()).toEqual(['claude-opus-4-8', 'gpt-5.5']);
    expect(a.listModelFavorites()).toHaveLength(2);
    expect(b.listModelFavorites()).toHaveLength(2);

    // ⑤ 收敛:静默之后不再互相触发(无差异即不写,不会自激成写风暴)。
    const setItem = vi.spyOn(memStorage, 'setItem');
    await settleAll();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('K2 同款:删除被别窗的迟到脏写复活后,事件调和再次断言删除', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    a.addModelFavorite({ ...OPUS, effort: 'high' }); // fav-1
    await settleAll();
    const staleBase = memStorage.getItem(key)!;

    // A 删掉它,并且**让提交后的那一轮调和先跑完** —— 这样后面 B 的脏写就落在「A 已经无事
    // 可做」之后,只能靠事件驱动的那一轮把删除重新断言(否则用例会被提交调和顺手做掉,
    // 测不到 K2 的闭环)。
    a.removeModelFavorite('fav-1');
    await settleAll();
    expect(persisted(key).items).toEqual([]);

    // B 拿删除**之前**的旧基底写自己的新增 → 整表写回把已删的 fav-1 复活。
    withStaleRead(staleBase, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    expect(persisted(key).items.map((i) => i.uid)).toContain('fav-1');

    await settleAll();
    // 删除也是 op:事件调和把它重新断言,复活的条目再次消失;B 的新增照样保留。
    expect(persisted(key).items.map((i) => i.modelId)).toEqual(['gpt-5.5']);
    expect(a.getModelFavorite('fav-1')).toBeUndefined();
    expect(b.getModelFavorite('fav-1')).toBeUndefined();
  });

  /**
   * 整条 op-log 的重放必须**幂等**:同一条收藏的 add + 后续 update 要折成一条「最终配置的
   * add」。不折的话,重放会在已经是新配置的状态上按旧身份再插一条 —— 用户看到同一份收藏
   * 出现两遍。
   */
  it('add + update 折叠:调和不会插出第二份副本', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    const uid = a.addModelFavorite({ ...OPUS, effort: 'high' });
    a.updateModelFavorite(uid, { effort: 'low', fast: true });
    await settleAll();

    // B 拿空表基底整表写回 → A 的这条被抹掉。
    withStaleRead(EMPTY_RAW, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    await settleAll();

    const items = persisted(key).items;
    expect(items).toHaveLength(2);
    const restored = items.find((i) => i.modelId === OPUS.modelId);
    // 补回来的是**编辑之后**那一份,而且只有一份。
    expect(restored).toMatchObject({ effort: 'low', fast: true });
  });

  /**
   * op-log 容量上限(FIFO 丢最老)。丢掉的那些 op 退回改动前的行为(不再被断言)——
   * 一次会话里对同一分区写上百次才会碰到,留下的是最近的、并发窗口还没过去的那些。
   */
  it('op-log 容量上限:超出上限后只有最近的 100 条参与调和', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    const total = 120;
    for (let i = 0; i < total; i += 1) {
      a.addModelFavorite({ providerId: 'xd', modelId: `m-${i}`, agent: 'codex' });
    }
    await settleAll();
    expect(persisted(key).items).toHaveLength(total);

    // 别的窗口拿空表整表写回,把 A 的全部条目抹掉。
    withStaleRead(EMPTY_RAW, () =>
      b.addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' }),
    );
    await settleAll();

    const restored = persisted(key)
      .items.map((i) => i.modelId)
      .filter((id) => id.startsWith('m-'));
    expect(restored).toHaveLength(100);
    expect(restored).toContain(`m-${total - 1}`);
    expect(restored).not.toContain('m-0');
    expect(restored).not.toContain('m-19');
    expect(restored).toContain('m-20');
  });
});
