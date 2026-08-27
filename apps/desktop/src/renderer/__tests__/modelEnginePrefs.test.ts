/**
 * modelEnginePrefs.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelEnginePrefs.ts 的核心约定(统一模型选择器 M2):
 *   1. 默认空表 → 无 override ⇒ 跟随推荐(get 返回 undefined)
 *   2. set/get 往返 + 同步落盘 + 跨重启恢复
 *   3. clear = **删 key**(恢复推荐),不是写一份推荐值快照
 *   4. providerId 拒绝保留位 '*'(MODEL_PRESET_SLOT_ID),读写两侧都要防撞
 *   5. sanitize:损坏 / 非法(含已退役的 'orca')数据静默丢弃,不抛
 *   6. dataOwnerId 分区:多账号各读各的桶,不串号
 *   7. storage 事件跨窗口重读,且迟到的旧事件不回滚本窗口新值
 *   8. 落盘失败(quota / 私密窗口)静默吞,内存态仍生效
 *   9. 跨 renderer **并发**写:同步乐观写 + Web Locks 串行权威重放(2026-08-17 review H1)
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts / providerModelMemory.test.ts
 * 的最小 localStorage stub。node 的 globalThis.navigator 没有 locks,所以除并发那一组外
 * 全部走「锁不可用 → 跳过重放」的退化路径 —— 整份用例同时也是那条退化路径的回归。
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

/** `navigator.locks` 的最小串行队列 polyfill(node env 没有 Web Locks);同 modelFavorites.test。 */
class MemLockManager {
  private chains = new Map<string, Promise<void>>();
  request(name: string, cb: () => unknown): Promise<void> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const run = prev.then(
      async () => {
        await cb();
      },
      async () => {
        await cb();
      },
    );
    this.chains.set(name, run.catch(() => {}));
    return run;
  }
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
  return await import('@/state/modelEnginePrefs');
}

/**
 * 「两个 renderer + 真实 storage 事件」的最小总线:一个 window stub 收下**所有**模块实例
 * 注册的监听器,每次落盘后异步广播一条事件给全部监听器。广播刻意也送回写入方自己(真实
 * 浏览器不回送)——本窗收到自己的写入后只会多跑一轮「无差异 → 不写」的调和,顺带把
 * 「调和不会自激成写风暴」锁进用例里。
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

describe('modelEnginePrefs store', () => {
  it('默认空表:没有 override ⇒ 跟随推荐(返回 undefined)', async () => {
    const m = await loadModule();
    expect(m.getModelEngineOverride('anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(m.hasModelEngineOverride('anthropic', 'claude-opus-4-8')).toBe(false);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it('set/get 往返 + 同步落盘 + 跨重启恢复', async () => {
    const m1 = await loadModule();
    m1.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    expect(m1.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(m1.hasModelEngineOverride('xd', 'gpt-5.5')).toBe(true);
    // 同步写:调用返回时已经落盘(不能靠 debounce / 微任务)。
    expect(JSON.parse(memStorage.getItem(m1.__STORAGE_KEY) ?? '{}')).toEqual({
      'xd:gpt-5.5': { agent: 'cc' },
    });

    // 模拟 app 重启(重置模块缓存后重新从 localStorage 加载)。
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('同一模型在不同来源下互不覆盖', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    m.setModelEngineOverride('openai', 'gpt-5.5', 'codex');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(m.getModelEngineOverride('openai', 'gpt-5.5')).toBe('codex');
  });

  it('clear = 删 override(恢复推荐),不是写推荐值快照', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('anthropic', 'claude-opus-4-8', 'pi');
    m.clearModelEngineOverride('anthropic', 'claude-opus-4-8');

    expect(m.getModelEngineOverride('anthropic', 'claude-opus-4-8')).toBeUndefined();
    expect(m.hasModelEngineOverride('anthropic', 'claude-opus-4-8')).toBe(false);
    // 落盘里这条 key 必须消失 —— 留一份「等于当前推荐」的快照会让用户吃不到新版推荐。
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect('anthropic:claude-opus-4-8' in persisted).toBe(false);

    // 重启后仍是「跟随推荐」。
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getModelEngineOverride('anthropic', 'claude-opus-4-8')).toBeUndefined();
  });

  it('clear 只删目标条目,不动其它模型的 override', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    m.setModelEngineOverride('xd', 'claude-sonnet-5', 'pi');
    m.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    expect(m.getModelEngineOverride('xd', 'claude-sonnet-5')).toBe('pi');
  });

  it("providerId 保留位 '*' 读写两侧都拒绝", async () => {
    const m = await loadModule();
    m.setModelEngineOverride('*', 'gpt-5.5', 'codex');
    expect(m.getModelEngineOverride('*', 'gpt-5.5')).toBeUndefined();
    // 完全没有落盘 —— 不能在 providerModelMemory 的保留槽形状上写出一条同形垃圾。
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();

    // 真实来源写入后,'*' 依然读不出别的来源的值。
    m.setModelEngineOverride('xd', 'gpt-5.5', 'codex');
    expect(m.getModelEngineOverride('*', 'gpt-5.5')).toBeUndefined();
    m.clearModelEngineOverride('*', 'gpt-5.5');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('codex');
  });

  it('空 providerId / modelId / 未知引擎的写入被静默忽略', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('', 'gpt-5.5', 'cc');
    m.setModelEngineOverride('xd', '', 'cc');
    // 已退役的 'orca' 不是可选引擎(agentVendors.SELECTABLE_VENDORS)。
    m.setModelEngineOverride('xd', 'gpt-5.5', 'orca' as never);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  it('sanitize:损坏 / 非法条目静默丢弃,合法条目保留', async () => {
    const { __STORAGE_KEY } = await import('@/state/modelEnginePrefs');
    vi.resetModules();
    memStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({
        'xd:gpt-5.5': { agent: 'cc' },
        'xd:legacy-orca': { agent: 'orca' },
        'xd:bad-shape': 'codex',
        'xd:null-entry': null,
        'xd:no-agent': { effort: 'high' },
        '': { agent: 'cc' },
      }),
    );
    const m = await loadModule();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(m.getModelEngineOverride('xd', 'legacy-orca')).toBeUndefined();
    expect(m.getModelEngineOverride('xd', 'bad-shape')).toBeUndefined();
    expect(m.getModelEngineOverride('xd', 'null-entry')).toBeUndefined();
    expect(m.getModelEngineOverride('xd', 'no-agent')).toBeUndefined();
  });

  it('sanitize:整份 JSON 非对象 / 解析失败 → 空表,不抛', async () => {
    const { __STORAGE_KEY } = await import('@/state/modelEnginePrefs');
    vi.resetModules();
    memStorage.setItem(__STORAGE_KEY, '["not","a","map"]');
    const m1 = await loadModule();
    expect(m1.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();

    vi.resetModules();
    memStorage.setItem(__STORAGE_KEY, '{ broken json');
    const m2 = await loadModule();
    expect(m2.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  it('dataOwnerId 分区:两个账号各读各的桶', async () => {
    const m = await loadModule();
    m.setModelEnginePrefsOwner('owner-a');
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');

    m.setModelEnginePrefsOwner('owner-b');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'codex');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('codex');

    m.setModelEnginePrefsOwner('owner-a');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');

    // 落盘 key 带 owner 后缀,互不覆盖;未登录(null)用裸 key。
    expect(memStorage.keys().sort()).toEqual([
      `${m.__STORAGE_KEY}:owner-a`,
      `${m.__STORAGE_KEY}:owner-b`,
    ]);
    m.setModelEnginePrefsOwner(null);
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  it('切换 owner 通知订阅者', async () => {
    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeModelEnginePrefs(seen);
    m.setModelEnginePrefsOwner('owner-a');
    expect(seen).toHaveBeenCalledTimes(1);
    // 同一 owner 重复设置短路。
    m.setModelEnginePrefsOwner('owner-a');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('订阅者在写入时收到通知,同值写入短路', async () => {
    const m = await loadModule();
    const seen = vi.fn();
    const unsubscribe = m.subscribeModelEnginePrefs(seen);
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    expect(seen).toHaveBeenCalledTimes(1);
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    expect(seen).toHaveBeenCalledTimes(1);
    m.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(seen).toHaveBeenCalledTimes(2);
    // 无记录再 clear → 短路。
    m.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(seen).toHaveBeenCalledTimes(2);
    unsubscribe();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'pi');
    expect(seen).toHaveBeenCalledTimes(2);
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
    m.subscribeModelEnginePrefs(seen);

    // 另一个窗口写入(共享 localStorage)后事件送达。
    const serialized = JSON.stringify({ 'xd:gpt-5.5': { agent: 'pi' } });
    memStorage.setItem(m.__STORAGE_KEY, serialized);
    onStorage?.({ key: m.__STORAGE_KEY, newValue: serialized } as StorageEvent);
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('pi');
    expect(seen).toHaveBeenCalledTimes(1);

    // 迟到的旧事件:payload 是旧值,但 localStorage 里已经是新值 → 重读后无变化,不回滚。
    seen.mockClear();
    onStorage?.({
      key: m.__STORAGE_KEY,
      newValue: JSON.stringify({ 'xd:gpt-5.5': { agent: 'codex' } }),
    } as StorageEvent);
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('pi');
    expect(seen).not.toHaveBeenCalled();

    // 别的 key 的事件不理会。
    memStorage.setItem('unrelated', 'x');
    onStorage?.({ key: 'unrelated', newValue: 'x' } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
  });

  it('storage 事件按 owner 分区过滤:另一账号桶的变更不影响当前 owner', async () => {
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
    m.setModelEnginePrefsOwner('owner-a');
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const seen = vi.fn();
    m.subscribeModelEnginePrefs(seen);

    const otherKey = `${m.__STORAGE_KEY}:owner-b`;
    memStorage.setItem(otherKey, JSON.stringify({ 'xd:gpt-5.5': { agent: 'pi' } }));
    onStorage?.({ key: otherKey, newValue: memStorage.getItem(otherKey) } as StorageEvent);
    expect(seen).not.toHaveBeenCalled();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('多窗口交错写入:另一窗口的新记录不被本窗口的陈旧缓存覆盖', async () => {
    const m = await loadModule();
    // 本窗口先写一条 → 内存缓存建立。
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');

    // 另一个窗口写入共享 localStorage,**storage 事件还没送到本窗口**(异步),
    // 于是本窗口缓存此刻是陈旧的。
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        'xd:gpt-5.5': { agent: 'cc' },
        'anthropic:claude-opus-5': { agent: 'codex' },
      }),
    );

    // 本窗口继续写另一条:整表写回必须落在**新鲜基底**上,不能拿陈旧缓存覆盖。
    m.setModelEngineOverride('openai', 'gpt-5.6', 'pi');
    expect(JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}')).toEqual({
      'xd:gpt-5.5': { agent: 'cc' },
      'anthropic:claude-opus-5': { agent: 'codex' },
      'openai:gpt-5.6': { agent: 'pi' },
    });
  });

  it('多窗口交错:clear 只删点名那条,不连带抹掉另一窗口刚加的记录', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        'xd:gpt-5.5': { agent: 'cc' },
        'anthropic:claude-opus-5': { agent: 'codex' },
      }),
    );
    m.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}')).toEqual({
      'anthropic:claude-opus-5': { agent: 'codex' },
    });
  });

  it('多窗口交错:另一窗口已写成同值时,本窗口短路不再落盘(不制造回滚窗口)', async () => {
    const m = await loadModule();
    m.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        'xd:gpt-5.5': { agent: 'pi' },
        'anthropic:claude-opus-5': { agent: 'codex' },
      }),
    );
    // 本窗口要写的正是另一窗口已经写好的那个值 → 同值短路(基底是新鲜的,判等才准)。
    m.setModelEngineOverride('xd', 'gpt-5.5', 'pi');
    expect(JSON.parse(memStorage.getItem(m.__STORAGE_KEY) ?? '{}')).toEqual({
      'xd:gpt-5.5': { agent: 'pi' },
      'anthropic:claude-opus-5': { agent: 'codex' },
    });
  });

  it('落盘失败静默吞,内存态仍生效', async () => {
    const m = await loadModule();
    const setItem = vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    expect(() => m.setModelEngineOverride('xd', 'gpt-5.5', 'cc')).not.toThrow();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    setItem.mockRestore();
  });

  it('无 window(SSR / 非 renderer 环境)时读写不抛', async () => {
    vi.stubGlobal('window', undefined);
    vi.resetModules();
    const m = await loadModule();
    expect(() => m.setModelEngineOverride('xd', 'gpt-5.5', 'cc')).not.toThrow();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });
});

/**
 * 跨 renderer **并发**写(2026-08-17 review H1)—— 与 modelFavorites 同一套机制、同一组场景。
 * 「写前重读基底」只修得了「对方先写完、事件还没到」那一路;两个窗口**都在对方写回之前**
 * 读了同一份旧快照时,后写者的整表写回仍会抹掉先写者,并把对方刚删掉的 override 复活。
 */
describe('modelEnginePrefs store · 跨 renderer 并发写', () => {
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
   * 把上一步的动作推出 op-log 的**并发窗口**(细节同 modelFavorites.test 的同名说明):
   * 调和只对毫秒级的并发交错负责,「用户在另一个窗口里看见再动手」那类相反动作按用户的新
   * 动作对待,本窗不再把旧 op 断言回去。
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
    const a = await import('@/state/modelEnginePrefs');
    vi.resetModules();
    const b = await import('@/state/modelEnginePrefs');
    return { a, b };
  }

  /**
   * 让**下一次** getItem 返回 `raw`,模拟「对方还没写回时读到的旧快照」。
   * 空表必须给显式 `'{}'`:freshMap 把 `getItem === null` 解释成「storage 不可读」并退回
   * 内存缓存(私密窗口 / 写满时的既有兜底),传 null 读不出旧表。
   */
  function withStaleRead<T>(raw: string, run: () => T): T {
    const spy = vi.spyOn(memStorage, 'getItem').mockImplementationOnce(() => raw);
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  function persisted(key: string): Record<string, { agent: string }> {
    return JSON.parse(memStorage.getItem(key) ?? '{}');
  }

  it('双窗口并发写不同模型:后写者的整表覆盖被重放补回,两条都在', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    // B 在 A 写回**之前**读了空表 → 它的整表写回把 A 那条抹掉。
    withStaleRead('{}', () => b.setModelEngineOverride('anthropic', 'claude-opus-5', 'pi'));
    expect(Object.keys(persisted(key))).toEqual(['anthropic:claude-opus-5']);

    await locks.settle();
    expect(persisted(key)).toEqual({
      'xd:gpt-5.5': { agent: 'cc' },
      'anthropic:claude-opus-5': { agent: 'pi' },
    });
    expect(a.getModelEngineOverride('anthropic', 'claude-opus-5')).toBe('pi');
    expect(b.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('A 改别的模型 + B 恢复推荐交错:被删的 override 不复活', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;
    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    await locks.settle();
    const before = memStorage.getItem(key) ?? '{}';
    // 这条 override 是「上一段时间里写的」——B 的恢复推荐是用户看到它之后做的新动作,
    // 不是并发交错;A 只有这次新写的那条该被断言。
    afterConcurrencyWindow();

    // B 点了「恢复推荐」(删这条 override)。
    b.clearModelEngineOverride('xd', 'gpt-5.5');
    // A 拿**删除之前**的快照写另一条 → 同步整表写回把已删的那条带了回来。
    withStaleRead(before, () => a.setModelEngineOverride('openai', 'gpt-5.6', 'codex'));
    expect(persisted(key)['xd:gpt-5.5']).toEqual({ agent: 'cc' });

    await locks.settle();
    expect(persisted(key)).toEqual({ 'openai:gpt-5.6': { agent: 'codex' } });
    expect(a.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    expect(b.getModelEngineOverride('openai', 'gpt-5.6')).toBe('codex');
  });

  it('两个窗口改同一模型:后一次显式选择胜出,不出现「写了没生效」', async () => {
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;
    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    // B 在同一条上改成 pi,基底是 A 写回之前的空表。
    withStaleRead('{}', () => b.setModelEngineOverride('xd', 'gpt-5.5', 'pi'));
    await locks.settle();
    // A 的重放先跑(先入队),把 cc 写回;B 的重放随后把它改成自己那次显式选择 pi。
    // 同一条 key 上两次显式选择本来就要分先后 —— 重放保证的是「最后一次显式选择真的落盘」,
    // 而不是把先写者的值凭空留下。A 那边的缓存由 storage 事件拉齐(见上一组用例)。
    expect(persisted(key)).toEqual({ 'xd:gpt-5.5': { agent: 'pi' } });
    expect(b.getModelEngineOverride('xd', 'gpt-5.5')).toBe('pi');
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
    const a = await import('@/state/modelEnginePrefs');
    vi.resetModules();
    const b = await import('@/state/modelEnginePrefs');

    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const stale = memStorage.getItem(a.__STORAGE_KEY) ?? '{}';
    withStaleRead(stale, () => b.setModelEngineOverride('openai', 'gpt-5.6', 'codex'));
    await locks.settle();
    expect(a.getModelEngineOverride('openai', 'gpt-5.6')).toBe('codex');

    const seen = vi.fn();
    a.subscribeModelEnginePrefs(seen);
    onStorage?.({ key: a.__STORAGE_KEY, newValue: stale } as StorageEvent);
    expect(a.getModelEngineOverride('openai', 'gpt-5.6')).toBe('codex');
    expect(seen).not.toHaveBeenCalled();
  });

  it('navigator.locks 不可用时跳过重放,行为退回「重读基底 + 整表写回」', async () => {
    vi.stubGlobal('navigator', {});
    vi.resetModules();
    const m = await loadModule();
    expect(() => m.setModelEngineOverride('xd', 'gpt-5.5', 'cc')).not.toThrow();
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    m.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(m.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  /**
   * K1(2026-08-17 review 第四轮):调和跑起来之前用户登出 / 切号时,上一版会因为
   * 「当前 storageKey ≠ 捕获的 key」整个放弃,旧分区的并发丢写永远没人合并。
   */
  it('K1 owner 切走不放弃调和:旧分区的并发丢写照样合并', async () => {
    const { a, b } = await loadTwoWindows();
    a.setModelEnginePrefsOwner('owner-a');
    b.setModelEnginePrefsOwner('owner-a');
    const key = `${a.__STORAGE_KEY}:owner-a`;

    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    withStaleRead('{}', () => b.setModelEngineOverride('anthropic', 'claude-opus-5', 'pi'));
    // 调和还在锁队列里排着,用户就登出了。
    a.setModelEnginePrefsOwner(null);
    await settleAll();

    expect(persisted(key)).toEqual({
      'xd:gpt-5.5': { agent: 'cc' },
      'anthropic:claude-opus-5': { agent: 'pi' },
    });
    // 旧分区的内容不会被灌进当前(未登录)分区的内存态。
    expect(a.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  /**
   * K2(2026-08-17 review 第四轮):B 在**申请锁之前**就拿旧基底 persist 了,它的调和只看到
   * 自己刚覆盖出来的状态 —— 一次性重放救不回 A 的 op。现在 B 的落盘会以 storage 事件到达 A,
   * A 随即把整条 op-log 重新断言。
   */
  it('K2 锁前旧基底的迟到覆盖:事件调和把被抹掉的 override 补回,随后静默', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    // ① B 先读旧基底(空表);② A 走完同步写 + 锁内调和。
    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    await settleAll();
    // ③ B 这才 persist(基底是 ① 的旧快照)→ A 那条被整表覆盖掉。
    withStaleRead('{}', () => b.setModelEngineOverride('anthropic', 'claude-opus-5', 'pi'));
    expect(persisted(key)).toEqual({ 'anthropic:claude-opus-5': { agent: 'pi' } });

    // ④ 事件驱动的调和补回。
    await settleAll();
    expect(persisted(key)).toEqual({
      'xd:gpt-5.5': { agent: 'cc' },
      'anthropic:claude-opus-5': { agent: 'pi' },
    });
    expect(a.getModelEngineOverride('anthropic', 'claude-opus-5')).toBe('pi');
    expect(b.getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');

    // ⑤ 收敛:静默之后不再互相触发。
    const setItem = vi.spyOn(memStorage, 'setItem');
    await settleAll();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('K2 同款:恢复推荐被别窗的迟到脏写复活后,事件调和再次删掉它', async () => {
    installStorageBus();
    const { a, b } = await loadTwoWindows();
    const key = a.__STORAGE_KEY;

    a.setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    await settleAll();
    const staleBase = memStorage.getItem(key) ?? '{}';

    a.clearModelEngineOverride('xd', 'gpt-5.5');
    expect(persisted(key)).toEqual({});

    // B 拿删除之前的旧基底写另一条 → 整表写回把已删的 override 复活。
    withStaleRead(staleBase, () => b.setModelEngineOverride('openai', 'gpt-5.6', 'codex'));
    expect(persisted(key)['xd:gpt-5.5']).toEqual({ agent: 'cc' });

    await settleAll();
    expect(persisted(key)).toEqual({ 'openai:gpt-5.6': { agent: 'codex' } });
    expect(a.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    expect(b.getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });
});
