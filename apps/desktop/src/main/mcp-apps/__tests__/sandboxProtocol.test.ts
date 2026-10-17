import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, protocol, session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
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
  unmountRemoteAppDocument,
} from '../sandboxProtocol.js';
afterEach(() => {
  clearMcpAppDocuments();
  setMcpAppCallerCleanup();
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
    expect(await resource.text()).toBe(document.html);
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
