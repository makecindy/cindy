// Verifies TabRegistry contract:
//  - report / release lifecycle, including replace-by-same-tabId
//  - destroyed listener self-prunes on guest crash
//  - reconcile drops stale rows only when their webContents is also dead
//  - pin set + listener firing semantics (only on transitions)
//  - getWebContentsByTabId returns null for missing / destroyed targets

import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { TabRegistry, type WebContentsLookup } from '../registry.js';

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  isDestroyed: () => boolean;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
  fireDestroyed: () => void;
}

function fakeWc(id: number): FakeWebContents {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const wc: FakeWebContents = {
    id,
    destroyed: false,
    listeners,
    isDestroyed: () => wc.destroyed,
    once: (event, cb) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    removeListener: (event, cb) => {
      const arr = listeners.get(event);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    },
    fireDestroyed: () => {
      wc.destroyed = true;
      const arr = listeners.get('destroyed') ?? [];
      for (const cb of [...arr]) cb();
    },
  };
  return wc;
}

function buildRegistry(): {
  registry: TabRegistry;
  wcMap: Map<number, FakeWebContents>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const wcMap = new Map<number, FakeWebContents>();
  const lookup: WebContentsLookup = (id) =>
    (wcMap.get(id) as unknown as WebContents | undefined) ?? null;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const registry = new TabRegistry({ lookupWebContents: lookup, logger });
  return { registry, wcMap, logger };
}

describe('TabRegistry — report / lookup / release', () => {
  it('round-trips webContents lookup by tabId', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });

    expect(registry.getWebContentsByTabId('t1')).toBe(wc as unknown as WebContents);
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.listBySession('s1')).toHaveLength(1);
    expect(registry.listBySession('s2')).toHaveLength(0);
  });

  it('onReport 在 report 落地时通知订阅者(popup 归属的事件驱动等待用)', () => {
    const { registry, wcMap } = buildRegistry();
    wcMap.set(101, fakeWc(101));
    const seen: number[] = [];
    const unsub = registry.onReport((record) => seen.push(record.webContentsId));

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    expect(seen).toEqual([101]);

    unsub();
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    expect(seen).toEqual([101]);
  });

  it('findByWebContentsId reverse-looks-up the owning tab record', () => {
    const { registry, wcMap } = buildRegistry();
    wcMap.set(101, fakeWc(101));
    wcMap.set(102, fakeWc(102));
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    registry.report({ sessionId: 's2', tabId: 't2', webContentsId: 102 });

    expect(registry.findByWebContentsId(101)).toEqual({
      sessionId: 's1',
      tabId: 't1',
      webContentsId: 101,
    });
    expect(registry.findByWebContentsId(102)?.sessionId).toBe('s2');
    expect(registry.findByWebContentsId(999)).toBeNull();

    // release 后反查同步失联 —— popup 路由不能拿到 stale 归属。
    registry.release('t1');
    expect(registry.findByWebContentsId(101)).toBeNull();
  });

  it('release drops the record and detaches the destroyed listener', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    expect(wc.listeners.get('destroyed')?.length).toBe(1);

    registry.release('t1');
    expect(registry.getWebContentsByTabId('t1')).toBeNull();
    expect(wc.listeners.get('destroyed')?.length ?? 0).toBe(0);
  });

  it('stale release (mismatched webContentsId) is ignored — host migration race', () => {
    // 宿主迁移竞态:旧 renderer 的 release(带旧 wcid)晚于新 renderer 的 report
    // 到达 —— 不能删掉新窗口刚注册的记录。
    const { registry, wcMap } = buildRegistry();
    const oldWc = fakeWc(101);
    const newWc = fakeWc(202);
    wcMap.set(101, oldWc);
    wcMap.set(202, newWc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    // 新 renderer 抢先 report 了新 webContentsId
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 202 });
    // 旧 renderer 的 stale release 姗姗来迟
    registry.release('t1', 101);

    expect(registry.getWebContentsByTabId('t1')).toBe(newWc as unknown as WebContents);
  });

  it('release with matching webContentsId drops the record', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });

    registry.release('t1', 101);
    expect(registry.getWebContentsByTabId('t1')).toBeNull();
  });

  it('release without expectedWebContentsId stays unconditional (back-compat)', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });

    registry.release('t1');
    expect(registry.getWebContentsByTabId('t1')).toBeNull();
  });

  it('reporting the same tabId with a new webContentsId detaches the old listener', () => {
    const { registry, wcMap } = buildRegistry();
    const oldWc = fakeWc(101);
    const newWc = fakeWc(202);
    wcMap.set(101, oldWc);
    wcMap.set(202, newWc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 202 });

    expect(oldWc.listeners.get('destroyed')?.length ?? 0).toBe(0);
    expect(newWc.listeners.get('destroyed')?.length).toBe(1);
    expect(registry.getWebContentsByTabId('t1')).toBe(newWc as unknown as WebContents);
  });

  it('two tabs aliased to the same webContentsId both clean up on destroy (P1-2)', () => {
    // Pathological but possible: a renderer bug reports the same wcid for
    // two different tabIds. The destroyed-listener is keyed by tabId (not
    // wcid) so each tab gets its own cleanup, and when the shared wc dies,
    // ONLY the tab whose recorded wcid still matches gets dropped.
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);

    registry.report({ sessionId: 's1', tabId: 'tabA', webContentsId: 101 });
    registry.report({ sessionId: 's1', tabId: 'tabB', webContentsId: 101 });

    // Both listeners installed — wc has two `destroyed` subscribers.
    expect(wc.listeners.get('destroyed')?.length).toBe(2);

    wc.fireDestroyed();

    // Both tabs cleaned (their recorded wcid matches the dead one).
    expect(registry.getWebContentsByTabId('tabA')).toBeNull();
    expect(registry.getWebContentsByTabId('tabB')).toBeNull();
  });

  it('destroyed listener self-prunes on guest crash', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    wc.fireDestroyed();

    expect(registry.getWebContentsByTabId('t1')).toBeNull();
    expect(registry.listAll()).toHaveLength(0);
  });

  it('getWebContentsByTabId lazily GCs a destroyed wc whose listener was missed', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    // Don't fire the destroyed event — simulate the listener missing fire.
    wc.destroyed = true;

    expect(registry.getWebContentsByTabId('t1')).toBeNull();
    expect(registry.listAll()).toHaveLength(0);
  });

  it('warns when reported webContentsId resolves to nothing', () => {
    const { registry, logger } = buildRegistry();
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 999 });

    expect(logger.warn).toHaveBeenCalledWith(
      'webContents not found at report time',
      expect.objectContaining({ tabId: 't1' }),
    );
  });
});

describe('TabRegistry — reconcile (drop-only)', () => {
  it('drops registry rows missing from liveTabIds AND whose wc is dead', () => {
    const { registry, wcMap } = buildRegistry();
    const liveWc = fakeWc(101);
    const deadWc = fakeWc(202);
    wcMap.set(101, liveWc);
    wcMap.set(202, deadWc);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    registry.report({ sessionId: 's1', tabId: 't2', webContentsId: 202 });
    deadWc.destroyed = true; // killed, listener missed

    const result = registry.reconcile(['t1']);

    expect(result.dropped).toEqual(['t2']);
    expect(registry.listAll().map((r) => r.tabId)).toEqual(['t1']);
  });

  it('keeps registry rows missing from liveTabIds whose wc is still alive (race)', () => {
    const { registry, wcMap } = buildRegistry();
    const wc1 = fakeWc(101);
    const wc2 = fakeWc(202);
    wcMap.set(101, wc1);
    wcMap.set(202, wc2);

    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    registry.report({ sessionId: 's1', tabId: 't2', webContentsId: 202 });

    // The renderer hasn't observed t2 yet (mount race), but its wc is alive —
    // keep it.
    const result = registry.reconcile(['t1']);

    expect(result.dropped).toEqual([]);
    expect(registry.listAll().map((r) => r.tabId).sort()).toEqual(['t1', 't2']);
  });

  it('reconcile is drop-only — unknown tabIds in liveTabIds do NOT auto-create rows', () => {
    const { registry } = buildRegistry();
    // Renderer claims t-new is alive but we never got a report — main has no
    // webContentsId for it, so nothing to upsert. Snapshot is drop-only.
    registry.reconcile(['t-new']);
    expect(registry.listAll()).toEqual([]);
  });

  it('returns the main-side pin set so renderer can mirror it post-reload', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });
    registry.pin('t1');
    registry.pin('t-detached'); // pin without a report — still surfaces

    const result = registry.reconcile(['t1']);

    expect(result.pinnedTabIds.sort()).toEqual(['t-detached', 't1']);
  });
});

describe('TabRegistry — pin set', () => {
  it('pin / unpin tracks state and fires listener on transitions only', () => {
    const { registry } = buildRegistry();
    const listener = vi.fn();
    registry.onPinChange(listener);

    expect(registry.pin('t1')).toBe(true);
    expect(registry.isPinned('t1')).toBe(true);
    expect(listener).toHaveBeenCalledWith('t1', true);

    // Same-state pin is a no-op (no listener fire).
    listener.mockClear();
    expect(registry.pin('t1')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(registry.unpin('t1')).toBe(true);
    expect(listener).toHaveBeenLastCalledWith('t1', false);

    listener.mockClear();
    expect(registry.unpin('t1')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('release of a pinned tab auto-unpins and fires the listener', () => {
    const { registry, wcMap } = buildRegistry();
    const wc = fakeWc(101);
    wcMap.set(101, wc);
    registry.report({ sessionId: 's1', tabId: 't1', webContentsId: 101 });

    const listener = vi.fn();
    registry.onPinChange(listener);
    registry.pin('t1');
    listener.mockClear();

    registry.release('t1');

    expect(registry.isPinned('t1')).toBe(false);
    expect(listener).toHaveBeenCalledWith('t1', false);
  });

  it('pin listener throw does not cascade to other listeners', () => {
    const { registry, logger } = buildRegistry();
    const good = vi.fn();
    registry.onPinChange(() => {
      throw new Error('first listener exploded');
    });
    registry.onPinChange(good);

    registry.pin('t1');

    expect(good).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('listPinned returns a snapshot of the current pin set', () => {
    const { registry } = buildRegistry();
    registry.pin('t1');
    registry.pin('t2');
    expect(registry.listPinned().sort()).toEqual(['t1', 't2']);
  });

  it('pinning an unknown tabId is permitted (intent recorded)', () => {
    const { registry } = buildRegistry();
    expect(registry.pin('unknown')).toBe(true);
    expect(registry.isPinned('unknown')).toBe(true);
  });
});
