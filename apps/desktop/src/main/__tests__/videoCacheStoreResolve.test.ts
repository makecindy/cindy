/**
 * videoCacheStoreResolve.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the contract for `resolveSafe()` on the xdt-video:// scheme —
 * security-critical URL→path resolver behind the videoProtocol handler.
 *
 * Mirrors imageCacheStoreResolve.test.ts. If video is added under a new
 * reserved host later (kling/luma/wan), add a case here.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `video-cache-resolve-${randomUUID()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { resolveSafe } = await import('../videoCacheStore');

describe('videoCacheStore.resolveSafe', () => {
  it('lizi-art-media-videos host routes to the right cache dir', () => {
    const url = 'xdt-video://lizi-art-media-videos/abc.mp4';
    const { absPath, mimeType } = resolveSafe(url);
    expect(absPath).toBe(
      path.join(userDataDir, 'cc-agent', 'lizi-art-media', 'videos', 'abc.mp4'),
    );
    expect(mimeType).toBe('video/mp4');
  });

  it('mime is derived from extension', () => {
    expect(
      resolveSafe('xdt-video://lizi-art-media-videos/clip.webm').mimeType,
    ).toBe('video/webm');
    expect(
      resolveSafe('xdt-video://lizi-art-media-videos/clip.mov').mimeType,
    ).toBe('video/quicktime');
  });

  it('rejects path-traversal via filename', () => {
    expect(() =>
      resolveSafe('xdt-video://lizi-art-media-videos/..%2Fevil.mp4'),
    ).toThrow();
  });

  it('rejects unknown reserved host', () => {
    expect(() => resolveSafe('xdt-video://bogus-host/x.mp4')).toThrow(
      /unknown host/i,
    );
  });

  it('rejects wrong scheme', () => {
    expect(() => resolveSafe('xdt-image://lizi-art-media-videos/x.mp4')).toThrow(
      /invalid url/i,
    );
  });

  it('rejects malformed percent-encoding as a malformed URL', () => {
    expect(() => resolveSafe('xdt-video://lizi-art-media-videos/%E0%A4%A.mp4')).toThrow(
      /malformed url/i,
    );
  });
});
