import { describe, expect, it } from 'vitest';

import {
  mediaErrorForLog,
  mediaErrorStackForLog,
  mediaRequestParamsForLog,
  mediaRequestUrlForLog,
} from '../mediaRequestLog.js';
import { base64DecodedByteLength, normalizeBase64Payload, parseDataUrl } from '../dataUrl.js';

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

describe('data URL 结构性解析（#5081）', () => {
  it('base64 超过 2^22 字符的 data URL 仍能正确摘要', () => {
    const bytes = Buffer.alloc(3.2 * 1024 * 1024, 7);
    const encoded = bytes.toString('base64');
    expect(encoded.length).toBeGreaterThan(2 ** 22);
    expect(
      mediaRequestParamsForLog({ image: `data:image/png;base64,${encoded}` }),
    ).toEqual({ image: `[data URL mime=image/png bytes=${bytes.byteLength}]` });
  });

  it('parseDataUrl 只按前缀与首个逗号切分，MIME 小写且识别 ;base64', () => {
    expect(parseDataUrl('data:Image/PNG;charset=x;Base64,aGk=')).toEqual({
      mimeType: 'image/png',
      base64: true,
      payload: 'aGk=',
    });
    expect(parseDataUrl('data:text/plain,hi,there')).toEqual({
      mimeType: 'text/plain',
      base64: false,
      payload: 'hi,there',
    });
    expect(parseDataUrl('data:,x')).toBeNull();
    expect(parseDataUrl('http://example.test')).toBeNull();
  });

  it('normalizeBase64Payload 去掉 CR/LF 并拒绝非法字符', () => {
    expect(normalizeBase64Payload('aG\r\nk=')).toBe('aGk=');
    expect(normalizeBase64Payload('aGk=')).toBe('aGk=');
    expect(normalizeBase64Payload('aG k=')).toBeNull();
    expect(normalizeBase64Payload('aGk=<script>')).toBeNull();
  });

  it('base64DecodedByteLength 与真实解码长度一致', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 100, 1023]) {
      const encoded = Buffer.alloc(length, 1).toString('base64');
      expect(base64DecodedByteLength(encoded)).toBe(length);
      expect(base64DecodedByteLength(`${encoded.slice(0, 4)}\r\n${encoded.slice(4)}`)).toBe(length);
    }
  });

  it('mediaErrorStackForLog 输出有界、脱敏的栈摘要，无栈时返回 null', () => {
    const error = new RangeError('Maximum call stack size exceeded');
    error.stack = [
      'RangeError: Maximum call stack size exceeded',
      '    at multipartRequestBody (https://user:secret@example.test/app.js:1:1)',
      ...Array.from({ length: 20 }, (_, index) => `    at frame${index} (file.js:${index}:1)`),
    ].join('\n');
    const summary = mediaErrorStackForLog(error);
    expect(summary).toMatch(/^RangeError: at multipartRequestBody /);
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('Maximum call stack');
    expect(summary!.split(' | ')).toHaveLength(6);
    expect(mediaErrorStackForLog('plain')).toBeNull();
  });
});
