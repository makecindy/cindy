import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessMediaService } from './media-service.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessMediaService', () => {
  it('stores an image by content hash and exposes only a stable cindy-media reference', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-media-'));
    dirs.push(dir);
    const service = new HeadlessMediaService(path.join(dir, 'blobs'));
    const image = await service.ingestBytes(Buffer.from([137, 80, 78, 71]), 'image/png');
    expect(image.url).toMatch(/^cindy-media:\/\/blobs\/[0-9a-f]{64}\.png$/);
    expect(service.resolve(image.url)).toMatchObject({ absPath: image.absPath, mimeType: 'image/png' });
    expect(fs.readFileSync(image.absPath)).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('uploads requested media through a private presigned object and caches a short-lived reference', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-media-'));
    dirs.push(dir);
    const calls: Array<{ url: string; method: string }> = [];
    const service = new HeadlessMediaService(path.join(dir, 'blobs'), {
      deviceLinkApiBase: () => 'https://relay.example.test',
      getAccessToken: async () => 'access-token',
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        if (String(input).endsWith('/presign-put')) return Response.json({ putUrl: 'https://oss.example.test/object', key: 'cindy/device-link/u/image.png' });
        return new Response(null, { status: 200 });
      },
    });
    const image = await service.ingestBytes(Buffer.from([1, 2, 3]), 'image/png');
    await expect(service.fetchForRemote({ url: image.url })).resolves.toEqual({
      ossKey: 'cindy/device-link/u/image.png', mimeType: 'image/png', size: 3,
    });
    await service.fetchForRemote({ url: image.url });
    expect(calls).toEqual([
      { url: 'https://relay.example.test/api/device-link/media/presign-put', method: 'POST' },
      { url: 'https://oss.example.test/object', method: 'PUT' },
    ]);
  });

  it('removes unreferenced blobs but preserves every visible-history reference', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-media-'));
    dirs.push(dir);
    const service = new HeadlessMediaService(path.join(dir, 'blobs'));
    const kept = await service.ingestBytes(Buffer.from('kept'), 'image/png');
    const removed = await service.ingestBytes(Buffer.from('removed'), 'image/png');
    await service.prune([{ type: 'user', content: [{ type: 'image', path: kept.url }] }]);
    expect(fs.existsSync(kept.absPath)).toBe(true);
    expect(fs.existsSync(removed.absPath)).toBe(false);
  });
});
