/**
 * `cindy_exec` MCP 服务(控制端)：把执行器的 Claude Code 风格工具以 MCP(Streamable HTTP，
 * 无状态、请求-响应)提供给另一台电脑上的 Claude Code。请求经设备互联隧道到达这里。
 */
import type { RemoteExecutor } from './executor';

export const CINDY_EXEC_MCP_SERVER = 'cindy_exec';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BATCH = 32;

export interface McpHttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body?: Buffer;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function json(status: number, value: unknown): McpHttpResponse {
  return {
    status,
    headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify(value)),
  };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleOne(
  executor: RemoteExecutor,
  request: JsonRpcRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const isNotification = request.id === undefined;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return isNotification ? null : rpcError(request.id, -32600, 'Invalid Request');
  }
  if (isNotification) return null;
  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion;
      const protocolVersion = typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: CINDY_EXEC_MCP_SERVER, version: '1.0.0' },
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: request.id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: executor.toolDefinitions().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };
    case 'tools/call': {
      const name = request.params?.name;
      if (typeof name !== 'string') return rpcError(request.id, -32602, 'tool name is required');
      const result = await executor.callTool(name, request.params?.arguments ?? {}, signal);
      return { jsonrpc: '2.0', id: request.id, result };
    }
    default:
      return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
}

/** 处理一次 MCP HTTP 请求。只支持 POST(无状态，不开 SSE 推送流)。 */
export async function handleExecMcpRequest(
  executor: RemoteExecutor,
  method: string,
  body: Buffer | undefined,
  signal?: AbortSignal,
): Promise<McpHttpResponse> {
  if (method === 'GET') return { status: 405, headers: [['allow', 'POST']] };
  if (method === 'DELETE') return { status: 200, headers: [] };
  if (method !== 'POST') return { status: 405, headers: [['allow', 'POST']] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body?.toString('utf8') ?? '');
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || parsed.length > MAX_BATCH) return json(400, rpcError(null, -32600, 'Invalid Request'));
    const responses = (await Promise.all(parsed.map((item) =>
      handleOne(executor, (item ?? {}) as JsonRpcRequest, signal)))).filter((item) => item !== null);
    return responses.length ? json(200, responses) : { status: 202, headers: [] };
  }
  if (!parsed || typeof parsed !== 'object') return json(400, rpcError(null, -32600, 'Invalid Request'));
  const response = await handleOne(executor, parsed as JsonRpcRequest, signal);
  return response ? json(200, response) : { status: 202, headers: [] };
}
