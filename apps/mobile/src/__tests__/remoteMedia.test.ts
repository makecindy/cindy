import { describe, expect, it, vi } from 'vitest';
import {
  canPreviewResolvedRemoteMedia,
  formatRemoteMediaSize,
  isDesktopLocalMediaUrl,
  isResolvedRemoteMediaFresh,
  localCopyResolvedMedia,
  REMOTE_MEDIA_NEVER_EXPIRES,
  resolveMobileRemoteMedia,
} from '@/session/remoteMedia';

describe('mobile remote media', () => {
  it('recognizes desktop-local media schemes only', () => {
    expect(isDesktopLocalMediaUrl('xdt-image://cache/a.png')).toBe(true);
    expect(isDesktopLocalMediaUrl('xdt-video://cache/a.mp4')).toBe(true);
    expect(isDesktopLocalMediaUrl('xdt-audio://cache/a.mp3')).toBe(true);
    expect(isDesktopLocalMediaUrl('xdt-file://m?path=/tmp/a.pdf')).toBe(true);
    expect(isDesktopLocalMediaUrl('https://example.com/a.png')).toBe(false);
    expect(isDesktopLocalMediaUrl('xdt-model://asset.glb')).toBe(false);
  });

  it('resolves desktop media through device-link fetch plus server presign-get', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      ossKey: 'cindy/device-link/user-1/a.png',
      mimeType: 'image/png',
      size: 2048,
    }));
    const presignGet = vi.fn(async () => ({
      getUrl: 'https://oss.example/a.png?signature=1',
      expiresAt: '2026-06-16T10:05:00.000Z',
    }));

    await expect(resolveMobileRemoteMedia({
      kind: 'image',
      url: 'xdt-image://cache/a.png',
    }, { fetchRemoteMedia, presignGet })).resolves.toEqual({
      url: 'https://oss.example/a.png?signature=1',
      ossKey: 'cindy/device-link/user-1/a.png',
      mimeType: 'image/png',
      size: 2048,
      expiresAt: '2026-06-16T10:05:00.000Z',
      previewable: true,
    });
    expect(fetchRemoteMedia).toHaveBeenCalledWith('xdt-image://cache/a.png', undefined);
    expect(presignGet).toHaveBeenCalledWith('cindy/device-link/user-1/a.png');
  });

  it('hands the ossKey to onOssKey before presign, so a presign failure is still recoverable', async () => {
    // presign 失败会让本函数在返回之前抛错 —— 调用方拿不到 resolved 结果,围绕它写的
    // finally 不会执行,已上传的对象永久遗留(review P1)。onOssKey 让 key 在上传成功那一刻
    // 就交出去,失败路径也能 best-effort DELETE。
    const order: string[] = [];
    const fetchRemoteMedia = vi.fn(async () => {
      order.push('upload');
      return { ossKey: 'cindy/device-link/user-1/a.png', mimeType: 'image/png', size: 2048 };
    });
    const presignGet = vi.fn(async () => {
      order.push('presign');
      throw new Error('relay down');
    });
    const seen: string[] = [];

    await expect(resolveMobileRemoteMedia(
      { kind: 'image', url: 'xdt-image://cache/a.png' },
      { fetchRemoteMedia, presignGet },
      { onOssKey: (key) => { order.push('onOssKey'); seen.push(key); } },
    )).rejects.toThrow('relay down');

    expect(seen).toEqual(['cindy/device-link/user-1/a.png']);
    // 顺序必须是 上传 → 交出 key → presign,否则失败窗口依旧漏。
    expect(order).toEqual(['upload', 'onOssKey', 'presign']);
  });

  it('hands out the ossKey even when the fetch result fails validation (0-byte file)', async () => {
    // 合法的零字节文件(空 .css / .js)会因 `size > 0` 这条校验先抛错,而被控端的 PUT
    // 已经完成 —— key 必须在校验**之前**交出去,否则那个对象永久遗留(review P1)。
    const fetchRemoteMedia = vi.fn(async () => ({
      ossKey: 'cindy/device-link/user-1/empty.css',
      mimeType: 'text/css',
      size: 0,
    }));
    const seen: string[] = [];

    await expect(resolveMobileRemoteMedia(
      { kind: 'image', url: 'xdt-image://cache/empty.css' },
      { fetchRemoteMedia, presignGet: vi.fn() },
      { onOssKey: (key) => seen.push(key) },
    )).rejects.toThrow();

    expect(seen).toEqual(['cindy/device-link/user-1/empty.css']);
  });

  it('does not call onOssKey when there is no object at all (empty key)', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({ ossKey: '', mimeType: 'text/css', size: 0 }));
    const onOssKey = vi.fn();
    await expect(resolveMobileRemoteMedia(
      { kind: 'image', url: 'xdt-image://cache/x.css' },
      { fetchRemoteMedia, presignGet: vi.fn() },
      { onOssKey },
    )).rejects.toThrow();
    expect(onOssKey).not.toHaveBeenCalled();
  });

  it('does not call onOssKey for inline results (no OSS object to reclaim)', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      ossKey: '',
      mimeType: 'image/webp',
      size: 4096,
      inlineBase64: 'aGVsbG8=',
    }));
    const onOssKey = vi.fn();

    await resolveMobileRemoteMedia(
      { kind: 'image', url: 'xdt-image://cache/a.png' },
      { fetchRemoteMedia, presignGet: vi.fn() },
      { thumbnail: true, onOssKey },
    );
    expect(onOssKey).not.toHaveBeenCalled();
  });

  it('returns inline thumbnail bytes as a data uri without touching presign', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      ossKey: '',
      mimeType: 'image/webp',
      size: 4096,
      inlineBase64: 'aGVsbG8=',
    }));
    const presignGet = vi.fn();

    await expect(resolveMobileRemoteMedia({
      kind: 'image',
      url: 'xdt-image://cache/a.png',
    }, { fetchRemoteMedia, presignGet }, { thumbnail: true })).resolves.toMatchObject({
      url: 'data:image/webp;base64,aGVsbG8=',
      ossKey: '',
      mimeType: 'image/webp',
      size: 4096,
      previewable: true,
      inlineBase64: 'aGVsbG8=',
    });
    expect(fetchRemoteMedia).toHaveBeenCalledWith('xdt-image://cache/a.png', { thumbnail: true });
    expect(presignGet).not.toHaveBeenCalled();
  });

  it('falls back to the presign path when an old desktop ignores the thumbnail flag', async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      ossKey: 'cindy/device-link/user-1/a.png',
      mimeType: 'image/png',
      size: 2048,
    }));
    const presignGet = vi.fn(async () => ({
      getUrl: 'https://oss.example/a.png?signature=1',
      expiresAt: '2026-06-16T10:05:00.000Z',
    }));

    await expect(resolveMobileRemoteMedia({
      kind: 'image',
      url: 'xdt-image://cache/a.png',
    }, { fetchRemoteMedia, presignGet }, { thumbnail: true })).resolves.toMatchObject({
      url: 'https://oss.example/a.png?signature=1',
      ossKey: 'cindy/device-link/user-1/a.png',
    });
    expect(presignGet).toHaveBeenCalledWith('cindy/device-link/user-1/a.png');
  });

  it('marks resolved image, video, and audio media as mobile-previewable by MIME type', () => {
    expect(canPreviewResolvedRemoteMedia('video', 'video/mp4')).toBe(true);
    expect(canPreviewResolvedRemoteMedia('audio', 'audio/mpeg')).toBe(true);
    expect(canPreviewResolvedRemoteMedia('image', 'application/octet-stream')).toBe(false);
    expect(canPreviewResolvedRemoteMedia('video', 'application/octet-stream')).toBe(false);
  });

  it('guards cached presigned urls with a safety window', () => {
    const now = Date.parse('2026-06-16T10:00:00.000Z');
    expect(isResolvedRemoteMediaFresh({ expiresAt: '2026-06-16T10:02:00.000Z' }, now)).toBe(true);
    expect(isResolvedRemoteMediaFresh({ expiresAt: '2026-06-16T10:00:30.000Z' }, now)).toBe(false);
    expect(isResolvedRemoteMediaFresh({ expiresAt: 'bad-date' }, now)).toBe(false);
  });

  describe('localCopyResolvedMedia', () => {
    const resolved = {
      url: 'https://oss.example/obj?sig=abc',
      ossKey: 'user/obj-1',
      mimeType: 'image/png',
      size: 3_000_000,
      expiresAt: '2026-06-16T11:00:00.000Z',
      previewable: true,
    };

    it('swaps the presigned url for the local file and keeps the oss key', () => {
      // 保留 ossKey 是硬要求:对象仍在世,退屏清理靠它 DELETE。
      expect(localCopyResolvedMedia(resolved, {
        uri: 'file:///cache/obj-1.png',
        mimeType: 'image/png',
        size: 2_999_888,
      })).toEqual({
        url: 'file:///cache/obj-1.png',
        ossKey: 'user/obj-1',
        mimeType: 'image/png',
        size: 2_999_888,
        expiresAt: REMOTE_MEDIA_NEVER_EXPIRES,
        previewable: true,
      });
    });

    it('falls back to the presigned entry when the disk copy is unusable', () => {
      // 落盘被跳过(单对象超预算)/ 失败 / 落成了非图片:回落原条目,不能返回坏地址。
      expect(localCopyResolvedMedia(resolved, null)).toBeNull();
      expect(localCopyResolvedMedia(resolved, undefined)).toBeNull();
      expect(localCopyResolvedMedia(resolved, { uri: '', mimeType: 'image/png', size: 1 })).toBeNull();
      expect(localCopyResolvedMedia(resolved, {
        uri: 'file:///cache/obj-1.bin',
        mimeType: 'application/octet-stream',
        size: 1,
      })).toBeNull();
    });

    it('marks the local copy as non-expiring so reopening skips the network', () => {
      const local = localCopyResolvedMedia(resolved, {
        uri: 'file:///cache/obj-1.png',
        mimeType: 'image/png',
        size: 10,
      });
      // 队列按 isResolvedRemoteMediaFresh 判缓存可用性:本地文件必须恒 fresh,
      // 否则再次点开又会回到「重新取件 + 重新下载」。
      expect(local && isResolvedRemoteMediaFresh(local, Date.parse('2030-01-01T00:00:00.000Z'))).toBe(true);
    });
  });

  it('formats byte sizes compactly', () => {
    expect(formatRemoteMediaSize(0)).toBe('');
    expect(formatRemoteMediaSize(512)).toBe('512 B');
    expect(formatRemoteMediaSize(2048)).toBe('2.0 KB');
    expect(formatRemoteMediaSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
