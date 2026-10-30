import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type McpSetupCallback = (
  context: LiziMcpSessionContext,
  proposal: { name?: string; url?: string; transport?: 'http' | 'sse' },
) => Promise<{ status: 'saved'; serverId: string } | { status: 'cancelled' }>;

export function registerMcpSetupTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  request: McpSetupCallback,
): void {
  registry.register({
    name: 'request_mcp_setup', category: 'auth',
    description: 'Open the existing MCP Settings form inside this task on the local Cindy Desktop. Suggest only a public name, URL and HTTP/SSE transport. The owner enters credentials in the form; never request or pass credentials in conversation, tools or files. Wait for the tool result: it returns only saved/serverId or cancelled. Saving uses the same behavior as Settings, including when new tools become available.',
    inputShape: {
      name: z.string().trim().min(1).max(60).optional(),
      url: z.string().url().max(2048).refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      }, 'Suggest a public endpoint without credentials or query parameters').optional(),
      transport: z.enum(['http', 'sse']).optional(),
    },
    handler: async proposal => {
      const context = getContext();
      if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId ||
        context.mcpCallerKind === 'descendant') {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use the local parent Desktop task.');
      }
      try { return okPayload({ ...await request(context, proposal) }); }
      catch { return errorPayload('MCP_SETUP_UNAVAILABLE', 'Could not open the MCP Settings form.'); }
    },
  });
}
