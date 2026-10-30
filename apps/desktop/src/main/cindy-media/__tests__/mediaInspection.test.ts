import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../localDb/schema';
import type { DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import { resolveSafe } from '../blobStore';
import { inspectMedia, previewGeneratedImages } from '../mediaInspection';
import * as compressor from '../../mcp-integrations/inlineImageCompressor';
import { GHOST_MODEL_IMAGE_MAX_BYTES } from '../../cindy-brain/ghostModelImages';

// Production inspectMedia + real ledger queries/files. Existing generation tests
// never decoded the returned URL. Unit tier: scope revocation must drop pixels;
// a failed preview must retain the paid result. Videos delegate to the existing path tool.
const state = vi.hoisted(() => ({ root: '', owner: 'owner', valid: true, pending: false }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
}));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgYGD4D8UQBgAd9AP9JAD7OgAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
let db: Database.Database;
const context = { sessionId: 's', isCurrent: () => state.valid };
async function media(buffer = PNG, ext = 'png', owner = 's') {
  const hash = createHash('sha256').update(buffer).digest('hex');
  const url = `cindy-media://blobs/${hash}.${ext}`;
  const file = resolveSafe(url).absPath;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  db.prepare('INSERT INTO media_refs VALUES (?, ?, ?)').run(hash, 'session-attachment', owner);
  return url;
}
beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-inspection-'));
  state.owner = 'owner';
  state.valid = true;
  state.pending = false;
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE sessions(id TEXT, status TEXT, cleared_at INTEGER); INSERT INTO sessions VALUES('s', 'active', NULL); CREATE TABLE media_refs(hash TEXT, ref_kind TEXT, ref_id TEXT);",
  );
  setCurrentDbClient({ drizzle: drizzle(db, { schema }) } as unknown as DbClient, 'owner');
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearCurrentDbClient();
  db.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('current-task media inspection', () => {
  // Review #7970: a valid large PNG bypassed the model-image input bound and
  // copied/decoded its full source repeatedly. Existing tests only used tiny images.
  // Unit: oversize bytes/pixels must omit previews, retain the paid URL, and allow path analysis.
  it.each(['bytes', 'pixels'] as const)(
    'omits %s-heavy previews while retaining the generated result',
    async (kind) => {
      const bytes =
        kind === 'bytes'
          ? Buffer.concat([PNG, Buffer.alloc(GHOST_MODEL_IMAGE_MAX_BYTES)])
          : await sharp({ create: { width: 4096, height: 4097, channels: 3, background: 'white' } })
              .png()
              .toBuffer();
      const url = await media(bytes);
      const result = await previewGeneratedImages({ ok: true, xdt_image_urls: [url] }, context);
      expect(result).toMatchObject({
        ok: true,
        xdt_image_urls: [url],
        preview_errors: expect.any(Array),
      });
      expect(result.modelImages).toHaveLength(0);
      expect(result.previews).toHaveLength(0);
    },
  );
  it('returns a decodable thumbnail within the inline budget for a valid dense image', async () => {
    const raw = Buffer.alloc(128 * 128 * 3);
    let seed = 1;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = seed >>> 24;
    }
    const source = await sharp(raw, { raw: { width: 128, height: 128, channels: 3 } })
      .png()
      .toBuffer();
    const url = await media(source);
    const result = await inspectMedia({ url }, context, 10_000);
    expect(source.length).toBeGreaterThan(10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const thumbnail = Buffer.from(result.modelImages[0].data, 'base64');
    expect(thumbnail.length).toBeLessThanOrEqual(10_000);
    expect(await sharp(thumbnail).metadata()).toMatchObject({
      width: 128,
      height: 128,
      format: 'webp',
    });
    expect(result.previews).toEqual([{ url, image_index: 0 }]);
  });
  it.each(['owner', 'clear', 'ref'] as const)(
    'drops the whole batch after %s changes while the second preview is compressed',
    async (change) => {
      const urls = await Promise.all(
        [1, 2].map((value) => media(Buffer.concat([PNG, Buffer.alloc(100_000, value)]))),
      );
      const compress = compressor.prepareInlineImagePreview;
      let calls = 0;
      vi.spyOn(compressor, 'prepareInlineImagePreview').mockImplementation(async (...args) => {
        const result = await compress(...args);
        if (++calls === 2) {
          if (change === 'owner') state.owner = 'next';
          if (change === 'clear') db.exec('UPDATE sessions SET cleared_at = 1');
          if (change === 'ref') db.exec('DELETE FROM media_refs');
        }
        return result;
      });
      const result = await previewGeneratedImages({ ok: true, xdt_image_urls: urls }, context);
      expect(calls).toBe(2);
      expect(result).toMatchObject({
        ok: true,
        xdt_image_urls: urls,
        preview_errors: expect.any(Array),
      });
      expect(result).not.toHaveProperty('modelImages');
    },
  );
  it('reads real image pixels without revealing a path or creating delivery fields', async () => {
    const url = await media();
    const result = await inspectMedia({ url }, context);
    expect(result).toEqual({
      ok: true,
      previews: [{ url, image_index: 0 }],
      modelImages: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
    });
    expect(JSON.stringify(result)).not.toContain(state.root);
  });
  it('rejects another task and arbitrary local/remote URLs before reading', async () => {
    const url = await media(PNG, 'png', 'other');
    expect(await inspectMedia({ url }, context)).toMatchObject({
      ok: false,
      errorCode: 'MEDIA_NOT_IN_TASK',
    });
    for (const url of [
      '/tmp/image.png',
      'https://example.test/image.png',
      'cindy-media://blobs/../../x',
    ]) {
      expect(await inspectMedia({ url }, context)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_INPUT',
      });
    }
  });
  it('rejects changed bytes, missing files, and corrupt images without leaking paths', async () => {
    const url = await media();
    await fs.writeFile(resolveSafe(url).absPath, 'wrong bytes');
    expect(await inspectMedia({ url }, context)).toMatchObject({
      errorCode: 'MEDIA_SOURCE_CHANGED',
    });
    await fs.unlink(resolveSafe(url).absPath);
    expect(await inspectMedia({ url }, context)).toMatchObject({
      errorCode: 'MEDIA_PREVIEW_UNAVAILABLE',
    });
    const broken = await media(PNG.subarray(0, 20));
    const result = await inspectMedia({ url: broken }, context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(state.root);
  });
  it('directs video inspection to path resolution without reading the video', async () => {
    const url = await media(MP4, 'mp4');
    const open = vi.spyOn(fs, 'open');
    const result = await inspectMedia({ url }, context);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'MEDIA_TYPE_UNSUPPORTED',
      message: expect.stringContaining('resolve_local_path'),
    });
    expect(open).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('modelImages');
  });
  it.each(['owner', 'permission', 'clear', 'delete', 'ref', 'pending', 'db'] as const)(
    'drops image pixels after %s changes during compression',
    async (change) => {
      const url = await media(Buffer.concat([PNG, Buffer.alloc(200_000)]));
      const compress = compressor.prepareInlineImagePreview;
      const compressSpy = vi
        .spyOn(compressor, 'prepareInlineImagePreview')
        .mockImplementation(async (...args) => {
          const result = await compress(...args);
          if (change === 'owner') state.owner = 'next';
          if (change === 'permission') state.valid = false;
          if (change === 'clear') db.exec('UPDATE sessions SET cleared_at = 1');
          if (change === 'delete') db.exec("UPDATE sessions SET status = 'deleted'");
          if (change === 'ref') db.exec('DELETE FROM media_refs');
          if (change === 'pending') state.pending = true;
          if (change === 'db') clearCurrentDbClient();
          return result;
        });
      const result = await inspectMedia({ url }, context);
      expect(compressSpy).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('modelImages');
    },
  );
  it('keeps generation success and all URLs when previews fail or exceed the batch budget', async () => {
    const good = await media();
    const bad = await media(Buffer.from('not an image'));
    const result = await previewGeneratedImages(
      { ok: true, status: 'completed', xdt_image_urls: [bad, good, good] },
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'completed',
      xdt_image_urls: [bad, good, good],
      previews_omitted: [good],
      previews: [{ url: good, image_index: 0 }],
    });
    expect(result.modelImages).toHaveLength(1);
    expect(result.preview_errors).toHaveLength(1);
    clearCurrentDbClient();
    expect(
      await previewGeneratedImages({ ok: true, xdt_image_urls: [good] }, context),
    ).toMatchObject({ ok: true, xdt_image_urls: [good], preview_errors: expect.any(Array) });
  });
});
