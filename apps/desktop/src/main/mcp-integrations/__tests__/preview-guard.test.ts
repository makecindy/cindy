import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  guardPreviewPageNavigation,
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

function fakeWcForGuard(initialUrl: string) {
  const ee = new EventEmitter();
  let currentUrl = initialUrl;
  const stopped: unknown[] = [];
  const loaded: unknown[] = [];
  const wc = {
    ee,
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    getURL: () => currentUrl,
    setURL: (u: string) => {
      currentUrl = u;
    },
    stop: () => {
      stopped.push(true);
    },
    loadURL: async (u: string) => {
      loaded.push(u);
      currentUrl = u;
    },
    emitWillNavigate: (u: string) => {
      const ev = { preventDefault: vi.fn() };
      ee.emit('will-navigate', ev, u);
      return ev;
    },
    emitDidStart: (u: string, isInPlace = false) => {
      // A navigation STARTS (does not yet update the URL for the purpose of
      // identity — identity clearing now happens on did-navigate).
      ee.emit('did-start-navigation', {}, u, isInPlace, true);
    },
    emitDidNavigate: (u: string) => {
      // A main-frame navigation COMMITS (matches real WebContents).
      currentUrl = u;
      ee.emit('did-navigate', {}, u);
    },
    stopped,
    loaded,
  };
  return wc as unknown as {
    on: (e: string, l: (...a: unknown[]) => void) => unknown;
    once: (e: string, l: (...a: unknown[]) => void) => unknown;
    getURL(): string;
    setURL(u: string): void;
    stop(): void;
    loadURL(u: string): Promise<void>;
    emitWillNavigate(u: string): { preventDefault: ReturnType<typeof vi.fn> };
    emitDidStart(u: string, isInPlace?: boolean): void;
    emitDidNavigate(u: string): void;
    stopped: unknown[];
    loaded: unknown[];
  };
}

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

describe('guardPreviewPageNavigation (preview identity)', () => {
  it('blocks a page-initiated escape away from the preview origin (round 24)', async () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    const wc = fakeWcForGuard(PREVIEW_URL);
    guardPreviewPageNavigation(wc as never);
    // authorized preview load → enter identity
    wc.emitDidStart(PREVIEW_URL);
    const ev = wc.emitWillNavigate('https://evil.example/exfil');
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('survives a history.replaceState path rewrite and still blocks the escape (round 27i)', async () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    const wc = fakeWcForGuard(PREVIEW_URL);
    guardPreviewPageNavigation(wc as never);
    wc.emitDidStart(PREVIEW_URL); // enter identity
    // Untrusted script rewrites the path to '/' via history.replaceState —
    // an IN-PAGE navigation (isInPlace=true) that does not fire
    // will-navigate. getURL() now no longer matches the preview shape, but
    // the identity must survive and the subsequent cross-origin escape must
    // still be blocked (codex-connector P1, round 27i).
    wc.setURL('http://127.0.0.1:49152/');
    wc.emitDidStart('http://127.0.0.1:49152/', true);
    const ev = wc.emitWillNavigate('https://evil.example/exfil');
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('clears identity on a REAL (cross-document) navigation away from preview (round 27i, committed via did-navigate round 27l)', async () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    const wc = fakeWcForGuard(PREVIEW_URL);
    guardPreviewPageNavigation(wc as never);
    wc.emitDidStart(PREVIEW_URL); // enter identity
    // A real navigation COMMITS away from the preview URL (did-navigate) →
    // identity cleared, guard no longer blocks escapes.
    wc.emitDidNavigate('https://example.com/');
    const ev = wc.emitWillNavigate('https://other.example/x');
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the preview identity when a navigation STARTS but never commits (Greptile P1 XzI5E / codex-connector P1 XzOZH)', async () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    const wc = fakeWcForGuard(PREVIEW_URL);
    guardPreviewPageNavigation(wc as never);
    wc.emitDidStart(PREVIEW_URL); // enter identity
    // A loadURL away from the preview starts (did-start-navigation) but then
    // fails / times out / stops — it never commits (no did-navigate). The OLD
    // preview document survives; the identity must STAY armed so a later
    // page-initiated escape is still blocked.
    wc.emitDidStart('https://evil.example/');
    const ev = wc.emitWillNavigate('https://evil.example/exfil');
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('blocks a same-origin non-preview navigation (cannot probe loopback via the preview origin)', async () => {
    setLivePreviewOrigin('http://127.0.0.1:49152');
    const wc = fakeWcForGuard(PREVIEW_URL);
    guardPreviewPageNavigation(wc as never);
    wc.emitDidStart(PREVIEW_URL);
    const ev = wc.emitWillNavigate('http://127.0.0.1:49152/not-preview.html');
    expect(ev.preventDefault).toHaveBeenCalled();
  });
});
