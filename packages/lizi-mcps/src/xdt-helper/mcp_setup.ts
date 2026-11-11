import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const MCP_SETUP_TRANSPORTS = ['http', 'sse'] as const;

/**
 * Accept the transport spelling any model sends (`HTTP`, `Http`, ` sse `) and hand the
 * bridge only the canonical lowercase enum. Returns `null` for values that are not a
 * transport at all, so the tool can answer with an actionable INVALID_ARGS instead of
 * silently opening a form with an unusable transport.
 */
export function normalizeMcpSetupTransport(value: string | undefined): 'http' | 'sse' | undefined | null {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return (MCP_SETUP_TRANSPORTS as readonly string[]).includes(normalized)
    ? normalized as (typeof MCP_SETUP_TRANSPORTS)[number]
    : null;
}

export type McpSetupCallback = (
  context: LiziMcpSessionContext,
  proposal: { name?: string; url?: string; transport?: 'http' | 'sse' },
) => Promise<{ status: 'saved'; serverId: string; runtimeState?: string; runtimeReason?: 'status_unavailable' | 'check_failed'; toolCount?: number } | { status: 'cancelled' }
  | { status: 'interrupted' } | { status: 'timed_out'; formPresented: boolean }
  | { status: 'unavailable'; reason: 'request_in_progress' | 'presentation_failed' }>;

export function registerMcpSetupTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  request: McpSetupCallback,
  gatewayAvailable = false,
): void {
  registry.register({
    name: 'request_mcp_setup', category: 'auth',
    description: 'Open the existing MCP Settings form inside this task on the local Cindy Desktop. Suggest only a public name, URL and HTTP/SSE transport. The owner enters credentials in the form; never request or pass credentials in conversation, tools or files. Wait for the tool result: saved/serverId proves configuration was saved, not that this runtime has loaded it or that connectivity passed. An optional runtimeState reports the engine observation; unverified includes runtimeReason (status_unavailable or check_failed) and is not a connection failure and connected is not a business ping result. After saving, follow the returned next entry when present: list_mcp_tools with serverId, then call_mcp_tool with the discovered schema. This fixed entry does not depend on native discovery. When next is absent, inspect this runtime capability before claiming that the saved service is callable. Use its normal authorized tools to continue the original question. Do not ask for another confirmation just to discover it, fabricate a user continuation, create a worker, or reinstall a saved server. Only cancelled means the owner cancelled. timed_out (with formPresented), interrupted, and unavailable are distinct outcomes; report the evidence, never label them user cancellation. A teammate may still need its capability selection before tools become available.',
    inputShape: {
      name: z.string().trim().min(1).max(60).optional(),
      url: z.string().url().max(2048).refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      }, 'Suggest a public endpoint without credentials or query parameters').optional(),
      // Case-insensitive on purpose: `HTTP` / `Http` are what models actually send, and a
      // strict enum rejected the whole call before the form could open.
      transport: z.string().trim().min(1).max(16).optional()
        .describe('http 或 sse，大小写不敏感'),
    },
    handler: async proposal => {
      const context = getContext();
      if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId ||
        context.mcpCallerKind === 'descendant') {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use the local parent Desktop task.');
      }
      const transport = normalizeMcpSetupTransport(proposal.transport);
      if (transport === null) {
        return errorPayload('INVALID_ARGS',
          `transport 只接受 http 或 sse（大小写不敏感），收到 "${proposal.transport}"；改成 http 或 sse 后重试。`,
          { field: 'transport', received: proposal.transport, allowed: [...MCP_SETUP_TRANSPORTS] });
      }
      const normalized = {
        ...(proposal.name ? { name: proposal.name.trim() } : {}),
        ...(proposal.url ? { url: proposal.url.trim() } : {}),
        ...(transport ? { transport } : {}),
      };
      try {
        const result = await request(context, normalized);
        // runtimeState 只描述引擎原生工具列表。把这件事写进回执，避免模型把
        // pending / not-mounted / unverified 读成“连接失败”而要求重装或新建任务。
        const nativeListHint = result.status === 'saved' && result.runtimeState && result.runtimeState !== 'connected'
          ? { hint: `配置已保存。runtimeState=${result.runtimeState} 只描述引擎原生工具列表，不是连接失败；直接用 next 的 list_mcp_tools → call_mcp_tool 即可，无需“继续”、新任务、worker 或重装。` }
          : {};
        return okPayload({
          ...result,
          ...nativeListHint,
          ...(gatewayAvailable && result.status === 'saved' ? {
            next: { tool: 'list_mcp_tools', args: { server: result.serverId }, callWith: 'call_mcp_tool' },
          } : {}),
        });
      }
      catch { return errorPayload('MCP_SETUP_UNAVAILABLE', 'Could not open the MCP Settings form.'); }
    },
  });
}
