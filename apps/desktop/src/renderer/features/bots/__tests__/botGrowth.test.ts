import { describe, expect, it } from 'vitest';

import type { MemoryRecord } from '@cindy/maker-core';

import { partitionBotMemoryRecords } from '../botGrowth';
import { buildBotGrowthSettingsPath, resolveBotSettingsHighlight } from '../botSettingsNav';


describe('partitionBotMemoryRecords — 两个列表的切分', () => {
  const record = (slug: string, type = 'user'): MemoryRecord =>
    ({
      filename: `${type}_${slug}.md`,
      slug,
      frontmatter: { title: slug, description: '', type, updatedAt: '2026-01-01T00:00:00.000Z' },
      body: '',
      sizeBytes: 1,
    }) as MemoryRecord;

  it('learned- 前缀进「TA 学会的」,其余进「TA 记得的」', () => {
    const { memories, learned } = partitionBotMemoryRecords([
      record('reply-style'),
      record('learned-shrink-email', 'reference'),
      record('learned-self-check', 'reference'),
    ]);
    expect(memories.map((item) => item.slug)).toEqual(['reply-style']);
    expect(learned.map((item) => item.slug)).toEqual([
      'learned-shrink-email',
      'learned-self-check',
    ]);
  });

  it('digest 两边都不展示', () => {
    const { memories, learned } = partitionBotMemoryRecords([
      record('auto-1', 'digest'),
      record('learned-x', 'digest'),
    ]);
    expect(memories).toEqual([]);
    expect(learned).toEqual([]);
  });

  it('空输入给空列表,而不是编造条目', () => {
    expect(partitionBotMemoryRecords([])).toEqual({ memories: [], learned: [] });
  });

  /**
   * 同源判据:引擎(maker-core storage.parseFilename)对 `memory_write({type:'project',
   * name:'learned-weekly-report-shape'})` 产出的就是这条 filename / slug —— 由
   * packages/lizi-mcps/src/__tests__/botMemoryChain.test.ts 用真存储钉住。
   * 两边任一侧改了命名规则,这里和那边会同时红。
   */
  it('吃得下引擎真实产出的 filename / slug 形状', () => {
    const { memories, learned } = partitionBotMemoryRecords([
      {
        filename: 'project_learned-weekly-report-shape.md',
        slug: 'learned-weekly-report-shape',
        frontmatter: {
          title: '周报的写法',
          description: '先结论后依据,三条封顶',
          type: 'project',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
        body: '固定用「结论 / 依据 / 下一步」三段。',
        sizeBytes: 120,
      } as MemoryRecord,
      {
        filename: 'user_chris-cadence.md',
        slug: 'chris-cadence',
        frontmatter: {
          title: 'Chris 的节奏偏好',
          description: '周报只要三条',
          type: 'user',
          updatedAt: '2026-08-19T00:00:00.000Z',
        },
        body: '周报只要三条要点。',
        sizeBytes: 90,
      } as MemoryRecord,
    ]);
    expect(learned.map((item) => item.frontmatter.title)).toEqual(['周报的写法']);
    expect(memories.map((item) => item.frontmatter.title)).toEqual(['Chris 的节奏偏好']);
  });
});

describe('尾注跳转 —— 设置页高亮参数', () => {
  it('只认两个合法值,其余一律不高亮', () => {
    expect(resolveBotSettingsHighlight('memory')).toBe('memory');
    expect(resolveBotSettingsHighlight('learned')).toBe('learned');
    expect(resolveBotSettingsHighlight('who')).toBeNull();
    expect(resolveBotSettingsHighlight(null)).toBeNull();
    expect(resolveBotSettingsHighlight(undefined)).toBeNull();
    expect(resolveBotSettingsHighlight('')).toBeNull();
  });

  it('跳转路径落到成长那一段并带上要高亮的列表', () => {
    // 锚点是 `grew` 不是 `who`:两个成长列表已从「TA 是谁」搬出来独立成块,
    // 还滚到 `who` 会停在头像那一行,要看的列表在一屏之外。
    expect(buildBotGrowthSettingsPath('bot-1', 'memory')).toBe(
      '/bots/bot-1?settings=1&anchor=grew&highlight=memory',
    );
    expect(buildBotGrowthSettingsPath('bot-1', 'learned')).toBe(
      '/bots/bot-1?settings=1&anchor=grew&highlight=learned',
    );
  });

  it('botId 进 URL 前转义', () => {
    expect(buildBotGrowthSettingsPath('a/b', 'memory')).toContain('/bots/a%2Fb?');
  });
});
