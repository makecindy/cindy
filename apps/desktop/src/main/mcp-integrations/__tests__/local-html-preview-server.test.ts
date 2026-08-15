import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('sandbox allow-scripts allow-same-origin');
    // LOAD-BEARING #1 — Service Worker script loads fall back to script-src
    // when worker-src is absent; a registered SW OUTLIVES the preview and
    // answers later navigations with synthetic responses carrying none of
    // these headers (codex-connector P1).
    expect(csp).toContain("worker-src 'none'");
    // LOAD-BEARING #2 — the preview page sits on loopback, where browsers
    // restrict private→private requests far less than public→private, and
    // page-context fetch does not pass through the Node SSRF guard. 'self'
    // keeps the page off every OTHER local service (notably the managed
    // browser's own CDP port).
    expect(csp).toContain("connect-src 'self'");
    // ...but it must NOT be 'none': a preview page that cannot read its own
    // data files renders blank, the screenshot is useless, and callers go
    // back to launching a raw browser — the incident this feature prevents.
    expect(csp).not.toContain("connect-src 'none'");
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

  it('refuses an ENTRY whose realpath target is NOT an HTML file, even when the symlink name ends in .html (P2)', async () => {
    // `index.html -> app.js`: the lexical check passes on the link name, but
    // the REAL entry is a plain JS file — serving it would violate the
    // .html/.htm-only entry contract (and its dir would become the root).
    await writeFile(nodePath.join(workingDir, 'dist', 'app.js'), 'export const x = 1;');
    const linkPath = nodePath.join(workingDir, 'dist', 'index.html');
    try {
      await symlink('app.js', linkPath, 'file');
    } catch {
      // Platform without symlink permission: nothing to assert.
      return;
    }
    await expect(createUrl('dist/index.html')).rejects.toThrow(/UNSUPPORTED_FILE/);
  });

  it('refuses an ENTRY that resolves into a hidden directory via an ordinary-named symlink (codex-connector P1)', async () => {
    // `public -> .private` passes the lexical hidden-segment check, but the
    // REAL entry path lands in a hidden directory which would become the
    // serving root.
    await mkdir(nodePath.join(workingDir, '.private'), { recursive: true });
    await writeFile(nodePath.join(workingDir, '.private', 'index.html'), '<p>hidden</p>');
    const linkPath = nodePath.join(workingDir, 'public');
    try {
      await symlink('.private', linkPath, 'dir');
    } catch {
      // Platform without symlink permission: nothing to assert.
      return;
    }
    await expect(createUrl('public/index.html')).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it('rejects a symlink with an ordinary name that resolves into a hidden directory (Greptile P1)', async () => {
    // `assets -> .private` passes the request-path hidden-segment check
    // ("assets" is not hidden), but realpath resolves into `.private` — the
    // REAL path must be re-checked for hidden segments.
    const { url } = await createUrl();
    const base = url.slice(0, url.lastIndexOf('/'));
    await mkdir(nodePath.join(workingDir, 'dist', '.private'), { recursive: true });
    await writeFile(nodePath.join(workingDir, 'dist', '.private', 'secret.json'), '{"hidden":true}');
    const linkPath = nodePath.join(workingDir, 'dist', 'assets');
    try {
      await symlink('.private', linkPath, 'dir');
    } catch {
      // Platform without symlink permission: nothing to assert.
      return;
    }
    expect((await get(`${base}/assets/secret.json`)).status).toBe(404);
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
    expect(previews).toEqual([[expect.stringMatching(/^http:\/\/127.0.0.1:\d+$/)]]);
    // dispose revokes immediately
    server.dispose();
    expect(previews.at(-1)).toEqual([]);
    // a new preview after dispose starts a fresh listener with a new grant
    await createUrl();
    expect(previews.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127.0.0.1:\d+$/)]);
  });

  it('concurrent requests share one in-flight startup, and dispose revocation stays the last grant (Copilot P1)', async () => {
    // Two requests arriving while startup is still in flight must share the
    // SAME `starting` promise (dispose no longer nulls it, and
    // ensureStarted clears it only after settle) — one listener, one grant.
    // This is the observable half of the Copilot P1 race: if a fresh round
    // started per request (starting cleared early), the second request would
    // reset `disposed` mid-flight and the first round could grant an origin
    // it no longer owns.
    const [a, b] = await Promise.all([createUrl(), createUrl()]);
    const grants = previews.filter((p) => p.length > 0);
    expect(grants.length).toBe(1);
    expect(new URL(a.url).origin).toBe(new URL(b.url).origin);
    // Dispose revocation is applied, and a subsequent request starts a
    // FRESH listener with a new grant (reuse contract preserved).
    server.dispose();
    expect(previews.at(-1)).toEqual([]);
    await createUrl();
    expect(previews.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127.0.0.1:\d+$/)]);
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

  it('refuses an ENTRY inside a hidden directory (Greptile P1)', async () => {
    // The serving root IS the entry's directory, so request-stage
    // hidden-segment checks can never see a hidden root — the entry path
    // itself must be rejected up front.
    await mkdir(nodePath.join(workingDir, '.private'), { recursive: true });
    await writeFile(nodePath.join(workingDir, '.private', 'index.html'), '<p>hidden</p>');
    await expect(createUrl('.private/index.html')).rejects.toThrow(/PATH_NOT_ALLOWED/);
    // nested hidden segment inside a normal tree is rejected too
    await mkdir(nodePath.join(workingDir, 'dist', '.private'), { recursive: true });
    await writeFile(nodePath.join(workingDir, 'dist', '.private', 'index.html'), '<p>hidden</p>');
    await expect(createUrl('dist/.private/index.html')).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });
});
