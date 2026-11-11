/**
 * lightboxMediaActions 单测:URL 分类 / 文件名推导纯函数 + 三个 handler body
 * (注入内存 fake deps,不启动 Electron)。
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import {
  classifyLightboxMediaUrl,
  collectStreamWithLimit,
  decodeDataImageOrThrow,
  sniffImageMime,
  createLightboxMediaHandlers,
  extForMimeType,
  mimeTypeForExt,
  suggestSaveFileName,
  REMOTE_IMAGE_MAX_BYTES,
  type LightboxMediaDeps,
} from '../lightboxMediaActions';

// 生成平台正确的 xdt-file URL:win32 下 '/pics/x.png' 这类 POSIX 绝对路径会被
// path.resolve 补上盘符,而分类器要求 resolve/normalize 一致,直接编码 POSIX 路径会被拒。
const localFileUrl = (p: string) => `xdt-file://local/?path=${encodeURIComponent(path.resolve(p))}`;

// ---------------------------------------------------------------------------
// classifyLightboxMediaUrl
// ---------------------------------------------------------------------------

describe('classifyLightboxMediaUrl', () => {
  it('classifies xdt-image URLs as image-cache without resolving', () => {
    expect(classifyLightboxMediaUrl('xdt-image://sess-1/img.png')).toEqual({
      kind: 'image-cache',
      url: 'xdt-image://sess-1/img.png',
    });
  });

  it('extracts the absolute path from an xdt-file URL', () => {
    const abs = path.resolve('/tmp/pic.png');
    const url = `xdt-file://local/?path=${encodeURIComponent(abs)}`;
    expect(classifyLightboxMediaUrl(url)).toEqual({ kind: 'local-file', absPath: abs });
  });

  it('rejects relative paths; traversal segments are collapsed (isPathAllowed is the real boundary)', () => {
    expect(
      classifyLightboxMediaUrl('xdt-file://local/?path=relative%2Fpic.png').kind,
    ).toBe('unsupported');
    // 与 localFileProtocol 一致:normalize 折叠 `..` 后仍是绝对路径就放行分类,
    // 访问控制由 handler 层的 isPathAllowed 兜底。win32 下用带盘符的路径,
    // 否则 resolve 补盘符会与 normalize 不一致而被分类器拒绝。
    const traversal =
      process.platform === 'win32' ? 'C:\\tmp\\..\\etc\\passwd.png' : '/tmp/../etc/passwd.png';
    expect(
      classifyLightboxMediaUrl(
        `xdt-file://local/?path=${encodeURIComponent(traversal)}`,
      ),
    ).toEqual({ kind: 'local-file', absPath: path.resolve(traversal) });
  });

  it('rejects xdt-file URLs whose extension is not an image', () => {
    expect(
      classifyLightboxMediaUrl(
        localFileUrl('/tmp/movie.mp4'),
      ).kind,
    ).toBe('unsupported');
  });

  it('classifies http(s) and base64 data URLs', () => {
    expect(classifyLightboxMediaUrl('https://example.com/a.png')).toEqual({
      kind: 'http',
      url: 'https://example.com/a.png',
    });
    expect(classifyLightboxMediaUrl('data:image/png;base64,AAAA')).toEqual({
      kind: 'data',
      mimeType: 'image/png',
      base64: 'AAAA',
    });
  });

  it('rejects non-base64 data URLs, non-image data URLs and unknown schemes', () => {
    expect(classifyLightboxMediaUrl('data:text/plain;base64,AAAA').kind).toBe('unsupported');
    expect(classifyLightboxMediaUrl('data:image/png,rawtext').kind).toBe('unsupported');
    expect(classifyLightboxMediaUrl('blob:https://x/y').kind).toBe('unsupported');
    expect(classifyLightboxMediaUrl('').kind).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// suggestSaveFileName / mime helpers
// ---------------------------------------------------------------------------

describe('suggestSaveFileName', () => {
  const NOW = 1720000000000;

  it('uses the source file basename for local sources', () => {
    expect(
      suggestSaveFileName({ kind: 'image-cache', url: 'xdt-image://s/i.png' }, '/cache/s/i.png', NOW),
    ).toBe('i.png');
  });

  it('uses the URL basename for http sources when it looks like an image', () => {
    expect(
      suggestSaveFileName({ kind: 'http', url: 'https://x.com/a/b/photo.webp?v=1' }, null, NOW),
    ).toBe('photo.webp');
  });

  it('falls back to a timestamp name for extension-less http URLs', () => {
    expect(
      suggestSaveFileName({ kind: 'http', url: 'https://x.com/render?id=3' }, null, NOW),
    ).toBe(`image-${NOW}.png`);
  });

  it('derives the extension from the mime type for data URLs', () => {
    expect(
      suggestSaveFileName({ kind: 'data', mimeType: 'image/webp', base64: 'AA' }, null, NOW),
    ).toBe(`image-${NOW}.webp`);
  });
});

describe('decodeDataImageOrThrow', () => {
  it('decodes within the cap and rejects oversized payloads before allocating', () => {
    expect(decodeDataImageOrThrow(Buffer.from('hello').toString('base64')).toString()).toBe(
      'hello',
    );
    // 构造一个"声称"解码后超 100MB 的 base64 长度(不真分配 100MB 字符串
    // 内容——用 length 估算即拒,这里用足够长的空串填充验证阈值)。
    const oversizedLen = Math.ceil(((REMOTE_IMAGE_MAX_BYTES + 1024) * 4) / 3);
    const oversized = 'A'.repeat(oversizedLen);
    expect(() => decodeDataImageOrThrow(oversized)).toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('mime helpers', () => {
  it('maps ext <-> mime with png fallback', () => {
    expect(mimeTypeForExt('.webp')).toBe('image/webp');
    expect(mimeTypeForExt('.weird')).toBe('image/png');
    expect(extForMimeType('image/jpeg')).toBe('.jpg');
    expect(extForMimeType('application/pdf')).toBe('.png');
  });
});

// ---------------------------------------------------------------------------
// handler bodies
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<LightboxMediaDeps> = {}): LightboxMediaDeps {
  return {
    realpath: vi.fn(async (filePath: string) => filePath),
    isPathAllowed: () => true,
    resolveImageCacheUrl: (url) => ({
      absPath: `/cache/${url.replace('xdt-image://', '')}`,
      mimeType: 'image/png',
    }),
    cacheImageFromPath: vi.fn(async () => ({ url: 'xdt-image://target/new.png', filename: 'new.png' })),
    cacheImageFromBuffer: vi.fn(async () => ({ url: 'xdt-image://target/new.png', filename: 'new.png' })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/downloads/out.png' })),
    openPath: vi.fn(async () => ''),
    fetchRemoteImage: vi.fn(async () => ({
      buffer: Buffer.from('remote-bytes'),
      mimeType: 'image/webp',
    })),
    fetchRemoteMediaImage: vi.fn(async () => ({
      buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('remote-media')]),
      mimeType: 'image/jpeg',
    })),
    getTempDir: () => '/tmp-dir',
    fileExists: () => true,
    statSize: async () => 1234,
    copyFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.from('local-bytes')),
    getDownloadsDir: () => '/downloads',
    now: () => 1720000000000,
    ...overrides,
  };
}

describe('openWithDefaultApp', () => {
  it('resolves an xdt-image URL and opens the cached file', async () => {
    const deps = makeDeps();
    await createLightboxMediaHandlers(deps).openWithDefaultApp({
      url: 'xdt-image://s/i.png',
    });
    expect(deps.openPath).toHaveBeenCalledWith('/cache/s/i.png');
  });

  it('rejects remote sources with INVALID_PARAMS', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps()).openWithDefaultApp({
        url: 'https://x.com/a.png',
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects disallowed paths with PERMISSION_DENIED', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps({ isPathAllowed: () => false })).openWithDefaultApp({
        url: 'xdt-image://s/i.png',
      }),
    ).rejects.toThrow(/\[PERMISSION_DENIED\]/);
  });

  it('rejects missing files with NOT_FOUND', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps({ fileExists: () => false })).openWithDefaultApp({
        url: 'xdt-image://s/i.png',
      }),
    ).rejects.toThrow(/\[NOT_FOUND\]/);
  });

  it('surfaces shell.openPath error strings as INTERNAL', async () => {
    await expect(
      createLightboxMediaHandlers(
        makeDeps({ openPath: vi.fn(async () => 'no handler registered') }),
      ).openWithDefaultApp({ url: 'xdt-image://s/i.png' }),
    ).rejects.toThrow(/\[INTERNAL\] no handler registered/);
  });
});

describe('saveAs', () => {
  // Unified previews: PDF/video originals save with their names, while image-only
  // reading stays closed to binary files and protected symlink targets stay blocked.
  it.each(['report.pdf', 'clip.mp4', 'archive.zip'])(
    'saves the original %s without image decoding',
    async (name) => {
      const file = path.resolve('/tmp', name);
      const deps = makeDeps();
      const handlers = createLightboxMediaHandlers(deps);
      await expect(handlers.saveAs({ url: localFileUrl(file) })).resolves.toMatchObject({
        canceled: false,
      });
      expect(deps.showSaveDialog).toHaveBeenCalledWith({
        defaultPath: path.join('/downloads', name),
      });
      expect(deps.copyFile).toHaveBeenCalledWith(file, '/downloads/out.png');
      await expect(handlers.readImageBytes({ url: localFileUrl(file) })).rejects.toThrow();
    },
  );
  it('rejects an allowed-looking file that resolves to a blocked path before offering save', async () => {
    const blocked = path.resolve('/private/key');
    const deps = makeDeps({
      realpath: vi.fn(async () => blocked),
      isPathAllowed: (value) => value !== blocked,
    });
    await expect(
      createLightboxMediaHandlers(deps).saveAs({ url: localFileUrl('/tmp/document.pdf') }),
    ).rejects.toThrow();
    expect(deps.showSaveDialog).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
  });

  it('copies a local source to the chosen path', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).saveAs({
      url: 'xdt-image://s/i.png',
    });
    expect(result).toEqual({ canceled: false, savedPath: '/downloads/out.png' });
    expect(deps.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: path.join('/downloads', 'i.png'),
    });
    expect(deps.copyFile).toHaveBeenCalledWith('/cache/s/i.png', '/downloads/out.png');
  });

  it('returns canceled without touching bytes when the dialog is dismissed', async () => {
    const deps = makeDeps({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    const result = await createLightboxMediaHandlers(deps).saveAs({
      url: 'https://x.com/a.png',
    });
    expect(result).toEqual({ canceled: true });
    expect(deps.fetchRemoteImage).not.toHaveBeenCalled();
  });

  it('downloads http sources only after the dialog is confirmed', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).saveAs({
      url: 'https://x.com/photo.png',
    });
    expect(result.canceled).toBe(false);
    expect(deps.fetchRemoteImage).toHaveBeenCalledWith('https://x.com/photo.png');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/downloads/out.png',
      Buffer.from('remote-bytes'),
    );
  });

  it('decodes data URLs to bytes', async () => {
    const deps = makeDeps();
    const payload = Buffer.from('hello').toString('base64');
    await createLightboxMediaHandlers(deps).saveAs({
      url: `data:image/png;base64,${payload}`,
    });
    expect(deps.writeFile).toHaveBeenCalledWith('/downloads/out.png', Buffer.from('hello'));
  });

  it('rejects unsupported sources with INVALID_PARAMS', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps()).saveAs({ url: 'blob:https://x/y' }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });

  it('wraps write failures as INTERNAL', async () => {
    await expect(
      createLightboxMediaHandlers(
        makeDeps({ copyFile: vi.fn(async () => Promise.reject(new Error('disk full'))) }),
      ).saveAs({ url: 'xdt-image://s/i.png' }),
    ).rejects.toThrow(/\[INTERNAL\] disk full/);
  });
});

describe('collectStreamWithLimit', () => {
  function readerOf(chunks: Uint8Array[]) {
    let i = 0;
    return {
      read: async () =>
        i < chunks.length ? { done: false, value: chunks[i++] } : { done: true as const },
    };
  }

  it('concatenates chunks under the limit', async () => {
    const buf = await collectStreamWithLimit(
      readerOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
      10,
    );
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it('throws as soon as accumulated bytes exceed the limit without draining the stream', async () => {
    let reads = 0;
    const endless = {
      read: async () => {
        reads += 1;
        return { done: false, value: new Uint8Array(1024) };
      },
    };
    await expect(collectStreamWithLimit(endless, 4096)).rejects.toThrow();
    expect(reads).toBeLessThanOrEqual(5);
  });
});

describe('sniffImageMime', () => {
  it('recognizes png / jpeg / gif / webp magic bytes', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('returns null for unknown bytes', () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="..."/>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('remote-media source', () => {
  it('classifies cindy-remote-media urls', () => {
    expect(classifyLightboxMediaUrl('cindy-remote-media://m/abc/def').kind).toBe('remote-media');
  });

  it('caches remote-media bytes for session sends', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).cacheForSession({
      url: 'cindy-remote-media://m/abc/def',
      sessionId: 'target',
    });
    expect(deps.fetchRemoteMediaImage).toHaveBeenCalled();
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('save-as fetches remote bytes and writes them to the chosen path', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).saveAs({
      url: 'cindy-remote-media://m/abc/def',
    });
    expect(result.canceled).toBe(false);
    expect(deps.writeFile).toHaveBeenCalled();
  });

  it('open-with-default-app drops remote bytes into a temp file and opens it', async () => {
    const deps = makeDeps();
    await createLightboxMediaHandlers(deps).openWithDefaultApp({
      url: 'cindy-remote-media://m/abc/def',
    });
    const written = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // 生产用 path.join 拼临时路径,win32 下是反斜杠,前缀比较走 normalize。
    expect(written.startsWith(path.normalize('/tmp-dir/'))).toBe(true);
    expect(written.endsWith('.jpg')).toBe(true);
    expect(deps.openPath).toHaveBeenCalledWith(written);
  });

  it('open-with-default-app reuses a stable per-URL temp path (no unbounded growth)', async () => {
    const deps = makeDeps();
    const handlers = createLightboxMediaHandlers(deps);
    await handlers.openWithDefaultApp({ url: 'cindy-remote-media://m/abc/def' });
    await handlers.openWithDefaultApp({ url: 'cindy-remote-media://m/abc/def' });
    await handlers.openWithDefaultApp({ url: 'cindy-remote-media://m/abc/other' });
    const writes = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(writes[0]).toBe(writes[1]); // 同 URL 重开覆盖同一文件
    expect(writes[2]).not.toBe(writes[0]); // 不同 URL 各自独立
  });

  it('readImageBytes serves http and remote-media, rejects image-cache sources', async () => {
    const deps = makeDeps();
    const handlers = createLightboxMediaHandlers(deps);
    const remote = await handlers.readImageBytes({ url: 'cindy-remote-media://m/abc/def' });
    expect(remote.mimeType).toBe('image/jpeg');
    // xdt-image:// renderer 直读 readCachedImageAsBase64,不走本 IPC。
    await expect(handlers.readImageBytes({ url: 'xdt-image://s/i.png' })).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
  });

  it('readImageBytes serves local files with ext-derived mime, no attachment cap', async () => {
    const deps = makeDeps({ statSize: async () => 50 * 1024 * 1024 }); // 50MB > 附件 30MB 上限
    const res = await createLightboxMediaHandlers(deps).readImageBytes({
      url: localFileUrl('/pics/diagram.svg'),
    });
    expect(res.mimeType).toBe('image/svg+xml');
    expect(Buffer.from(res.base64, 'base64').toString()).toBe('local-bytes');
  });

  it('readImageBytes wraps local fs errors as [INTERNAL] (TOCTOU ENOENT etc.)', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT: no such file or directory');
      }),
    });
    await expect(
      createLightboxMediaHandlers(deps).readImageBytes({
        url: localFileUrl('/pics/gone.png'),
      }),
    ).rejects.toThrow(/\[INTERNAL\]/);
  });

  it('readImageBytes rejects oversized local files and non-image extensions', async () => {
    const over = makeDeps({ statSize: async () => 101 * 1024 * 1024 });
    await expect(
      createLightboxMediaHandlers(over).readImageBytes({
        url: localFileUrl('/pics/big.png'),
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    // 非图片扩展名在 classify 层就被拒(IMAGE_EXTS 白名单)
    await expect(
      createLightboxMediaHandlers(makeDeps()).readImageBytes({
        url: localFileUrl('/pics/data.txt'),
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('cacheForSession', () => {
  it('re-caches a local source into the target session with draft lifecycle', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).cacheForSession({
      url: 'xdt-image://s/i.png',
      sessionId: 'target',
    });
    expect(deps.cacheImageFromPath).toHaveBeenCalledWith({
      sessionId: 'target',
      sourcePath: '/cache/s/i.png',
      originalName: 'i.png',
      lifecycle: 'draft',
    });
    expect(result).toEqual({
      url: 'xdt-image://target/new.png',
      name: 'i.png',
      ext: '.png',
      mimeType: 'image/png',
      size: 1234,
    });
  });

  it('downloads http sources and caches the buffer', async () => {
    const deps = makeDeps();
    const result = await createLightboxMediaHandlers(deps).cacheForSession({
      url: 'https://x.com/photo.webp',
      sessionId: 'target',
    });
    expect(deps.cacheImageFromBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'target',
        mimeType: 'image/webp',
        lifecycle: 'draft',
      }),
    );
    expect(result.ext).toBe('.webp');
    expect(result.size).toBe(Buffer.from('remote-bytes').byteLength);
  });

  it('sniffs the mime from bytes when the http response has no trusted content-type', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest')]);
    const deps = makeDeps({
      fetchRemoteImage: vi.fn(async () => ({ buffer: jpeg, mimeType: undefined })),
    });
    const result = await createLightboxMediaHandlers(deps).cacheForSession({
      url: 'https://x.com/render?id=3',
      sessionId: 'target',
    });
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.ext).toBe('.jpg');
    expect(deps.cacheImageFromBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg' }),
    );
  });

  it('rejects http bytes that cannot be identified as a supported image', async () => {
    const deps = makeDeps({
      fetchRemoteImage: vi.fn(async () => ({ buffer: Buffer.from('<html>not an image'), mimeType: undefined })),
    });
    await expect(
      createLightboxMediaHandlers(deps).cacheForSession({
        url: 'https://x.com/page',
        sessionId: 'target',
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(deps.cacheImageFromBuffer).not.toHaveBeenCalled();
  });

  it('requires a sessionId', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps()).cacheForSession({
        url: 'xdt-image://s/i.png',
        sessionId: '',
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });

  it('keeps IpcError codes from local resolution failures', async () => {
    await expect(
      createLightboxMediaHandlers(makeDeps({ fileExists: () => false })).cacheForSession({
        url: 'xdt-image://s/i.png',
        sessionId: 'target',
      }),
    ).rejects.toThrow(/\[NOT_FOUND\]/);
  });

  it('rejects local sources whose extension the image cache would corrupt (svg/bmp/ico)', async () => {
    const deps = makeDeps();
    const svgUrl = localFileUrl('/tmp/logo.svg');
    await expect(
      createLightboxMediaHandlers(deps).cacheForSession({ url: svgUrl, sessionId: 'target' }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(deps.cacheImageFromPath).not.toHaveBeenCalled();
  });

  it('rejects non-cacheable data URL mimes (svg)', async () => {
    const deps = makeDeps();
    await expect(
      createLightboxMediaHandlers(deps).cacheForSession({
        url: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
        sessionId: 'target',
      }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(deps.cacheImageFromBuffer).not.toHaveBeenCalled();
  });

  it('wraps Node fs errors (string code, not an IpcErrorCode) as INTERNAL', async () => {
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    await expect(
      createLightboxMediaHandlers(
        makeDeps({ cacheImageFromPath: vi.fn(async () => Promise.reject(enospc)) }),
      ).cacheForSession({ url: 'xdt-image://s/i.png', sessionId: 'target' }),
    ).rejects.toThrow(/\[INTERNAL\] no space left on device/);
  });

  it('wraps cache write failures as INTERNAL', async () => {
    await expect(
      createLightboxMediaHandlers(
        makeDeps({
          cacheImageFromPath: vi.fn(async () => Promise.reject(new Error('cache dir gone'))),
        }),
      ).cacheForSession({ url: 'xdt-image://s/i.png', sessionId: 'target' }),
    ).rejects.toThrow(/\[INTERNAL\] cache dir gone/);
  });
});
