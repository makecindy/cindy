import { describe, expect, it, vi } from 'vitest';

import { fetchPublicImageBytes, type GuardedImageFetch } from '../../publicImageFetch';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('IM public image fetch', () => {
  it('requires guarded HTTPS redirects and releases the pinned dispatcher', async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn<GuardedImageFetch>(async () => ({
      response: new Response(PNG_BYTES, {
        headers: { 'content-type': 'image/png' },
      }),
      finalUrl: 'https://cdn.example/image.png',
      release,
    }));

    await expect(
      fetchPublicImageBytes('https://cdn.example/image.png', 1024, guardedFetch),
    ).resolves.toEqual({
      buffer: PNG_BYTES,
      mimeType: 'image/png',
    });
    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://cdn.example/image.png',
        requireHttps: true,
        maxRedirects: 3,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an oversized response before reading its body', async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch: GuardedImageFetch = async () => ({
      response: new Response(PNG_BYTES, {
        headers: { 'content-length': '2048' },
      }),
      finalUrl: 'https://cdn.example/image.png',
      release,
    });

    await expect(
      fetchPublicImageBytes('https://cdn.example/image.png', 1024, guardedFetch),
    ).rejects.toThrow(/size limit/);
    expect(release).toHaveBeenCalledOnce();
  });
});
