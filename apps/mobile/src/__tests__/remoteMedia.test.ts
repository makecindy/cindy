import { describe, expect, it, vi } from 'vitest';
import {
  canPreviewResolvedRemoteMedia,
  formatRemoteMediaSize,
  isDesktopLocalMediaUrl,
  isResolvedRemoteMediaFresh,
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

  it('formats byte sizes compactly', () => {
    expect(formatRemoteMediaSize(0)).toBe('');
    expect(formatRemoteMediaSize(512)).toBe('512 B');
    expect(formatRemoteMediaSize(2048)).toBe('2.0 KB');
    expect(formatRemoteMediaSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
