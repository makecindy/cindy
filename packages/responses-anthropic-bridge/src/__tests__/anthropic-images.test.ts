import { describe, expect, it, vi } from 'vitest';

import {
  enforceAnthropicImageLimits,
  MAX_INPUT_BASE64_LENGTH,
  normalizeAnthropicImages,
  requestHasInlineImage,
} from '../anthropic-images.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Anthropic image limits and normalization', () => {
  it('keeps the newest 20 images when many remote images have unknown dimensions', () => {
    const content = Array.from({ length: 21 }, (_, index) => ({
      type: 'image',
      source: { type: 'url', url: `https://example.com/${index}.png` },
    }));
    const messages = [{ role: 'user', content }];
    enforceAnthropicImageLimits(messages);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[20]).toMatchObject({ type: 'image' });
  });

  it('normalizes inline images through the injected codec and preserves image presence', async () => {
    const normalize = vi.fn(async () => ({ data: tinyPng, mediaType: 'image/png' }));
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng } }],
    }];
    await normalizeAnthropicImages(messages, {
      codec: { normalize },
    });
    expect(normalize).toHaveBeenCalled();
    expect(requestHasInlineImage(messages)).toBe(true);
  });

  it('preserves supported inline images when the host has no native codec', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng } }],
    }];
    await normalizeAnthropicImages(messages);
    expect(messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: tinyPng },
    });
  });

  it('drops an inline image that exceeds the single-image base64 cap', () => {
    const messages = [{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'A'.repeat(5 * 1024 * 1024 + 1),
        },
      }],
    }];
    enforceAnthropicImageLimits(messages);
    expect(messages[0].content[0]).toMatchObject({ type: 'text' });
  });

  it('rejects oversized raw input before invoking the native codec', async () => {
    const normalize = vi.fn();
    const messages = [{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'A'.repeat(MAX_INPUT_BASE64_LENGTH + 1),
        },
      }],
    }];
    await normalizeAnthropicImages(messages, { codec: { normalize } });
    expect(normalize).not.toHaveBeenCalled();
    expect(messages[0].content[0]).toMatchObject({ type: 'text' });
  });

  it('serializes native normalization to bound concurrent decode memory', async () => {
    let active = 0;
    let peak = 0;
    const normalize = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { data: tinyPng, mediaType: 'image/png' };
    });
    const messages = [{
      role: 'user',
      content: Array.from({ length: 4 }, () => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: tinyPng },
      })),
    }];
    await normalizeAnthropicImages(messages, { codec: { normalize } });
    expect(normalize).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
  });

  it('serializes native normalization across concurrent requests sharing one codec', async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const normalize = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (normalize.mock.calls.length === 1) await firstBlocked;
      active -= 1;
      return { data: tinyPng, mediaType: 'image/png' };
    });
    const codec = { normalize };
    const messages = () => [{
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: tinyPng },
      }],
    }];

    const first = normalizeAnthropicImages(messages(), { codec });
    await vi.waitFor(() => expect(normalize).toHaveBeenCalledTimes(1));
    const second = normalizeAnthropicImages(messages(), { codec });
    await Promise.resolve();
    expect(normalize).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});
