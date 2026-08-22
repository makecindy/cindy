import { describe, expect, it } from 'vitest';

import { CURATED_MEMORY_TYPES } from '@cindy/maker-core';

import {
  BOT_MEMORY_SEED_MAX_ENTRIES,
  BOT_MEMORY_SEED_TYPES,
  normalizeBotMemorySeedEntries,
  normalizeBotMemorySeedEntry,
  selectMissingBotMemorySeedEntries,
} from '../botMemorySeed';

const valid = {
  slug: 'one-thing-per-reminder',
  type: 'reference',
  title: '一条提醒只说一件事',
  description: '提醒写短，一条只放一件事',
  body: '提醒要短。',
};

describe('bot memory seed contract', () => {
  it('mirrors the curated memory types maker-core accepts (digest is never a seed)', () => {
    expect([...BOT_MEMORY_SEED_TYPES].sort()).toEqual([...CURATED_MEMORY_TYPES].sort());
    expect(BOT_MEMORY_SEED_TYPES).not.toContain('digest');
  });

  it('normalizes a well-formed entry', () => {
    expect(normalizeBotMemorySeedEntry(valid)).toEqual(valid);
  });

  it('rejects anything the memory store would refuse rather than writing a broken shard', () => {
    expect(normalizeBotMemorySeedEntry(null)).toBeNull();
    expect(normalizeBotMemorySeedEntry([valid])).toBeNull();
    // slug 必须是 [a-z0-9_-]:中文标题当不了文件名。
    expect(normalizeBotMemorySeedEntry({ ...valid, slug: '一条提醒' })).toBeNull();
    expect(normalizeBotMemorySeedEntry({ ...valid, slug: '' })).toBeNull();
    expect(normalizeBotMemorySeedEntry({ ...valid, type: 'digest' })).toBeNull();
    expect(normalizeBotMemorySeedEntry({ ...valid, type: 'whatever' })).toBeNull();
    expect(normalizeBotMemorySeedEntry({ ...valid, title: '   ' })).toBeNull();
    expect(normalizeBotMemorySeedEntry({ ...valid, description: '' })).toBeNull();
  });

  it('flattens the description — it becomes one MEMORY.md index line', () => {
    const entry = normalizeBotMemorySeedEntry({ ...valid, description: 'a\nb   c' });
    expect(entry?.description).toBe('a b c');
  });

  it('falls back to the description when a body is missing, never writes an empty shard', () => {
    const entry = normalizeBotMemorySeedEntry({ ...valid, body: '  ' });
    expect(entry?.body).toBe(valid.description);
  });

  it('drops duplicates within one batch and caps the batch', () => {
    const many = Array.from({ length: BOT_MEMORY_SEED_MAX_ENTRIES + 4 }, (_, i) => ({
      ...valid,
      slug: `seed-${i}`,
    }));
    expect(normalizeBotMemorySeedEntries(many)).toHaveLength(BOT_MEMORY_SEED_MAX_ENTRIES);
    expect(normalizeBotMemorySeedEntries([valid, { ...valid }, { ...valid, slug: 'other' }])).toEqual(
      [valid, { ...valid, slug: 'other' }],
    );
    expect(normalizeBotMemorySeedEntries('nope')).toEqual([]);
  });

  /*
    幂等的判据是 slug,不是内容。用户把出厂那条改写成自己的说法之后,第二次落地
    (重试 / 重装 / 导入)必须原样放过它 —— 否则用户的改动会被默认值悄悄冲掉。
  */
  it('skips slugs that already exist, whatever their current content is', () => {
    const entries = normalizeBotMemorySeedEntries([valid, { ...valid, slug: 'read-back' }]);
    expect(selectMissingBotMemorySeedEntries(entries, [])).toHaveLength(2);
    expect(
      selectMissingBotMemorySeedEntries(entries, ['one-thing-per-reminder']).map((e) => e.slug),
    ).toEqual(['read-back']);
    expect(
      selectMissingBotMemorySeedEntries(entries, ['ONE-THING-PER-REMINDER', ' read-back ']),
    ).toEqual([]);
  });
});
