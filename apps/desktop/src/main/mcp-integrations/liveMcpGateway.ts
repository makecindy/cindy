import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { isFrozenMcpServerAllowed } from './codexBuiltinToolPolicy.js';

type Invoke = NonNullable<XdtHelperMcpDeps['mcpGateway']>;

/** Close an idle upstream session so abandoned tasks do not hold remote connections. */
const DEFAULT_IDLE_MS = 90_000;

interface LiveConnection {
  /** Configuration identity of the server this session talks to. */
  signature: string;
  server: McpServer;
  client: Client;
  lastUsed: number;
}

/** Per-call facade: never reuse another task's credentials, policy or connection.
 * The provider is resolved live. Its normal App facade retains owner/revision checks,
 * schema validation, model visibility, result filtering and App-card delivery.
 *
 * Connections are reused per task + server: remote MCP servers may bind state (database
 * selection, transactions) to their `Mcp-Session-Id`, so rebuilding the session on every
 * call would silently drop it. A task therefore keeps one session until its configuration
 * changes, the task stops being current, or the session stays idle for `idleMs`.
 */
export function createLiveMcpGateway(deps: {
  resolve(context: Parameters<Invoke>[0], server: string): {
    create(context: McpProviderContext): unknown;
    isCurrent(): boolean;
    signature(): string;
  } | null;
  idleMs?: number;
}): Invoke {
  const connections = new Map<string, LiveConnection>();
  /** Handshakes in flight, so concurrent first calls share one upstream session instead of
   *  creating several and leaking the losers (the App host has a fixed connection budget). */
  const connecting = new Map<string, Promise<LiveConnection | null>>();

  const closeConnection = (connection: LiveConnection) => {
    void connection.client.close().catch(() => {});
    void connection.server.close().catch(() => {});
  };
  const dropConnection = (key: string) => {
    const existing = connections.get(key);
    if (!existing) return;
    connections.delete(key);
    closeConnection(existing);
  };
  const sweepIdle = () => {
    const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    const now = Date.now();
    for (const [key, connection] of connections) {
      if (now - connection.lastUsed > idleMs) dropConnection(key);
    }
  };
  // Idle sessions must also close when the task stops calling this entry; the timer is
  // unref'd so it never keeps the process alive.
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const timer = setInterval(sweepIdle, Math.max(5_000, Math.floor(idleMs / 2)));
  timer.unref?.();

  return async (context, request, signal) => {
    const failure = (code: string) => ({ isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, errorCode: code }) }] });
    if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId || context.mcpCallerKind !== 'root'
      || !/^custom_[a-z0-9_-]{1,33}$/.test(request.server)
      || !isFrozenMcpServerAllowed(context.vendorOptions, request.server)) return failure('MCP_GATEWAY_NOT_ALLOWED');
    const entry = deps.resolve(context, request.server);
    if (!entry?.isCurrent()) return failure('MCP_GATEWAY_UNAVAILABLE');
    const assertCurrent = () => { signal?.throwIfAborted(); if (!entry.isCurrent()) throw new Error('MCP_GATEWAY_STALE'); };
    const key = `${context.sessionId}\u0000${context.sessionInstanceId}\u0000${request.server}`;
    sweepIdle();
    let signature: string;
    try {
      assertCurrent();
      signature = entry.signature();
    } catch {
      return failure(signal?.aborted ? 'MCP_GATEWAY_CANCELLED' : 'MCP_GATEWAY_UNAVAILABLE');
    }
    // A saved edit of this server starts a new session; an edit of any other server does not.
    if (connections.get(key)?.signature !== undefined && connections.get(key)?.signature !== signature) dropConnection(key);
    try {
      let connection = connections.get(key);
      if (!connection) {
        let handshake = connecting.get(key);
        if (!handshake) {
          handshake = (async (): Promise<LiveConnection | null> => {
            const config = entry.create({ ...context, agentKind: context.agentKind as McpProviderContext['agentKind'],
            getSessionContext: () => { assertCurrent(); return context as McpProviderContext; } }) as
              { type?: string; instance?: McpServer } | null;
            if (config?.type !== 'sdk' || !config.instance) return null;
            const client = new Client({ name: 'cindy-task-mcp', version: '1' });
            const [ct, st] = InMemoryTransport.createLinkedPair();
            try {
              await Promise.all([config.instance.connect(st), client.connect(ct, { signal, timeout: 15_000 })]);
            } catch (error) {
              void client.close().catch(() => {});
              void config.instance.close().catch(() => {});
              throw error;
            }
            const opened: LiveConnection = { signature, server: config.instance, client, lastUsed: Date.now() };
            connections.set(key, opened);
            return opened;
          })().finally(() => { connecting.delete(key); });
          connecting.set(key, handshake);
        }
        connection = await handshake ?? undefined;
        if (!connection) return failure('MCP_GATEWAY_UNAVAILABLE');
        assertCurrent();
      }
      connection.lastUsed = Date.now();
      if (request.action === 'list') {
        const result = await connection.client.listTools(request.cursor ? { cursor: request.cursor } : {},
          { signal, timeout: 15_000 });
        assertCurrent();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, server: request.server, ...result }) }] };
      }
      // Native helper approval has already reviewed this exact server/tool/arguments.
      // The existing facade enforces the current upstream schema and model visibility.
      const result = await connection.client.callTool({ name: request.tool, arguments: request.arguments }, undefined,
        { signal, timeout: 120_000 });
      assertCurrent();
      connection.lastUsed = Date.now();
      return result as Awaited<ReturnType<Invoke>>;
    } catch {
      // Transport or scope failure: the session may be half-open, so never keep it.
      dropConnection(key);
      return failure(signal?.aborted ? 'MCP_GATEWAY_CANCELLED' : 'MCP_GATEWAY_REQUEST_FAILED');
    }
  };
}
