/**
 * feishu/mediaStore.test.ts — getOrDownload 的媒体总仓缓存路由回归。
 * 钉死四条分支的"附件不丢"承诺(与 discord inbound.test.ts 同口径):
 *   - host 总仓命中 → 免下载直接复用;
 *   - host 索引坏账(有账无文件)→ 静默回落,不挡消息;
 *   - miss + 白名单 mime → 下载一次入仓;host 拒收 → 手头字节落老目录不二次下载;
 *   - 白名单外图片 / 非图片文件 / 无 media 注入 → 老目录行为不变。
 * 文件全部落 os.tmpdir() 并收尾清理(规则 23)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOrDownload } from '../mediaStore.js';
import { setHost } from '../moduleScope.js';
import { defaultLogger } from '../../logger.js';
import type { IMHost, IMHostMediaCache } from '../../types.js';

const tmpRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-media-store-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from('png-bytes');
const CINDY_URL = `cindy-media://blobs/${'a'.repeat(64)}.png`;

function makeMedia(overrides: Partial<IMHostMediaCache> = {}): IMHostMediaCache {
  return {
    cacheImage: vi.fn(async ({ token }: { token: string }) => ({
      absPath: `/blobs/${token}.png`,
      url: CINDY_URL,
    })),
    getCachedImage: vi.fn(async () => null),
    resolveMediaUrl: vi.fn(() => null),
    ...overrides,
  };
}

function wireHost(mediaDir: string, media?: IMHostMediaCache): void {
  const host = {
    paths: { feishuMediaDir: mediaDir },
    ...(media ? { media } : {}),
    secrets: {
      isAvailable: () => false,
      write: () => false,
      read: () => null,
      remove: () => {},
    },
    ipc: { handle: () => {}, broadcast: () => {} },
    httpPostForm: async () => ({ status: 200, body: {} }),
  } as unknown as IMHost;
  setHost(host, defaultLogger('im:feishu:test'));
}

let mediaDir = '';

beforeEach(() => {
  mediaDir = tempDir();
});

describe('getOrDownload(image, host 总仓路径)', () => {
  it('host 命中:免下载直接复用仓内文件(cached=true,url 透传)', async () => {
    const cachedFile = path.join(tempDir(), 'blob.png');
    fs.writeFileSync(cachedFile, PNG_BYTES);
    const media = makeMedia({
      getCachedImage: vi.fn(async () => ({ absPath: cachedFile, url: CINDY_URL, mimeType: 'image/png' })),
    });
    wireHost(mediaDir, media);
    const fetcher = vi.fn();

    const result = await getOrDownload('img-token-1', 'image', fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(media.cacheImage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      absPath: cachedFile,
      xdtImageUrl: CINDY_URL,
      mimeType: 'image/png',
      bytes: PNG_BYTES.byteLength,
      cached: true,
    });
  });

  it('host 索引坏账(有账无文件):静默回落到下载路径,附件不丢', async () => {
    const media = makeMedia({
      getCachedImage: vi.fn(async () => ({
        absPath: path.join(mediaDir, 'gone.png'), // 不存在,statSync 抛
        url: CINDY_URL,
        mimeType: 'image/png',
      })),
    });
    wireHost(mediaDir, media);
    const fetcher = vi.fn(async () => ({ buffer: PNG_BYTES, mimeType: 'image/png' }));

    const result = await getOrDownload('img-token-2', 'image', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(media.cacheImage).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.xdtImageUrl).toBe(CINDY_URL);
  });

  it('老目录命中(迁移前历史图):直接复用,不重下、不入仓', async () => {
    const legacyDir = path.join(mediaDir, 'images');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'img-token-3.png');
    fs.writeFileSync(legacyFile, PNG_BYTES);
    const media = makeMedia();
    wireHost(mediaDir, media);
    const fetcher = vi.fn();

    const result = await getOrDownload('img-token-3', 'image', fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(media.cacheImage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      absPath: legacyFile,
      mimeType: 'image/png',
      cached: true,
    });
    expect(result.xdtImageUrl).toContain('xdt-image://feishu-media-images/');
  });

  it('miss + 白名单 mime:下载一次入仓,不落老目录', async () => {
    const media = makeMedia();
    wireHost(mediaDir, media);
    const fetcher = vi.fn(async () => ({ buffer: PNG_BYTES, mimeType: 'image/PNG' }));

    const result = await getOrDownload('img-token-4', 'image', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(media.cacheImage).toHaveBeenCalledWith({
      integration: 'feishu',
      token: 'img-token-4',
      buffer: PNG_BYTES,
      mimeType: 'image/png', // 大小写归一后入仓
    });
    expect(result).toMatchObject({
      absPath: '/blobs/img-token-4.png',
      xdtImageUrl: CINDY_URL,
      cached: false,
    });
    expect(fs.existsSync(path.join(mediaDir, 'images', 'img-token-4.png'))).toBe(false);
  });

  it('host 仓拒收(cacheImage 抛):手头字节落老目录,不二次下载', async () => {
    const media = makeMedia({
      cacheImage: vi.fn(async () => {
        throw new Error('db not ready');
      }),
    });
    wireHost(mediaDir, media);
    const fetcher = vi.fn(async () => ({ buffer: PNG_BYTES, mimeType: 'image/png' }));

    const result = await getOrDownload('img-token-5', 'image', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const legacyFile = path.join(mediaDir, 'images', 'img-token-5.png');
    expect(fs.existsSync(legacyFile)).toBe(true);
    expect(fs.readFileSync(legacyFile)).toEqual(PNG_BYTES);
    expect(result).toMatchObject({
      absPath: legacyFile,
      xdtImageUrl: `xdt-image://feishu-media-images/${encodeURIComponent('img-token-5.png')}`,
      cached: false,
    });
  });

  it('白名单外图片 mime(svg):不入仓,直接老目录', async () => {
    const media = makeMedia();
    wireHost(mediaDir, media);
    const fetcher = vi.fn(async () => ({
      buffer: Buffer.from('<svg/>'),
      mimeType: 'image/svg+xml',
    }));

    const result = await getOrDownload('img-token-6', 'image', fetcher);

    expect(media.cacheImage).not.toHaveBeenCalled();
    expect(result.absPath).toBe(path.join(mediaDir, 'images', 'img-token-6.svg'));
  });
});

describe('getOrDownload(老路径不回归)', () => {
  it('非图片文件:即使注入 media 也走老目录,不碰总仓', async () => {
    const media = makeMedia();
    wireHost(mediaDir, media);
    const fetcher = vi.fn(async () => ({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
    }));

    const result = await getOrDownload('file-token-1', 'file', fetcher);

    expect(media.getCachedImage).not.toHaveBeenCalled();
    expect(media.cacheImage).not.toHaveBeenCalled();
    expect(result.absPath).toBe(path.join(mediaDir, 'files', 'file-token-1.pdf'));
    expect(result.xdtImageUrl).toContain('xdt-image://feishu-media-files/');
  });

  it('无 media 注入:图片走迁移前的老目录下载路径', async () => {
    wireHost(mediaDir);
    const fetcher = vi.fn(async () => ({ buffer: PNG_BYTES, mimeType: 'image/png' }));

    const result = await getOrDownload('img-token-7', 'image', fetcher);

    expect(result.absPath).toBe(path.join(mediaDir, 'images', 'img-token-7.png'));
    expect(result.cached).toBe(false);
  });
});
