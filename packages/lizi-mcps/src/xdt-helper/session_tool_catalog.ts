import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface SessionToolCatalogCallbacks {
  call(context: LiziMcpSessionContext, request: { sessionId: string; method: string; args: unknown[] }):
    Promise<ControlResult<{ engine: string; result: unknown }, string>>;
}

// Native web transports only. A process server belongs in the plugin's own
// approved Node worker, never in the harness's credential-bearing environment.
const webServer = z.object({ url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()).optional(),
  type: z.enum(['http', 'sse']).optional() }).passthrough().refine(config =>
  !['command', 'args', 'env', 'cwd', 'instance'].some(key => key in config), 'Only HTTP/SSE MCP configurations are supported.');

export function registerSessionToolCatalogTools(registry: XdtHelperToolRegistry,
  callbacks: SessionToolCatalogCallbacks, context: () => LiziMcpSessionContext): void {
  const invoke = async (sessionId: string | undefined, method: string, args: unknown[]) => {
    const caller = context();
    const target = sessionId ?? caller.sessionId;
    if (!target) return errorPayload('NO_SESSION_CONTEXT', '请提供目标任务 session_id。');
    if (target.includes('::') || caller.remoteHostId) return errorPayload('UNSUPPORTED_CAPABILITY', '原生工具目录仅支持执行电脑上的本机任务。');
    const result = await callbacks.call(caller, { sessionId: target, method, args });
    return result.ok ? okPayload({ session_id: target, method, engine: result.engine, result: result.result })
      : errorPayload(result.errorCode, result.message);
  };
  registry.register({ name: 'get_session_tool_catalog', category: 'control',
    description: '按需读取运行中本机任务的原生工具目录，不启动引擎或工具。Claude: mcpServerStatus；Pi: getAllTools/getActiveTools；Claude/Codex: readMcpServerTools（须 server_name）。不返回连接凭据或配置；缺少原生接口明确返回不支持。插件使用既有 control 组，须显式指定 session_id。',
    inputShape: { session_id: z.string().min(1).optional(), method: z.enum(['mcpServerStatus', 'getAllTools', 'getActiveTools', 'readMcpServerTools']),
      server_name: z.string().min(1).optional() },
    handler: async ({ session_id, method, server_name }) => {
      if (method === 'readMcpServerTools' && !server_name) return errorPayload('INVALID_ARGS', 'readMcpServerTools 需要 server_name。');
      return invoke(session_id, method, method === 'readMcpServerTools' ? [server_name] : []);
    },
  });
  registry.register({ name: 'set_session_tool_catalog', category: 'control',
    description: '修改运行中本机任务的原生工具目录，直接调用公开原生接口。Claude setMcpServers 替换 SDK 动态服务器完整集合（省略可移除宿主 SDK 服务），不自动合并；Pi setActiveTools 接收原生工具名数组，registerMcpServer/unregisterMcpServer 按原生注册语义。args 是该方法的原生位置参数数组。添加 MCP 仅支持已批准 node 的插件自带 HTTP/SSE 配置；不接受 stdio、不读取宿主凭据。显示/隐藏工具不代表授权或撤权，不修改任务权限，不持久化配置，不自动重放或恢复。Codex 创建期 dynamicTools 不支持在途改表。',
    inputShape: { session_id: z.string().min(1).optional(), method: z.enum(['setMcpServers', 'setActiveTools', 'registerMcpServer', 'unregisterMcpServer']),
      args: z.array(z.unknown()) },
    handler: async ({ session_id, method, args }) => {
      const schema = method === 'setMcpServers' ? z.tuple([z.record(z.string(), webServer)])
        : method === 'setActiveTools' ? z.tuple([z.array(z.string())])
        : method === 'registerMcpServer' ? z.tuple([z.string().min(1), webServer]) : z.tuple([z.string().min(1)]);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return errorPayload('INVALID_ARGS', '原生位置参数无效；MCP 只接受插件自带的 HTTP/SSE 配置。');
      return invoke(session_id, method, parsed.data);
    },
  });
}
