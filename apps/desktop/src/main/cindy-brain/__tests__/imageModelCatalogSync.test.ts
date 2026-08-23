/** XD 媒体成员只由运行时 Gateway `/models` 投影，不能再回落打包目录。 */

import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';

describe('媒体模型目录来源守卫', () => {
  it('bundled XD 只保留 provider 身份，不携带图片或视频成员', () => {
    const xd = BUNDLED_CATALOG.providers.find((p) => p.id === 'xd');
    expect(xd?.imageModels).toBeUndefined();
    expect(xd?.imageDefaults).toBeUndefined();
    expect(xd?.videoModels).toBeUndefined();
    expect(xd?.videoDefaults).toBeUndefined();
  });

  it('第三方 OpenAI 的媒体目录仍保留完整 provider-aware modelId', () => {
    const openai = BUNDLED_CATALOG.providers.find((p) => p.id === 'openai');
    expect(openai?.imageModels).toEqual([
      expect.objectContaining({
        id: 'openai/gpt-image-2',
        modalities: { input: ['text', 'image'], output: ['image'] },
      }),
    ]);
  });
});
