import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { createLocalPreviewServer, type LocalPreviewServer } from '../local-html-preview-server.js';

/**
 * End-to-end verification with a REAL Chrome (phase 2B): preview server +
 * system Chrome, covering page load, relative assets, JS/CSS execution,
 * screenshot, boundary refusals and CSP blocking. Requires a system Chrome
 * and network for the negative remote-asset check.
 */
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('e2e: previewLocalHtml with real Chrome', () => {
  it('loads assets, executes JS, screenshots, and refuses escapes (real Chrome)', async (ctx) => {
    // ── fixture workspace ──────────────────────────────────────────────
    const tmp = await mkdtemp(nodePath.join(os.tmpdir(), 'preview-e2e-'));
    const dist = nodePath.join(tmp, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(
      nodePath.join(dist, 'index.html'),
      `<!doctype html>
<html><head><title>Preview E2E</title>
<link rel="stylesheet" href="style.css">
</head><body>
<p id="marker">hello</p>
<img id="local" src="pixel.png" alt="pixel">
<img id="remote" src="https://example.com/missing.png" alt="remote">
<script src="app.js"></script>
</body></html>`,
    );
    await writeFile(nodePath.join(dist, 'style.css'), 'body { color: rgb(255, 0, 0); }');
    await writeFile(nodePath.join(dist, 'app.js'), 'window.__e2e = { ran: true };');
    await writeFile(nodePath.join(dist, 'pixel.png'), Buffer.from(RED_PNG_B64, 'base64'));
    await writeFile(nodePath.join(tmp, 'secret.json'), '{"top":"secret"}');
    await mkdir(nodePath.join(dist, '.config'), { recursive: true });
    await writeFile(nodePath.join(dist, '.config', 'data.json'), '{"hidden":true}');

    // ── preview server ─────────────────────────────────────────────────
    let granted: string[][] = [];
    const server: LocalPreviewServer = createLocalPreviewServer({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      applyPreviewOrigins: (origins) => granted.push(origins),
    });
    const { url } = await server.createPreviewUrl({ workingDir: tmp, localPath: 'dist/index.html' });
    expect(granted.at(-1)).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);

    // ── real Chrome ────────────────────────────────────────────────────
    // NOTE: the launch failure path must NOT return before the outer
    // try/finally below runs — a skipped test must still dispose the server
    // and delete the temp directory (new Codex reviewer P1, round 23).
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      // No system Chrome (e.g. a bare CI runner): skip instead of failing —
      // the suite's value is real-browser verification where Chrome exists.
      ctx.skip();
    }
    try {
      if (!browser) return;
      const page = await browser.newPage();
      // Mirrors the vendored addInitScript the managed Chrome injects on
      // preview pages (LOCAL PATCH in pw-session.ts): RTCPeerConnection is
      // shadowed before any page script runs. This probe verifies that
      // injection technique actually removes the constructor in real Chrome.
      await page.addInitScript(() => {
        try {
          // Scoped to the preview origin — matches the vendored injection
          // (round-10 P2): non-preview pages keep RTCPeerConnection.
          if (/^http:\/\/127\.0\.0\.1:\d+\/preview\/[a-f0-9]{64}\//.test(window.location.href)) {
            Object.defineProperty(window, 'RTCPeerConnection', {
              value: undefined,
              configurable: true,
            });
            Object.defineProperty(window, 'webkitRTCPeerConnection', {
              value: undefined,
              configurable: true,
            });
          }
        } catch {
          /* ignore */
        }
      });
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });

      // page + relative assets
      expect(await page.title()).toBe('Preview E2E');
      expect(await page.locator('#marker').textContent()).toBe('hello');

      // CSS applied
      const color = await page.evaluate(() => getComputedStyle(document.body).color);
      expect(color).toBe('rgb(255, 0, 0)');

      // JS executed
      expect(await page.evaluate(() => (window as { __e2e?: { ran: boolean } }).__e2e?.ran)).toBe(true);

      // local image loaded
      const localImgOk = await page.evaluate(() => {
        const img = document.getElementById('local') as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      });
      expect(localImgOk).toBe(true);

      // remote image BLOCKED by CSP (no https: subresources allowed)
      const remoteImgOk = await page.evaluate(() => {
        const img = document.getElementById('remote') as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      });
      expect(remoteImgOk).toBe(false);

      // screenshot works
      const shotPath = nodePath.join(tmp, 'preview-e2e.png');
      await page.screenshot({ path: shotPath });
      const { stat } = await import('node:fs/promises');
      expect((await stat(shotPath)).size).toBeGreaterThan(0);
      console.log(`[e2e] screenshot saved: ${shotPath}`);

      // boundary refusals from OUTSIDE the page (server-side, direct HTTP)
      const base = url.slice(0, url.lastIndexOf('/'));
      const statusOf = (p: string) => fetch(p).then((r) => r.status);
      expect(await statusOf(`${base}/../secret.json`)).toBe(404); // traversal
      expect(await statusOf(`${base}/%2e%2e/secret.json`)).toBe(404); // encoded traversal
      expect(await statusOf(`${base}/.config/data.json`)).toBe(404); // hidden segment
      expect(await statusOf(`${base}/secret.json`)).toBe(404); // outside entry dir

      // page-side fetch is blocked by CSP (connect-src 'none') — the page
      // has no channel to read same-origin file contents
      const pageFetch = await page.evaluate(async () => {
        try {
          await fetch('data.json');
          return 'allowed';
        } catch {
          return 'blocked';
        }
      });
      expect(pageFetch).toBe('blocked');

      // WebRTC is unavailable in the preview page: the injected kill-script
      // (mirror of the vendored addInitScript) shadows the constructor, so
      // the CSP-bypassing ICE/STUN/TURN exfiltration channel is closed.
      const rtcType = await page.evaluate(() => typeof RTCPeerConnection);
      expect(rtcType).toBe('undefined');

      // NOTE: the persistent route guard (exact-origin enforcement) is NOT
      // asserted here — this e2e runs a bare chromium.launch() with no
      // product guard, so a navigation-escape assertion would be invalid
      // (and flaky: it escapes on Windows, times out on Linux). The guard
      // is covered by the preview-guard unit tests (round 22, new Codex
      // reviewer).
    } finally {
      // Outermost nested finally: each cleanup step is individually guarded
      // so a throwing earlier step (e.g. browser.close() after a crash) can
      // never skip the server dispose or the temp-dir deletion — the exact
      // reliable-cleanup requirement (new Codex reviewer P1, round 23).
      try {
        await browser?.close();
      } catch {
        /* ignore: best-effort browser teardown */
      }
      // ── listener close invalidates the URL (server-side check) ─────────
      server.dispose();
      expect(granted.at(-1)).toEqual([]); // origin grant revoked
      // listener is closed → connection refused (URL no longer reachable)
      await expect(fetch(url, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch {
        /* ignore: best-effort temp cleanup */
      }
    }
  });
});
