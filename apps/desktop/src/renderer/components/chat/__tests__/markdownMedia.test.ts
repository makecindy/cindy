import { describe, expect, it } from 'vitest';

import { buildRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';
import { isManagedMarkdownVideoUrl, markdownMediaFilename } from '../markdownMedia';

describe('managed Markdown media', () => {
  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    'xdt-video://local/generated.webm',
    'cindy-remote-media://device/generated.mov?range=0-1',
  ])('recognizes %s as a video target', (url) => {
    expect(isManagedMarkdownVideoUrl(url)).toBe(true);
  });

  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    'https://example.com/generated.mp4',
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    undefined,
  ])('does not upgrade %s to a video target', (url) => {
    expect(isManagedMarkdownVideoUrl(url)).toBe(false);
  });

  it('decodes already encoded remote media URLs instead of looking for a visible extension', () => {
    const device = { kind: 'device', deviceId: 'dev-1' } as const;
    const encodedVideo = buildRemoteMediaUrl(device, 'xdt-video://local/generated.webm');
    const encodedImage = buildRemoteMediaUrl(device, 'cindy-media://blobs/aaaa.png');
    expect(isManagedMarkdownVideoUrl(encodedVideo)).toBe(true);
    expect(isManagedMarkdownVideoUrl(encodedImage)).toBe(false);
    expect(markdownMediaFilename(encodedVideo)).toBe('generated.webm');
  });

  it('prefers the Markdown alt text and falls back to the managed filename', () => {
    const url = 'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4';
    expect(markdownMediaFilename(url, 'Seedance 雪景版 KV 动态预览')).toBe(
      'Seedance 雪景版 KV 动态预览',
    );
    expect(markdownMediaFilename(url)).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    );
  });
});
