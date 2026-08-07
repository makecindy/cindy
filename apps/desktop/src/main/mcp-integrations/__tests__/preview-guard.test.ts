import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isPreviewUrl,
  isPreviewUrlAuthorized,
  killPreviewWebRtc,
  setLivePreviewOrigin,
} from '../browser-backend/preview-guard.js';

const PREVIEW_URL =
  'http://127.0.0.1:49152/preview/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.html';

afterEach(() => {
  setLivePreviewOrigin(null);
});

describe('isPreviewUrl (shape check)', () => {
  it('accepts a plain preview URL', () => {
    expect(isPreviewUrl(PREVIEW_URL)).toBe(true);
  });

  it('rejects a userinfo variant of the same preview URL (P1, round 27)', () => {
    // `http://x@127.0.0.1:49152/preview/<token>/...` keeps the authorized
    // origin and preview path shape, but the preview server never issues
    // userinfo URLs — treating the variant as a preview page would let a
    // document whose serialized href defeats the kill-script's anchored
    // regex count as preview (codex-connector P1, round 27).
    expect(isPreviewUrl(PREVIEW_URL.replace('http://', 'http://x@'))).toBe(false);
    expect(isPreviewUrl(PREVIEW_URL.replace('http://', 'http://user:pass@'))).toBe(false);
  });

  it('rejects other hosts/ports/paths as before', () => {
    expect(isPreviewUrl('https://127.0.0.1:49152/preview/abc/index.html')).toBe(false);
    expect(isPreviewUrl('http://localhost:49152/preview/abc/index.html')).toBe(false);
    expect(isPreviewUrl('http://127.0.0.1:9999/preview/abc/index.html')).toBe(false);
    expect(isPreviewUrl('http://127.0.0.1:49152/other.html')).toBe(false);
  });
});

describe('isPreviewUrlAuthorized (live-origin check)', () => {
  it('requires the live origin to match', () => {
    expect(isPreviewUrlAuthorized(PREVIEW_URL)).toBe(false); // no live origin
    setLivePreviewOrigin('http://127.0.0.1:49152');
    expect(isPreviewUrlAuthorized(PREVIEW_URL)).toBe(true);
  });

  it('rejects a userinfo variant even when its origin is authorized (P1, round 27)', () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    // The origin matches, but the shape check must refuse the variant.
    expect(isPreviewUrlAuthorized(PREVIEW_URL.replace('http://', 'http://x@'))).toBe(false);
  });
});

describe('killPreviewWebRtc (CDP injection)', () => {
  function fakeWc() {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    // The debugger object is built separately so the closure never
    // self-references `wc` (which is cast to never for the call).
    const debuggerState = { attached: false };
    const debuggerObj = {
      isAttached: () => debuggerState.attached,
      attach: vi.fn(() => {
        debuggerState.attached = true;
      }),
      sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        return {};
      }),
    };
    const wc = { debugger: debuggerObj } as never;
    return { wc, sent };
  }

  it('injects a kill-script that judges the PARSED URL, not the raw href (P1, round 27)', async () => {
    const { wc, sent } = fakeWc();
    const ok = await killPreviewWebRtc(wc as never);
    expect(ok).toBe(true);
    const add = sent.find((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument');
    expect(add).toBeDefined();
    const source = String(add?.params?.source ?? '');
    // Anchored-href test would miss `http://x@127.0.0.1:...`; the parsed
    // hostname/pathname test matches it. Assert the injected source parses
    // the URL and checks hostname+pathname.
    expect(source).toContain('new URL(location.href)');
    expect(source).toContain("__u.hostname === '127.0.0.1'");
    expect(source).toContain('test(__u.pathname)');
    expect(source).not.toContain('127\\.0\\.0\\.1');
  });

  it('is idempotent per WebContents', async () => {
    const { wc, sent } = fakeWc();
    expect(await killPreviewWebRtc(wc as never)).toBe(true);
    expect(await killPreviewWebRtc(wc as never)).toBe(true);
    expect(sent.filter((s) => s.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
  });

  it('fails closed when the debugger is unavailable', async () => {
    const ok = await killPreviewWebRtc({} as never);
    expect(ok).toBe(false);
  });
});
