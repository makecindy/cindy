import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { MobilePluginPreview, readMobilePreview } from '../mobilePreview.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

describe('mobile preview resource tunnel', () => {
  it('reads an actual Host loopback server, pins multi-chunk data and rejects another origin', async () => {
    const bytes = Buffer.alloc(100000, 65);
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'https://another.invalid/private' });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/javascript');
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port,
      url = `http://127.0.0.1:${port}/index.html`;
    const ghost = {
      enabled: true,
      manifest: { preview: { hosts: ['127.0.0.1'] } },
    } as InstalledGhost;
    const reader = vi.fn(readMobilePreview),
      preview = new MobilePluginPreview(url, reader);
    try {
      const first = await preview.fetch(ghost, { url, offset: 0 }, () => {});
      expect(first.nextOffset).toBe(49152);
      const second = await preview.fetch(
        ghost,
        { url, offset: first.nextOffset, revision: first.revision },
        () => {},
      );
      expect(Buffer.from(second.base64, 'base64')).toEqual(bytes.subarray(49152, 98304));
      expect(reader).toHaveBeenCalledTimes(1);
      await expect(
        preview.fetch(ghost, { url, offset: first.nextOffset, revision: 'changed' }, () => {}),
      ).rejects.toThrow('PREVIEW_CHANGED');
      await expect(
        preview.fetch(ghost, { url: 'http://localhost:1/private', offset: 0 }, () => {}),
      ).rejects.toThrow('PREVIEW_ORIGIN_DENIED');
      await expect(
        readMobilePreview(`http://127.0.0.1:${port}/redirect`, () => {}),
      ).rejects.toThrow('PREVIEW_ORIGIN_DENIED');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  it('does not publish a late response after the page authority changes or forward browser cookies', async () => {
    let current = true;
    const fetcher = vi.fn(async () => {
      current = false;
      return new Response('late');
    });
    await expect(
      readMobilePreview(
        'http://localhost:1234/page',
        () => {
          if (!current) throw new Error('closed');
        },
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow('closed');
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:1234/page',
      expect.objectContaining({ credentials: 'omit', redirect: 'manual' }),
    );
  });
});
