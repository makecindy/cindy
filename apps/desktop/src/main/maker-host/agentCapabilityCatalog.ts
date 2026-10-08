import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProvider, McpProviderContext } from '@cindy/maker-core';

export const RUNTIME_MCP_NAMES_KEY = 'cindyRuntimeMcpServerNames';

export interface AgentCapabilityQuery { server?: string; category?: string; }

/** Read the actual provider registrations. This catalog never grants permissions or starts tools. */
export async function readAgentCapabilityCatalog(
  providers: readonly McpProvider[],
  context: McpProviderContext,
  query: AgentCapabilityQuery,
  availability: (provider: McpProvider) => string | null = () => null,
) {
  const declarations = providers.map((provider) => {
    let reason: string | null = null;
    try {
      const mounted = context.vendorOptions?.[RUNTIME_MCP_NAMES_KEY];
      reason = Array.isArray(mounted) && !mounted.includes(provider.name)
        ? 'not-mounted-in-current-runtime' : availability(provider);
      if (!reason && provider.isEnabled?.(context) === false) reason = 'provider-not-enabled-for-session';
    } catch { reason = 'provider-status-unavailable'; }
    return {
      server: provider.name,
      title: provider.capability?.title ?? provider.name,
      description: provider.capability?.description ?? '',
      source: provider.capability?.source ?? 'custom',
      status: reason ? 'unavailable' : 'registered',
      ...(reason ? { reason } : {}),
      ...(provider.capability?.discovery ? { discovery: provider.capability.discovery } : {}),
    };
  });
  if (!query.server) return {
    ok: true, agent: context.agentKind, capabilities: declarations,
    hint: 'registered 表示已注册且入口条件满足，连接、设备与具体操作仍以发现和执行回执为准。指定 server 查询实际工具；插件沿其 discovery 入口展开。原生文件、命令行与子 Agent 工具由当前引擎提供，不属于 MCP 工具计数。',
  };
  const declaration = declarations.find((item) => item.server === query.server);
  if (!declaration) return { ok: false, errorCode: 'UNKNOWN_CAPABILITY', available: declarations.map((item) => item.server) };
  if (declaration.status === 'unavailable') return { ok: false, capability: declaration };
  const provider = providers.find((item) => item.name === query.server)!;
  // External connections are owned by the harness; never start another process,
  // inspect its credentials or execute a custom server's business operations.
  if (declaration.source !== 'builtin') return {
    ok: true, capability: declaration, discovery: 'harness-mcp',
    hint: '通过当前引擎已有的 MCP 发现入口查询此连接的工具。',
  };
  let instance: McpServer | undefined;
  let client: Client | undefined;
  try {
    const config = provider.toClaudeSdkConfig?.({ ...context, getSessionContext: () => context });
    const candidate = config && typeof config === 'object' && 'instance' in config ? config.instance : undefined;
    if (!(candidate instanceof McpServer)) return {
      ok: true, capability: declaration, discovery: 'harness-mcp',
    };
    instance = candidate;
    client = new Client({ name: 'cindy-capability-catalog', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated tools cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Only first-party progressive metadata is expanded here. Custom servers
    // may name arbitrary business operations list_tools; never execute those.
    const discovery = declaration.source === 'builtin' && tools.some((tool) => tool.name === 'list_tools')
      ? await client.callTool({ name: 'list_tools', arguments: query.category ? { category: query.category } : {} })
      : undefined;
    return { ok: true, capability: declaration, tools, ...(discovery ? { discovery } : {}) };
  } catch {
    return { ok: false, capability: declaration, errorCode: 'CAPABILITY_DISCOVERY_FAILED', message: '工具目录读取失败；请通过原工具入口重试。' };
  } finally {
    await Promise.allSettled([client?.close(), instance?.close()]);
  }
}
