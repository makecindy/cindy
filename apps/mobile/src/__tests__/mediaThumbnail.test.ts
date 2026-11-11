import { describe, expect, it } from 'vitest';
import {
  attachmentImageDisplaySize,
  mediaThumbnailPhase,
  shouldAutoResolveMediaThumbnail,
  type MediaThumbnailResolveState,
  type MediaThumbnailSource,
} from '@/session/mediaThumbnail';
import type { MobileResolvedRemoteMedia } from '@/session/remoteMedia';

function image(url: string, previewable = false): MediaThumbnailSource {
  return { kind: 'image', url, previewable };
}

function resolved(previewable: boolean): MobileResolvedRemoteMedia {
  return {
    url: 'https://oss.example/a.png?sig=1',
    ossKey: 'key/a.png',
    mimeType: previewable ? 'image/png' : 'application/octet-stream',
    size: 1024,
    expiresAt: '2999-01-01T00:00:00.000Z',
    previewable,
  };
}

const idle: MediaThumbnailResolveState = { status: 'idle' };

describe('shouldAutoResolveMediaThumbnail', () => {
  it('auto-resolves only non-previewable desktop-local images with a resolver', () => {
    expect(shouldAutoResolveMediaThumbnail(image('xdt-image://cache/a.png'), true)).toBe(true);
    // 已可直接预览 → 不取件
    expect(shouldAutoResolveMediaThumbnail(image('https://x/a.png', true), true)).toBe(false);
    // 非桌面端 scheme → 不取件
    expect(shouldAutoResolveMediaThumbnail(image('https://x/a.png'), true)).toBe(false);
    expect(shouldAutoResolveMediaThumbnail(image(''), true)).toBe(false);
    // 无取件回调 → 不取件
    expect(shouldAutoResolveMediaThumbnail(image('xdt-image://cache/a.png'), false)).toBe(false);
    // video / audio 永远不自动取件
    expect(shouldAutoResolveMediaThumbnail({ kind: 'video', url: 'xdt-video://cache/a.mp4', previewable: false }, true)).toBe(false);
    expect(shouldAutoResolveMediaThumbnail({ kind: 'audio', url: 'xdt-audio://cache/a.mp3', previewable: false }, true)).toBe(false);
  });
});

describe('mediaThumbnailPhase', () => {
  it('shows a failed direct image as unavailable instead of an empty ready preview', () => {
    expect(mediaThumbnailPhase(image('https://x/expired.png', true), { status: 'error' }, true))
      .toEqual({ kind: 'fallback', reason: 'error' });
  });
  it('maps direct, resolving, resolved, and fallback states', () => {
    expect(mediaThumbnailPhase(image('https://x/a.png', true), idle, true)).toEqual({ kind: 'direct' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), idle, true)).toEqual({ kind: 'resolving' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), { status: 'loading' }, true)).toEqual({ kind: 'resolving' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), { status: 'ready', media: resolved(true) }, true))
      .toEqual({ kind: 'resolved', uri: 'https://oss.example/a.png?sig=1' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), { status: 'error' }, true))
      .toEqual({ kind: 'fallback', reason: 'error' });
  });

  it('falls back for non-image, non-desktop urls, missing resolver, and unsupported mime', () => {
    expect(mediaThumbnailPhase({ kind: 'video', url: 'xdt-video://cache/a.mp4', previewable: false }, idle, true))
      .toEqual({ kind: 'fallback', reason: 'not-image' });
    expect(mediaThumbnailPhase(image('ftp://x/a.png'), idle, true))
      .toEqual({ kind: 'fallback', reason: 'not-desktop-url' });
    expect(mediaThumbnailPhase(image(''), idle, true))
      .toEqual({ kind: 'fallback', reason: 'not-desktop-url' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), idle, false))
      .toEqual({ kind: 'fallback', reason: 'no-resolver' });
    expect(mediaThumbnailPhase(image('xdt-image://cache/a.png'), { status: 'ready', media: resolved(false) }, true))
      .toEqual({ kind: 'fallback', reason: 'unsupported-mime' });
  });
});

describe('attachmentImageDisplaySize', () => {
  it('contains landscape and portrait images inside the max box preserving aspect ratio', () => {
    // 横图:宽超限 → 以宽为约束
    expect(attachmentImageDisplaySize({ width: 1400, height: 700 }, 280, 180))
      .toEqual({ width: 280, height: 140 });
    // 竖图(截图典型):高超限 → 以高为约束
    expect(attachmentImageDisplaySize({ width: 1170, height: 2532 }, 280, 180))
      .toEqual({ width: 83, height: 180 });
  });

  it('never upscales images smaller than the max box', () => {
    expect(attachmentImageDisplaySize({ width: 120, height: 90 }, 280, 180))
      .toEqual({ width: 120, height: 90 });
  });

  it('falls back to a max-box placeholder frame while dimensions are unknown or invalid', () => {
    // 横图居多,max 框比例占位比正方形更接近最终尺寸,缩小换帧跳变(rule 7)
    expect(attachmentImageDisplaySize(null, 280, 180)).toEqual({ width: 280, height: 180 });
    expect(attachmentImageDisplaySize({ width: -1, height: -1 }, 280, 180))
      .toEqual({ width: 280, height: 180 });
    expect(attachmentImageDisplaySize({ width: 0, height: 100 }, 280, 180))
      .toEqual({ width: 280, height: 180 });
  });

  it('keeps at least 1pt per edge for extreme aspect ratios', () => {
    expect(attachmentImageDisplaySize({ width: 10000, height: 10 }, 280, 180))
      .toEqual({ width: 280, height: 1 });
  });
});
