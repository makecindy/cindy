/**
 * imageCacheStoreResolve.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the contract for `resolveSafe()` — the security-critical URL→path
 * resolver behind the `xdt-image://` protocol handler.
 *
 * Coverage:
 *   - Reserved host fast path (feishu-media-images / feishu-media-files)
 *     resolves to the right cache directory.
 *   - Reserved host rejects path-traversal in the filename.
 *   - Session-id path (existing behaviour) still works.
 *   - Unknown reserved-style hosts fall through to session-id validation.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `image-cache-resolve-${randomUUID()}`);

import { vi } from 'vitest';
vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { resolveSafe, resolveSessionImageLenient, collectSessionImageUrls } = await import('../imageCacheStore');

describe('resolveSafe — reserved hosts', () => {
  it('feishu-media-images host routes to feishu-media/images/', () => {
    const url = 'xdt-image://feishu-media-images/abc123.jpg';
    const { absPath, mimeType } = resolveSafe(url);

    const expected = path.join(
      userDataDir,
      'cc-agent',
      'feishu-media',
      'images',
      'abc123.jpg',
    );
    expect(absPath).toBe(expected);
    expect(mimeType).toBe('image/jpeg');
  });

  it('feishu-media-files host routes to feishu-media/files/', () => {
    const url = 'xdt-image://feishu-media-files/doc-token.pdf';
    const { absPath } = resolveSafe(url);

    const expected = path.join(
      userDataDir,
      'cc-agent',
      'feishu-media',
      'files',
      'doc-token.pdf',
    );
    expect(absPath).toBe(expected);
  });

  it('lizi-confluence-attachments host routes to lizi-confluence/attachments/', () => {
    const url = 'xdt-image://lizi-confluence-attachments/att140839020.png';
    const { absPath, mimeType } = resolveSafe(url);

    const expected = path.join(
      userDataDir,
      'cc-agent',
      'lizi-confluence',
      'attachments',
      'att140839020.png',
    );
    expect(absPath).toBe(expected);
    expect(mimeType).toBe('image/png');
  });

  it('lizi-confluence-attachments rejects subpath in filename', () => {
    // Confluence-specific regression: early layout was {attId}/{name},
    // which xdt-image:// scheme cannot resolve. Layout must stay flat.
    expect(() =>
      resolveSafe('xdt-image://lizi-confluence-attachments/att123%2Ffile.png'),
    ).toThrow(/path out of bounds/);
  });

  it('lizi-jira-attachments host routes to lizi-jira/attachments/', () => {
    const url = 'xdt-image://lizi-jira-attachments/12345.png';
    const { absPath, mimeType } = resolveSafe(url);

    const expected = path.join(
      userDataDir,
      'cc-agent',
      'lizi-jira',
      'attachments',
      '12345.png',
    );
    expect(absPath).toBe(expected);
    expect(mimeType).toBe('image/png');
  });

  it('lizi-jira-attachments rejects subpath in filename', () => {
    expect(() =>
      resolveSafe('xdt-image://lizi-jira-attachments/12345%2Fevil.png'),
    ).toThrow(/path out of bounds/);
  });

  it('preview filename (token.preview.jpg) resolves correctly under reserved host', () => {
    const url = 'xdt-image://feishu-media-images/abc.preview.jpg';
    const { absPath } = resolveSafe(url);
    expect(absPath.endsWith(path.join('feishu-media', 'images', 'abc.preview.jpg'))).toBe(true);
  });

  it('reserved host rejects filenames with path-traversal characters', () => {
    expect(() => resolveSafe('xdt-image://feishu-media-images/..%2Fevil.jpg')).toThrow(
      /path out of bounds/,
    );
    // %2F decodes to "/", which is also rejected
    expect(() => resolveSafe('xdt-image://feishu-media-images/sub%2Ffile.jpg')).toThrow(
      /path out of bounds/,
    );
  });

  it('reserved host rejects empty filename', () => {
    expect(() => resolveSafe('xdt-image://feishu-media-images/')).toThrow(/path out of bounds/);
  });
});

describe('resolveSafe — session-id path (regression)', () => {
  it('UUID session URL resolves under cc-agent/images/{sessionId}/ and does not collide with reserved hosts', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const url = `xdt-image://${sessionId}/myfile.png`;
    const { absPath, mimeType } = resolveSafe(url);
    const expected = path.join(userDataDir, 'cc-agent', 'images', sessionId, 'myfile.png');
    expect(absPath).toBe(expected);
    expect(mimeType).toBe('image/png');
  });

  it('valid session URL resolves under cc-agent/images/{sessionId}/', () => {
    const url = 'xdt-image://sess-abc/myfile.png';
    const { absPath, mimeType } = resolveSafe(url);
    const expected = path.join(userDataDir, 'cc-agent', 'images', 'sess-abc', 'myfile.png');
    expect(absPath).toBe(expected);
    expect(mimeType).toBe('image/png');
  });

  it('session URL with path-traversal in filename is rejected', () => {
    expect(() => resolveSafe('xdt-image://sess-abc/..%2Fevil.png')).toThrow(/path out of bounds/);
  });

  it('non-xdt-image URL is rejected', () => {
    expect(() => resolveSafe('http://example.com/x.png')).toThrow(/invalid url/);
  });

  it('rejects malformed percent-encoding as a malformed URL', () => {
    expect(() => resolveSafe('xdt-image://sess-abc/%E0%A4%A.png')).toThrow(
      /malformed url/,
    );
  });
});

describe('resolveSessionImageLenient — ghost attachment grant forms', () => {
  const cacheRoot = path.join(userDataDir, 'cc-agent', 'images');
  const sessionId = 'sess-lenient';
  const filename = 'aaaa1111-bbbb-2222-cccc-3333dddd4444-1700000000000.png';

  it('canonical session URL resolves (delegates to resolveSafe)', () => {
    const { absPath, mimeType } = resolveSessionImageLenient(
      `xdt-image://${sessionId}/${filename}`,
    );
    expect(absPath).toBe(path.join(cacheRoot, sessionId, filename));
    expect(mimeType).toBe('image/png');
  });

  it('absolute local path inside the cache root resolves', () => {
    const local = path.join(cacheRoot, sessionId, filename);
    const { absPath, mimeType } = resolveSessionImageLenient(local);
    expect(absPath).toBe(local);
    expect(mimeType).toBe('image/png');
  });

  it('absolute path outside the cache root is rejected', () => {
    expect(() =>
      resolveSessionImageLenient(path.join(userDataDir, 'somewhere-else', filename)),
    ).toThrow();
    // sibling dir whose name shares the cache-root prefix must not slip through
    expect(() =>
      resolveSessionImageLenient(path.join(userDataDir, 'cc-agent', 'images-evil', 's', 'f.png')),
    ).toThrow();
  });

  it('absolute path at wrong depth or meta sidecar is rejected', () => {
    // directly under cache root (1 level) / 3 levels deep
    expect(() => resolveSessionImageLenient(path.join(cacheRoot, filename))).toThrow();
    expect(() =>
      resolveSessionImageLenient(path.join(cacheRoot, sessionId, 'sub', filename)),
    ).toThrow();
    // meta sidecar stays host-private
    expect(() =>
      resolveSessionImageLenient(path.join(cacheRoot, sessionId, `${filename}.xdt-meta.json`)),
    ).toThrow();
  });

  it('xdt-image URL missing the session segment locates the file by scanning session dirs', async () => {
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.join(cacheRoot, sessionId), { recursive: true });
    await fsp.writeFile(path.join(cacheRoot, sessionId, filename), 'png-bytes');

    const { absPath, mimeType } = resolveSessionImageLenient(`xdt-image://${filename}`);
    expect(absPath).toBe(path.join(cacheRoot, sessionId, filename));
    expect(mimeType).toBe('image/png');
  });

  it('missing-session URL with no matching file on disk is rejected', () => {
    expect(() =>
      resolveSessionImageLenient('xdt-image://no-such-file-1700000000000.png'),
    ).toThrow();
  });

  it('ignores malformed percent-encoding while collecting session URLs', () => {
    expect(collectSessionImageUrls('see xdt-image://sess-lenient/%E0%A4%A.png')).toEqual([]);
  });
});
