/**
 * ghostAttachmentResolve.test.ts
 * ---------------------------------------------------------------------------
 * ghost 附件过户地址解析的回归测试。锁三层行为:
 *   1. 会话图片缓存的宽容解析透传(canonical / 缓存内绝对路径);
 *   2. 媒体总仓 blob(聊天附件或 Agent 工具结果)——绝对路径按指纹反推
 *      规范路径逐字节比对,URL 形走 parseBlobUrl,媒体类型走 blobStore 白名单;
 *   3. maker-core 缩图缓存路径(大图送模型前被 image-resizer 透明替换,
 *      模型只有副本路径)——只认恰好一级深、真实存在的文件。
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `ghost-att-resolve-${randomUUID()}`);
const resizeCacheDir = path.join(os.tmpdir(), `ghost-att-resize-${randomUUID()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { configureDefaultImageResizer } = await import('@cindy/maker-core');
const { resolveGhostAttachmentUrl } = await import('../ghostAttachmentResolve');

const cacheRoot = path.join(userDataDir, 'cc-agent', 'images');
const sessionId = 'sess-ghost-att';
const cachedFilename = 'bbbb2222-cccc-3333-dddd-4444eeee5555-1700000000001.png';
const resizedFilename = `${'a'.repeat(64)}.webp`;
// 媒体总仓 blob:图片与视频各一枚(规范分桶)。
const blobsRoot = path.join(userDataDir, 'cindy-media', 'blobs');
const imageBlobHash = 'c'.repeat(64);
const imageBlobPath = path.join(blobsRoot, 'cc', `${imageBlobHash}.jpg`);
const videoBlobHash = 'd'.repeat(64);
const videoBlobPath = path.join(blobsRoot, 'dd', `${videoBlobHash}.mp4`);

beforeAll(async () => {
  configureDefaultImageResizer({ cacheDir: resizeCacheDir });
  await fsp.mkdir(path.join(cacheRoot, sessionId), { recursive: true });
  await fsp.writeFile(path.join(cacheRoot, sessionId, cachedFilename), 'png-bytes');
  await fsp.mkdir(resizeCacheDir, { recursive: true });
  await fsp.writeFile(path.join(resizeCacheDir, resizedFilename), 'webp-bytes');
  await fsp.mkdir(path.dirname(imageBlobPath), { recursive: true });
  await fsp.writeFile(imageBlobPath, 'jpg-bytes');
  await fsp.mkdir(path.dirname(videoBlobPath), { recursive: true });
  await fsp.writeFile(videoBlobPath, 'mp4-bytes');
});

describe('resolveGhostAttachmentUrl', () => {
  it('canonical xdt-image URL resolves via the lenient session resolver', () => {
    const { absPath, mimeType } = resolveGhostAttachmentUrl(
      `xdt-image://${sessionId}/${cachedFilename}`,
    );
    expect(absPath).toBe(path.join(cacheRoot, sessionId, cachedFilename));
    expect(mimeType).toBe('image/png');
  });

  it('absolute path inside the session image cache resolves', () => {
    const local = path.join(cacheRoot, sessionId, cachedFilename);
    expect(resolveGhostAttachmentUrl(local).absPath).toBe(local);
  });

  it('resize-cache path (screenshot resized copy) resolves with webp mime', () => {
    const local = path.join(resizeCacheDir, resizedFilename);
    const { absPath, mimeType } = resolveGhostAttachmentUrl(local);
    expect(absPath).toBe(local);
    expect(mimeType).toBe('image/webp');
  });

  it('resize-cache path is rejected when the file does not exist (LRU evicted)', () => {
    expect(() =>
      resolveGhostAttachmentUrl(path.join(resizeCacheDir, `${'b'.repeat(64)}.webp`)),
    ).toThrow();
  });

  it('subpath under the resize cache dir is rejected', () => {
    expect(() =>
      resolveGhostAttachmentUrl(path.join(resizeCacheDir, 'sub', resizedFilename)),
    ).toThrow();
  });

  it('absolute path outside both roots is rejected', () => {
    expect(() =>
      resolveGhostAttachmentUrl(path.join(os.tmpdir(), 'unrelated-dir', 'x.png')),
    ).toThrow();
  });

  it('媒体总仓 blob 绝对路径(聊天附件迁总仓后的用户图身份)解析成功并带回指纹', () => {
    const { absPath, mimeType, blobHash } = resolveGhostAttachmentUrl(imageBlobPath);
    expect(absPath).toBe(imageBlobPath);
    expect(mimeType).toBe('image/jpeg');
    expect(blobHash).toBe(imageBlobHash); // 接线层据此加账本出生闸
  });

  it('cindy-media://blobs/ URL 形同样解析成功', () => {
    const { absPath, mimeType, blobHash } = resolveGhostAttachmentUrl(
      `cindy-media://blobs/${imageBlobHash}.jpg`,
    );
    expect(absPath).toBe(imageBlobPath);
    expect(mimeType).toBe('image/jpeg');
    expect(blobHash).toBe(imageBlobHash);
  });

  it('会话图缓存层解析不带 blobHash(可达面天然限于进过会话的图,无需账本闸)', () => {
    expect(
      resolveGhostAttachmentUrl(`xdt-image://${sessionId}/${cachedFilename}`).blobHash,
    ).toBeUndefined();
  });

  it('blob 路径分桶目录与指纹前两位不符 → 拒(不信任传入路径)', async () => {
    const wrongBucket = path.join(blobsRoot, 'zz', `${imageBlobHash}.jpg`);
    await fsp.mkdir(path.dirname(wrongBucket), { recursive: true });
    await fsp.writeFile(wrongBucket, 'jpg-bytes');
    expect(() => resolveGhostAttachmentUrl(wrongBucket)).toThrow();
  });

  it('当前 Agent 生成的视频 blob 可按路径或受管 URL 交给插件', () => {
    expect(resolveGhostAttachmentUrl(videoBlobPath)).toEqual({
      absPath: videoBlobPath,
      mimeType: 'video/mp4',
      blobHash: videoBlobHash,
    });
    expect(resolveGhostAttachmentUrl(`cindy-media://blobs/${videoBlobHash}.mp4`)).toEqual({
      absPath: videoBlobPath,
      mimeType: 'video/mp4',
      blobHash: videoBlobHash,
    });
  });

  it('指纹形状合格但文件不存在 → 拒', () => {
    expect(() =>
      resolveGhostAttachmentUrl(path.join(blobsRoot, 'ee', `${'e'.repeat(64)}.jpg`)),
    ).toThrow();
  });
});
