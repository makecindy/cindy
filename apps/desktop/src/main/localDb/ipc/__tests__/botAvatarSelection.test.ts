import { describe, expect, it } from 'vitest';

import {
  BOT_AVATAR_MAX_BYTES,
  decodeBotAvatarImage,
  validateBotAvatarBuffer,
} from '../botAvatarSelection';

describe('Bot avatar selection', () => {
  it('accepts supported image bytes by magic signature', () => {
    expect(
      validateBotAvatarBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(validateBotAvatarBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      validateBotAvatarBuffer(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp');
  });

  it('rejects empty, oversized, and extension-only content', () => {
    expect(() => validateBotAvatarBuffer(Buffer.alloc(0))).toThrow(/INVALID_PARAMS/);
    expect(() => validateBotAvatarBuffer(Buffer.alloc(BOT_AVATAR_MAX_BYTES + 1))).toThrow(
      /INVALID_PARAMS/,
    );
    expect(() => validateBotAvatarBuffer(Buffer.from('not really a png'))).toThrow(
      /INVALID_PARAMS/,
    );
  });
  it('decodes bounded creation image bytes and still validates their actual signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    expect(decodeBotAvatarImage(png.toString('base64'))).toEqual({
      buffer: png,
      mimeType: 'image/png',
    });
    expect(decodeBotAvatarImage(undefined)).toBeNull();
    for (const value of [
      '',
      null,
      {},
      'not base64',
      'AAAA',
      'data:image/png;base64,AAAA',
      'A'.repeat(Math.ceil(BOT_AVATAR_MAX_BYTES / 3) * 4 + 4),
    ]) {
      expect(() => decodeBotAvatarImage(value)).toThrow(/INVALID_PARAMS/);
    }
  });
});
