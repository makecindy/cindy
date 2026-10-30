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
import { MCP_APP_LINK_GRANT_MS, type McpAppLinkAuthorization } from '../../shared/mcpApps.js';
import type { McpAppMessageGuard } from './message.js';
import { AppConnection, type AppServerConfig } from './connection.js';
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

// A fixed total budget: server progress may renew the View's idle timer, but
// must not keep a Main-owned tool request alive indefinitely.
const MCP_APP_TOOL_TIMEOUT_MS = 30 * 60_000;

export interface McpAppsHostDeps {
  owner(): object | undefined;
  config(id: string): AppServerConfig | undefined;
  /** Desktop injects an owner-scoped vault key so revisions survive restarts. */
  revisionKey?(): string;
  readCard(sessionId: string, clientId: string): Promise<McpAppRecord>;
  writeCard(sessionId: string, clientId: string, record: McpAppRecord): Promise<void>;
  authorizeTool(
    sessionId: string,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
  sendMessage(
    sessionId: string,
    record: McpAppRecord,
    content: unknown[],
    assertCurrent: McpAppMessageGuard,
  ): Promise<void>;
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

class ViewTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  seq = 0;
  readonly events: import('../../shared/mcpApps.js').McpAppHostEvent<JSONRPCMessage>[] = [];
  private bytes = 2; // The serialized array's brackets also count toward the budget.
  private wake?: () => void;
  private failed = false;
  private closed = false;
  constructor(private readonly maxBytes: number) {}
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.enqueue({ seq: ++this.seq, message });
  }
  openLink(id: string, url: string): void {
    this.enqueue({ seq: ++this.seq, openLink: { id, url } });
  }
  private enqueue(event: (typeof this.events)[number]): void {
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
    if (this.failed) throw new Error('MCP_APP_BACKPRESSURE');
    return this.events.filter((event) => event.seq > after);
  }
  async close(): Promise<void> {
    // Revocation can win after Host authorization but before poll installs its wake.
    this.closed = true;
    this.wake?.();
    this.onclose?.();
  }
}

interface View {
  openId?: string;
  owner: object;
  caller: string;
  sessionId: string;
  clientId: string;
  record: McpAppRecord;
  connection: AppConnection;
  bridge: AppBridge;
  transport: ViewTransport;
  initialized: boolean;
  inputSent: boolean;
  resultSent: boolean;
  context: McpUiHostContext;
  lastUsed: number;
  unlisten: (() => void)[];
  links: Map<string, { url: string; claim: () => void; resolve: (success: boolean) => void }>;
}

// Standalone, non-persistent Hosts still need a private key. Desktop supplies
// its persistent vault key through revisionKey; this default never leaves Main.
const transientRevisionKey = randomBytes(32).toString('hex');
export function appServerRevision(config: AppServerConfig, key = transientRevisionKey): string {
  return createHmac('sha256', key)
    .update('cindy:mcp-app-server-revision:v1\0')
    .update(JSON.stringify([config.id, config.url, config.transport, config.headers]))
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
    }
  >();
  private readonly connectionIds = new WeakMap<AppConnection, string>();
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
        this.openView(caller, sessionId, clientId, hostContext, pending.abort.signal, openId),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      pending.abort.signal.removeEventListener('abort', onAbort);
      if (this.opening.get(key) === pending) this.opening.delete(key);
    }
  }

  async cancelOpen(caller: string, sessionId: string, openId: string): Promise<void> {
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
    sessionId: string,
    clientId: string,
    hostContext: McpUiHostContext,
    signal: AbortSignal,
    openId?: string,
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
    let record = await this.deps.readCard(sessionId, clientId);
    signal.throwIfAborted();
    const config = this.deps.config(record.serverId);
    if (!config || this.serverRevision(config) !== record.serverRevision)
      throw new Error('MCP_APP_SERVER_CHANGED');
    const connectionId = (record as McpAppRecord & { connectionId?: string }).connectionId;
    const registered = connectionId ? this.connections.get(connectionId) : undefined;
    const detached = !registered || registered.owner !== owner || registered.connection.isClosed;
    // An unknown connection belongs to a previous Host lifetime. Its original
    // call cannot finish here, and replaying it could repeat a side effect.
    // Persist the terminal state before reconnecting, even if loading later fails.
    if (!registered && !record.result && !record.cancelled) {
      record = { ...record, cancelled: 'Tool execution interrupted before completion' };
      await this.updateResult(sessionId, clientId, record, owner);
      signal.throwIfAborted();
    }
    const connection =
      registered?.owner === owner && !registered.connection.isClosed
        ? registered.connection
        : (this.deps.connection?.(config) ?? new AppConnection(config));
    const registeredId = this.registerConnection(connection, owner);
    if (detached) this.connections.get(registeredId)!.retired = true;
    try {
      const client = await connection.getClient();
      signal.throwIfAborted();
      const tool = (await connection.tools(signal)).find((item) => item.name === record.tool.name);
      if (!tool || uiToolUri(tool) !== record.resourceUri)
        throw new Error('MCP_APP_TOOL_UNAVAILABLE');
      const loaded = await connection.resource(record.resourceUri, signal);
      signal.throwIfAborted();
      const resource = readAppResource(loaded.result, record.resourceUri, loaded.meta);
      const policy = appCsp(resource.meta);
      if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
      // Recheck after async resource loading so simultaneous opens share the limit.
      if (
        [...this.views.values()].filter((view) => view.caller === caller).length >=
        (caller.startsWith('device:') ? 4 : 16)
      )
        throw new Error('MCP_APP_VIEW_LIMIT');
      const viewId = randomUUID();
      const document: McpAppDocument = {
        viewId,
        html: resource.html,
        csp: policy.header,
        policy: policy.csp,
        prefersBorder: resource.meta.prefersBorder !== false,
      };
      const remote = caller.startsWith('device:');
      if (remote && Buffer.byteLength(JSON.stringify(document)) > MCP_APPS_MAX_REMOTE_BYTES)
        throw new Error('MCP_APP_RESOURCE_TOO_LARGE');
      const transport = new ViewTransport(remote ? MCP_APPS_MAX_REMOTE_BYTES : MCP_APPS_MAX_BYTES);
      const context: McpUiHostContext = {
        ...hostContext,
        toolInfo: { tool, id: clientId },
        displayMode: 'inline',
        availableDisplayModes:
          hostContext.platform === 'mobile' ? ['inline'] : ['inline', 'fullscreen'],
      };
      const capabilities = client.getServerCapabilities();
      const bridge = new AppBridge(
        null,
        { name: 'Cindy', version: '1.0.0' },
        {
          openLinks: {},
          ...(capabilities?.tools
            ? { serverTools: { listChanged: capabilities.tools.listChanged } }
            : {}),
          ...(capabilities?.resources
            ? { serverResources: { listChanged: capabilities.resources.listChanged } }
            : {}),
          logging: {},
          message: { text: {}, resourceLink: {} },
          updateModelContext: { text: {}, structuredContent: {} },
          sandbox: { permissions: {}, csp: policy.csp },
        },
        { hostContext: context },
      );
      const view: View = {
        openId,
        owner,
        caller,
        sessionId,
        clientId,
        record,
        connection,
        bridge,
        transport,
        context,
        initialized: false,
        inputSent: false,
        resultSent: false,
        lastUsed: Date.now(),
        unlisten: [],
        links: new Map(),
      };
      this.views.set(viewId, view);
      if (!this.sweepTimer) {
        this.sweepTimer = setInterval(() => {
          void this.sweep().catch(() => {});
        }, 30_000);
        this.sweepTimer.unref();
      }
      const assertCurrent = () => this.assertCurrentView(viewId, view);
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
        bridge.setHostContext(view.context);
        void assertCurrent()
          .then(() => bridge.sendToolInput({ arguments: record.arguments }))
          .then(() => {
            view.inputSent = true;
            return this.sendResult(viewId, view);
          })
          .catch(() => {
            void this.disposeView(viewId, view);
          });
      };
      bridge.oncalltool = async (params, extra) => {
        await assertCurrent();
        const tools = await currentResult(connection.tools(extra.signal), extra.signal);
        const target = tools.find((item) => item.name === params.name);
        if (!target || !toolVisibleTo(target, 'app')) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
        await this.deps.authorizeTool(sessionId, target, params.arguments ?? {}, extra.signal);
        const client = await currentClient(extra.signal);
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
                            await transport.send({ jsonrpc: '2.0', ...notification });
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
      };
      bridge.setRequestHandler(ListToolsRequestSchema, async (_params, extra) => {
        await assertCurrent();
        const tools = await currentResult(connection.tools(extra.signal), extra.signal);
        return { tools: tools.filter((item) => toolVisibleTo(item, 'app')) };
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
        const content = Array.isArray(params.content) ? params.content : [params.content];
        if (content.some((block) => block.type !== 'text' && block.type !== 'resource_link'))
          throw new Error('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
        await this.deps.sendMessage(sessionId, record, content, assertCurrent);
        return {};
      };
      bridge.onupdatemodelcontext = async (params) => {
        await assertCurrent();
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
          app: record.serverId,
          resourceUri: record.resourceUri,
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
          serverId: record.serverId,
          revision: record.serverRevision,
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
          if (!view.initialized || owner !== this.deps.owner()) return;
          if (message.method === 'notifications/tools/list_changed')
            void bridge.sendToolListChanged(message.params).catch(() => {});
          if (message.method === 'notifications/resources/list_changed')
            void bridge.sendResourceListChanged(message.params).catch(() => {});
          if (message.method === 'notifications/prompts/list_changed')
            void bridge.sendPromptListChanged(message.params).catch(() => {});
        }),
      );
      try {
        await bridge.connect(transport);
        // Register before rereading: tool completion during loading must reach this
        // View, and a clear or configuration change must prevent publishing it.
        const latest = await this.deps.readCard(sessionId, clientId);
        signal.throwIfAborted();
        this.view(caller, sessionId, viewId);
        if (
          latest.serverId !== record.serverId ||
          latest.serverRevision !== record.serverRevision ||
          latest.resourceUri !== record.resourceUri ||
          latest.tool.name !== record.tool.name
        )
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        // A completion delivered while the database read was pending is newer
        // than that read's snapshot; never replace it with an unfinished record.
        if (!view.record.result && !view.record.cancelled) view.record = latest;
      } catch (error) {
        await this.disposeView(viewId, view);
        throw error;
      }
      return document;
    } catch (error) {
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
        if (view.owner === owner && view.sessionId === sessionId && view.clientId === clientId) {
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
              view.owner === owner && view.sessionId === sessionId && view.clientId === clientId,
          )
          .map(([id, view]) => this.disposeView(id, view)),
      );
      throw error;
    }
  }

  async assertViewAuthorized(caller: string, sessionId: string, id: string): Promise<void> {
    await this.assertCurrentView(id, this.view(caller, sessionId, id));
  }

  private async assertCurrentView(id: string, view: View): Promise<void> {
    this.view(view.caller, view.sessionId, id);
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

  private async sendResult(id: string, view: View): Promise<void> {
    if (view.resultSent || (!view.record.result && !view.record.cancelled)) return;
    try {
      await this.assertCurrentView(id, view);
    } catch (error) {
      // A caller can close while its card read is pending. The saved result
      // still belongs to active peers; only shared authorization failures escape.
      if (this.views.get(id) !== view) return;
      throw error;
    }
    // Initialization and completion can both wait on the same authorization read.
    if (view.resultSent) return;
    try {
      if (view.record.result) {
        view.resultSent = true;
        await view.bridge.sendToolResult(view.record.result as CallToolResult);
      } else if (view.record.cancelled) {
        view.resultSent = true;
        await view.bridge.sendToolCancelled({ reason: view.record.cancelled });
      }
    } catch {
      // A broken transport cannot invalidate a successfully persisted card.
      await this.disposeView(id, view).catch(() => {});
    }
  }

  private view(caller: string, sessionId: string, id: string): View {
    const view = this.views.get(id);
    if (
      !view ||
      view.caller !== caller ||
      view.sessionId !== sessionId ||
      view.owner !== this.deps.owner()
    )
      throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    const config = this.deps.config(view.record.serverId);
    if (!config || this.serverRevision(config) !== view.record.serverRevision)
      throw new Error('MCP_APP_SERVER_CHANGED');
    view.lastUsed = Date.now();
    return view;
  }

  async dispatch(caller: string, sessionId: string, id: string, input: unknown): Promise<void> {
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
    if ('method' in message && message.method === 'ui/initialize' && view.initialized) {
      if ('id' in message)
        await view.transport.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32600, message: 'MCP_APP_ALREADY_INITIALIZED' },
        });
      return;
    }
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
    // Sandbox messages are reserved for the trusted outer proxy, never for an App.
    if ('method' in message && message.method.startsWith('ui/notifications/sandbox-')) return;
    if ('method' in message && 'id' in message) {
      const known =
        /^(ui\/(initialize|message|update-model-context|open-link|request-display-mode)|tools\/(list|call)|resources\/(read|list|templates\/list)|prompts\/list|ping)$/.test(
          message.method,
        );
      this.deps.audit?.(known ? message.method : 'unknown');
    }
    view.transport.onmessage?.(message);
  }

  async poll(caller: string, sessionId: string, id: string, after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('MCP_APP_INVALID_CURSOR');
    const view = this.view(caller, sessionId, id);
    if (after > view.transport.seq) throw new Error('MCP_APP_INVALID_CURSOR');
    await this.assertCurrentView(id, view);
    const events = await view.transport.poll(after);
    await this.assertCurrentView(id, view);
    return events;
  }

  context(caller: string, sessionId: string, id: string, patch: McpUiHostContext): void {
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
    view.context = { ...old, ...update };
    if (view.initialized) view.bridge.setHostContext(view.context);
  }

  async authorizeLink(
    caller: string,
    sessionId: string,
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
    sessionId: string,
    id: string,
    linkId: string,
    success: boolean,
  ): void {
    this.view(caller, sessionId, id).links.get(linkId)?.resolve(success);
  }

  displayMode(
    caller: string,
    sessionId: string,
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
    sessionId: string,
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
    if (!this.views.size) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    view.links.forEach((link) => link.resolve(false));
    this.deps.disposeDocument?.(id);
    view.unlisten.forEach((remove) => remove());
    await view.bridge.close();
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
          const card = await this.deps.readCard(item.sessionId, item.clientId);
          const config = this.deps.config(item.serverId);
          current =
            item.owner === this.deps.owner() &&
            !!config &&
            this.serverRevision(config) === item.revision &&
            card.serverId === item.serverId &&
            card.serverRevision === item.revision;
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
    const captured: Array<{ clientId: string; serverId: string; revision: string }> = [];
    const removals: Array<() => void> = [];
    for (const [key, item] of [...this.contexts]) {
      if (item.owner !== owner || item.sessionId !== sessionId) continue;
      // Validation and dispatch can overlap another App update. Never remove its replacement.
      const remove = () => {
        if (this.contexts.get(key) === item) this.contexts.delete(key);
      };
      try {
        const card = await this.deps.readCard(sessionId, item.clientId);
        const config = this.deps.config(item.serverId);
        if (owner !== this.deps.owner()) return empty;
        if (
          !config ||
          this.serverRevision(config) !== item.revision ||
          card.serverRevision !== item.revision
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
          captured.map((item) => this.deps.readCard(sessionId, item.clientId)),
        );
        if (owner !== this.deps.owner()) throw new Error('MCP_APP_OWNER_CHANGED');
        for (const [index, item] of captured.entries()) {
          const config = this.deps.config(item.serverId);
          if (
            !config ||
            this.serverRevision(config) !== item.revision ||
            cards[index].serverRevision !== item.revision
          )
            throw new Error('MCP_APP_SERVER_CHANGED');
        }
      },
      consume: () => {
        if (owner === this.deps.owner()) removals.forEach((remove) => remove());
      },
    };
  }

  async reset(): Promise<void> {
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
      const config = this.deps.config(view.record.serverId);
      if (
        view.owner !== this.deps.owner() ||
        !config ||
        this.serverRevision(config) !== view.record.serverRevision ||
        Date.now() - view.lastUsed > 60_000
      )
        await this.disposeView(id, view, true);
    }
    for (const [id, entry] of this.connections)
      if (entry.owner !== this.deps.owner() || entry.connection.isClosed) {
        this.connections.delete(id);
        await entry.connection.close().catch(() => {});
      }
  }
}
