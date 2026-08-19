/**
 * favoriteAnchorMemory.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/favoriteAnchorMemory.ts 的核心约定(统一模型选择器 §1.5,锚点从内存态改为
 * 持久化 —— Chris 2026-08-19 实测「我明明选了收藏第 3 个,打开选单默认焦点永远在下面」):
 *   1. 空表默认、同步落盘、跨重启恢复;
 *   2. 草稿槽**按引擎分**:切引擎再切回来勾的还是那一条,互不覆盖;
 *   3. 会话槽按 sessionId + **LRU 上限**:超出淘汰最久没写过的,重写把它移回队首;
 *   4. dataOwnerId 分区隔离(多账号不串号);
 *   5. storage 事件跨窗口**重读 localStorage**,不采信 event.newValue;
 *   6. sanitize:形状非法条目丢弃(引擎不认识 / 缺来源 / uid 重复),损坏 JSON 回退空表;
 *   7. 落盘失败静默吞,内存态仍生效。
 *
 * 项目 vitest env=node,无 window。沿用 modelFavorites.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

/** 两个「窗口」共享一份 localStorage,写入后广播 storage 事件给所有注册的监听器。 */
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
    for (const handler of handlers) handler({ key } as StorageEvent);
  };
}

async function loadModule() {
  return await import('@/state/favoriteAnchorMemory');
}

const SESSION_ANCHOR = {
  uid: 'fav-3',
  wireModelId: 'codex/gpt-5.5',
  engine: 'codex',
  providerId: 'xd',
} as const;

describe('favoriteAnchorMemory · 草稿槽', () => {
  it('默认空:没选过收藏时任何引擎都读不到锚点,也不落盘', async () => {
    const m = await loadModule();
    expect(m.getDraftFavoriteAnchor('cc')).toBeNull();
    expect(memStorage.getItem(m.__STORAGE_KEY)).toBeNull();
  });

  it('按引擎分槽:cc 与 codex 各记各的,互不覆盖,且同步落盘 + 跨重启恢复', async () => {
    const m1 = await loadModule();
    m1.setDraftFavoriteAnchor('cc', { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' });
    m1.setDraftFavoriteAnchor('codex', { uid: 'fav-2', wireModelId: 'codex/gpt-5.5', providerId: 'xd' });
    // 同步写:调用返回时已落盘(热更 app.exit 强退不丢)。
    expect(JSON.parse(memStorage.getItem(m1.__STORAGE_KEY) ?? 'null')).toMatchObject({
      drafts: {
        cc: { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' },
        codex: { uid: 'fav-2', wireModelId: 'codex/gpt-5.5', providerId: 'xd' },
      },
    });

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraftFavoriteAnchor('cc')).toEqual({ uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' });
    expect(m2.getDraftFavoriteAnchor('codex')).toEqual({
      uid: 'fav-2',
      wireModelId: 'codex/gpt-5.5',
      providerId: 'xd',
    });
  });

  it('写 null = 清该引擎的槽,不影响别的引擎', async () => {
    const m = await loadModule();
    m.setDraftFavoriteAnchor('cc', { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' });
    m.setDraftFavoriteAnchor('codex', { uid: 'fav-2', wireModelId: 'codex/gpt-5.5', providerId: 'xd' });
    m.setDraftFavoriteAnchor('cc', null);
    expect(m.getDraftFavoriteAnchor('cc')).toBeNull();
    expect(m.getDraftFavoriteAnchor('codex')?.uid).toBe('fav-2');
  });

  it('无变化时短路:不重复落盘、不通知订阅者', async () => {
    const m = await loadModule();
    const seen = vi.fn();
    m.subscribeFavoriteAnchorMemory(seen);
    m.setDraftFavoriteAnchor('cc', { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' });
    expect(seen).toHaveBeenCalledTimes(1);
    m.setDraftFavoriteAnchor('cc', { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' });
    expect(seen).toHaveBeenCalledTimes(1);
    m.setDraftFavoriteAnchor('pi', null);
    expect(seen).toHaveBeenCalledTimes(1);
    // 仅来源不同 = 另一份配置(2026-08-19 review P1:同 wire model 跨来源是两份副本),
    // 不算「无变化」,必须落盘。
    m.setDraftFavoriteAnchor('cc', {
      uid: 'fav-1',
      wireModelId: 'claude-opus-5',
      providerId: 'anthropic',
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(m.getDraftFavoriteAnchor('cc')?.providerId).toBe('anthropic');
  });
});

describe('favoriteAnchorMemory · 会话槽', () => {
  it('按 sessionId 存取 + 跨重启恢复;写 null = 清', async () => {
    const m1 = await loadModule();
    m1.setSessionFavoriteAnchor('s-1', { ...SESSION_ANCHOR });
    expect(m1.getSessionFavoriteAnchor('s-1')).toMatchObject(SESSION_ANCHOR);
    expect(m1.getSessionFavoriteAnchor('s-2')).toBeNull();

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getSessionFavoriteAnchor('s-1')).toMatchObject(SESSION_ANCHOR);
    m2.setSessionFavoriteAnchor('s-1', null);
    expect(m2.getSessionFavoriteAnchor('s-1')).toBeNull();
  });

  it('getSnapshot 引用稳定:没有写入时重复读返回同一个对象(useSyncExternalStore 的硬要求)', async () => {
    const m = await loadModule();
    m.setSessionFavoriteAnchor('s-1', { ...SESSION_ANCHOR });
    expect(m.getSessionFavoriteAnchor('s-1')).toBe(m.getSessionFavoriteAnchor('s-1'));
  });

  it('LRU:超出上限淘汰**最久没写过**的那条,不是最早创建的那条', async () => {
    const m = await loadModule();
    // 写满 100 条(s-0 最早)。
    for (let i = 0; i < 100; i += 1) {
      m.setSessionFavoriteAnchor(`s-${i}`, { ...SESSION_ANCHOR });
    }
    expect(m.getSessionFavoriteAnchor('s-0')).not.toBeNull();
    // 再次使用 s-0(选了另一条收藏)→ 它回到队首,下一次淘汰的应该是 s-1。
    m.setSessionFavoriteAnchor('s-0', { ...SESSION_ANCHOR, uid: 'fav-9' });
    m.setSessionFavoriteAnchor('s-100', { ...SESSION_ANCHOR });
    expect(m.getSessionFavoriteAnchor('s-0')?.uid).toBe('fav-9');
    expect(m.getSessionFavoriteAnchor('s-1')).toBeNull();
    expect(m.getSessionFavoriteAnchor('s-100')).not.toBeNull();
  });
});

describe('favoriteAnchorMemory · 分区 / 跨窗口 / 健壮性', () => {
  it('dataOwnerId 分区隔离:换账号读不到上一个账号的锚点,切回来照旧', async () => {
    const m = await loadModule();
    m.setFavoriteAnchorMemoryOwner('owner-a');
    m.setDraftFavoriteAnchor('cc', { uid: 'fav-a', wireModelId: 'model-a', providerId: 'xd' });
    m.setSessionFavoriteAnchor('s-1', { ...SESSION_ANCHOR });

    m.setFavoriteAnchorMemoryOwner('owner-b');
    expect(m.getDraftFavoriteAnchor('cc')).toBeNull();
    expect(m.getSessionFavoriteAnchor('s-1')).toBeNull();
    m.setDraftFavoriteAnchor('cc', { uid: 'fav-b', wireModelId: 'model-b', providerId: 'xd' });

    m.setFavoriteAnchorMemoryOwner('owner-a');
    expect(m.getDraftFavoriteAnchor('cc')?.uid).toBe('fav-a');
    expect(m.getSessionFavoriteAnchor('s-1')).toMatchObject(SESSION_ANCHOR);
    // 分区键真的落在不同 storage key 上(不是靠内存态糊出来的隔离)。
    expect(memStorage.keys().sort()).toEqual([
      `${m.__STORAGE_KEY}:owner-a`,
      `${m.__STORAGE_KEY}:owner-b`,
    ]);
  });

  it('storage 事件:重读 localStorage 而不是采信 event.newValue,另一个窗口的写入即时可见', async () => {
    installStorageBus();
    vi.resetModules();
    const a = await loadModule();
    vi.resetModules();
    const b = await loadModule();

    const seenByA = vi.fn();
    a.subscribeFavoriteAnchorMemory(seenByA);
    // B 窗口选了一条收藏 → A 窗口收到事件后重读,拿到的是真相而不是事件里的值。
    b.setDraftFavoriteAnchor('cc', { uid: 'fav-7', wireModelId: 'claude-opus-5', providerId: 'xd' });
    expect(a.getDraftFavoriteAnchor('cc')).toEqual({ uid: 'fav-7', wireModelId: 'claude-opus-5', providerId: 'xd' });
    expect(seenByA).toHaveBeenCalled();
  });

  it('sanitize:非法条目丢弃、损坏 JSON 回退空表(丢弃 = 回落模型行,安全方向)', async () => {
    const m0 = await loadModule();
    memStorage.setItem(
      m0.__STORAGE_KEY,
      JSON.stringify({
        drafts: {
          cc: { uid: 'fav-1', wireModelId: 'ok', providerId: 'xd' },
          // 引擎不认识 → 整条丢;缺 wireModelId → 整条丢。
          orca: { uid: 'fav-2', wireModelId: 'x', providerId: 'xd' },
          codex: { uid: 'fav-3' },
          // 缺来源 → 整条丢(来源是锚点身份三元组之一,2026-08-19 review P1)。
          pi: { uid: 'fav-5', wireModelId: 'ok' },
        },
        sessions: [
          { sessionId: 's-1', uid: 'fav-1', wireModelId: 'ok', engine: 'cc', providerId: 'xd' },
          // 缺来源 / 引擎非法 / sessionId 重复 → 丢。
          { sessionId: 's-2', uid: 'fav-2', wireModelId: 'ok', engine: 'cc' },
          { sessionId: 's-3', uid: 'fav-3', wireModelId: 'ok', engine: 'nope', providerId: 'xd' },
          { sessionId: 's-1', uid: 'fav-4', wireModelId: 'ok', engine: 'cc', providerId: 'xd' },
        ],
      }),
    );
    vi.resetModules();
    const m = await loadModule();
    expect(m.getDraftFavoriteAnchor('cc')?.uid).toBe('fav-1');
    expect(m.getDraftFavoriteAnchor('codex')).toBeNull();
    expect(m.getDraftFavoriteAnchor('pi')).toBeNull();
    expect(m.getSessionFavoriteAnchor('s-1')?.uid).toBe('fav-1');
    expect(m.getSessionFavoriteAnchor('s-2')).toBeNull();
    expect(m.getSessionFavoriteAnchor('s-3')).toBeNull();

    memStorage.setItem(m.__STORAGE_KEY, '{ not json');
    vi.resetModules();
    const broken = await loadModule();
    expect(broken.getDraftFavoriteAnchor('cc')).toBeNull();
  });

  it('落盘失败静默吞,内存态仍生效(私密窗口 / localStorage 写满)', async () => {
    const m = await loadModule();
    vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() =>
      m.setDraftFavoriteAnchor('cc', { uid: 'fav-1', wireModelId: 'claude-opus-5', providerId: 'xd' }),
    ).not.toThrow();
    expect(m.getDraftFavoriteAnchor('cc')?.uid).toBe('fav-1');
  });
});
