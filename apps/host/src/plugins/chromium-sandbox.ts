import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type JSHandle } from 'playwright-core';
import type { InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import { ghostInstallApprovalToken } from '../../../desktop/src/shared/ghost.js';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.js';
import type { SandboxHandle, SandboxHostAdapter } from '../../../desktop/src/main/cindy-brain/runtime/GhostRuntime.js';
import { GHOST_BOOT_PATH, GHOST_MAIL_SDK_PATH } from '../../../desktop/src/main/cindy-brain/runtime/ghostFiles.js';
import { GHOST_HTML_CSP } from '../../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.js';

export interface HeadlessPluginSandboxPorts {
  /** Captured by the launcher, never selected by plugin data. */
  executablePath?: string;
  bridgeSource: string;
  ownerKey: () => string;
  isCurrent: (ghost: InstalledGhost, ownerKey: string) => boolean;
  pageHandler: (ghost: InstalledGhost, origin: string, current: () => boolean) => (request: Request) => Promise<Response>;
  send: (ghost: InstalledGhost, payload: unknown) => Promise<unknown>;
}
interface Partition {
  key: string;
  id: string;
  origin: string;
  current: () => boolean;
  context: BrowserContext;
  handler: (request: Request) => Promise<Response>;
}

/** Real Chromium renderers, with Chromium's OS sandbox explicitly enabled.
 * No browser debugger socket, user browser profile, Node binding or host path is
 * exposed to a plugin. Page identity comes from the captured context and frame.
 */
export function createHeadlessPluginSandbox(ports: HeadlessPluginSandboxPorts) {
  let browserPromise: Promise<Browser> | undefined;
  let closed = false;
  const partitions = new Map<string, Promise<Partition>>();
  const logic = new Map<string, { page: Page; partition: Partition; bridge: JSHandle }>();
  const closing = new Set<Promise<unknown>>();
  function closeContext(context: BrowserContext) {
    const pending = context.close().catch(() => undefined).finally(() => closing.delete(pending));
    closing.add(pending);
  }
  function browser() {
    if (closed) return Promise.reject(new Error('PLUGIN_RUNTIME_STOPPED'));
    if (!browserPromise) {
      const pending = chromium.launch({
        headless: true, chromiumSandbox: true, executablePath: ports.executablePath,
      });
      browserPromise = pending;
      void pending.then(instance => {
        instance.once('disconnected', () => {
          if (browserPromise === pending) browserPromise = undefined;
        });
      }, () => {
        // Installing/repairing Chromium should allow a new attempt without a
        // Host restart. Do not erase a newer launch on late rejection.
        if (browserPromise === pending) browserPromise = undefined;
      });
    }
    return browserPromise;
  }
  async function partitionFor(ghost: InstalledGhost): Promise<Partition> {
    const owner = ports.ownerKey();
    if (!ports.isCurrent(ghost, owner)) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    const id = installedGhostStoragePart(ghost);
    const key = JSON.stringify([owner, id, ghost.dir, ghostInstallApprovalToken(ghost.approval), ghost.manifest.version]);
    let pending = partitions.get(key);
    if (pending) {
      const previous = await pending.catch(() => null);
      if (!previous?.current()) {
        if (partitions.get(key) === pending) partitions.delete(key);
        if (previous) closeContext(previous.context);
        pending = partitions.get(key);
      }
    }
    if (!pending) {
      pending = (async () => {
        const context = await (await browser()).newContext({
          acceptDownloads: false, serviceWorkers: 'block', permissions: [],
          bypassCSP: false, ignoreHTTPSErrors: false,
        });
        let contextClosed = false;
        context.once('close', () => { contextClosed = true; });
        const current = () => !closed && !contextClosed && context.browser()?.isConnected() !== false &&
          ports.ownerKey() === owner && ports.isCurrent(ghost, owner);
        try {
          if (!current()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
          // A virtual origin is intercepted inside this context. It has no DNS,
          // listener or loopback port; another plugin cannot reach its resources.
          const origin = `https://${createHash('sha256').update(key).digest('hex')}.cindy-ghost.invalid`;
          const handler = ports.pageHandler(ghost, origin, current);
          const partition = { key, id, origin, current, context, handler };
          await context.route('**/*', async route => {
            if (!current()) { await route.abort('blockedbyclient'); return; }
            const request = route.request();
            let url: URL;
            try { url = new URL(request.url()); } catch { await route.abort('blockedbyclient'); return; }
            if (url.origin !== origin) {
              // The existing page contract allows external HTTPS images only.
              if (url.protocol === 'https:' && request.resourceType() === 'image') await route.continue();
              else await route.abort('blockedbyclient');
              return;
            }
            if (url.username || url.password) { await route.abort('blockedbyclient'); return; }
            try {
              const body = request.postDataBuffer();
              // Page configuration endpoints already have a 64 KiB body contract.
              if (body && body.length > 65_536) { await route.fulfill({ status: 413 }); return; }
              const response = await handler(new Request(request.url(), {
                method: request.method(), headers: request.headers(),
                ...(body && !['GET', 'HEAD'].includes(request.method()) ? { body: new Uint8Array(body) } : {}),
              }));
              if (!current()) { await response.body?.cancel(); await route.abort('blockedbyclient'); return; }
              const bytes = Buffer.from(await response.arrayBuffer());
              if (!current()) { await route.abort('blockedbyclient'); return; }
              await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: bytes });
            } catch { await route.abort('failed').catch(() => undefined); }
          });
          await context.routeWebSocket('**/*', socket => socket.close());
          context.on('page', page => {
            page.on('dialog', dialog => { void dialog.dismiss().catch(() => undefined); });
            page.on('download', download => { void download.cancel().catch(() => undefined); });
            page.on('popup', popup => { void popup.close().catch(() => undefined); });
          });
          return partition;
        } catch (error) {
          await context.close().catch(() => undefined);
          throw error;
        }
      })();
      partitions.set(key, pending);
      void pending.catch(() => { if (partitions.get(key) === pending) partitions.delete(key); });
    }
    const partition = await pending;
    if (!partition.current()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    return partition;
  }
  const adapter: SandboxHostAdapter = {
    create(ghost): SandboxHandle {
      let destroyed = false;
      let page: Page | undefined;
      let gone: ((details: { reason: string }) => void) | undefined;
      const id = installedGhostStoragePart(ghost);
      return {
        async load() {
          const partition = await partitionFor(ghost);
          if (destroyed) throw new Error('PLUGIN_RUNTIME_STOPPED');
          page = await partition.context.newPage();
          const livePage = page;
          if (destroyed || !partition.current()) { await page.close(); throw new Error('PLUGIN_PAGE_UNAVAILABLE'); }
          page.on('crash', () => { if (!destroyed) gone?.({ reason: 'crashed' }); });
          page.on('close', () => { if (!destroyed) gone?.({ reason: 'closed' }); });
          const valid = () => !destroyed && partition.current() && !livePage.isClosed();
          await page.exposeBinding('__cindyPluginRequest', async (source, kind, payload) => {
            if (!valid() || source.page !== livePage || source.frame !== livePage.mainFrame() ||
                new URL(source.frame.url()).origin !== partition.origin) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
            if (kind === 'ping') return { ok: true, id };
            if (kind !== 'send') throw new Error('PLUGIN_REQUEST_INVALID');
            const result = await ports.send(ghost, payload);
            if (!valid()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
            return result;
          });
          // Initialize the private delivery handle before loading plugin code.
          // Unlike a global callback it cannot be replaced or called by a panel.
          await page.route(`${partition.origin}${GHOST_BOOT_PATH}`, route => route.fulfill({
            status: 200, contentType: 'text/html', headers: { 'Content-Security-Policy': GHOST_HTML_CSP },
            body: '<!doctype html><html><head></head><body></body></html>',
          }));
          await page.goto(`${partition.origin}${GHOST_BOOT_PATH}`);
          const bridge = await page.evaluateHandle(`(() => { ${ports.bridgeSource}\nconst bridge = CindyPluginBridge.createGhostPageBridge({ ping: () => window.__cindyPluginRequest('ping'), send: payload => window.__cindyPluginRequest('send', payload) }); Object.defineProperty(window, 'cindy', { value: bridge.api, writable: false, configurable: false }); return bridge; })()`);
          logic.set(id, { page, partition, bridge });
          await page.addScriptTag({ url: `${partition.origin}${GHOST_MAIL_SDK_PATH}` });
          await page.addScriptTag({ url: `${partition.origin}/${ghost.manifest.entry}` });
          if (!valid()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
        },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          if (logic.get(id)?.page === page) logic.delete(id);
          if (page) void page.close().catch(() => undefined);
        },
        crashForTest() {
          if (page) void page.context().newCDPSession(page).then(cdp => cdp.send('Page.crash')).catch(() => undefined);
        },
        onGone(callback) { gone = callback; },
      };
    },
  };
  return {
    adapter,
    async deliver(id: string, message: unknown, options: { failOnUncertain?: boolean } = {}): Promise<boolean> {
      const target = logic.get(id);
      if (!target?.partition.current() || target.page.isClosed()) return false;
      try { await target.bridge.evaluate((bridge, payload) => bridge.deliver(payload), message); return target.partition.current(); }
      catch { if (options.failOnUncertain) throw new Error('PLUGIN_DELIVERY_UNKNOWN'); return false; }
    },
    /** A zero-bridge page in the exact same owner × installation partition. */
    async openPage(ghost: InstalledGhost, pathname: string): Promise<Page> {
      const partition = await partitionFor(ghost);
      const url = new URL(pathname, partition.origin);
      if (url.origin !== partition.origin) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
      const page = await partition.context.newPage();
      try {
        await page.goto(url.href);
        if (!partition.current()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
        return page;
      } catch (error) { await page.close(); throw error; }
    },
    async revokeStale() {
      for (const [key, pending] of partitions) {
        const partition = await pending.catch(() => null);
        if (partition && !partition.current()) { partitions.delete(key); closeContext(partition.context); }
      }
      await Promise.all(closing);
    },
    async close() {
      closed = true;
      const active = await Promise.allSettled(partitions.values());
      for (const result of active) if (result.status === 'fulfilled') closeContext(result.value.context);
      partitions.clear(); logic.clear();
      await Promise.all(closing);
      await (await browserPromise?.catch(() => undefined))?.close();
    },
  };
}
