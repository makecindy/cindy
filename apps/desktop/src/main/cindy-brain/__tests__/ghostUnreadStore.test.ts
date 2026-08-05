/**
 * ghostUnreadStore.test.ts — 未读账本的落盘形状归一(纯函数,不碰 electron-store)。
 * 覆盖:非法 id / 非法时刻整条丢弃、坏 summary 只丢文案不丢点、最新在前、上限截断。
 */

import { describe, expect, it } from 'vitest';

import {
  applyGhostUnreadMark,
  isStaleGhostUnreadClear,
  normalizeGhostUnreadEntries,
} from '../ghostUnreadStore';
import { GHOST_BADGE_SUMMARY_MAX_CHARS } from '../../../shared/ghost';

describe('ghostUnreadStore · normalizeGhostUnreadEntries', () => {
  it('丢掉非法 id 与非法时刻,保留合法条目并按最新在前排序', () => {
    expect(
      normalizeGhostUnreadEntries({
        'cindy-github': { summary: '2 条新 PR', at: 200 },
        'bad id': { summary: 'x', at: 300 },
        'xd-mivo': { at: 100 },
        'no-time': { summary: 'x' },
        'bad-time': { at: -1 },
        'nan-time': { at: Number.NaN },
      }),
    ).toEqual([
      { ghostId: 'cindy-github', summary: '2 条新 PR', at: 200 },
      { ghostId: 'xd-mivo', at: 100 },
    ]);
  });

  it('坏 summary 只丢文案不丢点 —— 角标是"有新内容"这条事实,不该被一段坏文案连坐', () => {
    expect(
      normalizeGhostUnreadEntries({
        'a-plugin': { summary: 42, at: 10 },
        'b-plugin': { summary: 'x'.repeat(GHOST_BADGE_SUMMARY_MAX_CHARS + 1), at: 9 },
        'c-plugin': { summary: '', at: 8 },
      }),
    ).toEqual([
      { ghostId: 'a-plugin', at: 10 },
      { ghostId: 'b-plugin', at: 9 },
      { ghostId: 'c-plugin', at: 8 },
    ]);
  });

  it('非对象输入(损坏配置 / 老格式)一律降级成空,不阻断插件页首屏', () => {
    expect(normalizeGhostUnreadEntries(null)).toEqual([]);
    expect(normalizeGhostUnreadEntries(['a'])).toEqual([]);
    expect(normalizeGhostUnreadEntries('nope')).toEqual([]);
    expect(normalizeGhostUnreadEntries({ 'a-plugin': 'nope' })).toEqual([]);
  });

  it('applyGhostUnreadMark:同 id 覆盖不堆叠,最新在前', () => {
    const r = applyGhostUnreadMark(
      [
        { ghostId: 'a', summary: '旧', at: 10 },
        { ghostId: 'b', at: 20 },
      ],
      { ghostId: 'a', summary: '新', at: 30 },
    );
    expect(r.entries).toEqual([
      { ghostId: 'a', summary: '新', at: 30 },
      { ghostId: 'b', at: 20 },
    ]);
    expect(r.evicted).toEqual([]);
  });

  it('applyGhostUnreadMark:触到上限时**如实报出被挤掉的 id** —— 不报的话 renderer 会留着一颗账本里已经没有的点', () => {
    const current = Array.from({ length: 3 }, (_, i) => ({ ghostId: `p-${i}`, at: i + 1 }));
    const r = applyGhostUnreadMark(current, { ghostId: 'newcomer', at: 99 }, 3);
    expect(r.entries.map((e) => e.ghostId)).toEqual(['newcomer', 'p-2', 'p-1']);
    // 最老的那条被挤出账本,调用方必须据此补一条 unread:false 广播。
    expect(r.evicted).toEqual(['p-0']);
  });

  it('条件删除的判据:账本比"看到的那条"新时不得删', () => {
    // clearGhostUnread 的落盘那层要 electron-store,这里直接验判据本身:
    // renderer 清除请求与插件新点亮走两条独立 IPC,「新点亮先到、旧清除后到」
    // 时,无条件删会把用户还没看到的新摘要抹掉(codex review)。
    expect(isStaleGhostUnreadClear(20, 10)).toBe(true); // 账本更新 → 跳过
    expect(isStaleGhostUnreadClear(10, 10)).toBe(false); // 就是看到的那条 → 删
    expect(isStaleGhostUnreadClear(5, 10)).toBe(false); // 账本更旧 → 删
    expect(isStaleGhostUnreadClear(20, undefined)).toBe(false); // 主机侧无条件熄灭
  });

  it('截断到上限(未读是"当前还亮着的",不是历史流水)', () => {
    const raw: Record<string, { at: number }> = {};
    for (let i = 0; i < 260; i += 1) raw[`plugin-${i}`] = { at: i + 1 };
    const entries = normalizeGhostUnreadEntries(raw);
    expect(entries).toHaveLength(200);
    expect(entries[0]).toEqual({ ghostId: 'plugin-259', at: 260 });
  });
});
