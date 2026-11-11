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
/**
 * 最小 isom/ftyp 盒。头部 00000014 声明 20 字节,必须把兼容品牌补齐,
 * 否则嗅探会因裁断盒当成认不出,测试就只走上游声明兜底。
 */
const MP4_BYTES = Buffer.from('000000146674797069736f6d0000000069736f6d', 'hex');
const MP4_HASH = createHash('sha256').update(MP4_BYTES).digest('hex');
const QT_BYTES = Buffer.from('0000001466747970717420200000000071742020', 'hex');

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

    const mov = await storage.saveVideo(QT_BYTES, 'video/quicktime');
    expect(mov.xdtVideoUrl).toMatch(/\.mov$/);
  });

  it('空 buffer / 缺 mime 报 art: 前缀错误', async () => {
    const storage = generatedMedia.createBlobVideoStorage(db);
    await expect(storage.saveVideo(Buffer.alloc(0), 'video/mp4')).rejects.toThrow(/empty video buffer/);
    await expect(storage.saveVideo(MP4_BYTES, '')).rejects.toThrow(/mime is required/);
  });

  it('上游 content-type 不可信:带参数/octet-stream 归一化兜底 mp4,长任务不再最后一步炸(review P1)', () => {
    expect(generatedMedia.normalizeGeneratedVideoMime('video/mp4; charset=binary')).toBe('video/mp4');
    expect(generatedMedia.normalizeGeneratedVideoMime('VIDEO/QUICKTIME')).toBe('video/quicktime');
    expect(generatedMedia.normalizeGeneratedVideoMime('application/octet-stream')).toBe('video/mp4');
    expect(generatedMedia.normalizeGeneratedVideoMime('video/x-unknown')).toBe('video/mp4');
  });

  // 测试价值
  // - 生产入口与可观察结果:createBlobVideoStorage.saveVideo;
  //   扩展名跟随闻出的容器,带注释的错误页不入仓,报错不带上游正文。
  // - Bug／规则依据:签名下载返回 HTML/JSON 时仍显示成功并存成 .mp4;
  //   错误信息夹带正文会把签名 URL 写进日志。
  // - 现有覆盖缺口:样例比声明的盒短,嗅探直接放弃;octet-stream 兜底也是 mp4,
  //   看不出字节优先。前置 HTML 注释的错误页也会漏进仓。
  // - 最小失败输入:声明成 video/mp4 的 qt 盒;以 <!-- --> 开头的 HTML。
  // - tier:unit,内存账本,不起网络。
  it('先闻字节:声明不一致仍用容器,带注释的错误页不入仓且报错不带正文', async () => {
    const storage = generatedMedia.createBlobVideoStorage(db);
    const sniffed = await storage.saveVideo(MP4_BYTES, 'application/octet-stream');
    expect(sniffed.mime).toBe('video/mp4');
    expect(sniffed.xdtVideoUrl).toMatch(/\.mp4$/);
    // 声明成 quicktime 时兜底会变成 .mov;仍是 mp4 才说明嗅探真的跑过。
    const declaredQuickTime = await storage.saveVideo(MP4_BYTES, 'video/quicktime');
    expect(declaredQuickTime.mime).toBe('video/mp4');
    expect(declaredQuickTime.xdtVideoUrl).toBe(sniffed.xdtVideoUrl);
    const sniffedMov = await storage.saveVideo(QT_BYTES, 'video/mp4');
    expect(sniffedMov.mime).toBe('video/quicktime');
    expect(sniffedMov.xdtVideoUrl).toMatch(/\.mov$/);

    const rejected = [
      ['<html><body>cdn error</body></html>', 'cdn error'],
      ['{"status":"processing","url":"https://cdn.example/v.mp4?X-Amz-Signature=secret"}', 'X-Amz-Signature'],
      ['<!-- error --><html><body>cdn error</body></html>', 'cdn error'],
      ['<!-- comment1 --> <!-- comment2 -->\n<!DOCTYPE html><html><body>gateway down</body></html>', 'gateway down'],
      ['<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', 'AccessDenied'],
      ['<error>upstream failed</error>', 'upstream failed'],
    ] as const;
    for (const [body, leaked] of rejected) {
      let message = '';
      try {
        await storage.saveVideo(Buffer.from(body), 'video/mp4');
      } catch (err) {
        message = err instanceof Error ? err.message : '';
      }
      expect(message, body).toMatch(/错误页或 JSON/);
      expect(message, body).not.toContain(leaked);
      expect(message, body).not.toContain(body.slice(0, 24));
    }
    expect(db.select().from(schema.mediaBlobs).all()).toHaveLength(2);

    const unknown = await storage.saveVideo(Buffer.from('not-a-container'), 'application/octet-stream');
    expect(unknown.mime).toBe('video/mp4');
    expect(unknown.xdtVideoUrl).toMatch(/\.mp4$/);
  });
});

describe('materializeGeneratedImage(codex 生成图物化,thin adapter 的逻辑本体)', () => {
  const deps = {
    verifyManagedUrl: vi.fn(async (_url: string) => {}),
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
    deps.verifyManagedUrl.mockReset();
    deps.ingestFromPath.mockClear();
    deps.ingestBuffer.mockClear();
  });

  // #6412: the prior path-only/data-URL-only cases missed their combined shape.
  // unit: production materializer must return a managed result without touching a foreign path.
  it.each(['base64', 'data-url'])('uses valid %s bytes before an unreadable remote path', async (encoding) => {
    deps.ingestFromPath.mockRejectedValueOnce(new Error('MEDIA_SOURCE_MISSING'));
    const source = encoding === 'base64'
      ? { data: PNG_BYTES.toString('base64') }
      : { url: `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}` };
    const saved = await generatedMedia.materializeGeneratedImage({
      ...source, path: '/other-computer/image.png', pathOrigin: 'remote-agent',
    }, deps);
    expect(saved?.url).toBe(`cindy-media://blobs/${'c'.repeat(64)}.png`);
    expect(deps.ingestFromPath).not.toHaveBeenCalled();
    expect(deps.ingestBuffer).toHaveBeenCalledWith({ buffer: PNG_BYTES, mimeType: 'image/png' });
    deps.ingestFromPath.mockReset();
    deps.ingestFromPath.mockImplementation(async ({ originalName }) => ({
      url: `cindy-media://blobs/${'b'.repeat(64)}.png`, filename: originalName ?? 'x.png',
    }));
  });

  it('never reads a remote path on this Host, even if a local namesake exists', async () => {
    await expect(generatedMedia.materializeGeneratedImage({
      path: '/tmp/actual.png', pathOrigin: 'remote-agent',
    }, deps)).rejects.toThrow('REMOTE_SOURCE_REQUIRED');
    expect(deps.ingestFromPath).not.toHaveBeenCalled();
  });

  it.each(['not an image', '%%%'])('rejects invalid image bytes without falling back to a path', async (data) => {
    await expect(generatedMedia.materializeGeneratedImage({ data, path: '/tmp/actual.png' }, deps))
      .rejects.toThrow('INVALID_IMAGE');
    expect(deps.ingestFromPath).not.toHaveBeenCalled();
  });

  it('托管地址核验后复用，不重复入仓', async () => {
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
    expect(deps.verifyManagedUrl).toHaveBeenCalledTimes(2);
  });

  it('拒绝不存在的受管地址；有实际文件时重新导入当前 Host', async () => {
    const url = `cindy-media://blobs/${'e'.repeat(64)}.png`;
    deps.verifyManagedUrl.mockRejectedValueOnce(new Error('missing'));
    await expect(generatedMedia.materializeGeneratedImage({ url }, deps)).rejects.toThrow('missing');
    expect(deps.ingestFromPath).not.toHaveBeenCalled();
    deps.verifyManagedUrl.mockRejectedValueOnce(new Error('missing'));
    await expect(generatedMedia.materializeGeneratedImage({ url, path: '/tmp/actual.png' }, deps)).resolves.toMatchObject({ filename: 'actual.png' });
    expect(deps.ingestFromPath).toHaveBeenCalledWith({ sourcePath: '/tmp/actual.png', originalName: 'actual.png' });
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
