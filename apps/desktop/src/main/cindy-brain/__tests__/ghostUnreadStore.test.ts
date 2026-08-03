/**
 * ghostUnreadStore.test.ts — 未读账本的落盘形状归一(纯函数,不碰 electron-store)。
 * 覆盖:非法 id / 非法时刻整条丢弃、坏 summary 只丢文案不丢点、最新在前、上限截断。
 */

import { describe, expect, it } from 'vitest';

import { normalizeGhostUnreadEntries } from '../ghostUnreadStore';
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

  it('截断到上限(未读是"当前还亮着的",不是历史流水)', () => {
    const raw: Record<string, { at: number }> = {};
    for (let i = 0; i < 260; i += 1) raw[`plugin-${i}`] = { at: i + 1 };
    const entries = normalizeGhostUnreadEntries(raw);
    expect(entries).toHaveLength(200);
    expect(entries[0]).toEqual({ ghostId: 'plugin-259', at: 260 });
  });
});
