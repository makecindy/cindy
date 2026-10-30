/**
 * cindyPrefsStore.test.ts — cindy 槽隐藏配置(在途并发上限)的 normalize 单测。
 * 旧 `overrides` 只为一次性迁移保留快问快答钉值;迁移读写链路见
 * pluginModelPrefsMigration.test.ts。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing } = await import('../cindyPrefsStore');

describe('normalize(坏形态清洗)', () => {
  it('整体不是对象 / 缺键 → 空表,没有 overrides 字段', () => {
    expect(__testing.normalize(null)).toEqual({ inflightLimits: {} });
    expect(__testing.normalize({})).toEqual({ inflightLimits: {} });
    expect(__testing.normalize({ overrides: 42 })).toEqual({ inflightLimits: {} });
  });

  it('inflightLimits:正整数保留,0/负数/小数/字符串/非对象全部清掉', () => {
    expect(
      __testing.normalize({
        inflightLimits: { art: 3, zero: 0, neg: -1, frac: 1.5, str: '2', nan: NaN },
      }),
    ).toEqual({ inflightLimits: { art: 3 } });
    expect(__testing.normalize({ inflightLimits: 'nope' })).toEqual({ inflightLimits: {} });
  });

  it('旧 overrides 只留快问快答钉值供迁移,媒体/向量覆盖与坏条目不再读取', () => {
    expect(
      __testing.normalize({
        overrides: {
          art: { 'image.generate': 'gpt-image-2', 'text.oneshot': 'cat:xd:codex:gpt-5.5' },
          media: { 'video.generate': 'vid-pro', 'embed.text': 'emb-1' },
          blank: { 'text.oneshot': '' },
          broken: 'not-an-object',
        },
        inflightLimits: { art: 'bad' },
      }),
    ).toEqual({
      inflightLimits: {},
      overrides: {
        art: { 'text.oneshot': 'cat:xd:codex:gpt-5.5' },
        media: {},
        blank: {},
      },
    });
  });
});
