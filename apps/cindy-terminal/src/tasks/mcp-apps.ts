import { randomBytes } from 'node:crypto';
import { McpAppsHost, type McpAppsHostDeps } from '@cindy/app-runtime/mcp-apps/host';
import { createPersistedMcpAppsHostDeps } from '@cindy/app-runtime/mcp-apps/persistedHost';
import { createMcpAppsRuntime } from '@cindy/app-runtime/mcp-apps/runtime';
import { createAppServerProxy } from '@cindy/app-runtime/mcp-apps/serverProxy';
import { handleMcpAppOperation } from '@cindy/app-runtime/mcp-apps/operations';
import { CustomMcpProvider } from '@cindy/app-runtime/customMcpProvider';
import { createCustomMcpStore } from '@cindy/app-runtime/customMcpStore';
import type { CustomMcpConfig, InteractionRequest, InteractionDecision, Logger } from '@cindy/maker-core';
import type { NodeDatabase } from '../database.js';
import type { TerminalSecrets, InvocationContext } from '../contracts.js';
import type { TerminalConversations } from './conversations.js';

/** The original App host owns cards, upstream connections and grants. Remote
 * GUI clients render its documents; this process needs no renderer or WebView. */
export class TerminalMcpApps {
  readonly runtime = createMcpAppsRuntime();
  readonly ready: Promise<void>;
  private host?: McpAppsHost;
  private closed = false;
  private configured: CustomMcpProvider[] = [];
  private remoteNames = new Set<string>();
  private store?: ReturnType<typeof createCustomMcpStore>;
  private startHost?: () => Promise<void>;
  private hostFlight?: Promise<void>;
  constructor(private readonly options: {
    database: Promise<NodeDatabase>; conversations: Promise<TerminalConversations>;
    secrets: TerminalSecrets; logger: Logger; assertCurrent(): void;
    secretsLocked?(): boolean;
    send: McpAppsHostDeps['sendMessage'];
    request(id: string, input: InteractionRequest, signal: AbortSignal): Promise<InteractionDecision>;
  }) { this.ready = this.open(); void this.ready.catch(() => {}); }
  private guard() { if (this.closed) throw new Error('MCP_APPS_CLOSED'); this.options.assertCurrent(); }
  private async open() {
    const [database, conversations] = await Promise.all([this.options.database, this.options.conversations]);
    this.guard();
    const owner = database.getCurrentDbClientSnapshot();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    const currentOwner = () => {
      try { this.guard(); } catch { return undefined; }
      return database.getCurrentDbClientSnapshot() === owner ? owner : undefined;
    };
    this.store = createCustomMcpStore(() => {
      if (!currentOwner()) throw new Error('MCP_APP_OWNER_CHANGED');
      return owner.client;
    });
    this.startHost = async () => {
      this.guard();
      const secretKey = 'mcp-app-revision-key';
      let revisionKey = await this.options.secrets.get(secretKey); this.guard();
      if (!revisionKey) { revisionKey = randomBytes(32).toString('hex'); await this.options.secrets.set(secretKey, revisionKey); this.guard(); }
      this.host = new McpAppsHost(createPersistedMcpAppsHostDeps({
      currentOwner, ...conversations.broadcastTap,
      createMessage: conversations.messages.createMessage,
      broadcastMessageRow: conversations.messages.broadcastMessageRow,
      getMcpAppRevisionKey: () => { this.guard(); return revisionKey!; },
      readAppServer: this.runtime.readAppServer,
      send: this.options.send, request: this.options.request, logger: this.options.logger,
      }));
      this.runtime.setMcpAppsHost(this.host);
    };
    // Configuration/history remain readable while the user is setting up or
    // unlocking the vault. Interactive App grants still require the real key.
    if (!this.options.secretsLocked?.()) await this.startHost();
  }
  async unlock() {
    await this.ready; this.guard();
    if (this.host) return;
    this.hostFlight ??= this.startHost!().finally(() => { this.hostFlight = undefined; });
    await this.hostFlight;
  }
  async configuration() { await this.ready; this.guard(); return this.store!; }
  replaceConfigs(entries: Array<{ config: CustomMcpConfig; token: string | null; remoteEligible: boolean }>) {
    this.guard();
    const providers = entries.map(({ config, token }) => new CustomMcpProvider(config, () => token,
      (read, context) => createAppServerProxy(read, context, { ...this.runtime, logger: this.options.logger })));
    this.runtime.clearAppServerConfigs();
    for (const provider of providers) this.runtime.registerAppServer(provider.name, () => provider.appServerConfig());
    this.configured = providers;
    this.remoteNames = new Set(entries.filter(entry => entry.remoteEligible).map(entry => entry.config.id));
  }
  providers() { this.guard(); return [...this.configured]; }
  remoteProviders() { return this.providers().filter(provider => this.remoteNames.has(provider.name)); }
  remoteServerIds() { this.guard(); return [...this.remoteNames]; }
  async invoke(args: unknown[], context: InvocationContext) {
    await this.ready; this.guard(); context.assertCurrent?.();
    if (context.sharedTask) throw new Error('MCP_APP_OWNER_ONLY');
    if (typeof args[0] !== 'string' || args[1] && typeof args[1] === 'object' && 'deviceId' in args[1]) throw new Error('MCP_APP_INVALID_REQUEST');
    if (context.source === 'remote' && !context.deviceId) throw new Error('MCP_APP_OWNER_ONLY');
    await this.unlock(); this.guard(); context.assertCurrent?.();
    return handleMcpAppOperation(this.host!, context.source === 'remote' ? `device:${context.deviceId}` : 'terminal', args[0], args[1]);
  }
  async releaseDevice(deviceId: string) {
    // No account reads: disconnect/owner teardown revokes the original host's
    // views immediately, including any open operation still awaiting upstream.
    await this.host?.releaseCaller(`device:${deviceId}`);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => {});
    await this.hostFlight?.catch(() => {});
    this.configured = []; this.runtime.clearAppServerConfigs();
    await this.host?.reset();
  }
}
