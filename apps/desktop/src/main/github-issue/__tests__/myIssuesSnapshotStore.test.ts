/**
 * 首屏快照的清洗 —— 落盘文件是**不可信输入**(可被篡改、可能是旧版本写的)。
 * 判据与 payload 解析、账本清洗刻意保持一致:这一族在 #1103 / #1224 里反复漏过。
 * 只测纯函数,不碰 electron-store。
 */

import { describe, expect, it } from 'vitest';

import type { MyIssueItem } from '../../../shared/myIssues';
import { normalizeSnapshot, normalizeSnapshotItems, __testing } from '../myIssuesSnapshotStore';

function item(over: Partial<MyIssueItem> = {}): MyIssueItem {
  const number = over.number ?? 1061;
  return {
    number,
    url: `https://github.com/makecindy/cindy/issues/${number}`,
    title: '标题',
    type: 'bug',
    state: 'open',
    createdAt: '2026-07-30T09:12:49.000Z',
    updatedAt: null,
    commentCount: null,
    sources: ['cindy-tool'],
    ...over,
  };
}

describe('normalizeSnapshotItems', () => {
  it('正常条目原样保留', () => {
    expect(normalizeSnapshotItems([item()])).toEqual([item()]);
  });

  it('链接一律按 number 派生,不采纳落盘的值', () => {
    // 快照文件可被篡改,而这一页每行都声称「这是你在本仓提的 issue」、整行点击直接
    // 交给 openExternal。派生而非校验 —— 与 #1224 确立的「url 只有一个产出方式」一致。
    const [normalized] = normalizeSnapshotItems([
      item({ number: 42, url: 'https://evil.example.com/phish' }),
    ]);
    expect(normalized.url).toBe('https://github.com/makecindy/cindy/issues/42');
  });

  it('丢掉形状不对的条目', () => {
    const dropped = [
      null,
      'nope',
      { ...item(), number: 0 },
      { ...item(), number: 1.5 },
      { ...item(), title: '' },
      // createdAt 不可解析 → 排序比较器会得到 NaN,让**整份**列表顺序未定义
      { ...item(), createdAt: 'not-a-date' },
      { ...item(), state: 'reopened' },
      // sources 全非法 ⇒ 无法标注来源,不如不显示
      { ...item(), sources: ['made-up'] },
      { ...item(), sources: [] },
    ];
    expect(normalizeSnapshotItems(dropped)).toEqual([]);
  });

  it('可选字段坏掉时降级为 null,不整条丢弃', () => {
    const [normalized] = normalizeSnapshotItems([
      item({ type: 'question' as never, updatedAt: 'nope', commentCount: 'lots' as never }),
    ]);
    expect(normalized).toMatchObject({ type: null, updatedAt: null, commentCount: null });
  });

  it('只保留合法的来源,顺序按既有约定', () => {
    const [normalized] = normalizeSnapshotItems([
      item({ sources: ['github-account', 'nonsense', 'cindy-tool'] as never }),
    ]);
    expect(normalized.sources).toEqual(['cindy-tool', 'github-account']);
  });

  it('总量压在上限内 —— 首屏只需要看得见的那一段', () => {
    const many = Array.from({ length: __testing.MAX_SNAPSHOT_ITEMS + 50 }, (_, i) =>
      item({ number: i + 1 }),
    );
    expect(normalizeSnapshotItems(many)).toHaveLength(__testing.MAX_SNAPSHOT_ITEMS);
  });

  it('非数组输入返回空列表', () => {
    expect(normalizeSnapshotItems(undefined)).toEqual([]);
    expect(normalizeSnapshotItems({ items: [] })).toEqual([]);
  });
});

describe('normalizeSnapshot', () => {
  it('完整快照原样通过', () => {
    const snapshot = {
      items: [item()],
      githubEnhancement: { login: 'octocat', source: 'ghost' as const },
      cachedAt: '2026-07-31T12:00:00.000Z',
    };
    expect(normalizeSnapshot(snapshot)).toEqual(snapshot);
  });

  it('cachedAt 缺失或不可解析时当作没有快照', () => {
    for (const bad of [undefined, '', 'yesterday', 123]) {
      expect(normalizeSnapshot({ items: [item()], cachedAt: bad })).toBeNull();
    }
  });

  it('身份形状不对时降级为 null,但条目照常保留', () => {
    const result = normalizeSnapshot({
      items: [item()],
      githubEnhancement: { login: '', source: 'ghost' },
      cachedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(result?.githubEnhancement).toBeNull();
    expect(result?.items).toHaveLength(1);

    const badSource = normalizeSnapshot({
      items: [],
      githubEnhancement: { login: 'octocat', source: 'carrier-pigeon' },
      cachedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(badSource?.githubEnhancement).toBeNull();
  });

  it('null / 非对象一律当没有快照', () => {
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot('nope')).toBeNull();
    expect(normalizeSnapshot(undefined)).toBeNull();
  });

  it('空列表的快照是合法的 —— 但它不代表「查证过没有」', () => {
    // 语义在 useMyIssues 的 hasFreshData 那一层收口:快照顶上来时不下任何结论。
    const result = normalizeSnapshot({
      items: [],
      githubEnhancement: null,
      cachedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(result).toEqual({ items: [], githubEnhancement: null, cachedAt: '2026-07-31T12:00:00.000Z' });
  });
});
