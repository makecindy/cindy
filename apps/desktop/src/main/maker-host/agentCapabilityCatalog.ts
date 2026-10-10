import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AgentMcpServerToolsReport,
  AgentMcpServerToolsState,
  McpProvider,
  McpProviderContext,
} from '@cindy/maker-core';

export const RUNTIME_MCP_NAMES_KEY = 'cindyRuntimeMcpServerNames';

export interface AgentCapabilityQuery { server?: string; category?: string; }

/** The caller session's engine view of one MCP server; null = engine has no such entry. */
export type HarnessMcpToolsReader = (server: string) => Promise<AgentMcpServerToolsReport | null>;

const HARNESS_READ_TIMEOUT_MS = 8_000;
const TOOL_DESCRIPTION_MAX_CHARS = 300;

const HARNESS_STATE_MESSAGES: Record<Exclude<AgentMcpServerToolsState, 'connected'>, string> = {
  'not-mounted': '当前任务的引擎中没有挂载此服务，通常是任务开始后才添加或修改了它；新建任务后再试。',
  'no-tools': '引擎已配置此服务，但在当前任务中没有报告任何工具：可能启动时连接失败（地址错误、服务未运行或鉴权失败）、仍在启动，或服务本身没有工具。请在设置中检查该 MCP 的地址与连接状态，修正后新建任务再试。',
  failed: '引擎连接此服务失败。请在设置中检查该 MCP 的地址与连接状态，修正后新建任务再试。',
  'needs-auth': '此服务需要先完成授权，引擎才能取得它的工具。',
  pending: '引擎仍在连接此服务，稍后再查询。',
  disabled: '此服务在当前任务的引擎中已被停用。',
};

/** Read the actual provider registrations. This catalog never grants permissions or starts tools. */
export async function readAgentCapabilityCatalog(
  providers: readonly McpProvider[],
  context: McpProviderContext,
  query: AgentCapabilityQuery,
  availability: (provider: McpProvider) => string | null = () => null,
  readHarnessTools?: HarnessMcpToolsReader,
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
  if (declaration.source !== 'builtin') return readHarnessCapability(declaration, readHarnessTools);
  let instance: McpServer | undefined;
  let client: Client | undefined;
  try {
    const config = provider.toClaudeSdkConfig?.({ ...context, getSessionContext: () => context });
    const candidate = config && typeof config === 'object' && 'instance' in config ? config.instance : undefined;
    if (!(candidate instanceof McpServer)) return await readHarnessCapability(declaration, readHarnessTools);
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

/**
 * Ask the caller session's engine which tools it actually holds for a server it
 * connects itself. Registration alone is never reported as discovery success,
 * and engine failure text is not forwarded because it may carry endpoints.
 */
async function readHarnessCapability<T extends { server: string }>(
  declaration: T,
  readHarnessTools: HarnessMcpToolsReader | undefined,
) {
  const base = { capability: declaration, discovery: 'harness-mcp' as const };
  if (!readHarnessTools) return {
    ok: false, ...base, errorCode: 'HARNESS_DISCOVERY_UNAVAILABLE',
    message: '当前引擎没有可供读取的 MCP 工具目录，无法确认此服务在本任务中的工具。',
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let report: AgentMcpServerToolsReport | null;
  try {
    report = await Promise.race([
      readHarnessTools(declaration.server),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), HARNESS_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return {
      ok: false, ...base, errorCode: 'HARNESS_DISCOVERY_FAILED',
      message: '读取当前引擎的 MCP 工具目录失败，暂时无法确认此服务的工具；稍后重试。',
    };
  } finally {
    clearTimeout(timer);
  }
  if (!report) return {
    ok: false, ...base, errorCode: 'HARNESS_DISCOVERY_UNAVAILABLE',
    message: '当前引擎没有可供读取的 MCP 工具目录，无法确认此服务在本任务中的工具。',
  };
  if (report.state !== 'connected') return {
    ok: false, ...base, errorCode: 'HARNESS_MCP_NOT_READY', engineState: report.state,
    message: HARNESS_STATE_MESSAGES[report.state],
  };
  return {
    ok: true, ...base, engineState: report.state,
    tools: report.tools.map((tool) => tool.description && tool.description.length > TOOL_DESCRIPTION_MAX_CHARS
      ? { ...tool, description: `${tool.description.slice(0, TOOL_DESCRIPTION_MAX_CHARS)}…` }
      : tool),
    hint: report.tools.length > 0
      ? '以上是当前引擎在本任务中为此服务实际持有的工具（服务端原始名称），引擎会按自身规则命名后提供（通常带服务名前缀）。'
      : '此服务已连接，但没有提供任何工具。',
  };
}
