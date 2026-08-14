import { describe, expect, it } from 'vitest';

import {
  anthropicRequestBodyContainsImage,
  configuredVisionFallbackModel,
} from '../vision-fallback.js';

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

  it('keeps the vision route through tool-result-only continuations', () => {
    expect(anthropicRequestBodyContainsImage({
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
      ],
    })).toBe(true);
  });
});

describe('configuredVisionFallbackModel', () => {
  it('returns only the model explicitly configured by the user', () => {
    expect(configuredVisionFallbackModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(configuredVisionFallbackModel(null)).toBeNull();
  });
});
