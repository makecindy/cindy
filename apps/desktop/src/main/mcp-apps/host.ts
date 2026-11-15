import { z } from 'zod';
import { VIEW_STATE_KEY, VIEW_STATE_METHOD, VIEW_STATE_CAPABILITY, ViewStateWriter, viewStateError, type ViewStateStorage } from './viewState.js';
import { createLogger } from '../logger.js';
import { hostAppSdkAsset } from './hostSdk.js';
import { GHOST_PIPE_CALL_MAX_TOTAL_MS } from '../../shared/ghost.js';
import { pagePermissionGrants } from './pagePermissions.js';
import { PluginAppFiles, type PluginFileAccess } from './pluginFiles.js';
import { withPluginPageTicket, createPageProgressRelay } from './pluginPageCall.js';
import type { saveAppDownload } from './downloadFile.js';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue.js';
import { PLUGIN_PAGE_TICKET } from './pluginServer.js';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type Tool,
  type CallToolResult,
  type Progress,
  type ProgressNotification,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord, McpAppDocument } from '../../shared/mcpApps.js';
import { hasExecutionComputerFile, MCP_APP_LINK_GRANT_MS, type McpAppLinkAuthorization } from '../../shared/mcpApps.js';
import type { McpAppMessageGuard, McpAppMessageSource } from './message.js';
import { AppConnection, sharedPluginConnection, type AppServerConfig } from './connection.js';
import {
  appCsp,
  boundedAppRecord,
  readAppResource,
  safeAppLink,
  toolVisibleTo,
  uiToolUri,
  MCP_APPS_MAX_BYTES,
  MCP_APPS_MAX_REMOTE_BYTES,
} from './protocol.js';
import { OwnerScopedAppResourceCache } from './appResourceCache.js';

// A fixed total budget: server progress may renew the View's idle timer, but
// must not keep a Main-owned tool request alive indefinitely.
const MCP_APP_TOOL_TIMEOUT_MS = 30 * 60_000;

export interface McpAppsHostDeps {
  pluginFiles?: PluginFileAccess;
  owner(): object | undefined;
  config(id: string): AppServerConfig | undefined;
  /** Desktop injects an owner-scoped vault key so revisions survive restarts. */
  revisionKey?(): string;
  viewState?(owner: object, sessionId: string, clientId: string, record: McpAppRecord): ViewStateStorage;
  readCard(sessionId: string, clientId: string): Promise<McpAppRecord>;
  writeCard(sessionId: string, clientId: string, record: McpAppRecord): Promise<void>;
  authorizeTool(
    sessionId: string | null,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    source?: { clientId: string; serverId: string; title: string; caller?: string },
  ): Promise<void>;
  sendMessage(
    sessionId: string,
    record: McpAppRecord | McpAppMessageSource,
    content: unknown[],
    assertCurrent: McpAppMessageGuard,
    files?: AgentInputSerializedFile[],
  ): Promise<void>;
  downloadFile?(input: Omit<Parameters<typeof saveAppDownload>[0], 'showSaveDialog'>): Promise<{ isError?: boolean }>;
  disposeDocument?(viewId: string): void;
  connection?(config: AppServerConfig): AppConnection;
  audit?(method: string): void;
}

/** A send consumes only the captured updates, after the Agent accepts its input. */
export interface McpAppModelContext {
  text: string;
  assertCurrent(): Promise<void>;
  consume(): void;
}

/** Main-owned authority for a declared resource opened independently of a tool. */
export interface McpAppResourceBinding {
  id: string;
  title: string;
  serverId: string;
  serverRevision: string;
  resourceUri: string;
  assertCurrent(): void | Promise<void>;
  /** Task lifetime is checked at open/operations, not on each pushed state update. */
  assertOperation?(): Promise<void>;
  projectContext?(context: McpUiHostContext): Record<string, unknown>;
  /** A visible View owns its context source, independently of iframe reloads. */
  observeContext?(changed: () => void, signal: AbortSignal): Promise<() => void>;
  hostTools?: Tool[];
  callHostTool?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}

class ViewTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  seq = 0;
  readonly events: import('../../shared/mcpApps.js').McpAppHostEvent<JSONRPCMessage>[] = [];
  private bytes = 2; // The serialized array's brackets also count toward the budget.
  private wake?: () => void;
  private failed = false;
  private localFilesUnavailable = false;
  private closed = false;
  private discardedThrough = 0;
  private generation = 0;
  constructor(private readonly maxBytes: number, private readonly localFilesAllowed = true) {}
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    // Always tag events: viewers treat a missing generation as a legacy Host.
    this.enqueue({ seq: ++this.seq, generation: this.generation, message });
  }
  openLink(id: string, url: string): void {
    this.enqueue({ seq: ++this.seq, generation: this.generation, openLink: { id, url } });
  }
  private enqueue(event: (typeof this.events)[number]): void {
    if (!this.localFilesAllowed && hasExecutionComputerFile(event)) {
      this.localFilesUnavailable = true;
      this.wake?.();
      return;
    }
    const bytes =
      this.bytes + Buffer.byteLength(JSON.stringify(event)) + (this.events.length ? 1 : 0);
    if (this.failed || bytes > this.maxBytes || this.events.length >= 256) {
      this.failed = true;
      this.wake?.();
      return;
    }
    this.bytes = bytes;
    this.events.push(event);
    this.wake?.();
  }
  async poll(after: number): Promise<(typeof this.events)[number][]> {
    if (this.closed) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    if (this.localFilesUnavailable) throw new Error('MCP_APP_FILES_LOCAL_ONLY');
    if (this.failed) throw new Error('MCP_APP_BACKPRESSURE');
    while (this.events[0]?.seq <= after) {
      const event = this.events.shift()!;
      this.bytes -= Buffer.byteLength(JSON.stringify(event)) + (this.events.length ? 1 : 0);
    }
    if (!this.events.length) {
      if (this.wake) throw new Error('MCP_APP_POLL_ALREADY_PENDING');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = undefined;
          resolve();
        }, 10_000);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
    if (this.closed) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    if (this.localFilesUnavailable) throw new Error('MCP_APP_FILES_LOCAL_ONLY');
    if (this.failed) throw new Error('MCP_APP_BACKPRESSURE');
    return this.events.filter((event) => event.seq > after);
  }
  discardDocumentEvents(generation: number): void {
    this.generation = generation;
    this.discardedThrough = this.seq;
    this.events.length = 0;
    this.bytes = 2;
    this.failed = false;
    this.localFilesUnavailable = false;
  }
  currentEvents(events: (typeof this.events)): typeof this.events {
    return events.filter(event => event.seq > this.discardedThrough);
  }
  async close(): Promise<void> {
    // Revocation can win after Host authorization but before poll installs its wake.
    this.closed = true;
    this.wake?.();
    this.onclose?.();
  }
}

interface View {
  files?: PluginAppFiles;
  openId?: string;
  owner: object;
  caller: string;
  sessionId: string | null;
  clientId: string;
  record?: McpAppRecord;
  resourceBinding?: McpAppResourceBinding;
  serverId: string;
  serverRevision: string;
  connection: AppConnection;
  bridge: AppBridge;
  transport: ViewTransport;
  initialized: boolean;
  generation: number;
  documentTransport: Transport;
  documentReady: Promise<void>;
  restartDocument(): Promise<void>;
  initializeState(id: string | number): Promise<void>;
  inputSent: boolean;
  resultSent: boolean;
  context: McpUiHostContext;
  lastUsed: number;
  unlisten: (() => void)[];
  stopContext?: () => void;
  links: Map<string, { url: string; claim: () => void; resolve: (success: boolean) => void }>;
}

// Standalone, non-persistent Hosts still need a private key. Desktop supplies
// its persistent vault key through revisionKey; this default never leaves Main.
const transientRevisionKey = randomBytes(32).toString('hex');
export function appServerRevision(config: AppServerConfig, key = transientRevisionKey): string {
  return createHmac('sha256', key)
    .update('cindy:mcp-app-server-revision:v1\0')
    .update(JSON.stringify(config.plugin ? [config.id, config.transport, config.plugin.instance, config.plugin.revision, config.plugin.packageSha256, config.plugin.directory, config.url] : [config.id, config.url, config.transport, config.headers]))
    .digest('hex');
}

/** One official AppBridge per View; all requests are bound to a host-verified card. */
export class McpAppsHost {
  private readonly views = new Map<string, View>();
  private readonly opening = new Map<
    string,
    { owner: object; caller: string; abort: AbortController }
  >();
  private readonly cancelledOpens = new Map<string, { owner: object; until: number }>();
  private readonly connections = new Map<
    string,
    { owner: object; connection: AppConnection; retired?: boolean }
  >();
  private readonly contexts = new Map<
    string,
    {
      owner: object;
      sessionId: string;
      clientId: string;
      serverId: string;
      revision: string;
      value: unknown;
      assertSource?: () => Promise<void>;
    }
  >();
  private readonly stateWriters = new Set<{
    owner: object; sessionId: string; clientId: string; writer: ViewStateWriter;
  }>();
  private readonly connectionIds = new WeakMap<AppConnection, string>();
  private readonly resourceCache = new OwnerScopedAppResourceCache<{
    html: string; meta: import('@modelcontextprotocol/ext-apps').McpUiResourceMeta;
    policy: ReturnType<typeof appCsp>;
  }>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly deps: McpAppsHostDeps) {}

  serverRevision(config: AppServerConfig): string {
    return appServerRevision(config, this.deps.revisionKey?.());
  }

  captureOwner(): object {
    const owner = this.deps.owner();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    return owner;
  }

  /** Native entries use the same policy, one-use ticket and original main.js runner. */
  async callPluginAction(caller: string, sessionId: string | null, source: {
    serverId: string; id: string; title: string; attachments?: string[]; assertCurrent(): void | Promise<void>;
  }, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const owner = this.captureOwner();
    const assertCurrent = async () => {
      signal.throwIfAborted();
      if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
      await source.assertCurrent();
    };
    await assertCurrent();
    const config = this.deps.config(source.serverId);
    if (!config?.plugin) throw new Error('MCP_PLUGIN_UNAVAILABLE');
    const connection = this.deps.connection?.(config) ?? sharedPluginConnection(config, owner);
    const target = (await connection.tools(signal)).find(tool => tool.name === name && toolVisibleTo(tool, 'app'));
    if (!target) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
    await this.deps.authorizeTool(sessionId, target, args, signal, { caller, clientId: source.id,
      serverId: config.id, title: source.title });
    await assertCurrent();
    const client = await connection.getClient(signal);
    return withPluginPageTicket({ instance: config.plugin.instance, revision: config.plugin.revision,
      sessionId, clientId: source.id, tool: name, assertCurrent,
      ...(source.attachments ? { attachments: source.attachments } : {}) }, async ticket => {
      const result = await client.callTool({ name, arguments: args, _meta: { [PLUGIN_PAGE_TICKET]: ticket } },
        CallToolResultSchema, { signal, timeout: GHOST_PIPE_CALL_MAX_TOTAL_MS });
      await assertCurrent();
      return result as CallToolResult;
    });
  }

  assertOwner(owner: object): void {
    if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
  }

  registerConnection(connection: AppConnection, owner = this.captureOwner()): string {
    this.assertOwner(owner);
    const existing = this.connectionIds.get(connection);
    if (existing && this.connections.has(existing)) return existing;
    if (this.connections.size >= 256) throw new Error('MCP_APP_CONNECTION_LIMIT');
    const id = randomUUID();
    this.connections.set(id, { owner, connection });
    this.connectionIds.set(connection, id);
    return id;
  }

  async releaseConnection(connection: AppConnection): Promise<void> {
    if (connection.config?.plugin) return;
    const id = this.connectionIds.get(connection);
    const entry = id ? this.connections.get(id) : undefined;
    if (entry) entry.retired = true;
    if ([...this.views.values()].some((view) => view.connection === connection)) return;
    if (id) this.connections.delete(id);
    await connection.close();
  }

  async open(
    caller: string,
    sessionId: string,
    clientId: string,
    hostContext: McpUiHostContext,
    openId?: string,
  ): Promise<McpAppDocument> {
    return this.openSource(caller, sessionId, clientId, hostContext, openId);
  }

  async openResource(
    caller: string,
    sessionId: string | null,
    binding: McpAppResourceBinding,
    hostContext: McpUiHostContext,
    openId?: string,
  ): Promise<McpAppDocument> {
    return this.openSource(caller, sessionId, binding.id, hostContext, openId, binding);
  }

  private async openSource(
    caller: string,
    sessionId: string | null,
    clientId: string,
    hostContext: McpUiHostContext,
    openId?: string,
    resourceBinding?: McpAppResourceBinding,
  ): Promise<McpAppDocument> {
    const owner = this.captureOwner();
    const key = JSON.stringify([caller, sessionId, openId ?? randomUUID()]);
    this.pruneCancelledOpens();
    if (this.cancelledOpens.get(key)?.owner === owner) throw new Error('MCP_APP_OPEN_CANCELLED');
    if (this.opening.has(key) || this.opening.size >= 256) throw new Error('MCP_APP_VIEW_LIMIT');
    const pending = { owner, caller, abort: new AbortController() };
    this.opening.set(key, pending);
    const timer = setTimeout(() => pending.abort.abort(new Error('MCP_APP_OPEN_TIMEOUT')), 90_000);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(pending.abort.signal.reason);
      pending.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        this.openView(caller, sessionId, clientId, hostContext, pending.abort.signal, openId, resourceBinding),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      pending.abort.signal.removeEventListener('abort', onAbort);
      if (this.opening.get(key) === pending) this.opening.delete(key);
    }
  }

  async cancelOpen(caller: string, sessionId: string | null, openId: string): Promise<void> {
    const key = JSON.stringify([caller, sessionId, openId]);
    this.pruneCancelledOpens();
    // Cancellation may win the IPC authorization race before open reaches Host.
    // Keep a bounded tombstone longer than the complete control-side budget.
    if (this.cancelledOpens.size >= 512)
      this.cancelledOpens.delete(this.cancelledOpens.keys().next().value!);
    this.cancelledOpens.set(key, { owner: this.captureOwner(), until: Date.now() + 180_000 });
    const pending = this.opening.get(key);
    if (pending && pending.owner === this.deps.owner())
      pending.abort.abort(new Error('MCP_APP_OPEN_CANCELLED'));
    for (const [id, view] of this.views) {
      if (
        view.owner === this.deps.owner() &&
        view.caller === caller &&
        view.sessionId === sessionId &&
        view.openId === openId
      )
        await this.disposeView(id, view);
    }
  }

  async releaseCaller(caller: string): Promise<void> {
    for (const pending of this.opening.values())
      if (pending.caller === caller) pending.abort.abort(new Error('MCP_APP_OPEN_CANCELLED'));
    // The renderer and its iframes are already gone. Revoke Views synchronously,
    // without waiting for teardown or the idle sweep, before its replacement opens.
    await Promise.allSettled(
      [...this.views]
        .filter(([, view]) => view.caller === caller)
        .map(([id, view]) => this.disposeView(id, view)),
    );
  }

  private pruneCancelledOpens(): void {
    for (const [key, entry] of this.cancelledOpens)
      if (entry.owner !== this.deps.owner() || entry.until <= Date.now())
        this.cancelledOpens.delete(key);
  }

  private async openView(
    caller: string,
    sessionId: string | null,
    clientId: string,
    hostContext: McpUiHostContext,
    signal: AbortSignal,
    openId?: string,
    resourceBinding?: McpAppResourceBinding,
  ): Promise<McpAppDocument> {
    await this.sweep();
    signal.throwIfAborted();
    const owner = this.deps.owner();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    if (
      [...this.views.values()].filter((view) => view.caller === caller).length >=
      (caller.startsWith('device:') ? 4 : 16)
    )
      throw new Error('MCP_APP_VIEW_LIMIT');
    if (!resourceBinding && sessionId === null) throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    let record = resourceBinding ? undefined : await this.deps.readCard(sessionId!, clientId);
    await resourceBinding?.assertCurrent();
    await resourceBinding?.assertOperation?.();
    signal.throwIfAborted();
    const serverId = resourceBinding?.serverId ?? record!.serverId;
    const serverRevision = resourceBinding?.serverRevision ?? record!.serverRevision;
    const resourceUri = resourceBinding?.resourceUri ?? record!.resourceUri;
    const config = this.deps.config(serverId);
    if (!config || this.serverRevision(config) !== serverRevision)
      throw new Error('MCP_APP_SERVER_CHANGED');
    config.plugin?.assertCurrent(sessionId ?? undefined);
    if (caller.startsWith('device:') && config.plugin && hasExecutionComputerFile(record))
      throw new Error('MCP_APP_FILES_LOCAL_ONLY');
    const connectionId = record?.connectionId;
    const registered = connectionId ? this.connections.get(connectionId) : undefined;
    const detached = !registered || registered.owner !== owner || registered.connection.isClosed;
    // An unknown connection belongs to a previous Host lifetime. Its original
    // call cannot finish here, and replaying it could repeat a side effect.
    // Persist the terminal state before reconnecting, even if loading later fails.
    if (record && !registered && !record.result && !record.cancelled) {
      record = { ...record, cancelled: 'Tool execution interrupted before completion' };
      await this.updateResult(sessionId!, clientId, record, owner);
      signal.throwIfAborted();
    }
    const connection =
      registered?.owner === owner && !registered.connection.isClosed
        ? registered.connection
        : (this.deps.connection?.(config) ?? (config.plugin ? sharedPluginConnection(config, owner) : new AppConnection(config)));
    const registeredId = this.registerConnection(connection, owner);
    if (detached) this.connections.get(registeredId)!.retired = true;
    let stopContext: (() => void) | undefined;
    let liveView: View | undefined;
    try {
      const client = await connection.getClient();
      signal.throwIfAborted();
      const tool = record ? (await connection.tools(signal)).find((item) => item.name === record!.tool.name) : undefined;
      if (record && (!tool || uiToolUri(tool) !== resourceUri))
        throw new Error('MCP_APP_TOOL_UNAVAILABLE');
      const resourceKey = JSON.stringify([serverId, serverRevision, config.plugin?.packageSha256, resourceUri]);
      let resource = config.plugin ? this.resourceCache.get(owner, resourceKey) : undefined;
      if (!resource) {
        const loaded = await connection.resource(resourceUri, signal);
        signal.throwIfAborted();
        const parsed = readAppResource(loaded.result, resourceUri, loaded.meta);
        resource = { ...parsed, policy: appCsp(parsed.meta) };
        if (config.plugin) this.resourceCache.set(owner, resourceKey, resource);
      }
      const policy = resource.policy;
      if (config.plugin) {
        const allowed = new Set(config.plugin.domains);
        for (const domains of Object.values(policy.csp)) {
          if (!Array.isArray(domains)) continue;
          for (const domain of domains) {
            if (!allowed.has(domain)) throw new Error('MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED');
          }
        }
        config.plugin.assertCurrent(sessionId ?? undefined);
      }
      await resourceBinding?.assertCurrent();
      if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
      // Recheck after async resource loading so simultaneous opens share the limit.
      if (
        [...this.views.values()].filter((view) => view.caller === caller).length >=
        (caller.startsWith('device:') ? 4 : 16)
      )
        throw new Error('MCP_APP_VIEW_LIMIT');
      const viewId = randomUUID();
      const document: McpAppDocument = {
        sdk: { source: hostAppSdkAsset.source, addons: hostAppSdkAsset.addons },
        viewId,
        html: resource.html,
        csp: policy.header,
        policy: policy.csp,
        prefersBorder: resource.meta.prefersBorder !== false,
      };
      const remote = caller.startsWith('device:');
      // The optional runtime must not reduce the budget of an installed page.
      // With no source detection, a missing SDK can only fail that page's import.
      if (remote && document.sdk && Buffer.byteLength(JSON.stringify(document)) > MCP_APPS_MAX_REMOTE_BYTES) {
        // Optional addons never displace an official SDK that would fit on its own.
        document.sdk = { source: document.sdk.source };
      }
      if (remote && Buffer.byteLength(JSON.stringify(document)) > MCP_APPS_MAX_REMOTE_BYTES) {
        delete document.sdk;
        if (Buffer.byteLength(JSON.stringify(document)) > MCP_APPS_MAX_REMOTE_BYTES)
          throw new Error('MCP_APP_RESOURCE_TOO_LARGE');
        createLogger('mcp-apps').warn('Host SDK omitted: page fits the remote budget, but page plus SDK exceeds it; bare SDK imports will fail in this View');
      }
      const transport = new ViewTransport(remote ? MCP_APPS_MAX_REMOTE_BYTES : MCP_APPS_MAX_BYTES, !remote || !config.plugin);
      stopContext = await resourceBinding?.observeContext?.(() => {
        if (liveView && this.views.get(viewId) === liveView)
          this.context(caller, sessionId, viewId, { cindy: liveView.context.cindy });
      }, signal);
      signal.throwIfAborted();
      const { toolInfo: _untrustedToolInfo, cindy: _untrustedCindy, ...environmentContext } = hostContext;
      const context: McpUiHostContext = {
        ...environmentContext,
        ...(resourceBinding?.projectContext ? { cindy: resourceBinding.projectContext(hostContext) } : {}),
        ...(tool ? { toolInfo: { tool, id: clientId } } : {}),
        displayMode: 'inline',
        availableDisplayModes:
          hostContext.platform === 'mobile' ? ['inline'] : ['inline', 'fullscreen'],
      };
      // Private restoration data is execution-host owned, including on the first open.
      delete context[VIEW_STATE_KEY];
      delete context.viewState;
      // Independently opened resources have no persisted card to own a snapshot.
      const stateStorage = sessionId !== null && record
        ? this.deps.viewState?.(owner, sessionId, clientId, record) : undefined;
      const capabilities = client.getServerCapabilities();
      const createBridge = (currentContext = context) => new AppBridge(
        null,
        { name: 'Cindy', version: '1.0.0' },
        {
          openLinks: {},
          ...(!remote && config.plugin && this.deps.downloadFile ? { downloadFile: {} } : {}),
          ...(capabilities?.tools || resourceBinding?.hostTools?.length
            ? { serverTools: { listChanged: capabilities?.tools?.listChanged } }
            : {}),
          ...(capabilities?.resources
            ? { serverResources: { listChanged: capabilities.resources.listChanged } }
            : {}),
          logging: {},
          ...(sessionId !== null ? { message: { text: {}, resourceLink: {} },
            updateModelContext: { text: {}, structuredContent: {} } } : {}),
          sandbox: { permissions: {}, csp: policy.csp },
        },
        { hostContext: currentContext },
      );
      const bridge = createBridge();
      const view: View = {
        openId,
        owner,
        caller,
        sessionId,
        clientId,
        record,
        resourceBinding,
        serverId,
        serverRevision,
        connection,
        bridge,
        transport,
        context,
        initialized: false,
        generation: 0,
        documentTransport: transport,
        documentReady: Promise.resolve(),
        initializeState: async () => {},
        restartDocument: async () => {
          // Revoke before closing the old SDK Protocol, including its error replies.
          view.generation++;
          view.initialized = false;
          transport.discardDocumentEvents(view.generation);
          view.links.forEach(link => link.resolve(false));
          view.unlisten.splice(0).forEach(remove => remove());
          const old = view.bridge;
          const next = view.bridge = createBridge(view.context);
          const generation = view.generation;
          await old.close();
          if (this.views.get(viewId) === view && view.generation === generation)
            await connectDocument(next);
        },
        inputSent: false,
        resultSent: false,
        lastUsed: Date.now(),
        unlisten: [],
        stopContext,
        links: new Map(),
      };
      this.views.set(viewId, view);
      liveView = view;
      stopContext = undefined;
      if (!this.sweepTimer) {
        this.sweepTimer = setInterval(() => {
          void this.sweep().catch(() => {});
        }, 30_000);
        this.sweepTimer.unref();
      }
      const assertView = () => this.assertCurrentView(viewId, view);
      if (config.plugin && !remote && this.deps.pluginFiles) {
        view.files = new PluginAppFiles(viewId, config.plugin.instance, this.deps.pluginFiles, assertView);
        document.csp = document.csp.replace(/connect-src [^;]*/, match => match.replace("'none'", "").concat(" 'self'"));
      }
      const connectDocument = async (bridge: AppBridge): Promise<void> => {
        const generation = view.generation;
        const assertCurrent = async () => {
          if (view.generation !== generation) throw new Error('MCP_APP_DOCUMENT_CHANGED');
          await assertView();
          await resourceBinding?.assertOperation?.();
          if (view.generation !== generation) throw new Error('MCP_APP_DOCUMENT_CHANGED');
        };
        let initializeId: string | number | undefined;
        let restored: { value: unknown } | undefined;
        let stateAllowed = false;
        const writer = stateStorage ? new ViewStateWriter(snapshot => stateStorage.save(snapshot)) : undefined;
        const pendingWriter = writer && sessionId !== null ? { owner, sessionId, clientId, writer } : undefined;
        view.initializeState = async id => {
          initializeId = id;
          restored = undefined;
          stateAllowed = false;
          if (!stateStorage) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Capture only already accepted batches. Reads never flush or create rows.
            const barriers = [...this.stateWriters].filter(item => item.owner === owner &&
              item.sessionId === sessionId && item.clientId === clientId).map(item => item.writer.barrier());
            const value = await Promise.race([
              Promise.all(barriers).then(() => stateStorage.read()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(viewStateError('CINDY_VIEW_STATE_STORAGE_UNAVAILABLE')), 2_000);
              }),
            ]);
            if (view.generation === generation && initializeId === id && this.views.get(viewId) === view) {
              this.view(caller, sessionId, viewId);
              restored = { value };
            }
          } catch { /* Missing capability prevents overwriting a snapshot the page did not receive. */ }
          finally { clearTimeout(timer); }
        };
        if (writer && pendingWriter) bridge.setRequestHandler(
          z.object({ method: z.literal(VIEW_STATE_METHOD), params: z.unknown().optional() }),
          async request => {
            if (!stateAllowed) throw viewStateError('CINDY_VIEW_STATE_STORAGE_UNAVAILABLE');
            if (view.generation !== generation) throw viewStateError('MCP_APP_CARD_UNAVAILABLE');
            this.view(caller, sessionId, viewId);
            const params = request.params;
            if (!params || typeof params !== 'object' || Array.isArray(params) ||
                !Object.hasOwn(params, 'state') || Object.keys(params).length !== 1)
              throw viewStateError('CINDY_VIEW_STATE_INVALID');
            this.stateWriters.add(pendingWriter);
            try { await writer.set((params as { state: unknown }).state); return {}; }
            finally { if (!writer.hasRequests) this.stateWriters.delete(pendingWriter); }
          },
        );
        const scopedTransport: Transport = {
          async start() {},
          send: async (message) => {
            if (this.views.get(viewId) !== view || view.generation !== generation) return;
            if ('id' in message && message.id === initializeId && 'result' in message && restored) {
              const result = message.result as Record<string, unknown>;
              const capabilities = result.hostCapabilities as Record<string, unknown>;
              message = { ...message, result: {
                ...result,
                hostCapabilities: { ...capabilities, experimental: {
                  ...(capabilities.experimental as Record<string, unknown> | undefined),
                  [VIEW_STATE_KEY]: VIEW_STATE_CAPABILITY,
                } },
                hostContext: { ...(result.hostContext as Record<string, unknown>), [VIEW_STATE_KEY]: restored.value },
              } };
              stateAllowed = true;
              restored = undefined;
            }
            await transport.send(message);
          },
          async close() { scopedTransport.onclose?.(); },
        };
        view.documentTransport = scopedTransport;
        const currentClient = async (signal: AbortSignal) => {
          await assertCurrent();
          signal.throwIfAborted();
          const current = await connection.getClient(signal);
          // Reconnecting can outlive a cancellation, card clear or owner change.
          await assertCurrent();
          signal.throwIfAborted();
          return current;
        };
        const currentResult = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
          const result = await pending;
          // Authorization can change while the server is working. Discard the late
          // result before AppBridge can send it; never replay the upstream request.
          await assertCurrent();
          signal.throwIfAborted();
          return result;
        };
        bridge.oninitialized = () => {
          if (view.initialized || !bridge.getAppCapabilities()) return;
          view.initialized = true;
          void assertCurrent()
            .then(async () => {
              const attachments = (record?.tool._meta as Record<string, unknown> | undefined)?.['cindy/attachments'];
              if (!view.inputSent && view.files && attachments && tool) {
                const projected = await view.files.project(attachments);
                await assertCurrent();
                view.context = { ...view.context, toolInfo: { tool: {
                  ...tool, _meta: { ...tool._meta, 'cindy/attachments': projected },
                }, id: clientId } };
              }
              await assertCurrent();
              bridge.setHostContext(view.context);
            })
            .then(async () => {
              if (view.inputSent) return;
              if (!record) return;
              const args = view.files ? await view.files.project(record.arguments) : record.arguments;
              await assertCurrent();
              view.inputSent = true;
              await bridge.sendToolInput({ arguments: args });
            })
            .then(() => {
              if (view.generation !== generation) return;
              return this.sendResult(viewId, view);
            })
            .catch(() => {
              if (view.generation === generation) void this.disposeView(viewId, view);
            });
        };
        bridge.oncalltool = async (params, extra) => {
          await assertCurrent();
          if (resourceBinding?.hostTools?.some(tool => tool.name === params.name)) {
            if (!resourceBinding.callHostTool) throw new Error('MCP_APP_TOOL_UNAVAILABLE');
            const result = await resourceBinding.callHostTool(params.name, params.arguments ?? {}, extra.signal);
            await assertCurrent();
            return result;
          }
          const tools = await currentResult(connection.tools(extra.signal), extra.signal);
          const target = tools.find((item) => item.name === params.name);
          if (!target || !toolVisibleTo(target, 'app')) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
          // Page calls use the tool's normal policy regardless of how the script started.
          // The one-use ticket below binds identity; it does not grant approval.
          await this.deps.authorizeTool(sessionId, target, params.arguments ?? {}, extra.signal, { clientId, serverId, title: resourceBinding?.title ?? record!.tool.title ?? record!.tool.name, caller });
          const client = await currentClient(extra.signal);
          if (!config.plugin) {
            const token = params._meta?.progressToken;
            let active = true;
            let forwarding = false;
            let pendingProgress: Progress | undefined;
            try {
              return (await currentResult(
                client.callTool(params, CallToolResultSchema, {
                  signal: extra.signal,
                  timeout: MCP_APP_TOOL_TIMEOUT_MS,
                  // The SDK allocates a connection-scoped token when onprogress is
                  // registered. View-local tokens can collide on this shared client.
                  onprogress:
                    token === undefined
                      ? undefined
                      : (update) => {
                          if (!active || extra.signal.aborted) return;
                          pendingProgress = update;
                          if (forwarding) return;
                          forwarding = true;
                          // Retain only the latest update while authorization is
                          // checked, rather than queueing unbounded server progress.
                          void (async () => {
                            try {
                              while (active && !extra.signal.aborted && pendingProgress) {
                                await assertCurrent();
                                if (!active || extra.signal.aborted) return;
                                const latest = pendingProgress;
                                pendingProgress = undefined;
                                const notification: ProgressNotification = {
                                  method: 'notifications/progress',
                                  params: { ...latest, progressToken: token },
                                };
                                // AppBridge 1.7's helper type omits core MCP progress.
                                await scopedTransport.send({ jsonrpc: '2.0', ...notification });
                              }
                            } catch {
                              // Revoked Views must not receive late progress.
                              pendingProgress = undefined;
                            } finally {
                              forwarding = false;
                            }
                          })();
                        },
                }),
                extra.signal,
              )) as CallToolResult;
            } finally {
              active = false;
              pendingProgress = undefined;
            }
          }
          const invoke = (ticket?: string) => currentResult(client.callTool({ ...params,
            ...(ticket ? { _meta: { ...params._meta, [PLUGIN_PAGE_TICKET]: ticket } } : {}),
          }, CallToolResultSchema, { signal: extra.signal, ...(config.plugin ? { timeout: GHOST_PIPE_CALL_MAX_TOTAL_MS } : {}) }), extra.signal) as Promise<CallToolResult>;
          const token = params._meta?.progressToken;
          const progress = createPageProgressRelay(async (value, progressSignal) => {
            await assertCurrent();
            extra.signal.throwIfAborted();
            progressSignal.throwIfAborted();
            // AppBridge's notification union omits this base MCP notification.
            // Use its bound transport, retaining the standard wire shape and token.
            await scopedTransport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { ...value, progressToken: token! } });
          });
          const closeProgress = () => progress.close();
          extra.signal.addEventListener('abort', closeProgress, { once: true });
          try {
            const result = await withPluginPageTicket({ instance: config.plugin.instance,
              revision: config.plugin.revision, sessionId, clientId, tool: target.name, assertCurrent,
              ...(typeof token === 'string' || typeof token === 'number' ? { onProgress: progress.update } : {}),
            }, invoke);
            return view.files ? await view.files.project(result) : result;
          } finally {
            extra.signal.removeEventListener('abort', closeProgress);
            progress.close();
          }
        };
        bridge.setRequestHandler(ListToolsRequestSchema, async (_params, extra) => {
          await assertCurrent();
          const tools = await currentResult(connection.tools(extra.signal), extra.signal);
          return { tools: [...(resourceBinding?.hostTools ?? []), ...tools.filter((item) => toolVisibleTo(item, 'app') && !resourceBinding?.hostTools?.some(hostTool => hostTool.name === item.name))] };
        });
        bridge.onreadresource = async (params, extra) => {
          const client = await currentClient(extra.signal);
          return currentResult(client.readResource(params, { signal: extra.signal }), extra.signal);
        };
        bridge.onlistresources = async (params, extra) => {
          const client = await currentClient(extra.signal);
          return currentResult(client.listResources(params, { signal: extra.signal }), extra.signal);
        };
        bridge.onlistresourcetemplates = async (params, extra) => {
          const client = await currentClient(extra.signal);
          return currentResult(
            client.listResourceTemplates(params, { signal: extra.signal }),
            extra.signal,
          );
        };
        bridge.onlistprompts = async (params, extra) => {
          const client = await currentClient(extra.signal);
          return currentResult(client.listPrompts(params, { signal: extra.signal }), extra.signal);
        };
        bridge.onmessage = async (params) => {
          await assertCurrent();
          if (sessionId === null) throw new Error('MCP_APP_TASK_REQUIRED');
          const content = Array.isArray(params.content) ? params.content : [params.content];
          if (content.some((block) => block.type !== 'text' && block.type !== 'resource_link'))
            throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
          const files: AgentInputSerializedFile[] = [];
          if (view.files) {
            for (const block of content) {
              if (block.type !== 'resource_link' || !block.uri.startsWith('cindy-media:')) continue;
              const info = await view.files.describeGranted(block.uri);
              if (!info.mimeType.startsWith('image/')) continue;
              files.push({ id: randomUUID(), name: block.name, originalName: block.name,
                category: 'image', ext: block.uri.split('.').pop() ?? '', mimeType: info.mimeType,
                size: info.size, url: block.uri, path: block.uri });
            }
          }
          await assertCurrent();
          // Preparation still belongs to this document. Once accepted, queued
          // input belongs to the card/View and keeps only its current file grants.
          let accepted = false;
          const assertMessageCurrent = async () => {
            for (const file of files) await view.files!.describeGranted(file.url!);
            await (accepted ? assertView() : assertCurrent());
          };
          const source = record ?? { serverId, title: resourceBinding!.title };
          if (files.length) await this.deps.sendMessage(sessionId, source, content, assertMessageCurrent, files);
          else await this.deps.sendMessage(sessionId, source, content, assertMessageCurrent);
          accepted = true;
          return {};
        };
        if (!remote && config.plugin && this.deps.downloadFile) bridge.ondownloadfile = async (params, extra) => {
          await assertCurrent();
          if (params.contents.length > 16) throw new Error('MCP_APP_DOWNLOAD_LIMIT');
          for (const content of params.contents) {
            if (content.type === 'resource_link') {
              if (!view.files) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
              await view.files.describeGranted(content.uri);
            }
            const result = await this.deps.downloadFile!({ content, signal: extra.signal, assertCurrent,
              readGranted: uri => {
                if (!view.files) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
                return view.files.readGranted(uri, extra.signal);
              },
            });
            if (result.isError) return result;
          }
          return {};
        };
        bridge.onupdatemodelcontext = async (params) => {
          await assertCurrent();
          if (sessionId === null) throw new Error('MCP_APP_TASK_REQUIRED');
          if (Buffer.byteLength(JSON.stringify(params), 'utf8') > 128_000)
            throw new Error('MCP_APP_CONTEXT_TOO_LARGE');
          const { content, structuredContent } = params;
          if (content?.some((block) => block.type !== 'text'))
            throw new Error('MCP_APP_CONTEXT_CONTENT_UNSUPPORTED');
          const key = `${sessionId}:${clientId}`;
          if (this.contexts.size >= 256 && !this.contexts.has(key)) {
            await this.pruneModelContexts();
            // Pruning reads other cards and can outlive this View's authorization.
            await assertCurrent();
          }
          const next = {
            app: serverId,
            resourceUri,
            content,
            structuredContent,
          };
          const aggregateBytes = () => {
            const values = [...this.contexts.entries()]
              .filter(
                ([id, item]) => id !== key && item.owner === owner && item.sessionId === sessionId,
              )
              .map(([, item]) => item.value);
            values.push(next);
            return Buffer.byteLength(JSON.stringify(values), 'utf8');
          };
          let bytes = aggregateBytes();
          if (bytes > 512_000) {
            await this.pruneModelContexts();
            await assertCurrent();
            bytes = aggregateBytes();
          }
          // Recompute from the live map after cleanup; no await may separate the
          // final budget checks from publishing, or a concurrent update can overfill it.
          if (bytes > 512_000) throw new Error('MCP_APP_CONTEXT_TOO_LARGE');
          if (this.contexts.size >= 256 && !this.contexts.has(key))
            throw new Error('MCP_APP_CONTEXT_LIMIT');
          this.contexts.set(key, {
            owner,
            sessionId,
            clientId,
            serverId,
            revision: serverRevision,
            ...(resourceBinding ? { assertSource: async () => { await resourceBinding.assertCurrent(); await resourceBinding.assertOperation?.(); } } : {}),
            value: next,
          });
          return {};
        };
        bridge.onopenlink = async (params) => {
          await assertCurrent();
          const url = safeAppLink(params.url);
          if (view.links.size >= 4) throw new Error('MCP_APP_LINK_LIMIT');
          const id = randomUUID();
          const success = await new Promise<boolean>((resolve) => {
            const finish = (success: boolean) => {
              clearTimeout(timer);
              view.links.delete(id);
              resolve(success);
            };
            let timer = setTimeout(() => finish(false), 10_000);
            let claimed = false;
            view.links.set(id, {
              url,
              claim: () => {
                if (claimed) throw new Error('MCP_APP_LINK_ALREADY_AUTHORIZED');
                claimed = true;
                clearTimeout(timer);
                // The pending request cannot fail at its old deadline while the grant travels.
                timer = setTimeout(() => finish(false), MCP_APP_LINK_GRANT_MS);
              },
              resolve: finish,
            });
            transport.openLink(id, url);
          });
          if (!success) throw new Error('MCP_APP_LINK_OPEN_FAILED');
          return {};
        };
        bridge.onrequestdisplaymode = async (params) => {
          await assertCurrent();
          const modes = bridge.getAppCapabilities()?.availableDisplayModes ??
            context.availableDisplayModes ?? ['inline'];
          const mode =
            modes.includes(params.mode) && view.context.availableDisplayModes?.includes(params.mode)
              ? params.mode
              : (view.context.displayMode ?? 'inline');
          view.context = { ...view.context, displayMode: mode };
          bridge.setHostContext(view.context);
          return { mode };
        };
        // Accept application logging without persisting user data to the host diagnostic log.
        bridge.onloggingmessage = () => {};
        view.unlisten.push(
          connection.listen((message) => {
            if (view.generation !== generation || !view.initialized || owner !== this.deps.owner()) return;
            if (message.method === 'notifications/tools/list_changed')
              void bridge.sendToolListChanged(message.params).catch(() => {});
            if (message.method === 'notifications/resources/list_changed')
              void bridge.sendResourceListChanged(message.params).catch(() => {});
            if (message.method === 'notifications/prompts/list_changed')
              void bridge.sendPromptListChanged(message.params).catch(() => {});
          }),
        );
        await bridge.connect(scopedTransport);
      };
      try {
        await (view.documentReady = connectDocument(bridge));
        // Register before rereading: tool completion during loading must reach this
        // View, and a clear or configuration change must prevent publishing it.
        if (resourceBinding) {
          await resourceBinding.assertCurrent();
          await resourceBinding.assertOperation?.();
          signal.throwIfAborted();
          this.view(caller, sessionId, viewId);
          return document;
        }
        const latest = await this.deps.readCard(sessionId!, clientId);
        signal.throwIfAborted();
        this.view(caller, sessionId, viewId);
        if (
          latest.serverId !== record!.serverId ||
          latest.serverRevision !== record!.serverRevision ||
          latest.resourceUri !== record!.resourceUri ||
          latest.tool.name !== record!.tool.name
        )
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        // A completion delivered while the database read was pending is newer
        // than that read's snapshot; never replace it with an unfinished record.
        if (view.record && !view.record.result && !view.record.cancelled) view.record = latest;
      } catch (error) {
        await this.disposeView(viewId, view);
        throw error;
      }
      return document;
    } catch (error) {
      stopContext?.();
      if (detached) await this.releaseConnection(connection).catch(() => {});
      throw error;
    }
  }

  async updateResult(
    sessionId: string,
    clientId: string,
    record: McpAppRecord,
    owner = this.captureOwner(),
  ): Promise<void> {
    this.assertOwner(owner);
    record = boundedAppRecord(record);
    try {
      await this.deps.writeCard(sessionId, clientId, record);
      this.assertOwner(owner);
      for (const [id, view] of this.views)
        if (view.record && view.owner === owner && view.sessionId === sessionId && view.clientId === clientId) {
          view.record = record;
          if (view.inputSent) await this.sendResult(id, view);
        }
    } catch (error) {
      // Persistence and card-wide authorization failures revoke every matching View.
      // Caller-local closure and transport failures are isolated inside sendResult.
      await Promise.allSettled(
        [...this.views]
          .filter(
            ([, view]) =>
              !!view.record && view.owner === owner && view.sessionId === sessionId && view.clientId === clientId,
          )
          .map(([id, view]) => this.disposeView(id, view)),
      );
      throw error;
    }
  }

  async assertViewAuthorized(caller: string, sessionId: string | null, id: string): Promise<void> {
    await this.assertCurrentView(id, this.view(caller, sessionId, id));
  }

  private async assertCurrentView(id: string, view: View): Promise<void> {
    this.view(view.caller, view.sessionId, id);
    if (view.resourceBinding) {
      await view.resourceBinding.assertCurrent();
      this.view(view.caller, view.sessionId, id);
      return;
    }
    if (!view.record || view.sessionId === null) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
    const latest = await this.deps.readCard(view.sessionId, view.clientId);
    this.view(view.caller, view.sessionId, id);
    if (
      latest.serverId !== view.record.serverId ||
      latest.serverRevision !== view.record.serverRevision ||
      latest.resourceUri !== view.record.resourceUri ||
      latest.tool.name !== view.record.tool.name
    )
      throw new Error('MCP_APP_CARD_UNAVAILABLE');
  }

  /** Called only by the local protocol after Chromium frame verification. */
  async readPluginFile(viewId: string, token: string, request: Request): Promise<Response> {
    const view = this.views.get(viewId);
    if (!view?.files) return new Response(null, { status: 404 });
    try { return await view.files.read(token, request); }
    catch { return new Response(null, { status: 404 }); }
  }

  private async sendResult(id: string, view: View): Promise<void> {
    if (!view.record || !view.initialized || view.resultSent || (!view.record.result && !view.record.cancelled)) return;
    const generation = view.generation;
    const bridge = view.bridge;
    try {
      await this.assertCurrentView(id, view);
    } catch (error) {
      // A caller can close while its card read is pending. The saved result
      // still belongs to active peers; only shared authorization failures escape.
      if (this.views.get(id) !== view) return;
      throw error;
    }
    // Initialization and completion can both wait on the same authorization read.
    if (view.resultSent || view.generation !== generation) return;
    try {
      if (view.record.result) {
        const result = view.files ? await view.files.project(view.record.result) : view.record.result;
        if (view.generation !== generation || view.resultSent) return;
        view.resultSent = true;
        await bridge.sendToolResult(result as CallToolResult);
      } else if (view.record.cancelled) {
        view.resultSent = true;
        await bridge.sendToolCancelled({ reason: view.record.cancelled });
      }
    } catch {
      // A broken transport cannot invalidate a successfully persisted card.
      if (view.generation === generation) await this.disposeView(id, view).catch(() => {});
    }
  }

  private view(caller: string, sessionId: string | null, id: string): View {
    const view = this.views.get(id);
    if (
      !view ||
      view.caller !== caller ||
      view.sessionId !== sessionId ||
      view.owner !== this.deps.owner()
    )
      throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    const config = this.deps.config(view.serverId);
    if (!config || this.serverRevision(config) !== view.serverRevision)
      throw new Error('MCP_APP_SERVER_CHANGED');
    config.plugin?.assertCurrent(sessionId ?? undefined);
    view.lastUsed = Date.now();
    return view;
  }

  async dispatch(caller: string, sessionId: string | null, id: string, input: unknown): Promise<void> {
    if (JSON.stringify(input).length > MCP_APPS_MAX_BYTES)
      throw new Error('MCP_APP_MESSAGE_TOO_LARGE');
    const view = this.view(caller, sessionId, id);
    let message = JSONRPCMessageSchema.parse(input);
    // The stable spec used one content block; newer official SDKs use an array.
    if (
      'method' in message &&
      message.method === 'ui/message' &&
      message.params?.content &&
      !Array.isArray(message.params.content)
    ) {
      message = { ...message, params: { ...message.params, content: [message.params.content] } };
    }
    if ('method' in message && message.method === 'ui/initialize' && 'id' in message && view.initialized) {
      view.documentReady = view.restartDocument();
    }
    const generation = view.generation;
    await view.documentReady;
    if (view.generation !== generation) return;
    this.view(caller, sessionId, id);
    if (
      'method' in message &&
      !view.initialized &&
      !['ui/initialize', 'ui/notifications/initialized', 'ping'].includes(message.method)
    ) {
      if ('id' in message)
        await view.transport.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'MCP_APP_NOT_INITIALIZED' },
        });
      return;
    }
    if ('method' in message && message.method === 'ui/initialize' && 'id' in message) {
      await view.initializeState(message.id);
      if (view.generation !== generation) return;
      this.view(caller, sessionId, id);
    }
    // Sandbox messages are reserved for the trusted outer proxy, never for an App.
    if ('method' in message && message.method.startsWith('ui/notifications/sandbox-')) return;
    if ('method' in message && 'id' in message) {
      const known =
        /^(ui\/(initialize|message|update-model-context|open-link|request-display-mode)|tools\/(list|call)|resources\/(read|list|templates\/list)|prompts\/list|ping)$/.test(
          message.method,
        );
      this.deps.audit?.(known || message.method === VIEW_STATE_METHOD ? message.method : 'unknown');
    }
    view.documentTransport.onmessage?.(message);
  }

  async poll(caller: string, sessionId: string | null, id: string, after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('MCP_APP_INVALID_CURSOR');
    const view = this.view(caller, sessionId, id);
    if (after > view.transport.seq) throw new Error('MCP_APP_INVALID_CURSOR');
    await this.assertCurrentView(id, view);
    const events = await view.transport.poll(after);
    await this.assertCurrentView(id, view);
    // An authorization read may straddle a new initialize after poll has already
    // taken a snapshot. Do not return that snapshot's old-document replies.
    return view.transport.currentEvents(events);
  }

  context(caller: string, sessionId: string | null, id: string, patch: McpUiHostContext): void {
    const view = this.view(caller, sessionId, id);
    const old = view.context;
    // Tool identity and granted capabilities are host-owned, never renderer overrides.
    const allowed = [
      'theme',
      'styles',
      'locale',
      'timeZone',
      'containerDimensions',
      'safeAreaInsets',
      'deviceCapabilities',
    ] as const;
    const update = Object.fromEntries(
      allowed.filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]),
    );
    if (view.resourceBinding?.projectContext && Object.hasOwn(patch, 'cindy'))
      update.cindy = view.resourceBinding.projectContext(patch);
    view.context = { ...old, ...update };
    if (view.initialized) view.bridge.setHostContext(view.context);
  }

  async authorizeLink(
    caller: string,
    sessionId: string | null,
    id: string,
    linkId: string,
    url?: string,
  ): Promise<McpAppLinkAuthorization> {
    const view = this.view(caller, sessionId, id);
    await this.assertCurrentView(id, view);
    const link = view.links.get(linkId);
    if (!link) throw new Error('MCP_APP_LINK_UNAVAILABLE');
    if (url !== undefined && link.url !== url) throw new Error('MCP_APP_INVALID_LINK');
    link.claim();
    return { authorized: true, validForMs: MCP_APP_LINK_GRANT_MS };
  }

  linkResult(
    caller: string,
    sessionId: string | null,
    id: string,
    linkId: string,
    success: boolean,
  ): void {
    this.view(caller, sessionId, id).links.get(linkId)?.resolve(success);
  }

  displayMode(
    caller: string,
    sessionId: string | null,
    id: string,
    mode: 'inline' | 'fullscreen' | 'pip',
  ): void {
    const view = this.view(caller, sessionId, id);
    const appModes = view.bridge.getAppCapabilities()?.availableDisplayModes;
    if (
      !view.context.availableDisplayModes?.includes(mode) ||
      (appModes && !appModes.includes(mode))
    )
      return;
    view.context = { ...view.context, displayMode: mode };
    if (view.initialized) view.bridge.setHostContext(view.context);
  }

  async teardown(
    caller: string,
    sessionId: string | null,
    id: string,
    alreadyNotified = false,
  ): Promise<void> {
    const view = this.view(caller, sessionId, id);
    // The controller keeps its iframe mounted until this bounded handshake finishes.
    try {
      if (view.initialized && !alreadyNotified)
        await view.bridge.teardownResource({}, { timeout: 1_000 });
    } catch {
      /* An unresponsive App must not block leaving a task. */
    }
    await this.disposeView(id, view);
  }

  private async disposeView(id: string, view: View, notify = false): Promise<void> {
    if (this.views.get(id) !== view) return;
    if (notify && view.initialized) {
      try {
        await view.bridge.teardownResource({}, { timeout: 1_000 });
      } catch {
        /* Reclaim the View even when its teardown handshake times out. */
      }
    }
    this.views.delete(id);
    view.stopContext?.();
    view.files?.close();
    if (!this.views.size) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    view.links.forEach((link) => link.resolve(false));
    this.deps.disposeDocument?.(id);
    view.unlisten.forEach((remove) => remove());
    await view.bridge.close();
    await view.transport.close();
    const entry = this.connections.get(this.connectionIds.get(view.connection) ?? '');
    if (entry?.retired) await this.releaseConnection(view.connection);
  }

  private async pruneModelContexts(): Promise<void> {
    // Context survives a closed View until the next model turn. Reclaim revoked
    // cards, archived tasks and obsolete configurations before refusing a new one.
    for (const [key, item] of [...this.contexts]) {
      let current = false;
      if (item.owner === this.deps.owner()) {
        try {
          const card = item.assertSource ? (await item.assertSource(), undefined) : await this.deps.readCard(item.sessionId, item.clientId);
          const config = this.deps.config(item.serverId);
          current =
            item.owner === this.deps.owner() &&
            !!config &&
            this.serverRevision(config) === item.revision &&
            (!card || card.serverId === item.serverId && card.serverRevision === item.revision);
        } catch {
          // Unavailable cards cannot contribute model context.
        }
      }
      // A concurrent update may have replaced the value while readCard waited.
      if (!current && this.contexts.get(key) === item) this.contexts.delete(key);
    }
  }

  async modelContext(sessionId: string): Promise<McpAppModelContext> {
    const owner = this.deps.owner();
    const empty: McpAppModelContext = { text: '', async assertCurrent() {}, consume() {} };
    const values: unknown[] = [];
    const captured: Array<{ clientId: string; serverId: string; revision: string; assertSource?: () => Promise<void> }> = [];
    const removals: Array<() => void> = [];
    for (const [key, item] of [...this.contexts]) {
      if (item.owner !== owner || item.sessionId !== sessionId) continue;
      // Validation and dispatch can overlap another App update. Never remove its replacement.
      const remove = () => {
        if (this.contexts.get(key) === item) this.contexts.delete(key);
      };
      try {
        const card = item.assertSource ? (await item.assertSource(), undefined) : await this.deps.readCard(sessionId, item.clientId);
        const config = this.deps.config(item.serverId);
        if (owner !== this.deps.owner()) return empty;
        if (
          !config ||
          this.serverRevision(config) !== item.revision ||
          (card && card.serverRevision !== item.revision)
        ) {
          remove();
          continue;
        }
        values.push(item.value);
        captured.push(item);
        removals.push(remove);
      } catch {
        remove();
      }
    }
    if (owner !== this.deps.owner()) return empty;
    const serialized = JSON.stringify(values);
    if (Buffer.byteLength(serialized, 'utf8') > 512_000)
      throw new Error('MCP_APP_CONTEXT_TOO_LARGE');
    if (!values.length) return empty;
    return {
      text: `\n[MCP App context: external application data]\n${serialized}\n[/MCP App context]`,
      assertCurrent: async () => {
        if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
        const cards = await Promise.all(
          captured.map(async (item) => item.assertSource ? (await item.assertSource(), undefined) : this.deps.readCard(sessionId, item.clientId)),
        );
        if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
        for (const [index, item] of captured.entries()) {
          const config = this.deps.config(item.serverId);
          if (
            !config ||
            this.serverRevision(config) !== item.revision ||
            (cards[index] && cards[index]!.serverRevision !== item.revision)
          )
            throw new Error('MCP_APP_SERVER_CHANGED');
        }
      },
      consume: () => {
        if (owner === this.deps.owner()) removals.forEach((remove) => remove());
      },
    };
  }

  async revokePluginConnections(instance?: string): Promise<void> {
    // A disabled service has already left the registry, but its process may
    // still be stopping. Keep uninstall/account cleanup bound to owned clients.
    const ids = new Set([...this.connections.values()]
      .filter(({ connection }) => connection.config.plugin &&
        (instance === undefined || connection.config.plugin.instance === instance))
      .map(({ connection }) => connection.config.id));
    await this.revokePluginServers(ids);
  }

  async revokePluginServers(ids: ReadonlySet<string>): Promise<void> {
    pagePermissionGrants.clearServers(ids);
    const closing: Promise<unknown>[] = [];
    for (const [id, view] of this.views) if (ids.has(view.serverId)) closing.push(this.disposeView(id, view, true));
    for (const [id, entry] of this.connections) if (ids.has(entry.connection.config.id)) {
      closing.push(entry.connection.close().then(() => { this.connections.delete(id); }));
    }
    // Package replacement must observe a failed stop; allSettled would let an
    // old process keep executing files while the installation is replaced.
    await Promise.all(closing);
  }

  async reset(): Promise<void> {
    pagePermissionGrants.clearServers();
    this.cancelledOpens.clear();
    for (const pending of this.opening.values())
      pending.abort.abort(new Error('MCP_APP_OWNER_CHANGED'));
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const views = [...this.views.entries()];
    const connections = [...this.connections.values()];
    this.contexts.clear();
    this.connections.clear();
    await Promise.allSettled(
      views.map(async ([id, view]) => {
        try {
          if (view.initialized) await view.bridge.teardownResource({}, { timeout: 1_000 });
        } catch {
          /* Owner reset must finish even when an App no longer responds. */
        }
        await this.disposeView(id, view);
      }),
    );
    await Promise.allSettled(connections.map((entry) => entry.connection.close()));
  }

  private async sweep(): Promise<void> {
    for (const [id, view] of this.views) {
      const config = this.deps.config(view.serverId);
      if (
        view.owner !== this.deps.owner() ||
        !config ||
        this.serverRevision(config) !== view.serverRevision ||
        Date.now() - view.lastUsed > 60_000
      )
        await this.disposeView(id, view, true);
    }
    for (const [id, entry] of this.connections)
      if (entry.owner !== this.deps.owner() || entry.connection.isClosed) {
        await entry.connection.close().then(() => { this.connections.delete(id); }).catch(() => {});
      }
  }
}
