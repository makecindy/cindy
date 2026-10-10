/**
 * 远程 Agent 反向 HTTP 请求的本机路由(控制端)。
 *
 * 对方电脑上的 Agent 经它本机隧道发来的 HTTP 请求在这里落地：
 *  - `/exec/<op>`：执行器原始操作(Pi 的工具后端)，JSON 进 JSON 出；
 *  - `/mcp/cindy_exec`：Claude Code 风格文件与命令工具(MCP)；
 *  - `/mcp/<name>`：本机 Cindy 工具(MCP)，转发到本机 MCP 桥，身份固定为本任务(对方给的
 *    查询参数一律丢弃，不能借它冒用别的任务)。
 * 其余路径一律 404。
 */
import { fileURLToPath } from 'node:url';
import type { RemoteAgentReply } from '@cindy/device-link';

import { CINDY_EXEC_MCP_SERVER, handleExecMcpRequest } from '../executor/ccMcp';
import { ExecutorRequestError, type RemoteExecutor } from '../executor/executor';
import { resolveExecutorShell } from '../executor/shell';

/** 本任务可用的一个本机 MCP 服务：完整地址(已带本任务身份)与要附加的请求头。 */
export interface LocalMcpTarget {
  url: string;
  headers: Record<string, string>;
}

export interface ReverseHttpRouterDeps {
  executor: RemoteExecutor;
  /** 本任务可用的本机 MCP 服务，按名字查。 */
  mcpTarget(name: string): LocalMcpTarget | undefined;
  fetch?: typeof fetch;
}

const FORWARD_REQUEST_HEADERS = new Set(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']);
const FORWARD_RESPONSE_HEADERS = new Set(['content-type', 'mcp-session-id', 'mcp-protocol-version']);

function json(status: number, value: unknown): Extract<RemoteAgentReply, { type: 'http' }> {
  return {
    type: 'http',
    status,
    headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

function errorStatus(code: string): number {
  switch (code) {
    case 'INVALID':
      return 400;
    case 'EACCES':
    case 'EPERM':
      return 403;
    case 'ENOENT':
    case 'ENOTDIR':
      return 404;
    case 'UNSUPPORTED':
      return 501;
    case 'CLOSED':
      return 410;
    default:
      return 500;
  }
}

export function createReverseHttpRouter(deps: ReverseHttpRouterDeps) {
  const doFetch = deps.fetch ?? fetch;
  const workspace = deps.executor.workspace;

  const mapArguments = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (/^(?:cmd|command)$/.test(key)) return workspace.mapCommand(value, resolveExecutorShell().dialect);
      if (/^(?:path|filePath|file_path|directory|workingDir|cwd|root|libraryRoot|sourcePath|destinationPath)$/i.test(key)) return workspace.mapAlias(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => mapArguments(item, key));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapArguments(item, name)]));
  };
  const projectResult = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.startsWith('file://')) {
        try {
          const uri = new URL(value);
          const virtual = workspace.toAgentPath(fileURLToPath(uri));
          if (virtual !== fileURLToPath(uri)) {
            uri.host = '';
            uri.pathname = virtual.replace(/\\/g, '/');
            return uri.href;
          }
        } catch { /* 普通字符串或非本机 file URL，交给文本投影。 */ }
      }
      return workspace.mapTextForAgent(value);
    }
    if (Array.isArray(value)) return value.map(projectResult);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectResult(item)]));
  };

  async function forwardMcp(
    target: LocalMcpTarget,
    method: string,
    headers: Array<[string, string]>,
    body: Buffer | undefined,
    signal?: AbortSignal,
  ): Promise<RemoteAgentReply> {
    // 推送流(GET)对请求-响应式隧道没有意义，按协议回 405 让客户端不开推送流。
    if (method === 'GET') return { type: 'http', status: 405, headers: [['allow', 'POST, DELETE']] };
    const outgoing = new Headers(target.headers);
    for (const [name, value] of headers) {
      if (FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) outgoing.set(name, value);
    }
    const response = await doFetch(target.url, {
      method,
      headers: outgoing,
      ...(body && method !== 'GET' && method !== 'HEAD' ? { body: new Uint8Array((() => {
        try {
          const message = JSON.parse(body.toString('utf8'));
          if (message.method === 'tools/call' && message.params?.arguments) message.params.arguments = mapArguments(message.params.arguments);
          return Buffer.from(JSON.stringify(message));
        } catch { return body; }
      })()) } : {}),
      signal,
    });
    let data = Buffer.from(await response.arrayBuffer());
    if (response.headers.get('content-type')?.includes('application/json')) {
      try { data = Buffer.from(JSON.stringify(projectResult(JSON.parse(data.toString('utf8'))))); } catch { /* 非 JSON 原样透传。 */ }
    } else if (response.headers.get('content-type')?.includes('text/event-stream')) {
      data = Buffer.from(data.toString('utf8').split('\n').map((line) => {
        if (!line.startsWith('data:')) return line;
        try { return 'data: ' + JSON.stringify(projectResult(JSON.parse(line.slice(5).trim()))); } catch { return line; }
      }).join('\n'));
    }
    const replyHeaders: Array<[string, string]> = [];
    response.headers.forEach((value, name) => {
      if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) replyHeaders.push([name, value]);
    });
    return {
      type: 'http',
      status: response.status,
      headers: replyHeaders,
      ...(data.length ? { body: data.toString('base64') } : {}),
    };
  }

  return async function route(
    request: { method: string; path: string; headers: Array<[string, string]>; body?: string },
    signal?: AbortSignal,
  ): Promise<RemoteAgentReply> {
    const url = new URL(request.path, 'http://tunnel.invalid');
    const body = request.body ? Buffer.from(request.body, 'base64') : undefined;
    const execMatch = /^\/exec\/([a-z]+\.[a-z]+)$/.exec(url.pathname);
    if (execMatch) {
      if (request.method !== 'POST') return json(405, { error: { code: 'INVALID', message: 'POST only' } });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body?.toString('utf8') ?? '{}');
      } catch {
        return json(400, { error: { code: 'INVALID', message: 'invalid JSON body' } });
      }
      try {
        return json(200, await deps.executor.handle(execMatch[1], parsed, signal));
      } catch (error) {
        const code = error instanceof ExecutorRequestError ? error.code : 'EXECUTOR_ERROR';
        const message = error instanceof Error ? error.message : String(error);
        return json(errorStatus(code), { error: { code, message } });
      }
    }
    const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (mcpMatch) {
      const name = mcpMatch[1];
      if (name === CINDY_EXEC_MCP_SERVER) {
        const response = await handleExecMcpRequest(deps.executor, request.method, body, signal);
        return {
          type: 'http',
          status: response.status,
          headers: response.headers,
          ...(response.body?.length ? { body: response.body.toString('base64') } : {}),
        };
      }
      const target = deps.mcpTarget(name);
      if (!target) return json(404, { error: { code: 'NOT_FOUND', message: `MCP server ${name} is not available for this task` } });
      return forwardMcp(target, request.method, request.headers, body, signal);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'unknown path' } });
  };
}
