import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en-US'],
    getLocale: () => 'en-US',
  },
}));

import {
  anthropicRequestBodyContainsImage,
  configuredVisionFallbackModel,
} from '../vision-fallback.js';
import { setMainLocale, t } from '../../i18n.js';

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

  it('detects images nested inside the latest tool result', () => {
    expect(anthropicRequestBodyContainsImage({
      messages: [
        { role: 'user', content: 'Generate a chart' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'chart', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }],
          }],
        },
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

describe('vision fallback setup reminder translations', () => {
  it.each([
    ['zh-CN', '当前模型不支持图片'],
    ['zh-TW', '目前的模型不支援圖片'],
    ['en', 'does not support images'],
    ['ja', '画像に対応していません'],
    ['ko', '이미지를 지원하지 않습니다'],
  ] as const)('provides a localized setup reminder for %s', (locale, expected) => {
    setMainLocale(locale);
    expect(t('settings.subagentModels.visionFallbackSetupReminder')).toContain(expected);
  });
});
