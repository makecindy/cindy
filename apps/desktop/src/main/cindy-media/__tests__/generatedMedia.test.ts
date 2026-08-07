/**
 * generatedMedia.test.ts — AI 生成产物媒体总仓适配器单测。
 * 覆盖:saveImage/saveVideo 零引用入仓(字段形状对齐 @cindy/mcps 契约)、
 * resolveImageRef 三分支(blob 地址 / 老 xdt-image 地址 / 绝对路径)与拒绝面、
 * 空输入/缺 mime 的错误语义(与老 store 报错文案同族,模型可自纠)。
 * 文件落 os.tmpdir() 收尾清理(规则 23);账本内存 SQLite + 真实 migration。
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LedgerDb } from '../ledger';

let tmpUserData = '';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

const schema = await import('../../localDb/schema');
const generatedMedia = await import('../generatedMedia');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const PNG_HASH = createHash('sha256').update(PNG_BYTES).digest('hex');
const MP4_BYTES = Buffer.from('fake-mp4-bytes');
const MP4_HASH = createHash('sha256').update(MP4_BYTES).digest('hex');

function freshDb(): LedgerDb {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const sqlText = fs.readFileSync(MIGRATION_0070, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) raw.exec(trimmed);
  }
  migration0071.run(raw);
  return drizzle(raw, { schema }) as unknown as LedgerDb;
}

let db: LedgerDb;

beforeAll(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-media-test-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

beforeEach(() => {
  db = freshDb();
});

const legacyResolve = (ref: string) => ({
  absPath: path.join(tmpUserData, 'legacy', ref.replace('xdt-image://', '').replace(/\//g, '_')),
});

describe('createBlobImageStorage.saveImage(生成图入仓)', () => {
  it('零引用入仓,返回字段形状对齐 @cindy/mcps SavedImage 契约', async () => {
    const storage = generatedMedia.createBlobImageStorage({ resolveLegacyImageRef: legacyResolve }, db);
    const saved = await storage.saveImage(PNG_BYTES.toString('base64'), 'image/png');
    expect(saved.xdtImageUrl).toBe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(saved.fileId).toBe(PNG_HASH);
    expect(saved.filename).toBe(`${PNG_HASH}.png`);
    expect(saved.bytes).toBe(PNG_BYTES.byteLength);
    expect(fs.existsSync(saved.originalPath)).toBe(true);
    // 生成时零引用(草稿语义,消息落库时由 createMessage 钩子挂账)
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(1);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });

  it('空 base64 / 缺 mime / 解码为空各自报 art: 前缀错误(模型可自纠)', async () => {
    const storage = generatedMedia.createBlobImageStorage({ resolveLegacyImageRef: legacyResolve }, db);
    await expect(storage.saveImage('', 'image/png')).rejects.toThrow(/empty base64/);
    await expect(storage.saveImage(PNG_BYTES.toString('base64'))).rejects.toThrow(/mime is required/);
    await expect(storage.saveImage('!!!!', 'image/png')).rejects.toThrow(/empty buffer/);
  });
});

describe('createBlobImageStorage.resolveImageRef(改图源图三分支)', () => {
  it('cindy-media 地址 → 仓内绝对路径;不存在的指纹报 missing', async () => {
    const storage = generatedMedia.createBlobImageStorage({ resolveLegacyImageRef: legacyResolve }, db);
    const saved = await storage.saveImage(PNG_BYTES.toString('base64'), 'image/png');
    await expect(storage.resolveImageRef(saved.xdtImageUrl)).resolves.toBe(saved.originalPath);
    await expect(
      storage.resolveImageRef(`cindy-media://blobs/${'e'.repeat(64)}.png`),
    ).rejects.toThrow(/missing on disk/);
  });

  it('老 xdt-image 地址走 legacy 解析(历史图改图场景);绝对路径直通;其余拒', async () => {
    const storage = generatedMedia.createBlobImageStorage({ resolveLegacyImageRef: legacyResolve }, db);
    // legacy:文件真实存在才放行
    const legacyPath = legacyResolve('xdt-image://sess/old.png').absPath;
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, PNG_BYTES);
    await expect(storage.resolveImageRef('xdt-image://sess/old.png')).resolves.toBe(legacyPath);
    // 绝对路径:存在放行,不存在报 not found
    await expect(storage.resolveImageRef(legacyPath)).resolves.toBe(legacyPath);
    await expect(
      storage.resolveImageRef(path.join(tmpUserData, 'gone.png')),
    ).rejects.toThrow(/file not found/);
    // 相对路径 / 空:拒
    await expect(storage.resolveImageRef('relative.png')).rejects.toThrow(/unsupported image reference/);
    await expect(storage.resolveImageRef('')).rejects.toThrow(/empty image reference/);
  });
});

describe('createBlobVideoStorage.saveVideo(生成视频入仓)', () => {
  it('mp4 入仓零引用,字段形状对齐 SavedVideo 契约;mov 白名单已补', async () => {
    const storage = generatedMedia.createBlobVideoStorage(db);
    const saved = await storage.saveVideo(MP4_BYTES, 'video/mp4');
    expect(saved.xdtVideoUrl).toBe(`cindy-media://blobs/${MP4_HASH}.mp4`);
    expect(saved.mime).toBe('video/mp4');
    expect(fs.existsSync(saved.originalPath)).toBe(true);
    expect(db.select().from(schema.mediaRefs).all()).toHaveLength(0);

    const mov = await storage.saveVideo(Buffer.from('fake-mov'), 'video/quicktime');
    expect(mov.xdtVideoUrl).toMatch(/\.mov$/);
  });

  it('空 buffer / 缺 mime 报 art: 前缀错误', async () => {
    const storage = generatedMedia.createBlobVideoStorage(db);
    await expect(storage.saveVideo(Buffer.alloc(0), 'video/mp4')).rejects.toThrow(/empty video buffer/);
    await expect(storage.saveVideo(MP4_BYTES, '')).rejects.toThrow(/mime is required/);
  });

  it('上游 content-type 不可信:带参数/octet-stream 归一化兜底 mp4,长任务不再最后一步炸(review P1)', async () => {
    expect(generatedMedia.normalizeGeneratedVideoMime('video/mp4; charset=binary')).toBe('video/mp4');
    expect(generatedMedia.normalizeGeneratedVideoMime('VIDEO/QUICKTIME')).toBe('video/quicktime');
    expect(generatedMedia.normalizeGeneratedVideoMime('application/octet-stream')).toBe('video/mp4');
    expect(generatedMedia.normalizeGeneratedVideoMime('video/x-unknown')).toBe('video/mp4');
    // 端到端:octet-stream 的字节照样入仓成 .mp4
    const storage = generatedMedia.createBlobVideoStorage(db);
    const saved = await storage.saveVideo(Buffer.from('sig-url-bytes'), 'application/octet-stream');
    expect(saved.xdtVideoUrl).toMatch(/\.mp4$/);
  });
});

describe('materializeGeneratedImage(codex 生成图物化,thin adapter 的逻辑本体)', () => {
  const deps = {
    ingestFromPath: vi.fn(async ({ originalName }: { sourcePath: string; originalName?: string }) => ({
      url: `cindy-media://blobs/${'b'.repeat(64)}.png`,
      filename: originalName ?? 'x.png',
    })),
    ingestBuffer: vi.fn(async () => ({
      url: `cindy-media://blobs/${'c'.repeat(64)}.png`,
      filename: `${'c'.repeat(64)}.png`,
    })),
  };

  beforeEach(() => {
    deps.ingestFromPath.mockClear();
    deps.ingestBuffer.mockClear();
  });

  it('托管地址(老 xdt-image / 新 cindy-media)原样透传,不重复入仓', async () => {
    const legacy = await generatedMedia.materializeGeneratedImage(
      { url: 'xdt-image://sess-1/pic.png' },
      deps,
    );
    expect(legacy).toEqual({ url: 'xdt-image://sess-1/pic.png', filename: 'pic.png' });
    const blob = await generatedMedia.materializeGeneratedImage(
      { url: `cindy-media://blobs/${'d'.repeat(64)}.png` },
      deps,
    );
    expect(blob?.url).toBe(`cindy-media://blobs/${'d'.repeat(64)}.png`);
    expect(blob?.filename).toBe(`${'d'.repeat(64)}.png`);
    expect(deps.ingestFromPath).not.toHaveBeenCalled();
    expect(deps.ingestBuffer).not.toHaveBeenCalled();
  });

  it('本地路径 → ingestFromPath;data: base64 → ingestBuffer(mime 从 data url 头取)', async () => {
    await generatedMedia.materializeGeneratedImage({ path: '/tmp/gen.png' }, deps);
    expect(deps.ingestFromPath).toHaveBeenCalledWith({ sourcePath: '/tmp/gen.png', originalName: 'gen.png' });

    const b64 = PNG_BYTES.toString('base64');
    await generatedMedia.materializeGeneratedImage({ url: `data:image/png;base64,${b64}` }, deps);
    expect(deps.ingestBuffer).toHaveBeenCalledTimes(1);
    const bufferCalls = deps.ingestBuffer.mock.calls as unknown as Array<[{ mimeType: string }]>;
    expect(bufferCalls[0][0]).toMatchObject({ mimeType: 'image/png' });
  });

  it('认不出的形状返回 null;ingest 抛错向上传播(调用方决定丢图)', async () => {
    await expect(generatedMedia.materializeGeneratedImage({}, deps)).resolves.toBeNull();
    await expect(
      generatedMedia.materializeGeneratedImage({ url: 'data:text/plain;base64,aGk=' }, deps),
    ).resolves.toBeNull();
    deps.ingestFromPath.mockRejectedValueOnce(new Error('unsupported image extension'));
    await expect(
      generatedMedia.materializeGeneratedImage({ path: '/tmp/gen.avif' }, deps),
    ).rejects.toThrow(/unsupported/);
  });
});
