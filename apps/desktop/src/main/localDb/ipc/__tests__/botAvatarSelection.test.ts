import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';

const state = vi.hoisted(() => ({ packaged: false }));
vi.mock('electron', () => ({ app: {
  getAppPath: () => path.resolve(__dirname, '../../../../..'),
  get isPackaged() { return state.packaged; },
} }));

import {
  BOT_AVATAR_MAX_BYTES,
  decodeBotAvatarImage,
  readDefaultTeammatePortrait,
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

describe('bundled teammate portrait fallback', () => {
  it('provides sixteen distinct real portraits and wraps without reviving a retired role', async () => {
    const sharp = (await import('sharp')).default;
    const hashes = new Set<string>();
    for (let index = 0; index < 16; index++) {
      const image = await readDefaultTeammatePortrait(index);
      expect(image.mimeType).toBe('image/png');
      expect(await sharp(image.buffer).metadata()).toMatchObject({ width: 256, height: 256 });
      hashes.add(createHash('sha256').update(image.buffer).digest('hex'));
    }
    expect(hashes.size).toBe(16);
    expect(await readDefaultTeammatePortrait(16)).toEqual(await readDefaultTeammatePortrait(0));
  });

  it('uses the packaged gallery with exactly the same pixels as development', async () => {
    const expected = await readDefaultTeammatePortrait(3);
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true, value: path.resolve(__dirname, '../../../../../resources'),
    });
    state.packaged = true;
    try {
      expect(await readDefaultTeammatePortrait(3)).toEqual(expected);
    } finally {
      state.packaged = false;
      if (original) Object.defineProperty(process, 'resourcesPath', original);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });
});
