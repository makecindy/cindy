import { importedProcessEnvironment } from './process.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ImportedMcpServer } from './types.js';
import { CompanionImportError } from './types.js';
import { fingerprint } from './files.js';

interface Connection { client: Client; close(): Promise<void>; idle?: ReturnType<typeof setTimeout> }
interface CachedConnection { pending: Promise<Connection>; inUse: boolean }
const connections = new Map<string, CachedConnection>();
const liveConnections = new Set<{ assertOwner(): void; close(): Promise<void> }>();

/** Deletion invalidates the companion fence before draining transports, including
 * idle, initializing and uncached parallel clients. Other companions stay open. */
export async function closeInvalidImportedConnections(): Promise<void> {
  await Promise.all([...liveConnections].map(async connection => {
    try { connection.assertOwner(); } catch { await connection.close(); }
  }));
}

export const IMPORTED_TOOL_LIMIT = 1000;

/** Discovery and takeover must see the same complete, bounded catalog. */
export async function listImportedTools(client: Pick<Client, 'listTools'>, limit = IMPORTED_TOOL_LIMIT): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await client.listTools({ cursor }, { timeout: 15_000 });
    if (tools.length + page.tools.length > limit) throw new Error('Connection tool limit exceeded');
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (!cursor) return tools;
  }
  throw new Error('Connection page limit exceeded');
}

async function connectImportedConnection(
  server: ImportedMcpServer,
  environment: Record<string, string>,
  assertOwner: () => void,
  evict: () => void,
): Promise<Connection> {
  if (server.command && server.cwd !== undefined) {
    try {
      if (typeof server.cwd !== 'string' || !path.isAbsolute(server.cwd) || server.cwd.includes('\0') || !(await fs.stat(server.cwd)).isDirectory())
        throw new Error('Invalid working directory');
    } catch { throw new CompanionImportError('CONNECTION_FAILED'); }
    assertOwner();
  }
  const client = new Client({ name: 'cindy-companion', version: '1.0.0' });
  const transport = server.command
    ? new StdioClientTransport({ command: server.command, args: server.args ?? [], cwd: server.cwd,
      env: importedProcessEnvironment({ ...environment, ...server.env }), stderr: 'ignore' })
    : server.transport === 'sse'
      ? new SSEClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } })
      : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    clearInterval(ownerTimer); clearTimeout(connected.idle);
    evict();
    return closing ??= (async () => {
      try { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
      finally { liveConnections.delete(lifetime); }
    })();
  };
  const connected: Connection = { client, close };
  const lifetime = { assertOwner, close };
  liveConnections.add(lifetime);
  // Own the fence for the entire connection lifetime, including cached idle time
  // and initialization. Per-call cancellation still settles the in-flight work.
  const ownerTimer = setInterval(() => {
    try { assertOwner(); } catch {
      void close();
    }
  }, 250);
  ownerTimer.unref();
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CompanionImportError('CONNECTION_TIMEOUT')), 15_000); }),
    ]);
    assertOwner();
    return connected;
  } catch { await close(); throw new CompanionImportError('CONNECTION_FAILED'); }
  finally { clearTimeout(timer); }
}

/** Reuse idle connections; concurrent callers own independent cancellable transports. */
export async function withImportedConnection<T>(
  server: ImportedMcpServer,
  environment: Record<string, string>,
  assertOwner: () => void,
  run: (client: Client) => Promise<T>,
  scope?: { identity?: string; signal: AbortSignal },
): Promise<T> {
  assertOwner();
  scope?.signal.throwIfAborted();
  const key = scope?.identity ? fingerprint([scope.identity, server]) : undefined;
  let cached = key ? connections.get(key) : undefined;
  let pending: Promise<Connection>;
  if (cached && !cached.inUse) {
    // Reserve before awaiting initialization so simultaneous callers cannot share
    // a transport that either one may close on cancellation or request failure.
    cached.inUse = true;
    pending = cached.pending;
  } else {
    const cacheable = !!key && !cached;
    if (cacheable && connections.size >= 128) throw new CompanionImportError('CONNECTION_LIMIT');
    cached = undefined;
    const evict = () => {
      if (key && cached && connections.get(key) === cached) connections.delete(key);
    };
    pending = connectImportedConnection(server, environment, assertOwner, evict);
    void pending.catch(evict);
    if (cacheable) {
      cached = { pending, inUse: true };
      connections.set(key!, cached);
    }
  }
  const connection = await pending;
  clearTimeout(connection.idle);
  let invalid = false;
  let rejectBoundary: ((error: Error) => void) | undefined;
  const discard = () => {
    invalid = true;
    void connection.close();
    rejectBoundary?.(new CompanionImportError('CONNECTION_CANCELLED'));
  };
  const timer = setInterval(() => { try { assertOwner(); } catch { discard(); } }, 250);
  timer.unref();
  scope?.signal.addEventListener('abort', discard, { once: true });
  try {
    assertOwner(); scope?.signal.throwIfAborted();
    const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject; });
    const result = await Promise.race([boundary, Promise.resolve().then(() => {
      assertOwner(); scope?.signal.throwIfAborted();
      return run(connection.client);
    })]);
    assertOwner(); return result;
  } catch {
    discard();
    // Foreign errors can contain headers/tokens; do not return their message.
    throw new CompanionImportError('CONNECTION_FAILED');
  } finally {
    clearInterval(timer); scope?.signal.removeEventListener('abort', discard);
    if (!cached || invalid) await connection.close();
    else {
      cached.inUse = false;
      connection.idle = setTimeout(() => {
        void connection.close();
      }, 5 * 60_000);
      connection.idle.unref();
    }
  }
}
