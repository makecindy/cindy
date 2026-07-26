import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger, McpProvider, McpProviderContext } from '@cindy/maker-core';
import { getLiziMcpSessionContext, runWithLiziMcpSessionContext } from '@cindy/mcps/session-context';
import type { LiziMcpSessionContext } from '@cindy/mcps';

const TOKEN_ENV = 'CINDY_HEADLESS_MCP_TOKEN';
const TIMEOUT_SECONDS = 10 * 60;
const MCP_PATH_PREFIX = '/mcp/';
const INIT_BODY_MAX_BYTES = 1024 * 1024;

type TransportEntry = { transport: StreamableHTTPServerTransport; server: McpServer };

/**
 * A daemon-private Streamable HTTP bridge for Codex.  It listens exclusively
 * on loopback and requires a per-process bearer token, while Claude consumes
 * the same providers in-process.  The bridge restores the business session
 * context from Codex's thread id for every tool call; unknown threads fail
 * closed with no session context rather than being guessed.
 */
export class HeadlessMcpService {
  private readonly contexts = new Map<string, LiziMcpSessionContext>();
  private readonly token = randomBytes(32).toString('hex');
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly transports = new Map<string, Map<string, TransportEntry>>();

  constructor(private readonly providers: McpProvider[], private readonly logger: Logger) {}

  async start(): Promise<void> {
    if (this.server) return;
    const factories = this.serverFactories();
    if (Object.keys(factories).length === 0) return;
    for (const name of Object.keys(factories)) this.transports.set(name, new Map());

    const server = http.createServer((req, res) => this.handle(req, res, factories));
    server.keepAliveTimeout = 0;
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve();
      });
    });
    server.on('error', (error) => this.logger.error('headless MCP bridge listener error', { message: error.message }));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.logger.info('headless MCP bridge listening', { port: this.port, servers: Object.keys(factories) });
  }

  registerCodexThread(sessionId: string, threadId: string, workingDir: string, vendorOptions?: Record<string, unknown>): void {
    if (!sessionId || !threadId) return;
    this.contexts.set(threadId, { agentKind: 'codex', sessionId, workingDir, vendorOptions });
  }

  unregisterCodexThread(threadId: string): void {
    this.contexts.delete(threadId);
  }

  forgetSession(sessionId: string): void {
    for (const [threadId, context] of this.contexts) {
      if (context.sessionId === sessionId) this.contexts.delete(threadId);
    }
  }

  /** Extra Codex app-server args.  Empty when no in-process provider is enabled. */
  prepareCodexExtraSpawnConfig(): { extraArgs: string[]; extraEnv: Record<string, string> } {
    if (!this.port) return { extraArgs: [], extraEnv: {} };
    const enabled = this.enabledProviderNames();
    const extraArgs: string[] = [];
    for (const name of enabled) {
      const url = `http://127.0.0.1:${this.port}${MCP_PATH_PREFIX}${encodeURIComponent(name)}`;
      extraArgs.push('-c', `mcp_servers.${name}.url="${url}"`);
      extraArgs.push('-c', `mcp_servers.${name}.bearer_token_env_var="${TOKEN_ENV}"`);
      extraArgs.push('-c', `mcp_servers.${name}.startup_timeout_sec=${TIMEOUT_SECONDS}`);
      extraArgs.push('-c', `mcp_servers.${name}.tool_timeout_sec=${TIMEOUT_SECONDS}`);
    }
    return { extraArgs, extraEnv: enabled.length ? { [TOKEN_ENV]: this.token } : {} };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.contexts.clear();
    for (const bySession of this.transports.values()) {
      for (const { transport } of bySession.values()) await transport.close().catch(() => undefined);
      bySession.clear();
    }
    this.transports.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private serverFactories(): Record<string, () => McpServer> {
    const context: McpProviderContext = {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
      getSessionContext: () => {
        const active = getLiziMcpSessionContext();
        if (!active) return undefined;
        return {
          agentKind: active.agentKind as McpProviderContext['agentKind'],
          workingDir: active.workingDir,
          vendorOptions: active.vendorOptions,
          sessionId: active.sessionId,
          getSessionContext: context.getSessionContext,
        };
      },
    };
    const factories: Record<string, () => McpServer> = {};
    for (const provider of this.providers) {
      if (provider.isEnabled?.(context) === false || !provider.toClaudeSdkConfig) continue;
      const create = (): McpServer => {
        const config = provider.toClaudeSdkConfig!(context) as { type?: string; instance?: unknown } | null;
        if (config?.type !== 'sdk' || !config.instance) throw new Error(`MCP provider ${provider.name} did not return an SDK server`);
        return config.instance as McpServer;
      };
      try {
        const first = create();
        let pending: McpServer | null = first;
        factories[provider.name] = () => {
          const next = pending;
          pending = null;
          return next ?? create();
        };
      } catch (error) {
        this.logger.warn('skipping unavailable headless MCP provider', { provider: provider.name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return factories;
  }

  private enabledProviderNames(): string[] {
    const context: McpProviderContext = { agentKind: 'codex', workingDir: '', vendorOptions: {} };
    return this.providers
      .filter((provider) => provider.toClaudeSdkConfig && provider.isEnabled?.(context) !== false)
      .map((provider) => provider.name);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, factories: Record<string, () => McpServer>): Promise<void> {
    try {
      if (!isLocal(req.socket.remoteAddress ?? '')) return respond(res, 403);
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${this.token}`) return respond(res, 401);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(MCP_PATH_PREFIX)) return respond(res, 404);
      const name = decodeURIComponent(url.pathname.slice(MCP_PATH_PREFIX.length));
      if (!name || name.includes('/') || !factories[name]) return respond(res, 404);
      const sessions = this.transports.get(name);
      if (!sessions) return respond(res, 404);
      const header = req.headers['mcp-session-id'];
      const mcpSessionId = typeof header === 'string' ? header : undefined;
      if (mcpSessionId) return this.handleExisting(req, res, sessions, mcpSessionId);
      return this.handleInitialize(req, res, sessions, factories[name]);
    } catch (error) {
      this.logger.error('headless MCP request failed', { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) respond(res, 500);
    }
  }

  private async handleExisting(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, TransportEntry>, sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return respond(res, 404);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    const threadId = extractThreadId(body);
    const context = threadId ? this.contexts.get(threadId) : undefined;
    if (context) {
      await runWithLiziMcpSessionContext(context, () => entry.transport.handleRequest(req, res, body));
    } else {
      await entry.transport.handleRequest(req, res, body);
    }
  }

  private async handleInitialize(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, TransportEntry>, create: () => McpServer): Promise<void> {
    if (req.method !== 'POST') return respond(res, 400);
    const body = await readJsonBody(req, INIT_BODY_MAX_BYTES);
    if (!isInitializeRequest(body)) return respond(res, 400);
    const server = create();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId): void => { sessions.set(sessionId, { transport, server }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

function isLocal(remote: string): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function respond(res: http.ServerResponse, status: number): void {
  res.statusCode = status;
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  res.end();
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    length += buffer.length;
    if (length > maxBytes) throw new Error('MCP request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : undefined;
}

function extractThreadId(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  let threadId: string | undefined;
  for (const message of messages) {
    const value = message && typeof message === 'object'
      ? (message as { params?: { _meta?: { threadId?: unknown } } }).params?._meta?.threadId
      : undefined;
    if (typeof value !== 'string' || !value) return undefined;
    if (threadId && threadId !== value) return undefined;
    threadId = value;
  }
  return threadId;
}
