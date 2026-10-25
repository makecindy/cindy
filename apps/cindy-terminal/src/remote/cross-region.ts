import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseProviderShareLink, parseProviderShareInvitationIntent, providerShareLinkRegion, providerShareParsers, providerShareHostPeer, PROVIDER_SHARE_RELAY_CAPABILITY, type ProviderShareReceived, type ProviderShareRequestState, type ProviderShareLinkPreview } from '@cindy/device-link';
import type { TerminalRemoteAccountService } from './account.js';
import { TerminalDeviceService } from './service.js';
import type { TerminalDeviceServiceOptions } from './types.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';

type Region = 'cn' | 'global';
type Pending = { state: ProviderShareRequestState; region: Region; token?: string };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Shares use the owner's official region, never a pasted server as a network
 * target. The other region receives a signed card, not this account's token. */
export class TerminalCrossRegionShares {
  private readonly owner: string | null;
  private readonly marker: string;
  private marked = false;
  private credential: string | null = null;
  private expiresAt = 0;
  private received: ProviderShareReceived[] = [];
  private readonly pending = new Map<string, Pending>();
  private client?: TerminalDeviceService;
  private closed = false;
  private refreshing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly ready: Promise<void>;
  constructor(private readonly options: {
    profileDir: string; account: TerminalRemoteAccountService; region: Region;
    endpoints: Record<Region, string>; getOwnerScope(): string | null;
    deviceId: string; getHello: TerminalDeviceServiceOptions['getHello'];
    createWebSocket: TerminalDeviceServiceOptions['createWebSocket'];
    directRuntime?: TerminalDeviceServiceOptions['directRuntime'];
    onPush: TerminalDeviceServiceOptions['onPush']; fetch?: typeof fetch;
  }) {
    this.owner = options.getOwnerScope(); this.marker = path.join(options.profileDir, 'provider-share-regions.json');
    this.ready = this.load();
  }
  private peerRegion(): Region { return this.options.region === 'cn' ? 'global' : 'cn'; }
  private assertCurrent() { if (this.closed || !this.owner || this.options.getOwnerScope() !== this.owner) throw new Error('OWNER_CHANGED'); }
  private async load() {
    const bytes = await readPrivateFile(this.marker);
    if (!bytes) return;
    const value = JSON.parse(bytes.toString()) as { version?: unknown; region?: unknown };
    if (value.version !== 1 || value.region !== this.peerRegion()) throw new Error('INVALID_SHARE_REGION_MARKER');
    this.marked = true;
  }
  private async mark() {
    this.assertCurrent(); await privateDirectory(path.dirname(this.marker));
    await atomicPrivateWrite(this.marker, JSON.stringify({ version: 1, region: this.peerRegion() }));
    this.assertCurrent(); this.marked = true;
  }
  async open() { await this.ready; if (this.marked) await this.refresh(); }
  private async request(region: Region, suffix: string, body: unknown, credential?: string) {
    this.assertCurrent();
    const response = await (this.options.fetch ?? fetch)(new URL(`/api/device-link/provider-shares/x${suffix}`, this.options.endpoints[region]), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: `ProviderShareGuest ${credential}` } : {}) }, body: JSON.stringify(body),
    });
    this.assertCurrent();
    if (!response.ok) throw new Error(response.status === 403 ? 'PROVIDER_SHARE_ACCESS_DENIED' : 'PROVIDER_SHARE_REQUEST_FAILED');
    const value: unknown = await response.json(); this.assertCurrent();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PROVIDER_SHARE_RESPONSE');
    return value as Record<string, unknown>;
  }
  private intent(link: string) {
    const intent = parseProviderShareLink(link) ?? parseProviderShareInvitationIntent(link);
    if (!intent) throw new Error('INVALID_PROVIDER_SHARE_LINK');
    const region = providerShareLinkRegion(intent, this.options.endpoints);
    if (!region) throw new Error('UNKNOWN_PROVIDER_SHARE_REGION');
    return { ...intent, region };
  }
  async preview(link: string): Promise<ProviderShareLinkPreview> {
    const intent = this.intent(link);
    if (intent.region === this.options.region) return this.options.account.providerShares.preview(intent.invitation);
    const card = await this.options.account.identityCard('share-request', sha256(intent.invitation));
    return providerShareParsers.preview(await this.request(intent.region, '/preview', { invitation: intent.invitation, identityCard: card }));
  }
  async join(link: string): Promise<ProviderShareRequestState> {
    const intent = this.intent(link);
    const card = await this.options.account.identityCard('share-request', sha256(intent.invitation));
    let pending: Pending;
    if (intent.region === this.options.region) pending = { state: await this.options.account.providerShares.sendRequest(intent.invitation, card), region: intent.region };
    else {
      const result = await this.request(intent.region, '/requests', { invitation: intent.invitation, identityCard: card });
      pending = { state: providerShareParsers.requestState(result), region: intent.region, token: providerShareParsers.secret(result.requestToken) };
      await this.mark();
    }
    this.assertCurrent(); this.pending.set(pending.state.requestId, pending); return pending.state;
  }
  async requests(): Promise<ProviderShareRequestState[]> {
    this.assertCurrent();
    for (const item of this.pending.values()) {
      item.state = item.token ? providerShareParsers.requestState(await this.request(item.region, `/requests/${encodeURIComponent(item.state.requestId)}`, { requestToken: item.token }))
        : await this.options.account.providerShares.getRequest(item.state.requestId);
    }
    return [...this.pending.values()].map(item => item.state);
  }
  async withdraw(requestId: string) {
    const item = this.pending.get(requestId); if (!item) throw new Error('REQUEST_NOT_FOUND');
    if (item.token) await this.request(item.region, `/requests/${encodeURIComponent(requestId)}/withdraw`, { requestToken: item.token });
    else await this.options.account.providerShares.withdraw(requestId);
    this.assertCurrent(); this.pending.delete(requestId);
  }
  async refresh(): Promise<void> {
    await this.ready; this.assertCurrent(); if (!this.marked) return;
    if (this.refreshing) return this.refreshing;
    const work = (async () => {
      const region = this.peerRegion();
      const card = await this.options.account.identityCard('share-session', sha256(this.options.deviceId));
      const hello = this.options.getHello();
      const value = await this.request(region, '/session', { identityCard: card, deviceId: this.options.deviceId, deviceName: hello.deviceName, platform: hello.platform });
      const received = providerShareParsers.receivedList(value);
      const credential = value.credential == null ? null : providerShareParsers.secret(value.credential);
      const expiresAt = credential ? Date.parse(providerShareParsers.timestamp(value.expiresAt)) : 0;
      this.assertCurrent(); this.received = received; this.credential = credential; this.expiresAt = expiresAt;
      if (!credential || !received.length) { this.client?.stop(); this.client = undefined; }
      else if (!this.client) {
        this.client = new TerminalDeviceService({
          getOwnerScope: this.options.getOwnerScope, getHello: () => ({ ...this.options.getHello(), capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY], remoteControlEnabled: false }),
          getToken: async () => { this.assertCurrent(); if (Date.now() >= this.expiresAt - 60 * 60_000) await this.refresh(); return this.credential; },
          getWsUrl: () => { const url = new URL('/api/device-link/ws', this.options.endpoints[region]); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.href; },
          authorizationScheme: 'ProviderShareGuest', createWebSocket: this.options.createWebSocket, directRuntime: this.options.directRuntime,
          controllerCapabilities: [PROVIDER_SHARE_RELAY_CAPABILITY],
          invokeLocal: async () => { throw new Error('CROSS_REGION_CONTROLLER_ONLY'); }, onPush: this.options.onPush,
        }); this.client.start();
      }
    })();
    this.refreshing = work;
    try { await work; } finally {
      if (this.refreshing === work) this.refreshing = undefined;
      clearTimeout(this.timer);
      if (!this.closed) { this.timer = setTimeout(() => { void this.refresh().catch(() => undefined); }, this.credential ? 12 * 60 * 60_000 : 60_000); this.timer.unref(); }
    }
  }
  async list() { await this.ready; this.assertCurrent(); return [...this.received]; }
  snapshot(): readonly ProviderShareReceived[] { return [...this.received]; }
  has(shareId: string) { return this.received.some(share => share.shareId === shareId); }
  async invoke(shareId: string, channel: string, args: unknown[]) {
    this.assertCurrent(); if (Date.now() >= this.expiresAt - 60 * 60_000) await this.refresh();
    const share = this.received.find(share => share.shareId === shareId && share.status === 'active');
    if (!share || !this.client) throw new Error('PROVIDER_SHARE_UNAVAILABLE');
    return this.client.invoke(providerShareHostPeer(share.shareId, share.hostDeviceId), channel, args);
  }
  async leave(memberId: string): Promise<boolean> {
    if (!this.received.some(share => share.memberId === memberId)) return false;
    if (!this.credential) throw new Error('PROVIDER_SHARE_UNAVAILABLE');
    await this.request(this.peerRegion(), `/received/${encodeURIComponent(memberId)}/leave`, {}, this.credential);
    await this.refresh(); return true;
  }
  close() { this.closed = true; clearTimeout(this.timer); this.client?.stop(); this.client = undefined; this.pending.clear(); this.credential = null; this.received = []; }
}
