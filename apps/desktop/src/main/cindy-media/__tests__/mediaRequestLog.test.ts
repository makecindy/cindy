import { describe, expect, it } from 'vitest';

import { mediaRequestParamsForLog, mediaRequestUrlForLog } from '../mediaRequestLog.js';

describe('media request log redaction', () => {
  it('保留实际 URL 并脱敏 query 凭证', () => {
    expect(
      mediaRequestUrlForLog(
        'https://user:pass@example.test/v1/images?model=gpt-image-2&api_key=secret#local',
      ),
    ).toBe(
      'https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/v1/images?model=gpt-image-2&api_key=%5BREDACTED%5D',
    );
  });

  it('保留参数结构并收敛凭证和媒体正文', () => {
    expect(
      mediaRequestParamsForLog({
        model: 'openai/gpt-image-2',
        prompt: '生成一张图',
        apiKey: 'secret',
        image: 'data:image/png;base64,aGk=',
        source: 'https://example.test/input.png?token=secret#frame',
      }),
    ).toEqual({
      model: 'openai/gpt-image-2',
      prompt: '生成一张图',
      apiKey: '[REDACTED]',
      image: '[data URL mime=image/png bytes=2]',
      source: 'https://example.test/input.png?token=%5BREDACTED%5D#frame',
    });
  });
});
