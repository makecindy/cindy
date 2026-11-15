import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fetchPublicImageBytes = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: {
  getAppPath: () => path.resolve(__dirname, '../../../..'),
  get isPackaged() { return false; },
} }));
vi.mock('../../im/publicImageFetch.js', () => ({ fetchPublicImageBytes }));

import { avatarDownloadMaySucceedLater, restoreCloudAvatar } from '../avatarRestore.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('restoreCloudAvatar', () => {
  it('keeps a portable avatar without downloading it', async () => {
    fetchPublicImageBytes.mockReset();
    for (const avatar of ['🦊', '🤖', 'cindy://avatar/cindy']) {
      await expect(restoreCloudAvatar(avatar)).resolves.toEqual({ portable: avatar });
    }
    expect(fetchPublicImageBytes).not.toHaveBeenCalled();
  });

  // #6897: replacement values must never become an edit to the cloud identity.
  it.each([null, '', 'http://cdn.example/avatar.png', `cindy-media://blobs/${'a'.repeat(64)}.png`])(
    'marks a nonportable cloud avatar %s as a local stand-in', async avatar => {
      fetchPublicImageBytes.mockReset();
      await expect(restoreCloudAvatar(avatar)).resolves.toEqual({ portable: '🤖', fallback: true });
      expect(fetchPublicImageBytes).not.toHaveBeenCalled();
    },
  );

  it('stores image bytes when the public address still serves an image', async () => {
    fetchPublicImageBytes.mockResolvedValue({ buffer: png, mimeType: 'image/png' });
    const restored = await restoreCloudAvatar('https://cdn.example/avatar.png');
    expect(restored).toEqual({ imageBase64: Buffer.from(png).toString('base64') });
  });

  it('uses the default avatar when the address is permanently gone, so take-over can finish', async () => {
    fetchPublicImageBytes.mockRejectedValue(new Error('remote image request failed: HTTP 404'));
    await expect(restoreCloudAvatar('https://cdn.example/missing.png')).resolves.toEqual({ portable: '🤖', fallback: true });
    fetchPublicImageBytes.mockResolvedValue({ buffer: Uint8Array.from([1, 2, 3, 4]), mimeType: 'text/plain' });
    await expect(restoreCloudAvatar('https://cdn.example/not-image')).resolves.toEqual({ portable: '🤖', fallback: true });
  });

  it('keeps a temporary download failure retryable', async () => {
    fetchPublicImageBytes.mockRejectedValue(new Error('remote image request failed: HTTP 503'));
    await expect(restoreCloudAvatar('https://cdn.example/avatar.png')).rejects.toThrow('AVATAR_UNAVAILABLE');
    const abort = new AbortController();
    abort.abort();
    fetchPublicImageBytes.mockRejectedValue(new Error('The operation was aborted'));
    await expect(restoreCloudAvatar('https://cdn.example/avatar.png', abort.signal)).rejects.toThrow('AVATAR_UNAVAILABLE');
  });
});

describe('avatarDownloadMaySucceedLater', () => {
  it('retries timeouts and account changes, not a refused address', () => {
    expect(avatarDownloadMaySucceedLater(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toBe(true);
    expect(avatarDownloadMaySucceedLater(new Error('OWNER_CHANGED'))).toBe(true);
    expect(avatarDownloadMaySucceedLater(new Error('remote image request failed: HTTP 403'))).toBe(false);
    expect(avatarDownloadMaySucceedLater(new Error('remote image exceeds the size limit'))).toBe(false);
  });

  it('retries the network failure undici hides under fetch failed', async () => {
    const offline = new TypeError('fetch failed');
    offline.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    fetchPublicImageBytes.mockRejectedValue(offline);
    await expect(restoreCloudAvatar('https://cdn.example/avatar.png')).rejects.toThrow('AVATAR_UNAVAILABLE');
    const both = new TypeError('fetch failed');
    both.cause = new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ], 'fetch failed');
    expect(avatarDownloadMaySucceedLater(both)).toBe(true);
  });
});
