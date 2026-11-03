// Unit: native bytes become managed refs, never raw base64 in message history.
// Existing generated-media tests do not cover native tool blocks or owner invalidation.
import { describe, expect, it, vi } from 'vitest';
import { materializeToolProcessMedia } from '../toolProcessMedia';
import { ingestMedia } from '../ingest';
import type { LedgerDb } from '../ledger';
import fs from 'node:fs/promises';
import { materializeSshRemoteMedia } from '../../file-browser/ssh-media';
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn() } }));
vi.mock('../../file-browser/ssh-media', () => ({ materializeSshRemoteMedia: vi.fn() }));
vi.mock('../ingest', () => ({
  ingestMedia: vi.fn(async () => ({ url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' })),
}));
const db = {} as LedgerDb;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=',
  'base64',
);
describe('native tool media materialization', () => {
  it('ingests verified bytes and collapses repeated refs', async () => {
    const image = { kind: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' };
    expect(await materializeToolProcessMedia([image, image], db, () => {})).toEqual([
      { kind: 'image', url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' },
    ]);
    expect(ingestMedia).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: png, mimeType: 'image/png', refs: [] }),
      db,
    );
  });
  it('rejects false media types without importing them', async () => {
    vi.mocked(ingestMedia).mockClear();
    expect(
      await materializeToolProcessMedia(
        [{ kind: 'video', data: png.toString('base64'), mimeType: 'video/mp4' }],
        db,
        () => {},
      ),
    ).toEqual([]);
    expect(ingestMedia).not.toHaveBeenCalled();
  });
  it('keeps playable video references in the tool step', async () => {
    const video = { kind: 'video' as const, url: 'https://example.com/clip.mp4' };
    expect(await materializeToolProcessMedia([video], db, () => {})).toEqual([video]);
  });
  it('stops before writing when the owner changed', async () => {
    vi.mocked(ingestMedia).mockClear();
    await expect(
      materializeToolProcessMedia([{ kind: 'image', data: png.toString('base64') }], db, () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
    expect(ingestMedia).not.toHaveBeenCalled();
  });
  it('reads remote paths only through the SSH cache and keeps other media after a missing file', async () => {
    vi.mocked(materializeSshRemoteMedia).mockResolvedValueOnce({
      ok: true,
      cachePath: '/cache/image',
      sourceVersion: 'v',
      size: png.length,
      mime: 'image/png',
      relPath: 'image.png',
    });
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(png as never)
      .mockRejectedValueOnce(new Error('missing'));
    const origin = { workdir: '/remote', remoteHostId: 'ssh-host' };
    const refs = await materializeToolProcessMedia(
      [{ kind: 'image', path: '/remote/image.png' }],
      db,
      () => {},
      origin,
    );
    expect(fs.readFile).toHaveBeenCalledWith('/cache/image');
    expect(fs.readFile).not.toHaveBeenCalledWith('/remote/image.png');
    expect(refs).toHaveLength(1);
    const video = { kind: 'video' as const, url: 'https://example.com/video.mp4' };
    expect(
      await materializeToolProcessMedia([{ kind: 'image', path: '/missing' }, video], db, () => {}),
    ).toEqual([video]);
  });
});
