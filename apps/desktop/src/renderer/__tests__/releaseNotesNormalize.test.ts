/**
 * release-notes 归一化单测(更新公告 topic 格式 v2)。
 * 守住:legacy 作者分组 payload 展开为 flat items 且 topics 为空数组;
 * v2 payload 的 topics/intro 透传、缺 sections 不炸;畸形 topic 条目被丢弃
 * 而不是让弹窗崩溃。模块级缓存:每个用例 vi.resetModules() + 动态 import。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown) {
  const fetchReleaseNotes = vi.fn(async () => payload);
  vi.stubGlobal('window', { electronAPI: { fetchReleaseNotes } });
  return fetchReleaseNotes;
}

describe('release-notes normalization', () => {
  it('legacy payload:sections 按作者组展开,topics 归一为空数组', async () => {
    stubFetch({
      version: '0.1.17',
      date: '2026-07-27',
      contributors: ['Lizi'],
      sections: [
        {
          title: 'Bug Fixes',
          items: [{ name: 'Lizi', list: ['修复 A', '修复 B'] }],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.17');
    expect(notes?.sections[0]?.items).toEqual([
      { text: '修复 A', by: 'Lizi' },
      { text: '修复 B', by: 'Lizi' },
    ]);
    expect(notes?.topics).toEqual([]);
    expect(notes?.intro).toBeUndefined();
  });

  it('v2 payload:topics/intro 透传,缺 sections 归一为空数组', async () => {
    stubFetch({
      version: '0.1.18',
      date: '2026-07-28',
      contributors: ['Lizi', 'Kmny'],
      intro: '本次合并 64 个 PR。',
      topics: [
        {
          emoji: '🎙️',
          title: '语音输入更稳',
          text: '麦克风保活逻辑重写,后台麦克风不再意外残留。',
          contributors: ['Lizi'],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.18');
    expect(notes?.sections).toEqual([]);
    expect(notes?.intro).toBe('本次合并 64 个 PR。');
    expect(notes?.topics).toEqual([
      {
        emoji: '🎙️',
        title: '语音输入更稳',
        text: '麦克风保活逻辑重写,后台麦克风不再意外残留。',
        contributors: ['Lizi'],
      },
    ]);
  });

  it('畸形 topic 条目被丢弃,合法条目补默认值', async () => {
    stubFetch({
      version: '0.1.19',
      date: '2026-07-29',
      contributors: [],
      topics: [
        { title: '只有标题没有正文' },
        { title: '   ', text: '标题是纯空白' },
        { title: '正文是纯空白', text: '' },
        { emoji: 42, title: '正常主题', text: '正文。', contributors: ['A', 7, 'B'] },
        'not-an-object',
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.19');
    expect(notes?.topics).toEqual([
      { emoji: undefined, title: '正常主题', text: '正文。', contributors: ['A', 'B'] },
    ]);
  });

  it('legacy payload 的畸形 section/作者组/条目被丢弃而不是抛异常', async () => {
    stubFetch({
      version: '0.1.21',
      date: '2026-07-31',
      contributors: ['A', 42, null],
      sections: [
        { title: 'Bug Fixes' }, // 缺 items
        { items: [{ name: 'X', list: ['x'] }] }, // 缺 title
        {
          title: 'New Features',
          items: [
            { name: 'A', list: ['正常条目', 7, null] },
            { name: 'B' }, // 缺 list
            'not-a-group',
          ],
        },
      ],
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.21');
    expect(notes?.contributors).toEqual(['A']);
    expect(notes?.sections).toEqual([
      { title: 'New Features', items: [{ text: '正常条目', by: 'A' }] },
    ]);
  });

  it('无任何可渲染内容(全部 topic 畸形且无 sections)按拉取失败处理', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.20',
      date: '2026-07-30',
      contributors: ['A'],
      topics: [{ title: '只有标题', body: '字段名写错了' }],
    });
    const mod = await import('@/release-notes');
    expect(await mod.fetchReleaseNotes('0.1.20')).toBeNull();
    // 不缓存失败结果:同版本再次调用要重新发起请求,修复后的 CDN payload 可以生效。
    expect(await mod.fetchReleaseNotes('0.1.20')).toBeNull();
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(2);
  });
});
