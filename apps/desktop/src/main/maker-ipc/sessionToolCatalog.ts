import { assertTaskActionCurrent } from './taskActionAuthorization.js';

/** On-demand native calls, with the existing plugin identity and owner checks. */
export function createSessionToolCatalogExecutor(ports: {
  getSession(id: string): Promise<{ agentKind: string; remoteHostId: string | null;
    readMcpServerTools(server: string): Promise<unknown | null>;
    callNativeToolCatalog(method: string, args: unknown[]): Promise<unknown> } | undefined>;
  pluginCall(): { caller: { pluginId: string }; assertCurrent(): void } | undefined;
  getGhost(id: string): { enabled: boolean; approval: { state: string }; manifest: { node?: unknown } } | null;
}) {
  return async (request: { sessionId: string; method: string; args: unknown[] }, assertCurrent: () => Promise<void>) => {
    const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
    await assertCurrent();
    const session = await ports.getSession(request.sessionId);
    if (!session) return fail('NOT_FOUND', '目标任务没有运行中的引擎；不会为目录操作启动任务。');
    if (session.remoteHostId) return fail('UNSUPPORTED_CAPABILITY', '原生工具目录仅支持本机引擎。');
    const mutation = ['setMcpServers', 'setActiveTools', 'registerMcpServer', 'unregisterMcpServer'].includes(request.method);
    if (mutation) await assertTaskActionCurrent();
    const plugin = ports.pluginCall();
    if (request.method === 'registerMcpServer' || request.method === 'setMcpServers' &&
      Object.keys(request.args[0] as object).length > 0) {
      const ghost = plugin ? ports.getGhost(plugin.caller.pluginId) : null;
      if (!ghost?.enabled || ghost.approval.state !== 'approved' || !ghost.manifest.node)
        return fail('UNSUPPORTED_CAPABILITY', '添加原生 MCP 仅支持已批准 node 的插件自带 HTTP/SSE 服务。');
    }
    await assertCurrent();
    plugin?.assertCurrent();
    try {
      const result = request.method === 'readMcpServerTools'
        ? await session.readMcpServerTools(request.args[0] as string)
        : await session.callNativeToolCatalog(request.method, request.args);
      if (request.method === 'readMcpServerTools' && result === null)
        return fail('UNSUPPORTED_CAPABILITY', '该引擎没有可读取的原生 MCP 目录。');
      await assertCurrent();
      plugin?.assertCurrent();
      return { ok: true as const, engine: session.agentKind, result };
    } catch (error) {
      if (error instanceof Error && error.message === 'UNSUPPORTED_CAPABILITY')
        return fail('UNSUPPORTED_CAPABILITY', '当前引擎版本或运行环境不支持此原生方法。');
      return fail('NATIVE_TOOL_CATALOG_FAILED', '原生操作未确认完成；请读取目录核对，不要自动重放修改。');
    }
  };
}
