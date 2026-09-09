import { describe, expect, it } from 'vitest';

import { mediaErrorForLog, mediaRequestParamsForLog, mediaRequestUrlForLog } from '../mediaRequestLog.js';

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

  it.each(['sig', 'OSSAccessKeyId'])('隐藏媒体签名参数 %s，同时保留普通参数', (key) => {
    const shown = new URL(mediaRequestUrlForLog(
      `https://example.test/media?operation=read&${key}=test-credential`,
    ));
    expect(shown.searchParams.get(key)).toBe('[REDACTED]');
    expect(shown.searchParams.get('operation')).toBe('read');
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

describe('media error log redaction', () => {
  it('preserves the failure reason while removing URLs, credentials and error payloads', () => {
    const error = Object.assign(new Error('provider initialization failed: https://user:password@example.test/private?sig=secret; api_key=test-secret'), {
      response: { body: 'private payload' },
    });
    const logged = mediaErrorForLog(error);
    expect(logged).toContain('provider initialization failed:');
    expect(logged).toContain('[REDACTED_URL]');
    expect(logged).toContain('api_key=[REDACTED]');
    expect(logged).not.toMatch(/password|example\.test|test-secret|private payload|\n +at /);
    expect(mediaErrorForLog(new Error('art: proxy.baseUrl is required'))).toBe('art: proxy.baseUrl is required');
  });

  it('bounds diagnostics and does not serialize arbitrary thrown objects', () => {
    expect(mediaErrorForLog('x'.repeat(2_000))).toHaveLength(1_000);
    expect(mediaErrorForLog({ token: 'private' })).toBe('Non-Error thrown (object)');
    expect(mediaErrorForLog('token=private')).toBe('token=[REDACTED]');
  });
});
