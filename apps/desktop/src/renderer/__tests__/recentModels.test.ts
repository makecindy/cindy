/**
 * recentModels.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/recentModels.ts 的核心约定(统一模型选择器「最近」视图):
 *   1. 默认空列表,不写 localStorage
 *   2. record 落盘 + usedAt 倒序 + 重复记录移到最前(时间取新)
 *   3. 去重按**副本身份**(来源 + 模型 + 引擎 + 深度 + Fast):同一模型不同配置各占一行,
 *      完全相同的副本只留一条、usedAt 取 max(时钟回拨不降级)
 *   4. 容量裁剪:只留最近 RECENT_MODELS_KEEP 条
 *   5. sanitize:非法条目丢弃、引擎非法整条丢、providerId 拒绝保留位 '*'、重复副本取最新、排序倒序
 *   6. dataOwnerId 分区隔离
 *   7. storage 事件跨窗口重读,迟到旧事件不回滚
 *   8. 落盘失败静默吞,内存态仍生效
 *
 * 项目 vitest env=node,无 window。沿用 modelFavorites.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
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
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 「另一窗口写盘 → 广播 storage 事件」的最小总线。 */
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

/** `navigator.locks` 的最小串行队列 polyfill(node env 没有 Web Locks;同 modelEnginePrefs.test)。 */
function installLocks(): void {
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, callback: () => unknown) => {
        const previous = tails.get(name) ?? Promise.resolve();
        const run = previous.then(() => callback());
        tails.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    },
  });
}

/** 等锁内调和跑完(microtask + 事件队列各让几轮)。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadModule() {
  return await import('@/state/recentModels');
}

const OPUS = { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc' } as const;
const SOL = { providerId: 'openai', modelId: 'gpt-5.6-sol', agent: 'codex' } as const;

describe('recentModels store', () => {
  it('默认空列表,不落盘', async () => {
    const m = await loadModule();
    expect(m.listRecentModels()).toEqual([]);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it('记录后倒序陈列,重复记录移到最前并更新时间', async () => {
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    m.recordRecentModel(SOL, 2000);
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual([
      'gpt-5.6-sol',
      'claude-opus-5',
    ]);

    m.recordRecentModel(OPUS, 3000);
    const items = m.listRecentModels();
    expect(items.map((item) => item.modelId)).toEqual(['claude-opus-5', 'gpt-5.6-sol']);
    expect(items[0]?.usedAt).toBe(3000);
    // 去重:同一份副本不堆第二条。
    expect(items).toHaveLength(2);
  });

  it('按副本身份去重:同一模型的不同配置各占一行', async () => {
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    m.recordRecentModel({ ...OPUS, effort: 'high' }, 2000);
    m.recordRecentModel({ ...OPUS, fast: true }, 3000);
    const items = m.listRecentModels();
    expect(items).toHaveLength(3);
    expect(items.map((item) => `${item.effort ?? '-'}${item.fast ? '+fast' : ''}`)).toEqual([
      '-+fast',
      'high',
      '-',
    ]);
    // 完全相同的副本(含 effort / fast 全同)仍然只留一条。
    m.recordRecentModel({ ...OPUS, effort: 'high' }, 4000);
    expect(m.listRecentModels()).toHaveLength(3);
    expect(m.listRecentModels()[0]).toMatchObject({ effort: 'high', usedAt: 4000 });
  });

  it('落盘内容与列表一致,可跨重启恢复(同一 key 重读)', async () => {
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) as string) as {
      items: Array<{ modelId: string; usedAt: number }>;
    };
    expect(persisted.items).toEqual([
      { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 1000 },
    ]);
    // 模拟重启:清缓存后重读同一份 localStorage。
    m.__resetForTest();
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        items: [{ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 1000 }],
      }),
    );
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual(['claude-opus-5']);
  });

  it('非法入参静默 no-op,不写脏数据', async () => {
    const m = await loadModule();
    m.recordRecentModel({ providerId: '*', modelId: 'x', agent: 'cc' }, 1);
    m.recordRecentModel({ providerId: 'anthropic', modelId: '', agent: 'cc' }, 1);
    // agent 非法 → 整条丢弃(配置副本缺引擎无法表达任何配置)。
    m.recordRecentModel({ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'nope' } as never, 1);
    m.recordRecentModel({ ...OPUS }, Number.NaN);
    expect(m.listRecentModels()).toEqual([]);
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it('时钟回拨:更旧的 usedAt 不把已有记录的时间往回拧', async () => {
    const m = await loadModule();
    m.recordRecentModel(OPUS, 5000);
    m.recordRecentModel(OPUS, 1000);
    expect(m.listRecentModels()[0]?.usedAt).toBe(5000);
  });

  it('容量裁剪:只保留最近 RECENT_MODELS_KEEP 条', async () => {
    const m = await loadModule();
    for (let i = 0; i < m.RECENT_MODELS_KEEP + 5; i += 1) {
      m.recordRecentModel({ providerId: 'anthropic', modelId: `m-${i}`, agent: 'cc' }, 1000 + i);
    }
    const items = m.listRecentModels();
    expect(items).toHaveLength(m.RECENT_MODELS_KEEP);
    // 保留的是最新的一批:队首是最后记的,队尾是第 (总数 - KEEP + 1) 条。
    expect(items[0]?.modelId).toBe(`m-${m.RECENT_MODELS_KEEP + 4}`);
    expect(items[items.length - 1]?.modelId).toBe('m-5');
  });

  it('sanitize:损坏 / 越界条目丢弃,重复副本取最新,排序倒序', async () => {
    const m = await loadModule();
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        items: [
          null,
          'nope',
          { providerId: '*', modelId: 'reserved', agent: 'cc', usedAt: 9 },
          { providerId: 'anthropic', modelId: '', agent: 'cc', usedAt: 9 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'nope', usedAt: 9 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 'oops' },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 100 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 300 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', effort: 'high', usedAt: 200 },
        ],
      }),
    );
    expect(m.listRecentModels()).toEqual([
      { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 300 },
      { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', effort: 'high', usedAt: 200 },
    ]);
  });

  it('写失败后再写成功:磁盘旧快照不能把只存在内存里的那条顶掉', async () => {
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    // 配额满:B 没落盘,只活在内存里(缓存仍更新)。
    vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    m.recordRecentModel(SOL, 2000);
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual([
      'gpt-5.6-sol',
      'claude-opus-5',
    ]);
    // 下一次成功写入的基底 = 磁盘真相 ∪ 内存态,不能只看磁盘(否则 B 被抹掉)。
    m.recordRecentModel({ providerId: 'anthropic', modelId: 'claude-sonnet-5', agent: 'cc' }, 3000);
    expect(
      m
        .listRecentModels()
        .map((item) => item.modelId)
        .sort(),
    ).toEqual(['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol']);
    const persisted = JSON.parse(memStorage.getItem(m.__STORAGE_KEY) as string) as {
      items: Array<{ modelId: string }>;
    };
    expect(persisted.items.map((item) => item.modelId).sort()).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'gpt-5.6-sol',
    ]);
  });

  it('跨窗口迟到覆盖:锁内重放 op-log 把本窗的记录重新断言(两份都留;重复调和幂等)', async () => {
    installLocks();
    installStorageBus();
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    // 别窗拿旧基底做的整表覆盖:磁盘上只剩对方那一条。
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        items: [{ providerId: 'openai', modelId: 'gpt-5.6-sol', agent: 'codex', usedAt: 2000 }],
      }),
    );
    await flushAsync();
    // 本窗的 op 被重新断言:A 回来了(按 usedAt 排在 B 后面)。
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual([
      'gpt-5.6-sol',
      'claude-opus-5',
    ]);
    // 再广播一次:无差异不写,状态收敛(不活锁)。
    const diskBefore = memStorage.getItem(m.__STORAGE_KEY);
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        items: [
          { providerId: 'openai', modelId: 'gpt-5.6-sol', agent: 'codex', usedAt: 2000 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 1000 },
        ],
      }),
    );
    await flushAsync();
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBe(diskBefore);
    expect(m.listRecentModels()).toHaveLength(2);
  });

  it('切换 owner 后旧分区仍按原 key 调和,不写进新分区', async () => {
    installLocks();
    installStorageBus();
    const m = await loadModule();
    m.setRecentModelsOwner('user-a');
    const keyA = `${m.__STORAGE_KEY}:user-a`;
    m.recordRecentModel(OPUS, 1000);
    m.setRecentModelsOwner('user-b');
    // 别窗迟到覆盖 A 分区。
    memStorage.setItem(
      keyA,
      JSON.stringify({
        items: [{ providerId: 'openai', modelId: 'gpt-5.6-sol', agent: 'codex', usedAt: 2000 }],
      }),
    );
    await flushAsync();
    const persistedA = JSON.parse(memStorage.getItem(keyA) as string) as {
      items: Array<{ modelId: string }>;
    };
    expect(persistedA.items.map((item) => item.modelId).sort()).toEqual([
      'claude-opus-5',
      'gpt-5.6-sol',
    ]);
    // B 分区不受影响,当前视图也不串数据。
    expect(memStorage.getItem(`${m.__STORAGE_KEY}:user-b`)).toBeNull();
    expect(m.listRecentModels()).toEqual([]);
  });

  it('storage 事件重读真相,且不采信迟到的旧事件', async () => {
    installStorageBus();
    const m = await loadModule();
    m.recordRecentModel(OPUS, 1000);
    // 另一窗口写入更完整的状态(真实浏览器不回送写入方,这里手动广播)。
    memStorage.setItem(
      m.__STORAGE_KEY,
      JSON.stringify({
        items: [
          { providerId: 'openai', modelId: 'gpt-5.6-sol', agent: 'codex', usedAt: 2000 },
          { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc', usedAt: 1000 },
        ],
      }),
    );
    await Promise.resolve();
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual([
      'gpt-5.6-sol',
      'claude-opus-5',
    ]);
  });

  it('落盘失败静默吞,内存态仍生效', async () => {
    const m = await loadModule();
    vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => m.recordRecentModel(OPUS, 1000)).not.toThrow();
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual(['claude-opus-5']);
  });

  it('dataOwnerId 分区隔离:切号后各读各的', async () => {
    const m = await loadModule();
    m.setRecentModelsOwner('user-a');
    m.recordRecentModel(OPUS, 1000);
    m.setRecentModelsOwner('user-b');
    expect(m.listRecentModels()).toEqual([]);
    m.recordRecentModel(SOL, 2000);
    m.setRecentModelsOwner('user-a');
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual(['claude-opus-5']);
    m.setRecentModelsOwner('user-b');
    expect(m.listRecentModels().map((item) => item.modelId)).toEqual(['gpt-5.6-sol']);
  });
});
