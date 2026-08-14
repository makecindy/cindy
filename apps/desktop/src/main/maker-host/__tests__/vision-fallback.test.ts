import { describe, expect, it } from 'vitest';

import { anthropicRequestBodyContainsImage } from '../vision-fallback.js';

describe('anthropicRequestBodyContainsImage', () => {
  it('ignores images attached in earlier conversation turns', () => {
    expect(anthropicRequestBodyContainsImage({
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] },
        { role: 'assistant', content: '图片已收到' },
        { role: 'user', content: '请继续总结' },
      ],
    })).toBe(false);
  });
});
