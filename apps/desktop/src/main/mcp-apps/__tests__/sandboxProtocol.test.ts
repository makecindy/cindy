import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, protocol, session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { withHostAppSdk } from '@cindy/maker-shared/mcp-app-sdk';
import { HOST_APP_SDK_PATH } from '../../../shared/mcpApps.js';
import { hostAppSdkAsset } from '../hostSdk.js';
import type { McpAppsHost } from '../host.js';
import { setMcpAppsHost } from '../runtime.js';
vi.mock('electron', async (original) => {
  const electron = await original<typeof import('electron')>();
  return {
    ...electron,
    session: {
      ...electron.session,
      defaultSession: {
        ...electron.session.defaultSession,
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn((_filter: unknown, listener: typeof state.beforeHeaders) => {
          state.beforeHeaders = listener;
        }) },
      },
    },
  };
});
const state = vi.hoisted(() => ({ owner: {} as object | null,
  beforeHeaders: undefined as ((details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void) => void) | undefined,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.owner,
}));
import {
  assertMcpAppDocumentCaller,
  clearMcpAppDocuments,
  mountRemoteAppDocument,
  registerMcpAppProtocol,
  isMcpAppFrameNavigationAllowed,
  isMcpAppPermissionRequest,
  supplyMcpAppDocument,
  setMcpAppCallerCleanup,
  setMcpAppFileReader,
  unmountRemoteAppDocument,
} from '../sandboxProtocol.js';
afterEach(() => {
  clearMcpAppDocuments();
  setMcpAppCallerCleanup();
  setMcpAppFileReader(undefined);
  app.removeAllListeners('web-contents-created');
  vi.restoreAllMocks();
  state.owner = {};
});
const document = {
  viewId: 'untrusted-id',
  html: '<!doctype html><body>App',
  csp: 'default-src *',
  prefersBorder: true,
};
describe('MCP App local protocol isolation', () => {
  it('gives remotely mounted documents the same authenticated bridge and releases their Main binding', async () => {
    let handler!: (request: Request) => Promise<Response> | Response;
    vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
    registerMcpAppProtocol();
    const invoke = vi.fn(async () => ({}));
    const dispose = vi.fn();
    const id = mountRemoteAppDocument(document, 'renderer:1', invoke, dispose);
    const response = await handler(new Request(`cindy-mcp-app://${id}/sandbox`));
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(await response.text()).toContain(`cindy-mcp-app://${id}/bridge`);
    expect((await handler(new Request(`cindy-mcp-app://${id}/bridge`, { method: 'POST', body: '{}' }))).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
    unmountRemoteAppDocument(id, 'renderer:1');
    clearMcpAppDocuments();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('authenticates the real sandbox frame, never the top Renderer or a forged channel key', async () => {
    let handler!: (request: Request) => Promise<Response> | Response;
    vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
    registerMcpAppProtocol();
    const beforeHeaders = state.beforeHeaders!;
    const invoke = vi.fn(async () => ({ ok: true }));
    supplyMcpAppDocument(document, 'renderer:1', invoke);
    const frame = { url: 'cindy-mcp-app://untrusted-id/sandbox' };
    const details = { url: 'cindy-mcp-app://untrusted-id/bridge', method: 'POST',
      webContentsId: 1, frame, requestHeaders: { 'x-cindy-mcp-app-frame': 'forged' } };
    for (const invalid of [null, { url: 'file:///host.html' },
      { url: 'cindy-mcp-app://untrusted-id-view/resource' }]) {
      const callback = vi.fn();
      beforeHeaders({ ...details, frame: invalid } as never, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const otherWindow = vi.fn();
    beforeHeaders({ ...details, webContentsId: 2 } as never, otherWindow);
    expect(otherWindow).toHaveBeenCalledWith({ cancel: true });
    const callback = vi.fn();
    beforeHeaders(details as never, callback);
    const headers = callback.mock.calls[0][0].requestHeaders;
    expect(headers['X-Cindy-Mcp-App-Frame']).not.toBe('forged');
    expect(headers['x-cindy-mcp-app-frame']).toBeUndefined();
    const request = (key: string) => new Request(details.url, { method: 'POST',
      headers: { 'X-Cindy-Mcp-App-Frame': key }, body: JSON.stringify({ op: 'message', message: {} }) });
    expect((await handler(request('forged'))).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
    const html = await (await handler(new Request('cindy-mcp-app://untrusted-id/sandbox'))).text();
    expect(html).not.toContain(headers['X-Cindy-Mcp-App-Frame']);
    const response = await handler(request(headers['X-Cindy-Mcp-App-Frame']));
    expect(await response.json()).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledOnce();
    frame.url = 'https://navigated.example.org';
    expect((await handler(request(headers['X-Cindy-Mcp-App-Frame']))).status).toBe(403);
    expect(invoke).toHaveBeenCalledOnce();
    frame.url = 'cindy-mcp-app://untrusted-id/sandbox';
    const oversized = new Request(details.url, { method: 'POST',
      headers: { 'X-Cindy-Mcp-App-Frame': headers['X-Cindy-Mcp-App-Frame'] },
      body: 'x'.repeat(4 * 1024 * 1024 + 1) });
    expect((await handler(oversized)).status).toBe(400);
    expect(invoke).toHaveBeenCalledOnce();
    state.owner = {};
    expect((await handler(request(headers['X-Cindy-Mcp-App-Frame']))).status).toBe(404);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('installs both permission handlers and denies App and opaque subframe requests', () => {
    registerMcpAppProtocol();
    const request = vi
      .mocked(session.defaultSession.setPermissionRequestHandler)
      .mock.calls.at(-1)![0]!;
    const check = vi
      .mocked(session.defaultSession.setPermissionCheckHandler)
      .mock.calls.at(-1)![0]!;
    const callback = vi.fn();
    const details = { isMainFrame: false, requestingUrl: 'cindy-mcp-app://view-view/resource' };
    request(null as unknown as WebContents, 'notifications', callback, details);
    expect(callback).toHaveBeenCalledWith(false);
    expect(check(null, 'midi', 'cindy-mcp-app://view-view', details)).toBe(false);
    expect(check(null, 'serial', 'null', { isMainFrame: false })).toBe(false);
    expect(
      check(null, 'media', 'file://', { isMainFrame: true, requestingUrl: 'file:///host.html' }),
    ).toBe(true);
  });
  it('preserves Electron host permission defaults without enabling synchronous clipboard reads', () => {
    registerMcpAppProtocol();
    const request = vi.mocked(session.defaultSession.setPermissionRequestHandler).mock.calls.at(-1)![0]!;
    const check = vi.mocked(session.defaultSession.setPermissionCheckHandler).mock.calls.at(-1)![0]!;
    const details = { isMainFrame: true, requestingUrl: 'file:///host.html' };
    const callback = vi.fn();
    request(null as unknown as WebContents, 'notifications', callback, details);
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    for (const permission of ['media', 'notifications', 'geolocation'] as const) {
      expect(check(null, permission, 'file://', details)).toBe(true);
    }
    expect(check(null, 'deprecated-sync-clipboard-read', 'file://', details)).toBe(false);
  });
  it('denies permissions for external descendants by their real ancestry', () => {
    const resource = { url: 'cindy-mcp-app://view-view/resource', parent: null };
    const nested = { url: 'https://embed.example.org', parent: resource };
    const unrelated = { url: 'https://other.example.org', parent: null };
    const contents = {
      mainFrame: { framesInSubtree: [resource, nested, unrelated] },
    } as unknown as WebContents;
    expect(
      isMcpAppPermissionRequest(contents, { isMainFrame: false, requestingUrl: nested.url }),
    ).toBe(true);
    expect(isMcpAppPermissionRequest(contents, { isMainFrame: false })).toBe(true);
    expect(
      isMcpAppPermissionRequest(contents, { isMainFrame: false, requestingUrl: unrelated.url }),
    ).toBe(false);
  });
  it('forwards unmodified Escape from the focused App into its trusted sandbox only', () => {
    registerMcpAppProtocol();
    const id = mountRemoteAppDocument(document, 'renderer:1');
    const sandbox = {
      url: `cindy-mcp-app://${id}/sandbox`,
      parent: null,
      executeJavaScript: vi.fn(async () => {}),
    };
    const contents = Object.assign(new EventEmitter(), {
      focusedFrame: { url: `cindy-mcp-app://${id}-view/resource`, parent: sandbox },
    });
    app.emit('web-contents-created', {}, contents);
    const event = { preventDefault: vi.fn() };
    contents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'Escape',
      isComposing: true,
    });
    expect(sandbox.executeJavaScript).not.toHaveBeenCalled();
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
    expect(sandbox.executeJavaScript).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    state.owner = {};
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
    expect(sandbox.executeJavaScript).toHaveBeenCalledOnce();
  });
  it('keeps a disposed render frame from escaping WebContents callbacks and quitting the app', () => {
    registerMcpAppProtocol();
    const disposed = () => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    };
    const contents = new EventEmitter();
    app.emit('web-contents-created', {}, contents);
    const input = { preventDefault: vi.fn() };
    const escape = { type: 'keyDown', key: 'Escape' };
    Object.defineProperty(contents, 'focusedFrame', { configurable: true, get: disposed });
    expect(() => contents.emit('before-input-event', input, escape)).not.toThrow();
    Object.defineProperty(contents, 'focusedFrame', {
      configurable: true,
      value: { get url() { return disposed(); }, parent: null },
    });
    expect(() => contents.emit('before-input-event', input, escape)).not.toThrow();
    expect(input.preventDefault).not.toHaveBeenCalled();
    // A frame that disappears cannot be authorised, so its navigation is refused.
    const gone = { get frame() { return disposed(); }, url: 'https://example.org', preventDefault: vi.fn() };
    expect(() => contents.emit('will-frame-navigate', gone)).not.toThrow();
    expect(gone.preventDefault).toHaveBeenCalledOnce();
    const ancestorGone = {
      frame: { url: 'cindy-mcp-app://example-view/resource', get parent() { return disposed(); } },
      url: 'https://example.org',
      preventDefault: vi.fn(),
    };
    expect(() => contents.emit('will-frame-navigate', ancestorGone)).not.toThrow();
    expect(ancestorGone.preventDefault).toHaveBeenCalledOnce();
    // Failures that are not a disposed frame are still reported.
    Object.defineProperty(contents, 'focusedFrame', {
      configurable: true,
      get() { throw new Error('boom'); },
    });
    expect(() => contents.emit('before-input-event', input, escape)).toThrow('boom');
  });
  it('rebuilds remote CSP and serves only the current owner through distinct origins', async () => {
    let handler!: (request: Request) => Promise<Response> | Response;
    vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => {
      handler = callback;
    });
    registerMcpAppProtocol();
    const id = mountRemoteAppDocument(document, 'renderer:1');
    const resource = await handler(new Request('cindy-mcp-app://' + id + '-view/resource'));
    expect(resource.status).toBe(200);
    expect(resource.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(resource.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    expect((await resource.text()).replace(/<script data-cindy-runtime>[\s\S]*?<\/script>/, '').replace(/<script type="importmap">[\s\S]*?<\/script>/, '')).toBe(document.html);
    const sandbox = await handler(new Request('cindy-mcp-app://' + id + '/sandbox'));
    expect(sandbox.headers.get('Content-Security-Policy')).toContain(
      'frame-src cindy-mcp-app://' + id + '-view',
    );
    for (const path of [
      'cindy-mcp-app://' + id + '/resource',
      'cindy-mcp-app://' + id + '-view/sandbox',
      'cindy-mcp-app://' + id + '/secret',
    ])
      expect((await handler(new Request(path))).status).toBe(404);
    state.owner = {};
    expect((await handler(new Request('cindy-mcp-app://' + id + '-view/resource'))).status).toBe(
      404,
    );
  });
  it('binds local mounts and privileged links to the mounting renderer and owner', () => {
    const id = mountRemoteAppDocument(document, 'renderer:1');
    expect(() => assertMcpAppDocumentCaller(id, 'renderer:1')).not.toThrow();
    expect(() => unmountRemoteAppDocument(id, 'renderer:2')).toThrow('MCP_APP_VIEW_UNAVAILABLE');
    state.owner = {};
    expect(() => assertMcpAppDocumentCaller(id, 'renderer:1')).toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it.each(['destroyed', 'render-process-gone', 'reload'] as const)(
    'reclaims only the affected renderer documents and Host Views on %s',
    async (cause) => {
      const releaseCaller = vi.fn(async () => {});
      setMcpAppsHost({ releaseCaller } as unknown as McpAppsHost);
      let handler!: (request: Request) => Promise<Response> | Response;
      vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => {
        handler = callback;
      });
      registerMcpAppProtocol();
      const contents = Object.assign(new EventEmitter(), { id: 1 });
      app.emit('web-contents-created', {}, contents);
      const oldIds = Array.from({ length: 16 }, () =>
        mountRemoteAppDocument(document, 'renderer:1'),
      );
      const otherId = mountRemoteAppDocument(document, 'renderer:2');
      supplyMcpAppDocument({ ...document, viewId: 'host-document' });
      expect(() => mountRemoteAppDocument(document, 'renderer:1')).toThrow('MCP_APP_VIEW_LIMIT');

      // Same-document navigation and subframe reloads must leave cards alive.
      contents.emit('did-start-navigation', {}, 'cindy://app#task', true, true);
      contents.emit('did-start-navigation', {}, 'cindy-mcp-app://view/resource', false, false);
      expect(() => assertMcpAppDocumentCaller(oldIds[0], 'renderer:1')).not.toThrow();
      expect(releaseCaller).not.toHaveBeenCalled();
      if (cause === 'reload') contents.emit('did-start-navigation', {}, 'cindy://app', false, true);
      else contents.emit(cause);
      expect(releaseCaller).toHaveBeenCalledExactlyOnceWith('renderer:1');

      for (const id of oldIds) {
        expect(() => assertMcpAppDocumentCaller(id, 'renderer:1')).toThrow(
          'MCP_APP_VIEW_UNAVAILABLE',
        );
        expect((await handler(new Request(`cindy-mcp-app://${id}-view/resource`))).status).toBe(
          404,
        );
      }
      expect((await handler(new Request(`cindy-mcp-app://${otherId}-view/resource`))).status).toBe(
        200,
      );
      expect(
        (await handler(new Request('cindy-mcp-app://host-document-view/resource'))).status,
      ).toBe(200);
      const replacement = mountRemoteAppDocument(document, 'renderer:1');
      expect(() => assertMcpAppDocumentCaller(replacement, 'renderer:1')).not.toThrow();
    },
  );
  it('does not allow a policy-bearing App to navigate itself into a privileged or external page', () => {
    const source = 'cindy-mcp-app://example-view/resource';
    expect(isMcpAppFrameNavigationAllowed(source, source + '#section')).toBe(true);
    expect(isMcpAppFrameNavigationAllowed('cindy-mcp-app://example/sandbox', source)).toBe(true);
    for (const target of [
      'https://example.org',
      'file:///private',
      'cindy-mcp-app://other-view/resource',
      'cindy-mcp-app://example/sandbox',
    ])
      expect(isMcpAppFrameNavigationAllowed(source, target)).toBe(false);
    expect(
      isMcpAppFrameNavigationAllowed('https://existing-cindy-view', 'https://existing-link'),
    ).toBe(true);
  });
  it('allows nested navigation only to the owning App approved frame domains', () => {
    const source = 'cindy-mcp-app://example-view/resource';
    const domains = ['https://frames.example.org', 'https://*.embed.example.org:*'];
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org/view', domains)).toBe(
      true,
    );
    expect(
      isMcpAppFrameNavigationAllowed(
        'https://frames.example.org',
        'https://sub.embed.example.org:8443/view',
        domains,
      ),
    ).toBe(true);
    for (const target of [
      'https://other.example.org',
      'http://frames.example.org',
      'file:///private',
      'cindy-mcp-app://other-view/resource',
    ])
      expect(isMcpAppFrameNavigationAllowed(source, target, domains)).toBe(false);
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org', [])).toBe(false);
    // Declaring a domain does not allow the App document itself to leave its origin.
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org')).toBe(false);
  });
});

// A2: knowing a file token must not let another card/frame or a top-level Renderer
// read it. Exercise the production Electron protocol hook, not URL string guards.
it('serves granted files only to their own real App frame', async () => {
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  supplyMcpAppDocument(document, 'renderer:1');
  const read = vi.fn(async () => new Response('file'));
  setMcpAppFileReader(read);
  const url = 'cindy-mcp-app://untrusted-id-view/__cindy/files/token';
  const details = { url, method: 'GET', webContentsId: 1,
    frame: { url: 'cindy-mcp-app://untrusted-id-view/resource' }, requestHeaders: {} };
  for (const altered of [{ frame: { url: 'file:///host.html' } }, { frame: { url: 'cindy-mcp-app://other-view/resource' } }, { webContentsId: 2 }, { method: 'POST' }]) {
    const cb = vi.fn(); state.beforeHeaders!({ ...details, ...altered } as never, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: true });
  }
  expect((await handler(new Request(url))).status).toBe(404);
  const cb = vi.fn(); state.beforeHeaders!(details as never, cb);
  expect(await (await handler(new Request(url, { headers: cb.mock.calls[0][0].requestHeaders }))).text()).toBe('file');
  expect(read).toHaveBeenCalledExactlyOnceWith('untrusted-id', 'token', expect.any(Request));
  clearMcpAppDocuments();
  expect((await handler(new Request(url, { headers: cb.mock.calls[0][0].requestHeaders }))).status).toBe(404);
});

// Unit: real protocol route, reserved View URL, importmap before authored modules.
// Old documents omit sdk; revoked Views must stop serving their executor's bytes.
it('serves the executor SDK and importmap without widening CSP', async () => {
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  const sdk = hostAppSdkAsset;
  expect(sdk.source).toBe(readFileSync(createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8'));
  const id = mountRemoteAppDocument({ ...document, html: '<!doctype html><html><head><script type="module">import {App} from "@modelcontextprotocol/ext-apps"</script></head></html>', sdk }, 'renderer:1');
  const request = (path: string) => handler(new Request('cindy-mcp-app://' + id + '-view/' + path));
  const page = await request('resource');
  const legacyId = mountRemoteAppDocument(document, 'renderer:1');
  const legacy = await handler(new Request('cindy-mcp-app://' + legacyId + '-view/resource'));
  expect(page.headers.get('Content-Security-Policy')).toBe(legacy.headers.get('Content-Security-Policy'));
  const legacyHtml = await legacy.text();
  expect(legacyHtml).toContain('data-cindy-runtime');
  expect(legacyHtml).toContain('cindy-mcp-app://' + legacyId + '-view/__cindy/sdk/ext-apps/app.js');
  expect((await handler(new Request('cindy-mcp-app://' + legacyId + '-view/__cindy/sdk/ext-apps/app.js'))).status).toBe(404);
  expect(legacyHtml.replace(/<script data-cindy-runtime>[\s\S]*?<\/script>/, '').replace(/<script type="importmap">[\s\S]*?<\/script>/, '')).toBe(document.html);
  const html = await page.text();
  expect(html).toContain('cindy-mcp-app://' + id + '-view/__cindy/sdk/ext-apps/app.js');
  expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
  const asset = await request('__cindy/sdk/ext-apps/app.js');
  expect(asset.headers.get('Content-Type')).toContain('text/javascript');
  expect(await asset.text()).toBe(sdk.source);
  for (const [path, bytes] of [
    ['__cindy/sdk/cindy/view-state.js', sdk.addons['cindy/view-state'].source],
    ['__cindy/sdk/cindy/view-state-react.js', sdk.addons['cindy/view-state'].reactSource],
  ]) {
    expect(await (await request(path)).text()).toBe(bytes);
    expect((await request(path + '?invalid=1')).status).toBe(404);
    expect((await handler(new Request('cindy-mcp-app://' + id + '-view/' + path, { method: 'POST' }))).status).toBe(404);
    expect((await handler(new Request('cindy-mcp-app://' + legacyId + '-view/' + path))).status).toBe(404);
  }
  expect((await request('__cindy/sdk/ext-apps/app.js?version=1')).status).toBe(404);
  expect((await handler(new Request('cindy-mcp-app://' + id + '/__cindy/sdk/ext-apps/app.js'))).status).toBe(404);
  unmountRemoteAppDocument(id, 'renderer:1');
  expect((await request('__cindy/sdk/ext-apps/app.js')).status).toBe(404);
  supplyMcpAppDocument(document);
  expect((await handler(new Request('cindy-mcp-app://untrusted-id-view/__cindy/sdk/ext-apps/app.js'))).status).toBe(404);
});

// Lead R7: parse once at publication, never on each resource GET.
it('prepares each supplied document once for repeated resource requests', async () => {
  const sdk = await import('@cindy/maker-shared/mcp-app-sdk');
  const prepare = vi.spyOn(sdk, 'withHostAppSdk');
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  supplyMcpAppDocument({ ...document, html: '<script type="module">import "@modelcontextprotocol/ext-apps"</script>', sdk: hostAppSdkAsset });
  for (let i = 0; i < 2; i++) expect((await handler(new Request('cindy-mcp-app://untrusted-id-view/resource'))).status).toBe(200);
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('reuses parsed preparation while applying each view URL and current theme at the parsed head end', async () => {
  const sdk = await import('@cindy/maker-shared/mcp-app-sdk');
  const prepare = vi.spyOn(sdk, 'withHostAppSdk');
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  const authoredLiteral = '__CINDY_VIEW_ID__';
  const authoredScript = "const end = '</head>';";
  const html = `<!doctype html><head><meta name="color-scheme" content="light dark"><script>${authoredScript}</script></head><body><p>${authoredLiteral}</p>`;
  for (const [viewId, theme] of [['first-view', 'dark'], ['second-view', 'light']]) {
    supplyMcpAppDocument({ ...document, viewId, html, sdk: hostAppSdkAsset },
      undefined, undefined, undefined, { theme });
    // The second supply must use the cache, including its preparation marker.
    expect(prepare).toHaveBeenCalledOnce();
    const result = await (await handler(new Request(`cindy-mcp-app://${viewId}-view/resource`))).text();
    const parsed = parse(result);
    expect(parsed.mode).toBe('no-quirks');
    const root = documentElement(parsed);
    const head = root.childNodes.find(node => node.nodeName === 'head') as DefaultTreeAdapterTypes.Element;
    const themes = themeNodes(parsed);
    expect(themes).toHaveLength(1);
    expect(head.childNodes.at(-1)).toBe(themes[0]);
    const text = (node: DefaultTreeAdapterTypes.Element) => node.childNodes.map(child => 'value' in child ? child.value : '').join('');
    const scripts = head.childNodes.filter((node): node is DefaultTreeAdapterTypes.Element => 'tagName' in node && node.tagName === 'script');
    expect(scripts.map(text)).toContain(authoredScript);
    const map = scripts.find(node => node.attrs.some(attr => attr.name === 'type' && attr.value === 'importmap'))!;
    expect(JSON.parse(text(map)).imports['@modelcontextprotocol/ext-apps'])
      .toBe(`cindy-mcp-app://${viewId}-view/__cindy/sdk/ext-apps/app.js`);
    const style = { colorScheme: '', setProperty() {} };
    new Function('document', 'getComputedStyle', 'addEventListener', 'parent', text(themes[0]))(
      { documentElement: { style } }, () => ({ colorScheme: 'light dark' }), () => {}, {},
    );
    expect(style.colorScheme).toBe(theme);
    const body = root.childNodes.find(node => node.nodeName === 'body') as DefaultTreeAdapterTypes.Element;
    expect(text(body.childNodes[0] as DefaultTreeAdapterTypes.Element)).toBe(authoredLiteral);
  }
  expect(prepare).toHaveBeenCalledOnce();
});
it('preheats Cindy theme variables for dual-scheme pages and leaves single-scheme pages alone', async () => {
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  const context = {
    theme: 'dark',
    styles: { variables: {
      '--color-background-primary': '#111', '--color-text-primary': '#eee',
      '--font-sans': 'Author Font',
    } },
  };
  const dual = mountRemoteAppDocument({ ...document,
    html: '<!doctype html><html><head><meta name="color-scheme" content="light dark"><style>:root{--color-background-primary:#author}</style></head><body>App</body></html>',
  }, 'renderer:1', undefined, undefined, context);
  const dualResponse = await handler(new Request(`cindy-mcp-app://${dual}-view/resource`));
  const dualHtml = await dualResponse.text();
  expect(dualHtml).toContain('data-cindy-theme');
  expect(dualHtml).toContain('"theme":"dark"');
  expect(dualHtml).toContain('"--color-background-primary":"#111"');
  expect(dualHtml).not.toContain('--font-sans');
  expect(dualHtml.indexOf('data-cindy-theme')).toBeLessThan(dualHtml.indexOf('</head>'));
  expect(dualResponse.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'unsafe-inline'");

  const singleSource = '<!doctype html><html><head><style>:root{color-scheme:light}</style></head><body>App</body></html>';
  const single = mountRemoteAppDocument({ ...document, viewId: 'single', html: singleSource }, 'renderer:1', undefined, undefined, context);
  const singleHtml = await (await handler(new Request(`cindy-mcp-app://${single}-view/resource`))).text();
  expect(singleHtml.replace(/<script data-cindy-runtime>[\s\S]*?<\/script>/, '').replace(/<script type="importmap">[\s\S]*?<\/script>/, '')).toBe(singleSource);

  const style = { colorScheme: '', values: new Map<string, string>(),
    setProperty(name: string, value: string) { this.values.set(name, value); } };
  const authored = new Map([['--color-background-primary', '#author']]);
  const listeners: ((event: { data: unknown; source?: unknown }) => void)[] = [];
  const fakeDocument = { documentElement: { style }, querySelectorAll: () => [{
    getAttribute: () => 'light dark',
  }] };
  const themeSource = dualHtml.match(/<script data-cindy-theme>([\s\S]*?)<\/script>/)?.[1];
  expect(themeSource).toBeDefined();
  const parent = {};
  new Function('document', 'getComputedStyle', 'addEventListener', 'parent', themeSource!)(
    fakeDocument, () => ({
      colorScheme: style.colorScheme || 'light dark',
      getPropertyValue: (name: string) => style.values.get(name) ?? authored.get(name) ?? '',
    }), (_name: string, listener: (event: { data: unknown; source?: unknown }) => void) => listeners.push(listener), parent,
  );
  expect(style.colorScheme).toBe('dark');
  expect(style.values.has('--color-background-primary')).toBe(false);
  expect(authored.get('--color-background-primary')).toBe('#author');
  listeners[0]({ source: parent, data: {
    jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { theme: 'light', styles: { variables: {
      '--color-background-primary': '#updated-author', '--color-text-primary': '#111', '--font-sans': 'Updated Font',
    } } },
  } });
  expect(style.colorScheme).toBe('light');
  expect(style.values.get('--color-text-primary')).toBe('#111');
  expect(style.values.has('--color-background-primary')).toBe(false);
  expect(style.values.has('--font-sans')).toBe(false);
  listeners[0]({ source: {}, data: {
    jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { theme: 'dark', styles: { variables: { '--color-text-primary': '#evil' } } },
  } });
  expect(style.values.get('--color-text-primary')).toBe('#111');
});

// Unit regression for #10481: serving a headless document with a theme must not
// turn standards-mode content into quirks mode. Existing theme cases have a head.
it.each(['', ' \n\t', '<!-- before document -->', '\uFEFF \n<!-- <!doctype html> is only a comment -->\n'])(
  'preserves the doctype and parsing mode of headless documents with prefix %j', async (prefix) => {
    let handler!: (request: Request) => Promise<Response> | Response;
    vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
    registerMcpAppProtocol();
    supplyMcpAppDocument({ ...document, html: prefix + '<!doctype html><body>App' },
      undefined, undefined, undefined, { theme: 'dark' });
    const response = await handler(new Request('cindy-mcp-app://untrusted-id-view/resource'));
    const html = await response.text();
    const parsed = parse(html, { sourceCodeLocationInfo: true });
    expect(parsed.mode).toBe('no-quirks');
    // Leading comments are valid before a doctype; no element may precede it.
    const first = parsed.childNodes.find((node) => node.nodeName !== '#comment');
    expect(first?.nodeName).toBe('#documentType');
    const doctypeEnd = first!.sourceCodeLocation!.endOffset;
    expect(themeNodes(parsed)).toHaveLength(1);
    expect(themeNodes(parsed)[0].sourceCodeLocation!.startOffset).toBeGreaterThanOrEqual(doctypeEnd);
  },
);

// Regression for the synchronous Main-process prefix scan: repeated comments
// must finish even when no doctype follows. Test the post-preparation entry
// through document supply so the prepared marker and replacement run together.
it.each([false, true])('handles 5000 leading comments with doctype=%s', async (hasDoctype) => {
  const prefix = '<!--x-->'.repeat(5000);
  const html = prefix + (hasDoctype ? '<!doctype html>' : '') + '<body>App';
  const parsed = parse(await suppliedThemeHtml(html));
  expect(parsed.mode).toBe(hasDoctype ? 'no-quirks' : 'quirks');
  expect(themeNodes(parsed)).toHaveLength(1);
  const body = documentElement(parsed).childNodes.find(node => node.nodeName === 'body') as DefaultTreeAdapterTypes.Element;
  expect(body.childNodes).toEqual([expect.objectContaining({ nodeName: '#text', value: 'App' })]);
});

it.each([
  ['unclosed comment', '<!-- no end <!doctype html>'],
  ['unclosed meta tags', '<meta '.repeat(5000)],
  ['unclosed head tags', '<head '.repeat(5000)],
])('keeps the leading insertion fallback for %s', async (_name, html) => {
  const parsed = parse(await suppliedThemeHtml(html));
  expect(parsed.mode).toBe('quirks');
  expect(themeNodes(parsed)).toHaveLength(1);
});

// The first theme implementation searched raw HTML, corrupting inline bundles
// containing head-like text. Verify the served DOM, not a source-text pattern.
it.each([
  ['script', "window.ok=1;const tpl='<html><head></head><body>';window.tplLen=tpl.length;"],
  ['style', ':root{--example:"</head><head>";color-scheme:light dark}'],
  ['comment', ' </head><head> '],
])('keeps head-like text inside an authored %s intact', async (kind, content) => {
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  const authored = kind === 'comment' ? `<!--${content}-->` : `<${kind} id="author">${content}</${kind}>`;
  const html = `<!doctype html><html><head><meta name="color-scheme" content="light dark">${authored}</head><body><div id="x">App</div></body></html>`;
  supplyMcpAppDocument({ ...document, html }, undefined, undefined, undefined, { theme: 'dark' });
  const result = parse(await (await handler(new Request('cindy-mcp-app://untrusted-id-view/resource'))).text());
  expect(result.mode).toBe('no-quirks');
  const root = result.childNodes.find(node => node.nodeName === 'html') as DefaultTreeAdapterTypes.Element;
  const head = root.childNodes.find(node => node.nodeName === 'head') as DefaultTreeAdapterTypes.Element;
  const author = head.childNodes.find(node => kind === 'comment'
    ? node.nodeName === '#comment'
    : 'attrs' in node && node.attrs.some(attr => attr.name === 'id' && attr.value === 'author'))!;
  expect('data' in author ? author.data : 'childNodes' in author
    ? author.childNodes.map(node => 'value' in node ? node.value : '').join('') : undefined).toBe(content);
  const themes = head.childNodes.filter(node => 'attrs' in node && node.tagName === 'script'
    && node.attrs.some(attr => attr.name === 'data-cindy-theme'));
  expect(themes).toHaveLength(1);
  const body = root.childNodes.find(node => node.nodeName === 'body') as DefaultTreeAdapterTypes.Element;
  expect(body.childNodes.map(node => node.nodeName)).toEqual(['div']);
});

function documentElement(parsed: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element {
  return parsed.childNodes.find(node => node.nodeName === 'html') as DefaultTreeAdapterTypes.Element;
}
function themeNodes(parsed: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element[] {
  const head = documentElement(parsed).childNodes.find(node => node.nodeName === 'head') as DefaultTreeAdapterTypes.Element;
  return head.childNodes.filter((node): node is DefaultTreeAdapterTypes.Element => 'attrs' in node
    && node.tagName === 'script' && node.attrs.some(attr => attr.name === 'data-cindy-theme'));
}
async function suppliedThemeHtml(html: string, context: { theme?: string } = { theme: 'dark' }): Promise<string> {
  let handler!: (request: Request) => Promise<Response> | Response;
  vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => { handler = callback; });
  registerMcpAppProtocol();
  supplyMcpAppDocument({ ...document, html }, undefined, undefined, undefined, context);
  return (await handler(new Request('cindy-mcp-app://untrusted-id-view/resource'))).text();
}
it.each([{}, { theme: 'dark' }])('removes the prepared marker without changing single-theme output for context %j', async (context) => {
  const html = '<!doctype html><head><style>:root{color-scheme:light}</style></head><body>App';
  const supplied = await suppliedThemeHtml(html, context);
  expect(supplied).toBe(withHostAppSdk(html, 'cindy-mcp-app://untrusted-id-view' + HOST_APP_SDK_PATH));
  const parsed = parse(supplied);
  expect(parsed.mode).toBe('no-quirks');
  expect(themeNodes(parsed)).toHaveLength(0);
});
