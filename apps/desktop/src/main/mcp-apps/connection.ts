import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  TaskStatusNotificationSchema,
  CancelledNotificationSchema,
  type Notification,
  type ClientCapabilities,
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

type AppServerNotification = Notification;
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { MCP_APPS_EXTENSION } from './protocol.js';

export interface AppServerConfig {
  id: string;
  url: string;
  transport: 'http' | 'sse' | 'in-process';
  plugin?: { ghostId?: string; namespace?: string | null; instance: string; revision: string; packageSha256: string; directory: string; title: string; trust: string; domains: string[]; assertCurrent(sessionId?: string): void; createTransport(): Transport };
  headers?: Record<string, string>;
}

/** Credentials and the MCP client always stay in Main, never in a View. */
export class AppConnection {
  private createClient(): Client {
    const capabilities = this.config.plugin ? {} : this.peer?.capabilities() ?? {};
    const client = new Client(
      { name: 'Cindy', version: '1.0.0' },
      {
        capabilities: {
          ...capabilities,
          extensions: {
            ...capabilities.extensions,
            [MCP_APPS_EXTENSION]: { mimeTypes: [RESOURCE_MIME_TYPE] },
          },
        },
      },
    );
    if (this.peer && !this.config.plugin) {
      const peer = this.peer;
      const pending = new Map<RequestId, AbortController>();
      client.fallbackRequestHandler = async (request, extra) => {
        const cancelled = new AbortController();
        pending.set(extra.requestId, cancelled);
        try {
          return await peer.request(request, {
            ...extra,
            signal: AbortSignal.any([extra.signal, cancelled.signal]),
          });
        } finally {
          pending.delete(extra.requestId);
        }
      };
      // SDK 1.29 ignores cancellation of numeric request ID 0. Main owns these
      // forwarded handlers, so cancel by exact ID without changing SDK internals.
      client.setNotificationHandler(CancelledNotificationSchema, (message) => {
        const requestId = message.params.requestId;
        if (requestId !== undefined) pending.get(requestId)?.abort(message.params.reason);
      });
    }
    return client;
  }
  private client?: Client;
  private connecting?: Promise<Client>;
  private closed = false;
  private readonly listeners = new Set<(message: AppServerNotification) => void>();
  get isClosed(): boolean {
    return this.closed;
  }

  constructor(
    readonly config: AppServerConfig,
    private readonly peer?: {
      capabilities(): ClientCapabilities;
      request: NonNullable<Client['fallbackRequestHandler']>;
    },
  ) {}

  async getClient(signal?: AbortSignal): Promise<Client> {
    this.config.plugin?.assertCurrent();
    signal?.throwIfAborted();
    if (this.closed) throw new Error('MCP_APP_CONNECTION_CLOSED');
    if (!this.connecting) {
      const client = this.createClient();
      this.client = client;
      const requestInit = { headers: this.config.headers };
      const url = this.config.plugin ? undefined : new URL(this.config.url);
      const transport =
        this.config.plugin ? this.config.plugin.createTransport() : this.config.transport === 'sse'
          ? new SSEClientTransport(url!, {
              requestInit,
              eventSourceInit: {
                fetch: (input, init) =>
                  fetch(input, { ...init, headers: { ...this.config.headers, ...init?.headers } }),
              },
            })
          : new StreamableHTTPClientTransport(url!, { requestInit });
      // A transport loss retires only this attempt. A later independent request
      // may connect again; requests already sent are never replayed here.
      const retire = () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.connecting = undefined;
      };
      client.onclose = retire;
      this.connecting = client.connect(transport, { timeout: 30_000 }).then(() => {
        if (this.closed || this.client !== client) throw new Error('MCP_APP_CONNECTION_CLOSED');
        for (const schema of [
          ToolListChangedNotificationSchema,
          ResourceListChangedNotificationSchema,
          PromptListChangedNotificationSchema,
          ResourceUpdatedNotificationSchema,
          LoggingMessageNotificationSchema,
          TaskStatusNotificationSchema,
        ]) {
          client.setNotificationHandler(schema, (message) => {
            this.listeners.forEach((listener) => listener(message));
          });
        }
        client.fallbackNotificationHandler = async (message) => {
          this.listeners.forEach((listener) => listener(message));
        };
        return client;
      }).catch(async (error) => {
        retire();
        await client.close().catch(() => {});
        throw error;
      });
    }
    if (!signal) return this.connecting;
    const connecting = this.connecting;
    // Initialization is shared. Cancel only this waiter, leaving peers and the
    // bounded connection attempt intact; observe late failures after cancellation.
    return new Promise<Client>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      connecting.then(
        (client) => {
          signal.removeEventListener('abort', abort);
          resolve(client);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }

  async tools(signal?: AbortSignal): Promise<Tool[]> {
    const client = await this.getClient(signal);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('MCP_APP_INVALID_PAGINATION');
      if (cursor) seen.add(cursor);
      if (seen.size > 100 || tools.length > 10_000) throw new Error('MCP_APP_TOOL_LIST_TOO_LARGE');
    } while (cursor);
    return tools;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.client?.close();
  }

  listen(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resource(uri: string, signal?: AbortSignal) {
    const client = await this.getClient(signal);
    const result = await client.readResource({ uri }, { signal });
    if (result.contents.some((item) => item.uri === uri && item._meta?.ui !== undefined))
      return { result };
    let cursor: string | undefined;
    const seen = new Set<string>();
    // Metadata may live on resources/list. servers without listing still support read.
    try {
      do {
        const page = await client.listResources(cursor ? { cursor } : undefined, { signal });
        const resource = page.resources.find((item) => item.uri === uri);
        if (resource) return { result, meta: resource._meta?.ui };
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 100))
          throw new Error('MCP_APP_INVALID_PAGINATION');
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch {
      /* Resource reads do not require list support. */
    }
    return { result };
  }
}

const pluginConnections = new WeakMap<object, Map<string, AppConnection>>();
export function sharedPluginConnection(config: AppServerConfig, owner: object): AppConnection {
  let entries = pluginConnections.get(owner);
  if (!entries) pluginConnections.set(owner, entries = new Map());
  const key = JSON.stringify([config.id, config.plugin?.revision, config.plugin?.packageSha256, config.plugin?.directory]);
  let connection = entries.get(key);
  if (!connection || connection.isClosed) entries.set(key, connection = new AppConnection(config));
  return connection;
}
