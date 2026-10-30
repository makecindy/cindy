import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isSharedTaskPeer } from '@cindy/device-link';
import type { McpAppSandboxView } from '../../shared/mcpApps.js';
import { isMcpAppLinkAuthorizationCurrent } from '../../shared/mcpApps.js';
import { MCP_APPS_MAX_BYTES, MCP_APPS_MAX_REMOTE_BYTES, safeAppLink } from './protocol.js';
import { mcpAppOperationSchema } from './operations.js';
import { assertMcpAppDocumentCaller, mountRemoteAppDocument, unmountRemoteAppDocument } from './sandboxProtocol.js';

const id = z.string().min(1).max(256);
const documentSchema = z.object({
  viewId: id, html: z.string(), csp: z.string(), prefersBorder: z.boolean(),
  policy: z.object({
    connectDomains: z.array(z.string()).optional(), resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(), baseUriDomains: z.array(z.string()).optional(),
  }).optional(),
});
interface RemoteViewDeps {
  owner(): object | null | undefined;
  closeEpoch(deviceId: string): number;
  invoke(deviceId: string, sessionId: string, input: Record<string, unknown>, preSend: () => void): Promise<unknown>;
  openLink(url: string): Promise<void>;
}
interface Opening {
  owner: object; caller: string; deviceId: string; sessionId: string; openId?: string;
  remoteOpenId: string; cancelled: boolean; closeEpoch: number;
}
interface RemoteView extends Opening {
  localId: string; remoteId: string; links: Map<string, string>; closing?: Promise<void>;
}

/** Main binds a remote View to its local owner/window/frame; Renderer IDs never grant App RPC access. */
export class RemoteMcpAppViews {
  private readonly opening = new Set<Opening>();
  private readonly views = new Map<string, RemoteView>();
  constructor(private readonly deps: RemoteViewDeps) {}

  private assertLink(entry: Opening): void {
    if (this.deps.closeEpoch(entry.deviceId) !== entry.closeEpoch) throw new Error('MCP_APP_LINK_CLOSED');
  }

  private async call(entry: Opening, input: Record<string, unknown>, assertCurrent = () => {}): Promise<unknown> {
    const preSend = () => {
      if (this.deps.owner() !== entry.owner) throw new Error('MCP_APP_OWNER_CHANGED');
      this.assertLink(entry);
      assertCurrent();
    };
    preSend();
    return this.deps.invoke(entry.deviceId, entry.sessionId, input, preSend);
  }
  private assertView(view: RemoteView): void {
    this.assertLink(view);
    if (this.views.get(view.localId) !== view || this.deps.owner() !== view.owner)
      throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    assertMcpAppDocumentCaller(view.localId, view.caller);
  }
  private forward(view: RemoteView, input: Record<string, unknown>): Promise<unknown> {
    this.assertView(view);
    return this.call(view, { ...input, viewId: view.remoteId }, () => this.assertView(view));
  }
  private async poll(view: RemoteView, input: Record<string, unknown>): Promise<unknown> {
    let failedAt: number | undefined;
    let delay = 500;
    while (true) {
      try { return await this.forward(view, input); }
      catch (error) {
        this.assertView(view);
        failedAt ??= Date.now();
        if (view.closing || /MCP_APP_|CHANNEL_NOT_ALLOWED|NOT_FOUND|ACCESS_REVOKED|PERMISSION_DENIED/.test(String(error)) ||
            Date.now() - failedAt >= 30_000) throw error;
        // Only this View's read is retried. Never reset a peer/relay or replay App writes.
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(5_000, delay * 2);
      }
    }
  }

  async control(caller: string, deviceId: unknown, sessionId: string, raw: unknown): Promise<unknown> {
    if (!id.safeParse(deviceId).success || !id.safeParse(sessionId).success ||
        !raw || Buffer.byteLength(JSON.stringify(raw)) > MCP_APPS_MAX_BYTES)
      throw new Error('MCP_APP_INVALID_REQUEST');
    const device = deviceId as string;
    if (isSharedTaskPeer(device)) throw new Error('MCP_APP_OWNER_ONLY');
    const parsed = mcpAppOperationSchema.safeParse(raw);
    if (!parsed.success) throw new Error('MCP_APP_INVALID_REQUEST');
    const input = parsed.data;
    if (input.op === 'open') return this.open(caller, device, sessionId, input);
    if (input.op === 'cancel-open') {
      await Promise.all([...this.opening].filter((entry) => entry.caller === caller &&
        entry.deviceId === device && entry.sessionId === sessionId && entry.openId === input.openId &&
        entry.owner === this.deps.owner()).map((entry) => this.cancel(entry)));
      return {};
    }
    if (!['context', 'display-mode', 'teardown'].includes(input.op))
      throw new Error('MCP_APP_FRAME_REQUIRED');
    const view = 'viewId' in input ? this.views.get(input.viewId) : undefined;
    if (!view || view.caller !== caller || view.deviceId !== device || view.sessionId !== sessionId)
      throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    this.assertView(view);
    if (input.op === 'teardown') {
      await this.close(view);
      return {};
    }
    if (view.closing) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    const result = await this.forward(view, input);
    this.assertView(view);
    return result;
  }

  private async open(
    caller: string, deviceId: string, sessionId: string,
    input: Extract<z.infer<typeof mcpAppOperationSchema>, { op: 'open' }>,
  ): Promise<McpAppSandboxView> {
    const owner = this.deps.owner();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    const count = [...this.opening, ...this.views.values()].filter((entry) => entry.caller === caller && entry.owner === owner).length;
    if (count >= 16) throw new Error('MCP_APP_VIEW_LIMIT');
    const entry: Opening = { owner, caller, deviceId, sessionId, openId: input.openId,
      remoteOpenId: randomUUID(), cancelled: false, closeEpoch: this.deps.closeEpoch(deviceId) };
    this.opening.add(entry);
    let remoteId: string | undefined;
    try {
      const raw = await this.call(entry, { ...input, openId: entry.remoteOpenId }, () => {
        if (entry.cancelled) throw new Error('MCP_APP_OPEN_CANCELLED');
      });
      this.assertLink(entry);
      const document = documentSchema.parse(raw);
      remoteId = document.viewId;
      if (Buffer.byteLength(JSON.stringify(document)) > MCP_APPS_MAX_REMOTE_BYTES)
        throw new Error('MCP_APP_DOCUMENT_TOO_LARGE');
      if (entry.cancelled || this.deps.owner() !== owner) throw new Error('MCP_APP_OPEN_CANCELLED');
      // Only Main's remote result is supplied. There is no Renderer-controlled HTML/RPC rebinding.
      const view: RemoteView = { ...entry, localId: '', remoteId, links: new Map() };
      view.localId = mountRemoteAppDocument(document, caller, (raw) => this.frame(view, raw), () => this.dispose(view));
      this.views.set(view.localId, view);
      return { viewId: view.localId, transport: 'sandbox', prefersBorder: document.prefersBorder };
    } catch (error) {
      // No writes are replayed. An old Host may reject cancel-open; its idle lease remains the fallback.
      await this.call(entry, remoteId ? { op: 'teardown', viewId: remoteId } :
        { op: 'cancel-open', openId: entry.remoteOpenId }).catch(() => {});
      throw error;
    } finally { this.opening.delete(entry); }
  }

  /** Called exclusively by the protocol after verifying Chromium's actual sandbox frame. */
  private async frame(view: RemoteView, raw: unknown): Promise<unknown> {
    this.assertView(view);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Buffer.byteLength(JSON.stringify(raw)) > MCP_APPS_MAX_BYTES) throw new Error('MCP_APP_INVALID_REQUEST');
    const value = raw as Record<string, unknown>;
    if (value.op === 'open-link') {
      if (view.closing) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
      if (typeof value.linkId !== 'string' || typeof value.url !== 'string' ||
          view.links.get(value.linkId) !== safeAppLink(value.url)) throw new Error('MCP_APP_INVALID_LINK');
      view.links.delete(value.linkId);
      const requestedAt = performance.now();
      const authorization = await this.forward(view, { op: 'authorize-link', linkId: value.linkId });
      this.assertView(view);
      if (view.closing) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
      if (!isMcpAppLinkAuthorizationCurrent(authorization, performance.now() - requestedAt))
        throw new Error('MCP_APP_LINK_NOT_AUTHORIZED');
      await this.deps.openLink(safeAppLink(value.url));
      return {};
    }
    const parsed = mcpAppOperationSchema.safeParse({ ...value, viewId: view.localId });
    if (!parsed.success || !['message', 'poll', 'link-result'].includes(parsed.data.op))
      throw new Error('MCP_APP_INVALID_REQUEST');
    const input = parsed.data;
    const result = await (input.op === 'poll' ? this.poll(view, input) : this.forward(view, input));
    this.assertView(view);
    if (input.op === 'poll') {
      if (!Array.isArray(result) || result.length > 256 || Buffer.byteLength(JSON.stringify(result)) > MCP_APPS_MAX_REMOTE_BYTES)
        throw new Error('MCP_APP_INVALID_POLL');
      for (const event of result) {
        if (event?.openLink && typeof event.openLink.id === 'string' && typeof event.openLink.url === 'string') {
          if (view.links.size >= 256 && !view.links.has(event.openLink.id)) throw new Error('MCP_APP_BACKPRESSURE');
          view.links.set(event.openLink.id, safeAppLink(event.openLink.url));
        }
      }
    }
    if (input.op === 'link-result') view.links.delete(input.linkId);
    return result;
  }

  private cancel(entry: Opening): Promise<unknown> {
    entry.cancelled = true;
    this.opening.delete(entry);
    return this.call(entry, { op: 'cancel-open', openId: entry.remoteOpenId });
  }
  private close(view: RemoteView): Promise<void> {
    view.closing ??= (async () => {
      try { await this.call(view, { op: 'teardown', viewId: view.remoteId }); }
      finally { if (this.views.get(view.localId) === view) unmountRemoteAppDocument(view.localId, view.caller); }
    })();
    return view.closing;
  }
  private dispose(view: RemoteView): void {
    this.views.delete(view.localId);
    view.links.clear();
    if (!view.closing) void this.call(view, { op: 'teardown', viewId: view.remoteId }).catch(() => {});
  }
  async releaseCaller(caller: string): Promise<void> {
    const pending = [...this.opening].filter((entry) => entry.caller === caller).map((entry) => this.cancel(entry));
    for (const view of this.views.values()) if (view.caller === caller) unmountRemoteAppDocument(view.localId, caller);
    await Promise.allSettled(pending);
  }
}
