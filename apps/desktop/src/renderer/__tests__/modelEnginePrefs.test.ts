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
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts / providerModelMemory.test.ts
 * 的最小 localStorage stub。
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
  return await import('@/state/modelEnginePrefs');
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
