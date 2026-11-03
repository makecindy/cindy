import { describe, expect, it } from 'vitest';
import { imageParameterSchema, normalizeImageParameters } from '../imageParameters.js';

describe('image options use the selected channel and model', () => {
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
