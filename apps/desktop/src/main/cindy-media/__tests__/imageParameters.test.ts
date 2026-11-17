import { describe, expect, it } from 'vitest';
import { imageParameterSchema, normalizeImageParameters } from '../imageParameters.js';

describe('image options use the selected channel and model', () => {
  // #8673 / unit: native options must survive the production normalizer used
  // at each dispatch boundary. The old tests only cover convenience fields.
  it.each(['openai', 'gemini', 'xai'] as const)('preserves unenumerated %s native options', (protocol) => {
    const nativeParameters = { seed: 0, future_option: { enabled: false, values: ['native', 1] } };
    expect(normalizeImageParameters(protocol, 'account/future-image', { nativeParameters })).toEqual({ nativeParameters });
    expect(() => normalizeImageParameters(undefined, 'legacy-image', { nativeParameters })).toThrow('not supported');
  });

  // The current media result contract delivers one final image. Opening body
  // options must not pay for a stream/batch and then silently lose its results.
  it.each([
    ['openai', { n: 2 }],
    ['openai', { stream: true }],
    ['gemini', { generationConfig: { candidateCount: 2 } }],
  ] as const)('rejects %s native options that change the single-image result protocol', (protocol, nativeParameters) => {
    expect(() => normalizeImageParameters(protocol, 'account/image', { nativeParameters })).toThrow('single');
  });

  it.each(['images', 'contents', 'image[]'])('keeps native %s on the host-managed reference path', (field) => {
    expect(() => normalizeImageParameters('openai', 'account/image', {
      nativeParameters: { [field]: ['unmanaged-reference'] },
    })).toThrow('host');
  });

  it('keeps supported large native sizes and all Sunburst quality levels', () => {
    for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        normalizeImageParameters('openai', 'account/gpt-image-2.5-sunburst', {
          size: '1760x3824',
          quality,
        }),
      ).toEqual({ size: '1760x3824', quality });
    }
    expect(normalizeImageParameters('openai', 'openai/gpt-image-2', { size: '2160x3840' })).toEqual(
      { size: '2160x3840' },
    );
  });

  it.each(['1320x2868', '16x16', '4096x4096', '512x2048', '0x1024', '1024', '999999x999999'])(
    'rejects invalid size %s before submission',
    (size) => {
      expect(() =>
        normalizeImageParameters('openai', 'openai/gpt-image-2.5-flare', { size }),
      ).toThrow();
    },
  );

  it('preserves legacy ratios and supports widescreen without changing the ratio', () => {
    expect(
      normalizeImageParameters('openai', 'openai/gpt-image-2', { aspectRatio: '3:2' }),
    ).toEqual({ size: '1536x1024' });
    for (const aspectRatio of ['16:9', '9:16', '4:3', '19.5:9', '110:239']) {
      const { size } = normalizeImageParameters('openai', 'openai/gpt-image-2', { aspectRatio });
      const [w, h] = size!.split('x').map(Number);
      const [a, b] = aspectRatio.split(':').map(Number);
      expect(w / h).toBeCloseTo(a / b, 8);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
    }
    expect(() =>
      normalizeImageParameters('openai', 'openai/gpt-image-1.5', { aspectRatio: '16:9' }),
    ).toThrow();
    expect(() =>
      normalizeImageParameters('openai', 'openai/gpt-image-2', {
        size: '1024x1024',
        aspectRatio: '16:9',
      }),
    ).toThrow('conflict');
  });

  it('does not silently drop wrong-provider fields or explicit unsupported values', () => {
    expect(() =>
      normalizeImageParameters('gemini', 'gemini-3-pro-image', { size: '2048x2048' }),
    ).toThrow('not supported');
    expect(() =>
      normalizeImageParameters('xai', 'grok-imagine-image', { quality: 'high' }),
    ).toThrow('not supported');
    expect(() =>
      normalizeImageParameters('xai', 'grok-imagine-image', { resolution: '4k' }),
    ).toThrow();
    expect(() => normalizeImageParameters('openai', 'gpt-image-2', { quality: 'max' })).toThrow();
    expect(() =>
      normalizeImageParameters('gemini', 'gemini-2.5-flash-image', { resolution: '4K' }),
    ).toThrow();
    expect(
      normalizeImageParameters('gemini', 'gemini-3-pro-image', {
        resolution: '4k',
        aspectRatio: '16:9',
      }),
    ).toEqual({ resolution: '4K', aspectRatio: '16:9' });
    expect(normalizeImageParameters('xai', 'grok-imagine-image', { resolution: '2K' })).toEqual({
      resolution: '2k',
    });
  });

  it('does not inject defaults and keeps older guides executable', () => {
    expect(normalizeImageParameters('openai', 'gpt-image-2.5-flare', {})).toEqual({});
    expect(normalizeImageParameters(undefined, 'old-model', { aspectRatio: '2:3' })).toEqual({
      aspectRatio: '2:3',
    });
    expect(imageParameterSchema('openai', 'gpt-image-2.5-sunburst').quality.enum).toContain('max');
    expect(imageParameterSchema('gemini', 'gemini-3-pro-image').resolution.enum).toContain('4K');
    expect(imageParameterSchema('xai', 'grok-imagine-image-2.0').quality.enum).toEqual([
      'auto',
      'low',
      'medium',
    ]);
  });
});
