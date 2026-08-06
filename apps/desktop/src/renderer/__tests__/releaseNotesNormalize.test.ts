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

  it('同一版本按 zh-CN/en/ja/ko 选择对应内容,raw payload 只请求一次', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.23',
      date: '2026-08-06',
      contributors: ['Lizi'],
      topics: [{ id: 'voice', title: '顶层中文', text: '兼容正文。' }],
      contentByLocale: Object.fromEntries(
        ['zh-CN', 'en', 'ja', 'ko'].map((locale) => [
          locale,
          {
            intro: `intro-${locale}`,
            topics: [{
              id: 'voice',
              emoji: '🎙️',
              title: `title-${locale}`,
              text: `text-${locale}`,
              contributors: ['Lizi'],
            }],
          },
        ]),
      ),
    });
    const mod = await import('@/release-notes');

    for (const locale of ['zh-CN', 'en', 'ja', 'ko'] as const) {
      const notes = await mod.fetchReleaseNotes('0.1.23', locale);
      expect(notes?.intro).toBe(`intro-${locale}`);
      expect(notes?.topics[0]).toMatchObject({
        id: 'voice',
        title: `title-${locale}`,
        text: `text-${locale}`,
      });
    }
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('同一版本并发选择不同语言时也只跨 IPC 请求一次 raw payload', async () => {
    let resolveRaw!: (value: unknown) => void;
    const rawPromise = new Promise<unknown>((resolve) => { resolveRaw = resolve; });
    const fetchReleaseNotes = vi.fn(() => rawPromise);
    vi.stubGlobal('window', { electronAPI: { fetchReleaseNotes } });
    const mod = await import('@/release-notes');

    const english = mod.fetchReleaseNotes('0.1.28', 'en');
    const japanese = mod.fetchReleaseNotes('0.1.28', 'ja');
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);

    resolveRaw({
      version: '0.1.28',
      date: '2026-08-06',
      contentByLocale: {
        en: { topics: [{ id: 'same', title: 'English', text: 'English text.' }] },
        ja: { topics: [{ id: 'same', title: '日本語', text: '日本語本文。' }] },
      },
    });

    await expect(english).resolves.toMatchObject({ topics: [{ title: 'English' }] });
    await expect(japanese).resolves.toMatchObject({ topics: [{ title: '日本語' }] });
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('指定语言缺失或畸形时按 en → zh-CN → 顶层旧格式回退', async () => {
    stubFetch({
      version: '0.1.24',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        'zh-CN': { topics: [{ title: '本地中文', text: 'localized-zh' }] },
        en: { topics: [{ title: 'English', text: 'localized-en' }] },
        ja: { topics: [{ title: '   ', text: '' }] },
      },
    });
    const mod = await import('@/release-notes');

    expect((await mod.fetchReleaseNotes('0.1.24', 'ja'))?.topics[0]?.text)
      .toBe('localized-en');
    expect((await mod.fetchReleaseNotes('0.1.24', 'ko'))?.topics[0]?.text)
      .toBe('localized-en');
    expect((await mod.fetchReleaseNotes('0.1.24', 'zh-CN'))?.topics[0]?.text)
      .toBe('localized-zh');
  });

  it('localized block 为 null 或非对象时按缺失处理并继续 fallback', async () => {
    const fetchReleaseNotes = stubFetch({
      version: '0.1.29',
      date: '2026-08-06',
      contentByLocale: {
        en: { topics: [{ title: 'English', text: 'localized-en' }] },
        ja: null,
        ko: 'not-an-object',
      },
    });
    const mod = await import('@/release-notes');

    expect((await mod.fetchReleaseNotes('0.1.29', 'ja'))?.topics[0]?.text)
      .toBe('localized-en');
    expect((await mod.fetchReleaseNotes('0.1.29', 'ko'))?.topics[0]?.text)
      .toBe('localized-en');
    expect(fetchReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('英文缺失时回退中文,中文 localized 缺失时直接回退顶层中文', async () => {
    stubFetch({
      version: '0.1.25',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        'zh-CN': { topics: [{ title: '本地中文', text: 'localized-zh' }] },
      },
    });
    const mod = await import('@/release-notes');

    expect((await mod.fetchReleaseNotes('0.1.25', 'ko'))?.topics[0]?.text)
      .toBe('localized-zh');

    vi.resetModules();
    stubFetch({
      version: '0.1.26',
      date: '2026-08-06',
      topics: [{ title: '顶层中文', text: 'legacy-root' }],
      contentByLocale: {
        en: { topics: [{ title: 'English', text: 'localized-en' }] },
      },
    });
    const zhMod = await import('@/release-notes');
    expect((await zhMod.fetchReleaseNotes('0.1.26', 'zh-CN'))?.topics[0]?.text)
      .toBe('legacy-root');
  });

  it('localized legacy sections 也能被选择和归一化', async () => {
    stubFetch({
      version: '0.1.27',
      date: '2026-08-06',
      contentByLocale: {
        ja: {
          sections: [{
            title: 'Bug Fixes',
            items: [{ name: 'A', list: ['修正しました'] }],
          }],
        },
      },
    });
    const mod = await import('@/release-notes');
    const notes = await mod.fetchReleaseNotes('0.1.27', 'ja');
    expect(notes?.sections).toEqual([
      { title: 'Bug Fixes', items: [{ text: '修正しました', by: 'A' }] },
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
