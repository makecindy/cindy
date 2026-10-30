import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const readAvatarFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ readFile: readAvatarFile }));
vi.mock('../cindy-media/blobStore', () => ({ resolveSafe: vi.fn(() => ({ absPath: '/managed/avatar.png' })) }));
import { encodeNotificationAvatar, notificationAvatar } from '../notificationAvatar';

describe('notification avatars', () => {
  it('carries bundled identities and emoji without a network lookup', async () => {
    expect(await notificationAvatar('cindy://avatar/preset/cindy')).toEqual({ kind: 'preset', value: 'cindy' });
    expect(await notificationAvatar('🐸')).toEqual({ kind: 'symbol', value: '🐸' });
    expect(await notificationAvatar('cindy://avatar/unknown')).toBeUndefined();
    expect(await notificationAvatar('https://example.com/avatar.jpg')).toBeUndefined();
    expect(await notificationAvatar('/private/avatar.jpg')).toBeUndefined();
  });

  it('keeps a reply deliverable when the managed avatar is unavailable', async () => {
    readAvatarFile.mockRejectedValueOnce(new Error('Missing media'));
    expect(await notificationAvatar(`cindy-media://blobs/${'a'.repeat(64)}.png`)).toBeUndefined();
  });

  it('aborts slow avatar reads before they consume the reply preview window', async () => {
    vi.useFakeTimers();
    try {
      readAvatarFile.mockImplementationOnce((_path, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }));
      const result = notificationAvatar(`cindy-media://blobs/${'b'.repeat(64)}.png`);
      await vi.advanceTimersByTimeAsync(150);
      expect(await result).toBeUndefined();
      expect(readAvatarFile.mock.lastCall?.[1].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('produces a bounded decodable thumbnail for a detailed uploaded portrait', async () => {
    const pixels = Buffer.alloc(256 * 256 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 197 + (i >> 5) * 53) % 256;
    const input = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const result = await encodeNotificationAvatar(input, sharp);
    expect(result?.kind).toBe('jpeg');
    expect(result!.value.length).toBeLessThanOrEqual(2048);
    const metadata = await sharp(Buffer.from(result!.value, 'base64')).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(72);
    expect(metadata.width).toBe(metadata.height);
  });
});
