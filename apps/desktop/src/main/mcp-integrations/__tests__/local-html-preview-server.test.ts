import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalPreviewServer,
  LocalPreviewError,
  type LocalPreviewServer,
} from '../local-html-preview-server.js';

/**
 * Sandboxed local HTML preview server tests: token scoping, path boundary
 * (traversal / encoded / backslash / dotfile / whitelist), response headers
 * (nosniff / no-store / CSP) and origin-grant lifecycle.
 */
describe('local-html-preview-server', () => {
  let tmpRoot: string;
  let workingDir: string;
  let previews: string[][];
  let server: LocalPreviewServer;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(nodePath.join(os.tmpdir(), 'preview-test-'));
    workingDir = nodePath.join(tmpRoot, 'work');
    await mkdir(nodePath.join(workingDir, 'dist'), { recursive: true });
    await mkdir(nodePath.join(workingDir, 'other'), { recursive: true });
    await writeFile(
      nodePath.join(workingDir, 'dist', 'index.html'),
      '<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script>',
    );
    await writeFile(nodePath.join(workingDir, 'dist', 'style.css'), 'body { color: red; }');
    await writeFile(nodePath.join(workingDir, 'dist', 'app.js'), 'console.log(1);');
    await writeFile(nodePath.join(workingDir, 'secret.json'), '{"password":"hunter2"}');
    await writeFile(nodePath.join(workingDir, '.env'), 'TOKEN=leak');
    await writeFile(nodePath.join(workingDir, 'other', 'data.json'), '{}');
    // hidden directories with whitelisted files — must stay unreachable
    await mkdir(nodePath.join(workingDir, 'dist', '.github'), { recursive: true });
    await writeFile(nodePath.join(workingDir, 'dist', '.github', 'data.json'), '{"hidden":true}');
    await mkdir(nodePath.join(workingDir, 'dist', '.config'), { recursive: true });
    await writeFile(nodePath.join(workingDir, 'dist', '.config', 'app.js'), 'console.log("hidden");');

    previews = [];
    server = createLocalPreviewServer({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      applyPreviewOrigins: (origins) => previews.push(origins),
    });
  });

  afterEach(() => {
    server.dispose();
  });

  async function createUrl(localPath = 'dist/index.html', opts?: { workingDir?: string }) {
    return server.createPreviewUrl({
      workingDir: opts?.workingDir ?? workingDir,
      localPath,
      sessionId: 'session-1',
    });
  }

  async function get(url: string, method = 'GET') {
    return fetch(url, { method, signal: AbortSignal.timeout(5000) });
  }

  it('serves the HTML entry with hardened response headers', async () => {
    const { url } = await createUrl();
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('sandbox allow-scripts allow-same-origin');
    // navigate-to is NOT relied on: Chromium does not implement it, so it
    // must not appear pretending to be a control that does not exist.
    expect(csp).not.toContain('navigate-to');
    // no remote subresources: https: must appear in NO directive
    expect(csp).not.toContain('https:');
    await res.arrayBuffer();
  });

  it('applies the same security headers to error/refusal responses', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    const res404 = await get(`${base}/../secret.json`); // traversal refusal
    expect(res404.status).toBe(404);
    expect(res404.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res404.headers.get('cache-control')).toBe('no-store');
    expect(res404.headers.get('content-security-policy')).toContain('connect-src');
    const res405 = await get(url, 'POST');
    expect(res405.status).toBe(405);
    expect(res405.headers.get('cache-control')).toBe('no-store');
    expect(res405.headers.get('content-security-policy')).toContain('sandbox');
    const res400 = await get(`${base}/%zz`); // undecodable → 400
    expect(res400.status).toBe(400);
    expect(res400.headers.get('cache-control')).toBe('no-store');
    expect(res400.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('refuses requests after the serving root is renamed (root identity pinned)', async () => {
    const { url } = await createUrl();
    expect((await get(url)).status).toBe(200);
    // Rename the entry dir away and put nothing in its place: the pinned root
    // no longer resolves to the same canonical path → refuse (fail-closed).
    const entryDir = nodePath.join(workingDir, 'dist');
    const renamed = nodePath.join(workingDir, 'dist-renamed');
    await import('node:fs/promises').then(({ rename }) => rename(entryDir, renamed));
    expect((await get(url)).status).toBe(404);
    // cleanup so afterEach dispose doesn't hit a stale path
    await import('node:fs/promises').then(({ rename }) => rename(renamed, entryDir));
  });

  it('refuses a served fd whose dev/ino differs from the pre-open snapshot (swap-and-restore)', async () => {
    // Simulates the round-10 attack: the pre-open `stat` snapshot is forged to
    // carry the victim file's size/timestamps but a DIFFERENT filesystem-object
    // identity (dev/ino), while `fs.open` really opens the outside file. The
    // size/timestamp comparison alone would pass; the dev/ino check must refuse.
    const { url } = await createUrl();
    const realStat = await fsPromises.stat(
      nodePath.join(workingDir, 'dist', 'index.html'),
      { bigint: true },
    );
    const forged = {
      ...realStat,
      size: realStat.size,
      mtimeNs: realStat.mtimeNs,
      birthtimeNs: realStat.birthtimeNs,
      dev: realStat.dev + 1n,
      ino: realStat.ino + 1n,
      isFile: () => true,
    };
    const statSpy = vi.spyOn(fsPromises, 'stat').mockResolvedValueOnce(forged as never);
    try {
      expect((await get(url)).status).toBe(404);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('serves relative CSS/JS resources from the entry directory', async () => {
    const { url } = await createUrl();
    const css = await get(url.replace('index.html', 'style.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    const js = await get(url.replace('index.html', 'app.js'));
    expect(js.status).toBe(200);
  });

  it('rejects path traversal and encoded variants', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    // raw ../ — rejected at the boundary
    expect((await get(`${base}/../secret.json`)).status).toBe(404);
    // percent-encoded dot-dot
    expect((await get(`${base}/%2e%2e/secret.json`)).status).toBe(404);
    // encoded backslash traversal (Windows separator)
    expect((await get(`${base}/..%5c..%5csecret.json`)).status).toBe(404);
    // plain backslash traversal
    expect((await get(`${base}/..\\..\\secret.json`)).status).toBe(404);
  });

  it('rejects dotfiles, non-whitelisted extensions and directory requests', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    expect((await get(`${base}/.env`)).status).toBe(404); // dotfile
    expect((await get(`${base}/secret.json`)).status).toBe(404); // json lives outside entry dir — also covered below
    expect((await get(`${base}/..`)).status).toBe(404); // directory-ish
    expect((await get(url)).status).toBe(200); // sanity
  });

  it('rejects symlink/junction escapes pointing outside the serving root', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    // A whitelisted-looking file that is actually a symlink to a file OUTSIDE
    // the entry directory must not be served (realpath re-check rejects it).
    const linkPath = nodePath.join(workingDir, 'dist', 'link.html');
    try {
      await symlink(nodePath.join(workingDir, 'secret.json'), linkPath);
    } catch {
      // Platform without symlink permission (e.g. Windows w/o developer mode):
      // nothing to assert, the rest of the suite still covers the boundary.
      return;
    }
    expect((await get(`${base}/link.html`)).status).toBe(404);
  });

  it('rejects hidden directory segments even when the file extension is whitelisted', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    // .github/data.json and .config/app.js are inside the serving root and
    // extension-whitelisted, but the hidden segment must still be refused.
    expect((await get(`${base}/.github/data.json`)).status).toBe(404);
    expect((await get(`${base}/.config/app.js`)).status).toBe(404);
  });

  it('does not serve anything outside the entry directory (serving root = entry dir)', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    // sibling of dist/ is outside the entry dir root
    expect((await get(`${base}/../secret.json`)).status).toBe(404);
  });

  it('rejects unknown tokens and wrong HTTP methods', async () => {
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    // token segment entirely missing → 404
    expect((await get(`${base.slice(0, base.indexOf('/preview/'))}/preview/index.html`)).status).toBe(404);
    expect((await get(`${base.replace(/preview\/[a-f0-9]{64}/, 'preview/0000000000000000000000000000000000000000000000000000000000000000')}/index.html`)).status).toBe(404);
    expect((await get(url, 'POST')).status).toBe(405);
    expect((await get(url, 'HEAD')).status).toBe(200);
  });

  it('refuses out-of-workingDir entries and non-HTML entries', async () => {
    await expect(createUrl(nodePath.join(tmpRoot, 'outside.html'))).rejects.toThrow(LocalPreviewError);
    await expect(createUrl('dist/app.js')).rejects.toThrow(/UNSUPPORTED_FILE/);
    await expect(createUrl('missing.html')).rejects.toThrow(LocalPreviewError);
  });

  it('grants the preview origin only after a successful bind, and revokes on dispose', async () => {
    // first createPreviewUrl starts the listener → grants exactly one origin
    await createUrl();
    expect(previews).toEqual([[expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]]);
    // dispose revokes immediately
    server.dispose();
    expect(previews.at(-1)).toEqual([]);
    // a new preview after dispose starts a fresh listener with a new grant
    await createUrl();
    expect(previews.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
  });

  it('fails closed when the workingDir is missing', async () => {
    await expect(createUrl('dist/index.html', { workingDir: '' })).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it('revokes expired tokens (TTL)', async () => {
    const ttlServer = createLocalPreviewServer({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      applyPreviewOrigins: () => {},
      tokenTtlMs: 30,
    });
    const { url } = await ttlServer.createPreviewUrl({ workingDir, localPath: 'dist/index.html' });
    expect((await get(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await get(url)).status).toBe(404); // token expired
    ttlServer.dispose();
  });
});
