import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger, McpProvider, McpProviderContext } from '@cindy/maker-core';

const TOKEN_ENV = 'CINDY_HEADLESS_MCP_TOKEN';
const SERVER_NAME = 'cindy_memory';
const MAX_INIT_BODY_BYTES = 1024 * 1024;
const MCP_TIMEOUT_SECONDS = 10 * 60;

interface ActiveTransport {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface CodexMemoryBridge {
  extraArgs: string[];
  extraEnv: Record<string, string>;
  port: number;
  token: string;
  url: string;
  shutdown(): Promise<void>;
}

async function readJsonBody(req: http.IncomingMessage, limit = Number.POSITIVE_INFINITY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    received += buffer.length;
    if (received > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const body = Buffer.concat(chunks).toString('utf8');
  return body.trim() ? JSON.parse(body) : undefined;
}

function createServerFactory(provider: McpProvider, workingDir: string): () => McpServer {
  const context: McpProviderContext = { agentKind: 'codex', workingDir, vendorOptions: {} };
  if (provider.name !== SERVER_NAME || !provider.toClaudeSdkConfig) {
    throw new Error('Codex Maker Memory bridge requires the cindy_memory SDK provider');
  }
  return () => {
    const config = provider.toClaudeSdkConfig!(context) as { type?: string; instance?: unknown } | null;
    if (config?.type !== 'sdk' || !config.instance) {
      throw new Error('cindy_memory did not return an SDK MCP server');
    }
    return config.instance as McpServer;
  };
}

export async function startCodexMemoryBridge(options: {
  provider: McpProvider;
  workingDir: string;
  logger: Logger;
}): Promise<CodexMemoryBridge> {
  const logger = options.logger.child('codex-memory-bridge');
  const createServer = createServerFactory(options.provider, options.workingDir);
  const token = randomBytes(32).toString('hex');
  const sessions = new Map<string, ActiveTransport>();
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        return;
      }
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== `/mcp/${SERVER_NAME}`) {
        res.writeHead(404).end();
        return;
      }

      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
      if (sessionId) {
        const active = sessions.get(sessionId);
        if (!active) {
          res.writeHead(404).end('Unknown session');
          return;
        }
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await active.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(400).end('Missing mcp-session-id');
        return;
      }
      const body = await readJsonBody(req, MAX_INIT_BODY_BYTES);
      if (!isInitializeRequest(body)) {
        res.writeHead(400).end('Expected initialize request');
        return;
      }

      const mcpServer = createServer();
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string): void => { sessions.set(id, { server: mcpServer, transport }); },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error('Codex memory bridge request failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 500);
      if (!res.writableEnded) res.end();
    }
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/mcp/${SERVER_NAME}`;
  logger.info('Codex memory bridge listening', { port, server: SERVER_NAME });
  return {
    port,
    token,
    url,
    extraEnv: { [TOKEN_ENV]: token },
    extraArgs: [
      // Do not inherit Desktop/plugin MCP entries from a user's CODEX_HOME.
      '-c', 'mcp_servers={}',
      '-c', `mcp_servers.${SERVER_NAME}.url="${url}"`,
      '-c', `mcp_servers.${SERVER_NAME}.bearer_token_env_var="${TOKEN_ENV}"`,
      '-c', `mcp_servers.${SERVER_NAME}.startup_timeout_sec=${MCP_TIMEOUT_SECONDS}`,
      '-c', `mcp_servers.${SERVER_NAME}.tool_timeout_sec=${MCP_TIMEOUT_SECONDS}`,
    ],
    async shutdown() {
      for (const active of sessions.values()) await active.transport.close().catch(() => undefined);
      sessions.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
