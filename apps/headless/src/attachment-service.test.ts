import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessAttachmentService } from './attachment-service.js';
import { buildAttachmentOssRef } from '@cindy/device-link';
import { HeadlessMediaService } from './media-service.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessAttachmentService', () => {
  it('copies regular local inputs into a session-private 0600 directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-attachment-'));
    dirs.push(dir);
    const source = path.join(dir, 'source.txt');
    fs.writeFileSync(source, 'original');
    const service = new HeadlessAttachmentService(path.join(dir, 'managed'));
    const content = await service.normalize('session_1', {
      type: 'user', content: [{ type: 'text', text: 'inspect this' }, { type: 'file', path: source }],
    });
    expect(content).toMatchObject({ type: 'user', content: [
      { type: 'text', text: 'inspect this' },
      { type: 'file', path: expect.stringContaining(path.join('managed', 'session_1')) },
    ] });
    const copied = (content as { content: Array<{ path?: string }> }).content[1].path!;
    fs.writeFileSync(source, 'changed after send');
    expect(fs.readFileSync(copied, 'utf8')).toBe('original');
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
  });

  it('rejects non-file and relative attachment paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-attachment-'));
    dirs.push(dir);
    const service = new HeadlessAttachmentService(path.join(dir, 'managed'));
    await expect(service.normalize('session_1', { type: 'user', content: [{ type: 'file', path: 'relative.txt' }] }))
      .rejects.toThrow('attachment path must be absolute');
    await expect(service.normalize('session_1', { type: 'user', content: [{ type: 'file', path: dir }] }))
      .rejects.toThrow('not a regular file');
  });

  it('materializes phone-uploaded Device Link attachments before queue dispatch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-attachment-'));
    dirs.push(dir);
    const bytes = Buffer.from('uploaded from phone');
    const ref = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/u/spec.txt',
      originalName: 'spec.txt',
      mimeType: 'text/plain',
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const calls: Array<{ url: string; method: string }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/presign-get')) return Response.json({ getUrl: 'https://storage.example.test/object' });
      if (url === 'https://storage.example.test/object') return new Response(bytes);
      return Response.json({ deleted: true });
    };
    const service = new HeadlessAttachmentService(path.join(dir, 'managed'), {
      deviceLinkApiBase: () => 'https://relay.example.test',
      getAccessToken: async () => 'token',
      fetch,
    });

    const result = await service.normalizeQueued('session_1', {
      text: 'review this',
      files: [{ path: ref, category: 'text', mimeType: 'text/plain' }],
    });
    expect(result).toMatchObject({ type: 'user' });
    const block = (result as { content: Array<{ path?: string }> }).content[1];
    expect(block.path).toMatch(/managed[\\/]session_1[\\/].+\.txt$/);
    expect(fs.readFileSync(block.path!, 'utf8')).toBe('uploaded from phone');
    expect(calls).toEqual(expect.arrayContaining([
      { url: 'https://relay.example.test/api/device-link/media/presign-get', method: 'POST' },
      { url: 'https://storage.example.test/object', method: 'GET' },
    ]));
  });

  it('persists image history as a cindy-media URL while the agent receives a local protected path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-attachment-'));
    dirs.push(dir);
    const source = path.join(dir, 'photo.png');
    fs.writeFileSync(source, Buffer.from([1, 2, 3]));
    const media = new HeadlessMediaService(path.join(dir, 'media', 'blobs'));
    const service = new HeadlessAttachmentService(path.join(dir, 'managed'), undefined, media);
    const runtimeContent = await service.normalize('session_1', {
      type: 'user', content: [{ type: 'image', path: source, mimeType: 'image/png' }],
    });
    const localPath = (runtimeContent as { content: Array<{ path: string }> }).content[0]!.path;
    expect(localPath).toContain(path.join('media', 'blobs'));
    const display = service.toDisplayContent(runtimeContent) as { images: Array<{ url: string }> };
    expect(display.images[0]!.url).toMatch(/^cindy-media:\/\/blobs\/[0-9a-f]{64}\.png$/);
  });
});
