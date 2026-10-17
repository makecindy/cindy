import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  CreateTaskResultSchema,
  ResultSchema,
  SetLevelRequestSchema,
  ErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type CallToolResult,
  type ClientRequest,
  type ClientNotification,
  type Progress,
  type Request,
  type RequestId,
  type ServerCapabilities,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { McpAppRecord } from '../../shared/mcpApps.js';
import { AppConnection, type AppServerConfig } from './connection.js';
import { appServerRevision } from './host.js';
import { getMcpAppsHost, readAppServer } from './runtime.js';
import { toolVisibleTo, uiToolUri } from './protocol.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-apps');

/** Tool-result root metadata belongs to Views, including results retrieved from tasks. */
function modelToolResult<T extends { _meta?: unknown }>(result: T) {
  const modelResult = { ...result };
  delete modelResult._meta;
  return modelResult;
}

/** Preserve the SDK handshake while attaching authenticated upstream metadata. */
class AppProxyServer extends McpServer {
  constructor(
    name: string,
    private readonly readInitialize: () => Promise<{
      instructions?: string;
      capabilities: ServerCapabilities;
    }>,
  ) {
    super(
      { name, version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: true },
          prompts: { listChanged: true },
          completions: {},
          logging: {},
          tasks: { requests: { tools: { call: {} } } },
        },
      },
    );
  }

  override connect(transport: Transport): Promise<void> {
    const initializing = new Set<RequestId>();
    const wrapped: Transport = {
      get sessionId() {
        return transport.sessionId;
      },
      setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
      start: async () => {
        const onmessage = transport.onmessage;
        const onerror = transport.onerror;
        const onclose = transport.onclose;
        transport.onmessage = (message, extra) => {
          if (isJSONRPCRequest(message) && message.method === 'initialize')
            initializing.add(message.id);
          onmessage?.(message, extra);
          wrapped.onmessage?.(message, extra);
        };
        transport.onerror = (error) => {
          onerror?.(error);
          wrapped.onerror?.(error);
        };
        transport.onclose = () => {
          initializing.clear();
          onclose?.();
          wrapped.onclose?.();
        };
        await transport.start();
      },
      send: async (message, options?: TransportSendOptions) => {
        if (isJSONRPCResultResponse(message) && initializing.delete(message.id)) {
          try {
            // The SDK's internal superset permits forwarding. Only the actual
            // upstream capabilities are advertised to the model client.
            const upstream = await this.readInitialize();
            message = { ...message, result: { ...message.result, ...upstream } };
          } catch {
            // A failed response send is only reported out of band by the SDK.
            // Return an initialize error instead of leaving the client waiting.
            message = {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: ErrorCode.InternalError, message: 'MCP_APP_INITIALIZE_FAILED' },
            };
          }
        } else if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
          initializing.delete(message.id);
        }
        await transport.send(message, options);
      },
      close: () => transport.close(),
    };
    return super.connect(wrapped);
  }
}

/** Generic MCP facade: the harness keeps its own tool approval, while Main negotiates Apps. */
export function createAppServerProxy(
  readConfig: () => AppServerConfig,
  context: McpProviderContext,
): McpServer {
  const config = readConfig();
  // Main-only live checks use a process-private key, independent of the vault.
  // Never persist this fingerprint or expose it as an App-card revision.
  const liveRevision = appServerRevision(config);
  const host = getMcpAppsHost();
  const owner = host.captureOwner();
  const connection = new AppConnection(config, {
    capabilities: () => server.server.getClientCapabilities() ?? {},
    request: async (request, extra) => {
      assertCurrent();
      const token = request.params?._meta?.progressToken;
      const result = await server.server.request(request as ServerRequest, ResultSchema, {
        signal: extra.signal,
        onprogress: token === undefined ? undefined : (progress) => {
          try { assertCurrent(); } catch { return; }
          void extra.sendNotification({
            method: 'notifications/progress',
            params: { ...progress, progressToken: token },
          }).catch(() => {});
        },
      });
      assertCurrent();
      return result;
    },
  });
  const assertCurrent = () => {
    host.assertOwner(owner);
    const current = readAppServer(config.id);
    if (!current || appServerRevision(current) !== liveRevision)
      throw new Error('MCP_APP_SERVER_CHANGED');
  };
  // Bridge factories are created eagerly, but unused proxies must not retain a Host slot.
  const registerOnUse = () => {
    assertCurrent();
    return host.registerConnection(connection, owner);
  };
  const currentClient = async (signal?: AbortSignal) => {
    registerOnUse();
    const client = await connection.getClient(signal);
    assertCurrent();
    signal?.throwIfAborted();
    return client;
  };
  const requestOptions = (
    request: Request,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => {
    const token = request.params?._meta?.progressToken;
    return {
      signal: extra.signal,
      onprogress:
        token === undefined
          ? undefined
          : (progress: Progress) => {
              try {
                assertCurrent();
              } catch {
                return;
              }
              // Upstream owns any task queue; this facade only relays the notification.
              void server.server
                .notification(
                  {
                    method: 'notifications/progress',
                    params: { ...progress, progressToken: token },
                  },
                  { relatedRequestId: extra.requestId },
                )
                .catch(() => {});
            },
    };
  };
  const server: AppProxyServer = new AppProxyServer(config.id, async () => {
    const client = await currentClient();
    return {
      capabilities: client.getServerCapabilities() ?? {},
      instructions: client.getInstructions(),
    };
  });
  // Ordinary MCP methods (completion, subscriptions, logging, tasks and
  // extensions) retain their upstream behavior. tools/call stays below the
  // explicit visibility and App-card handling boundary.
  const forwardRequest = async (
    request: Request,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => {
    const client = await currentClient(extra.signal);
    const result = await client.request(
      request as ClientRequest,
      ResultSchema,
      requestOptions(request, extra),
    );
    assertCurrent();
    if (request.method === 'tasks/result') return modelToolResult(result);
    return result;
  };
  server.server.fallbackRequestHandler = forwardRequest;
  server.server.fallbackNotificationHandler = async (message) => {
    const client = await currentClient();
    await client.notification(message as ClientNotification);
    assertCurrent();
  };
  // Override the SDK's local log-level handler; the upstream owns its logging state.
  server.server.setRequestHandler(SetLevelRequestSchema, forwardRequest);
  server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    registerOnUse();
    const tools = await connection.tools(extra.signal);
    assertCurrent();
    return { tools: tools.filter((tool) => toolVisibleTo(tool, 'model')) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const connectionId = registerOnUse();
    const tool = (await connection.tools(extra.signal)).find(
      (candidate) => candidate.name === request.params.name,
    );
    extra.signal.throwIfAborted();
    assertCurrent();
    if (!tool || !toolVisibleTo(tool, 'model')) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
    if (request.params.task) {
      const client = await currentClient(extra.signal);
      const result = await client.request(
        { method: 'tools/call', params: request.params },
        CreateTaskResultSchema,
        requestOptions(request, extra),
      );
      assertCurrent();
      return result;
    }
    const active = context.getSessionContext?.() ?? context;
    const uri = uiToolUri(tool);
    const sessionId = active.sessionId;
    const clientId = `mcp-app:${randomUUID()}`;
    let record: McpAppRecord | undefined;
    if (uri && sessionId) {
      // Vault and UI persistence failure must not change a tool's actual outcome.
      try {
        record = {
          version: 1,
          serverId: config.id,
          serverRevision: host.serverRevision(config),
          resourceUri: uri,
          tool,
          arguments: request.params.arguments ?? {},
          connectionId,
        } as McpAppRecord;
        await host.updateResult(sessionId, clientId, record, owner);
      } catch {
        log.warn('MCP App card could not be stored');
        record = undefined;
      }
    }
    let result: CallToolResult;
    try {
      assertCurrent();
      const client = await currentClient(extra.signal);
      result = (await client.callTool(
        request.params,
        CallToolResultSchema,
        requestOptions(request, extra),
      )) as CallToolResult;
      assertCurrent();
    } catch (error) {
      if (record && sessionId) {
        try {
          await host.updateResult(
            sessionId,
            clientId,
            extra.signal.aborted
              ? { ...record, cancelled: 'Tool execution cancelled' }
              : {
                  ...record,
                  result: {
                    isError: true,
                    content: [{ type: 'text', text: 'MCP App tool execution failed' }],
                  },
                },
            owner,
          );
        } catch {
          log.warn('MCP App failure card could not be stored');
        }
      }
      throw error;
    }
    if (record && sessionId) {
      try {
        await host.updateResult(sessionId, clientId, { ...record, result }, owner);
      } catch {
        log.warn('MCP App result card could not be stored');
      }
    }
    // Card persistence may yield while the owner or server configuration changes.
    assertCurrent();
    return modelToolResult(result);
  });
  const unlisten = connection.listen((message) => {
    try {
      assertCurrent();
    } catch {
      return;
    }
    void server.server.notification(message).catch(() => {});
  });
  server.server.onclose = () => {
    unlisten();
    void host.releaseConnection(connection).catch(() => {});
  };
  return server;
}
