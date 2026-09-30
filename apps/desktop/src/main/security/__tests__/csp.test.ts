/**
 * csp.test.ts — regression guard for the main-window Content-Security-Policy.
 *
 * Covers the pure policy builder (dev vs prod divergence, custom-scheme
 * allow-listing, hardened defaults) and the header injector
 * (mainFrame-only rewrite, pre-existing CSP stripping, subresource passthrough).
 */

import { describe, it, expect } from 'vitest';

import {
  buildContentSecurityPolicy,
  installContentSecurityPolicy,
  parseOrigin,
  type CspContext,
} from '../csp';

/** Parse a `; `-joined CSP string into a directive → sources[] map. */
function parsePolicy(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const chunk of policy.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [name, ...sources] = parts;
    out[name] = sources;
  }
  return out;
}

const PROD_CTX: CspContext = {
  isDev: false,
  devServerOrigin: null,
};

const DEV_CTX: CspContext = {
  isDev: true,
  devServerOrigin: 'http://localhost:5173',
};

describe('parseOrigin', () => {
  it('extracts the origin from a full URL', () => {
    expect(parseOrigin('https://api.example.com/api/v1')).toBe(
      'https://api.example.com',
    );
    expect(parseOrigin('http://localhost:3333')).toBe('http://localhost:3333');
  });

  it('returns null for empty / invalid input', () => {
    expect(parseOrigin(null)).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin('not a url')).toBeNull();
  });
});

describe('buildContentSecurityPolicy — shared invariants', () => {
  for (const [label, ctx] of [
    ['dev', DEV_CTX],
    ['prod', PROD_CTX],
  ] as const) {
    it(`[${label}] locks down default-src / object-src / frame-src and base/form/frame-ancestors`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      expect(d['default-src']).toEqual(["'self'"]);
      expect(d['object-src']).toEqual(["'none'"]);
      expect(d['frame-src']).toEqual(["'none'"]);
      expect(d['frame-ancestors']).toEqual(["'none'"]);
      expect(d['base-uri']).toEqual(["'self'"]);
      expect(d['form-action']).toEqual(["'self'"]);
    });

    it(`[${label}] allow-lists custom media protocols in img-src / media-src`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      for (const scheme of ['xdt-image:', 'xdt-file:', 'xdt-video:', 'xdt-model:', 'cindy-remote-media:', 'cindy-media:']) {
        expect(d['img-src']).toContain(scheme);
      }
      for (const scheme of ['xdt-audio:', 'xdt-video:', 'cindy-remote-media:', 'cindy-media:']) {
        expect(d['media-src']).toContain(scheme);
      }
      // data: / blob: needed for canvas, object URLs, inline assets.
      expect(d['img-src']).toEqual(expect.arrayContaining(['data:', 'blob:']));
      expect(d['media-src']).toEqual(expect.arrayContaining(['blob:']));
    });

    it(`[${label}] style-src allows inline styles + Google Fonts stylesheet`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      expect(d['style-src']).toEqual(
        expect.arrayContaining(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']),
      );
    });

    it(`[${label}] worker-src allows self + blob`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      expect(d['worker-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    });

    it(`[${label}] includes xdt-model: / cindy-media: in connect-src`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      // <model-viewer> fetch()es models over the privileged xdt-model: scheme
      // (mivo 老缓存) and cindy-media: (媒体总仓 GLB,意识 3D 链路).
      expect(d['connect-src']).toContain('xdt-model:');
      expect(d['connect-src']).toContain('cindy-media:');
      // three.js GLTFLoader loads GLB-embedded textures via fetch(blob:) —
      // governed by connect-src. Dropping this silently renders textured
      // GLBs as white models (texture failures are swallowed upstream).
      expect(d['connect-src']).toContain('blob:');
    });

    it(`[${label}] allows WebAssembly (wasm-unsafe-eval) for 3D model decoders`, () => {
      const d = parsePolicy(buildContentSecurityPolicy(ctx));
      expect(d['script-src']).toContain("'wasm-unsafe-eval'");
    });
  }
});

describe('buildContentSecurityPolicy — dev', () => {
  it('script-src allows unsafe-eval + unsafe-inline (Vite / React Refresh)', () => {
    const d = parsePolicy(buildContentSecurityPolicy(DEV_CTX));
    expect(d['script-src']).toEqual(
      expect.arrayContaining(["'self'", "'unsafe-inline'", "'unsafe-eval'"]),
    );
  });

  it('connect-src allows the HMR websocket (ws:) and the dev-server origin', () => {
    const d = parsePolicy(buildContentSecurityPolicy(DEV_CTX));
    expect(d['connect-src']).toEqual(expect.arrayContaining(['ws:', 'wss:']));
    expect(d['connect-src']).toContain('http://localhost:5173');
  });
});

describe('buildContentSecurityPolicy — prod', () => {
  it('script-src blocks inline + remote script (the primary XSS hardening) but allows eval for vendored drawio', () => {
    const d = parsePolicy(buildContentSecurityPolicy(PROD_CTX));
    expect(d['script-src']).toEqual(["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"]);
    // Load-bearing: NO 'unsafe-inline' → an injected inline <script> (the main
    // XSS→preload escalation vector) is blocked; only 'self' → no remote script.
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    // 'unsafe-eval' is a deliberate trade-off for the vendored drawio viewer's
    // real eval(); it only reaches an existing eval sink, not script injection.
    expect(d['script-src']).toContain("'unsafe-eval'");
  });

  it('connect-src has no ws:/http: scheme wildcards (only self + https/wss)', () => {
    const d = parsePolicy(buildContentSecurityPolicy(PROD_CTX));
    expect(d['connect-src']).toEqual(
      expect.arrayContaining(["'self'", 'https:', 'wss:']),
    );
    // API 域名不再单列(2026-07 apiBaseUrl 清理):https: 通配本就覆盖,
    // 主 server 请求全部经 main 进程 IPC 代理发出,renderer 无直连。
    expect(d['connect-src']).not.toContain('ws:');
    expect(d['connect-src']).not.toContain('http:');
  });
});

describe('installContentSecurityPolicy', () => {
  /** Minimal fake session capturing the onHeadersReceived listener. */
  function fakeSession() {
    let listener:
      | ((details: unknown, callback: (r: unknown) => void) => void)
      | null = null;
    let registrations = 0;
    return {
      get registrations() {
        return registrations;
      },
      webRequest: {
        onHeadersReceived: (fn: (details: unknown, callback: (r: unknown) => void) => void) => {
          registrations += 1;
          listener = fn;
        },
      },
      invoke(details: unknown): { cancel?: boolean; responseHeaders?: Record<string, string | string[]> } {
        let captured: { cancel?: boolean; responseHeaders?: Record<string, string | string[]> } = {};
        listener?.(details, (r) => {
          captured = r as typeof captured;
        });
        return captured;
      },
    };
  }

  it.each(['', '?mode=files'])('protects the packaged capture document %s', (query) => {
    const s = fakeSession();
    const ctx = { ...PROD_CTX, desktopCapture: true };
    installContentSecurityPolicy(s as never, ctx);
    const result = s.invoke({ resourceType: 'mainFrame', url: `cindy-desktop-capture://capture/index.html${query}`, responseHeaders: {} });
    expect(result.responseHeaders?.['Content-Security-Policy']).toEqual([buildContentSecurityPolicy(ctx)]);
    expect(result.responseHeaders?.['Content-Security-Policy']?.[0]).toContain("connect-src 'none'");
  });

  it.each([
    'cindy-desktop-capture://capture/index.html?mode=unknown',
    'cindy-desktop-capture://capture/index.html?mode=files&other=1',
    'cindy-desktop-capture://capture/other.html?mode=files',
    'cindy-desktop-capture://capture.evil/index.html?mode=files',
  ])('does not broaden the capture document allowlist to %s', (url) => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, { ...PROD_CTX, desktopCapture: true });
    expect(s.invoke({ resourceType: 'mainFrame', url, responseHeaders: {} })).toEqual({});
  });

  it('keeps capture URLs scoped to the capture session and main frame', () => {
    const url = 'cindy-desktop-capture://capture/index.html?mode=files';
    const app = fakeSession();
    installContentSecurityPolicy(app as never, PROD_CTX);
    expect(app.invoke({ resourceType: 'mainFrame', url, responseHeaders: {} })).toEqual({});
    const capture = fakeSession();
    installContentSecurityPolicy(capture as never, { ...PROD_CTX, desktopCapture: true });
    expect(capture.invoke({ resourceType: 'script', url, responseHeaders: {} })).toEqual({});
  });

  it('is idempotent: a second install on the same session does NOT re-register the listener', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, PROD_CTX);
    installContentSecurityPolicy(s as never, PROD_CTX);
    // Guard prevents the second call from replacing our onHeadersReceived listener.
    expect(s.registrations).toBe(1);
    // and the (still-registered) listener keeps working
    const result = s.invoke({ resourceType: 'mainFrame', url: 'file:///app/index.html', responseHeaders: {} });
    expect(result.responseHeaders?.['Content-Security-Policy']).toEqual([
      buildContentSecurityPolicy(PROD_CTX),
    ]);
  });

  it('injects the CSP header on mainFrame document responses', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, PROD_CTX);
    const result = s.invoke({ resourceType: 'mainFrame', url: 'file:///app/index.html', responseHeaders: { 'X-Test': ['1'] } });
    expect(result.responseHeaders?.['Content-Security-Policy']).toEqual([
      buildContentSecurityPolicy(PROD_CTX),
    ]);
    // Existing unrelated headers are preserved.
    expect(result.responseHeaders?.['X-Test']).toEqual(['1']);
  });

  it('strips any upstream CSP header (case-insensitive) before injecting ours', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, PROD_CTX);
    const result = s.invoke({
      resourceType: 'mainFrame',
      url: 'file:///app/index.html',
      responseHeaders: {
        'content-security-policy': ["default-src *"],
        'Content-Security-Policy-Report-Only': ["default-src *"],
      },
    });
    const keys = Object.keys(result.responseHeaders ?? {});
    // Only our canonical header remains.
    expect(keys.filter((k) => k.toLowerCase().startsWith('content-security-policy'))).toEqual([
      'Content-Security-Policy',
    ]);
  });

  it('injects CSP on the dev-server origin mainFrame (dev mode)', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, DEV_CTX);
    const result = s.invoke({ resourceType: 'mainFrame', url: 'http://localhost:5173/', responseHeaders: {} });
    expect(result.responseHeaders?.['Content-Security-Policy']).toBeDefined();
  });

  it('does NOT inject CSP on external URL mainFrame (e.g. Feishu OAuth)', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, PROD_CTX);
    // External OAuth page must pass through unchanged — our prod policy has no
    // 'unsafe-inline' and would silently break third-party pages using it.
    const result = s.invoke({ resourceType: 'mainFrame', url: 'https://accounts.example.com/login', responseHeaders: {} });
    expect(result.responseHeaders).toBeUndefined();
  });

  it('dev-origin match is exact origin, not a string prefix', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, DEV_CTX);
    // http://localhost:51730 shares the http://localhost:5173 prefix but is a
    // different origin — must pass through untouched.
    const result = s.invoke({ resourceType: 'mainFrame', url: 'http://localhost:51730/', responseHeaders: {} });
    expect(result.responseHeaders).toBeUndefined();
  });

  it('does NOT modify non-mainFrame (subresource) responses', () => {
    const s = fakeSession();
    installContentSecurityPolicy(s as never, PROD_CTX);
    const result = s.invoke({ resourceType: 'image', responseHeaders: { 'Content-Type': ['image/png'] } });
    expect(result.responseHeaders).toBeUndefined();
  });
});
