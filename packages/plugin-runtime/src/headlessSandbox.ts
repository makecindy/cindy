import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createGhostBridge } from './bridge.js';
import { GHOST_BOOT_PATH, GHOST_MAIL_SDK_PATH, ghostBootHtml, ghostFileMime, resolveGhostFilePath } from './ghostFiles.js';
import { resolveGhostContentPath } from './store/ghostContentTree.js';
import { installedGhostStoragePart } from './shared/pluginIdentity.js';
import type { InstalledGhost } from './shared/ghost.js';
import type { SandboxHandle, SandboxHostAdapter } from './GhostRuntime.js';

export interface HeadlessSandboxOptions {
  /** Managed or explicitly selected Chromium, never an Electron executable. */
  executablePath: string | (() => Promise<string>);
  mailRuntimeSource: string | (() => Promise<string>);
  /** Captures owner generation, installation identity and approval revision. */
  capture(ghost: InstalledGhost): () => boolean;
  receive(instanceId: string, payload: unknown): Promise<unknown>;
  /** Host endpoints share the installed instance's existing slot executors. */
  request?(instanceId: string, request: Request, current: () => boolean): Promise<Response | null>;
}

const htmlCsp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob:";

/** Pure-Node adapter for the existing GhostRuntime. Chromium keeps its native
 * sandbox. A separate ephemeral context owns each approved plugin; there is no
 * network listener, persistent browser profile, Node bridge, or shared cookie jar.
 * Synthetic HTTPS origins are served only through this private browser route. */
export class HeadlessGhostSandbox implements SandboxHostAdapter {
  private browser: Promise<Browser> | undefined;
  private closed = false;
  private handles = new Map<string, HeadlessHandle>();
  private closing = new Set<Promise<void>>();
  constructor(readonly options: HeadlessSandboxOptions) {}

  async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    if (!this.browser) {
      const flight = (async () => {
        const executablePath = typeof this.options.executablePath === 'function' ? await this.options.executablePath() : this.options.executablePath;
        if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
        return chromium.launch({ executablePath,
        headless: true, chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        args: ['--site-per-process', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        });
      })();
      this.browser = flight;
      flight.then(browser => {
        if (this.closed) void browser.close();
        browser.on('disconnected', () => { if (this.browser === flight) this.browser = undefined; });
      }, () => { if (this.browser === flight) this.browser = undefined; });
    }
    const browser = await this.browser;
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    return browser;
  }

  create(ghost: InstalledGhost): SandboxHandle {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    const id = installedGhostStoragePart(ghost);
    this.handles.get(id)?.destroy();
    const handle = new HeadlessHandle(this, ghost, this.options.capture(ghost));
    this.handles.set(id, handle);
    return handle;
  }

  send(instanceId: string, payload: unknown): boolean { return this.handles.get(instanceId)?.send(payload) ?? false; }
  async evaluate(instanceId: string, script: string): Promise<unknown> {
    const handle = this.handles.get(instanceId);
    if (!handle) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    return handle.evaluate(script);
  }
  retire(handle: HeadlessHandle, closing: Promise<void>) {
    if (this.handles.get(handle.id) === handle) this.handles.delete(handle.id);
    this.closing.add(closing); void closing.finally(() => this.closing.delete(closing));
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const handle of [...this.handles.values()]) handle.destroy();
    await Promise.allSettled([...this.closing]);
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close(); this.browser = undefined;
  }
}

class HeadlessHandle implements SandboxHandle {
  readonly id: string;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private destroyed = false;
  private gone: ((details: { reason: string }) => void) | undefined;
  private delivery = Promise.resolve();
  private readonly binding = 'cindy_' + randomUUID().replaceAll('-', '');
  private readonly receiver = 'cindy_' + randomUUID().replaceAll('-', '');
  private readonly origin: string;
  constructor(private host: HeadlessGhostSandbox, private ghost: InstalledGhost, private current: () => boolean) {
    this.id = installedGhostStoragePart(ghost);
    this.origin = `https://${ghost.manifest.id}.cindy-plugin.invalid`;
  }
  private live = () => !this.destroyed && this.current();
  private guard = () => { if (!this.live()) throw new Error('PLUGIN_PAGE_UNAVAILABLE'); };
  async load(): Promise<void> {
    this.guard();
    const browser = await this.host.getBrowser(); this.guard();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
    this.context = context;
    if (!this.live()) { await context.close(); this.guard(); }
    await context.route('**/*', route => this.route(route));
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage(); this.page = page;
    page.on('crash', () => { if (!this.destroyed) this.gone?.({ reason: 'crashed' }); });
    context.on('close', () => { if (!this.destroyed) this.gone?.({ reason: 'closed' }); });
    page.on('popup', popup => { void popup.close(); });
    page.on('download', download => { void download.cancel(); });
    await page.exposeBinding(this.binding, async (source, channel: string, payload?: unknown) => {
      this.guard();
      if (source.page !== page || source.frame !== page.mainFrame() || source.frame.url() !== this.origin + GHOST_BOOT_PATH) throw new Error('PERMISSION_DENIED');
      if (channel === 'ghost-pipe:ping') return { ok: true, id: this.id };
      if (channel !== 'ghost-pipe:send') throw new Error('PERMISSION_DENIED');
      const result = await this.host.options.receive(this.id, payload); this.guard(); return result;
    });
    // The exact shared preload API is installed before any plugin script runs.
    // This source executes inside Chromium, never in the Node host.
    await page.addInitScript({ content: `(() => {
      if (window !== window.top || location.href !== ${JSON.stringify(this.origin + GHOST_BOOT_PATH)}) return;
      const factory = ${createGhostBridge.toString()};
      const invoke = window[${JSON.stringify(this.binding)}];
      const bridge = factory({ invoke: (channel, payload) => invoke(channel, payload),
        subscribe: listener => Object.defineProperty(window, ${JSON.stringify(this.receiver)}, { value: listener }) });
      Object.defineProperty(window, 'cindy', { value: Object.freeze(bridge) });
    })();` });
    this.guard();
    await page.goto(this.origin + GHOST_BOOT_PATH, { waitUntil: 'load', timeout: 30_000 });
    this.guard();
  }
  private async route(route: Route): Promise<void> {
    try {
      if (!this.live()) { await route.abort('accessdenied'); return; }
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== this.origin) {
        // Same narrowly scoped HTTPS-image exception as Desktop. Scripts,
        // fetch, frames, sockets and navigation never get general networking.
        if (url.protocol === 'https:' && request.resourceType() === 'image') await route.continue();
        else await route.abort('accessdenied');
        return;
      }
      if (request.isNavigationRequest() && (request.frame() !== this.page?.mainFrame() || url.pathname !== GHOST_BOOT_PATH)) { await route.abort('accessdenied'); return; }
      let response: Response | null = null;
      const post = request.postDataBuffer();
      if (post && post.byteLength > 65_536) response = new Response(null, { status: 413 });
      if (!response) response = await this.host.options.request?.(this.id, new Request(request.url(), {
        method: request.method(), headers: request.headers(), ...(post && request.method() !== 'GET' && request.method() !== 'HEAD' ? { body: new Uint8Array(post) } : {}),
      }), this.live) ?? null;
      if (!response && request.method() !== 'GET') response = new Response(null, { status: 405 });
      if (!response) {
        if (url.pathname === GHOST_BOOT_PATH) response = new Response(ghostBootHtml(this.ghost.manifest.entry), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        else if (url.pathname === GHOST_MAIL_SDK_PATH) response = new Response(typeof this.host.options.mailRuntimeSource === 'function' ? await this.host.options.mailRuntimeSource() : this.host.options.mailRuntimeSource, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
        else {
          const resolved = resolveGhostFilePath(this.ghost.dir, url.pathname);
          if (!resolved) response = new Response(null, { status: 403 });
          else {
            const file = await resolveGhostContentPath(this.ghost.dir, path.relative(this.ghost.dir, resolved).split(path.sep).join('/'), { expect: 'file', label: 'plugin runtime' });
            response = new Response(new Uint8Array(await readFile(file)), { headers: { 'Content-Type': ghostFileMime(file) } });
          }
        }
      }
      if (!this.live()) { await route.abort('accessdenied'); return; }
      const headers = Object.fromEntries(response.headers); headers['cache-control'] = 'no-store';
      if (headers['content-type']?.startsWith('text/html')) headers['content-security-policy'] = htmlCsp;
      const body = Buffer.from(await response.arrayBuffer()); this.guard();
      await route.fulfill({ status: response.status, headers, body });
    } catch { await route.fulfill({ status: this.live() ? 404 : 403, body: '' }).catch(() => {}); }
  }
  async evaluate(script: string): Promise<unknown> {
    this.guard();
    if (!this.page || this.page.isClosed()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    const result = await this.page.evaluate(script);
    this.guard();
    return result;
  }
  send(payload: unknown): boolean {
    if (!this.live() || !this.page || this.page.isClosed()) return false;
    const page = this.page;
    this.delivery = this.delivery.then(async () => {
      this.guard();
      await page.evaluate(({ receiver, payload }) => {
        const deliver = (globalThis as unknown as Record<string, (payload: unknown) => void>)[receiver];
        if (typeof deliver !== 'function') throw new Error('PLUGIN_BRIDGE_NOT_READY');
        deliver(payload);
      }, { receiver: this.receiver, payload });
    }).catch(() => { if (!this.destroyed) this.gone?.({ reason: 'delivery-failed' }); });
    return true;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const context = this.context; this.context = undefined; this.page = undefined;
    this.host.retire(this, context?.close().catch(() => {}) ?? Promise.resolve());
  }
  crashForTest(): void { if (this.page) void this.page.goto('chrome://crash').catch(() => {}); }
  onGone(callback: (details: { reason: string }) => void): void { this.gone = callback; }
}
