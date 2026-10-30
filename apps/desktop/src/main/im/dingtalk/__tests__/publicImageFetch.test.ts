import { describe, expect, it, vi } from 'vitest';

import { fetchWithSsrFGuard, SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
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

  it('exempts proxy fake-IP ranges only, keeping private and metadata addresses blocked (#8020)', async () => {
    const seen: Array<unknown> = [];
    const guardedFetch: GuardedImageFetch = async (params) => {
      seen.push(params.policy);
      throw new Error('stop before any network I/O');
    };
    await expect(fetchPublicImageBytes('https://cdn.example/a.png', 1024, guardedFetch)).rejects.toThrow('stop before');
    expect(seen[0]).toEqual({ allowRfc2544BenchmarkRange: true, allowIpv6UniqueLocalRange: true });

    // The same policy through the real guard: these must still be refused
    // before any connection is attempted.
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1']) {
      const lookupFn = (async () => [{ address, family: 4 }]) as never;
      await expect(
        fetchPublicImageBytes('https://cdn.example/a.png', 1024, (params) => fetchWithSsrFGuard({ ...params, lookupFn })),
        address,
      ).rejects.toBeInstanceOf(SsrFBlockedError);
    }
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

  it('aborts the download when the caller cancels', async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const guardedFetch = vi.fn<GuardedImageFetch>(async ({ signal }) => {
      seen = signal;
      caller.abort();
      return { response: new Response(PNG_BYTES), finalUrl: 'https://cdn.example/image.png', release: async () => undefined };
    });
    await fetchPublicImageBytes('https://cdn.example/image.png', 1024, guardedFetch, { signal: caller.signal });
    expect(seen?.aborted).toBe(true);
  });
});
