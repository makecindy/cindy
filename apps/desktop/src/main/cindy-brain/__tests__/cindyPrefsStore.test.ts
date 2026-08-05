/**
 * cindyPrefsStore.test.ts — cindy 槽后端覆盖存储的 normalize 单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里
 * 只测纯函数 normalize(坏形态清洗),读写链路由 IPC 层与 slot 测试覆盖。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing } = await import('../cindyPrefsStore');

describe('normalize(坏形态清洗)', () => {
  it('合法覆盖保留;未知能力键、空串、非对象条目全部清掉', () => {
    expect(
      __testing.normalize({
        overrides: {
          art: { 'image.generate': 'gpt-image-2', 'image.upscale': 'x', 'image.edit': '' },
          broken: 'not-an-object',
          empty: {},
        },
      }),
    ).toEqual({ overrides: { art: { 'image.generate': 'gpt-image-2' } }, inflightLimits: {} });
  });

  it('旧 Gemini 图片 alias 映射到新 ID，保留已自定义用户的模型选择', () => {
    expect(
      __testing.normalize({
        overrides: {
          art: {
            'image.generate': 'gemini-3-pro-image-preview',
            'image.edit': 'gemini-3.1-flash-image-preview',
            'video.generate': 'gemini-3-pro-image-preview',
          },
        },
      }),
    ).toEqual({
      overrides: {
        art: {
          'image.generate': 'gemini-3-pro-image',
          'image.edit': 'gemini-3.1-flash-image',
          // 迁移只作用于图片能力，避免改写其它类别的未知值。
          'video.generate': 'gemini-3-pro-image-preview',
        },
      },
      inflightLimits: {},
    });
  });

  it('整体不是对象 / 缺 overrides → 空表', () => {
    expect(__testing.normalize(null)).toEqual({ overrides: {}, inflightLimits: {} });
    expect(__testing.normalize({ overrides: 42 })).toEqual({ overrides: {}, inflightLimits: {} });
  });

  it('inflightLimits:正整数保留,0/负数/小数/字符串/非对象全部清掉', () => {
    expect(
      __testing.normalize({
        inflightLimits: { art: 3, zero: 0, neg: -1, frac: 1.5, str: '2', nan: NaN },
      }),
    ).toEqual({ overrides: {}, inflightLimits: { art: 3 } });
    expect(__testing.normalize({ inflightLimits: 'nope' })).toEqual({ overrides: {}, inflightLimits: {} });
  });

  it('overrides 与 inflightLimits 互不影响(一边坏了另一边照常保留)', () => {
    expect(
      __testing.normalize({
        overrides: { art: { 'image.generate': 'gpt-image-2' } },
        inflightLimits: { art: 'bad' },
      }),
    ).toEqual({ overrides: { art: { 'image.generate': 'gpt-image-2' } }, inflightLimits: {} });
    expect(
      __testing.normalize({ overrides: 42, inflightLimits: { art: 2 } }),
    ).toEqual({ overrides: {}, inflightLimits: { art: 2 } });
  });
});
