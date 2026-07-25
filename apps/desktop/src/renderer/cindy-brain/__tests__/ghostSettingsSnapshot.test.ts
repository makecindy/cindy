// @vitest-environment jsdom
/**
 * ghostSettingsSnapshot 单测:存取往返、损坏数据容错、体积上限与总量预算、
 * TTL 过期、孤儿清理、匹配判定(版本 / 主题 / DPR / 宽度容差)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGhostSettingsSnapshotCacheForTest,
  GHOST_SETTINGS_LAYOUT_REVISION,
  loadGhostSettingsSnapshot,
  pruneGhostSettingsSnapshots,
  saveGhostSettingsSnapshot,
  snapshotMatchesContext,
  snapshotMatchesWidth,
  SNAPSHOT_WIDTH_TOLERANCE,
  type GhostSettingsSnapshot,
} from '../ghostSettingsSnapshot';

function makeSnapshot(overrides: Partial<GhostSettingsSnapshot> = {}): GhostSettingsSnapshot {
  return {
    dataUrl: 'data:image/png;base64,abc',
    width: 1200,
    height: 240,
    dpr: 2,
    themeCss: ':root { --surface: #111; }',
    version: '1.1.1',
    layoutRevision: GHOST_SETTINGS_LAYOUT_REVISION,
    capturedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetGhostSettingsSnapshotCacheForTest();
});

describe('存取往返', () => {
  it('save 后 load 返回同一内容,且写进了 localStorage', () => {
    const snap = makeSnapshot();
    saveGhostSettingsSnapshot('g1', snap);
    __resetGhostSettingsSnapshotCacheForTest();
    expect(loadGhostSettingsSnapshot('g1')).toEqual(snap);
    expect(localStorage.getItem('ghostSettings.snapshot.g1')).toBeTruthy();
  });

  it('不同意识 id 互不串台', () => {
    saveGhostSettingsSnapshot('g1', makeSnapshot({ version: '1.0.0' }));
    saveGhostSettingsSnapshot('g2', makeSnapshot({ version: '2.0.0' }));
    expect(loadGhostSettingsSnapshot('g1')?.version).toBe('1.0.0');
    expect(loadGhostSettingsSnapshot('g2')?.version).toBe('2.0.0');
  });

  it('没有存量时返回 null', () => {
    expect(loadGhostSettingsSnapshot('nope')).toBeNull();
  });
});

describe('容错', () => {
  it('localStorage 里是坏 JSON 时按没有处理', () => {
    localStorage.setItem('ghostSettings.snapshot.g1', '{oops');
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();
  });

  it('形不对(缺字段 / 类型错 / 非图片 dataUrl)按没有处理', () => {
    localStorage.setItem(
      'ghostSettings.snapshot.g1',
      JSON.stringify({
        dataUrl: 'javascript:alert(1)',
        width: 1,
        height: 1,
        dpr: 1,
        themeCss: '',
        version: '1',
        capturedAt: Date.now(),
      }),
    );
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();
    __resetGhostSettingsSnapshotCacheForTest();
    localStorage.setItem(
      'ghostSettings.snapshot.g1',
      JSON.stringify({ ...makeSnapshot(), width: 'wide' }),
    );
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();
    __resetGhostSettingsSnapshotCacheForTest();
    // 老格式(缺 capturedAt)同样作废。
    const legacy: Partial<GhostSettingsSnapshot> = { ...makeSnapshot() };
    delete legacy.capturedAt;
    localStorage.setItem('ghostSettings.snapshot.g1', JSON.stringify(legacy));
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();

    __resetGhostSettingsSnapshotCacheForTest();
    const preLayoutRevision: Partial<GhostSettingsSnapshot> = { ...makeSnapshot() };
    delete preLayoutRevision.layoutRevision;
    localStorage.setItem('ghostSettings.snapshot.g1', JSON.stringify(preLayoutRevision));
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();
  });

  it('localStorage 写失败(配额满)时静默降级为仅内存缓存', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      const snap = makeSnapshot();
      expect(() => saveGhostSettingsSnapshot('g1', snap)).not.toThrow();
      // 本会话内存缓存仍可读。
      expect(loadGhostSettingsSnapshot('g1')).toEqual(snap);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('存储预算', () => {
  it('单条超大位图只存内存不落 localStorage,并清掉同 id 旧持久快照', () => {
    saveGhostSettingsSnapshot('g1', makeSnapshot());
    expect(localStorage.getItem('ghostSettings.snapshot.g1')).toBeTruthy();
    const snap = makeSnapshot({ dataUrl: `data:image/png;base64,${'a'.repeat(500_000)}` });
    saveGhostSettingsSnapshot('g1', snap);
    expect(localStorage.getItem('ghostSettings.snapshot.g1')).toBeNull();
    expect(loadGhostSettingsSnapshot('g1')).toEqual(snap);
  });

  it('总量超预算时按拍摄时间淘汰最旧的其它快照', () => {
    const big = (tag: string) => `data:image/png;base64,${tag.repeat(390_000)}`;
    // 5 条 ~390k 快照(总预算 2M):写第 6 条时应从最旧开始腾位。
    for (let i = 0; i < 5; i++) {
      saveGhostSettingsSnapshot(`g${i}`, makeSnapshot({ dataUrl: big('a'), capturedAt: 1000 + i }));
    }
    saveGhostSettingsSnapshot('gNew', makeSnapshot({ dataUrl: big('b'), capturedAt: 9999 }));
    // 最新的必须在;最旧的 g0(至少)被淘汰;总量回到预算内。
    expect(localStorage.getItem('ghostSettings.snapshot.gNew')).toBeTruthy();
    expect(localStorage.getItem('ghostSettings.snapshot.g0')).toBeNull();
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith('ghostSettings.snapshot.')) total += localStorage.getItem(key)!.length;
    }
    expect(total).toBeLessThanOrEqual(2_000_000);
  });

  it('TTL 过期的快照按没有处理并顺手清盘', () => {
    const stale = makeSnapshot({ capturedAt: Date.now() - 15 * 24 * 60 * 60 * 1000 });
    localStorage.setItem('ghostSettings.snapshot.g1', JSON.stringify(stale));
    expect(loadGhostSettingsSnapshot('g1')).toBeNull();
    expect(localStorage.getItem('ghostSettings.snapshot.g1')).toBeNull();
  });

  it('prune 按已装清单清孤儿(含内存缓存),在装的不动', () => {
    saveGhostSettingsSnapshot('keep', makeSnapshot());
    saveGhostSettingsSnapshot('orphan', makeSnapshot());
    pruneGhostSettingsSnapshots(['keep', 'not-yet-snapshotted']);
    expect(localStorage.getItem('ghostSettings.snapshot.keep')).toBeTruthy();
    expect(localStorage.getItem('ghostSettings.snapshot.orphan')).toBeNull();
    expect(loadGhostSettingsSnapshot('orphan')).toBeNull();
    expect(loadGhostSettingsSnapshot('keep')).toBeTruthy();
  });
});

describe('匹配判定', () => {
  const ctx = { version: '1.1.1', themeCss: ':root { --surface: #111; }', dpr: 2 };

  it('插件版本 / 宿主布局版本 / 主题 / DPR 全等才命中', () => {
    expect(snapshotMatchesContext(makeSnapshot(), ctx)).toBe(true);
    expect(snapshotMatchesContext(makeSnapshot({ version: '1.1.2' }), ctx)).toBe(false);
    expect(snapshotMatchesContext(makeSnapshot({ layoutRevision: 2 }), ctx)).toBe(false);
    expect(
      snapshotMatchesContext(makeSnapshot({ themeCss: ':root { --surface: #eee; }' }), ctx),
    ).toBe(false);
    expect(snapshotMatchesContext(makeSnapshot({ dpr: 1 }), ctx)).toBe(false);
  });

  it('宽度在容差内命中,超出作废', () => {
    const snap = makeSnapshot({ width: 1200 });
    expect(snapshotMatchesWidth(snap, 1200)).toBe(true);
    expect(snapshotMatchesWidth(snap, 1200 + SNAPSHOT_WIDTH_TOLERANCE)).toBe(true);
    expect(snapshotMatchesWidth(snap, 1200 - SNAPSHOT_WIDTH_TOLERANCE)).toBe(true);
    expect(snapshotMatchesWidth(snap, 1200 + SNAPSHOT_WIDTH_TOLERANCE + 1)).toBe(false);
  });
});
