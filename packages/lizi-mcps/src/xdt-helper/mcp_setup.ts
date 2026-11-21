import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type McpSetupCallback = (
  context: LiziMcpSessionContext,
  proposal: { name?: string; url?: string; transport?: 'http' | 'sse' | 'stdio'; command?: string; args?: string[] },
) => Promise<{ status: 'saved'; serverId: string } | { status: 'cancelled' }>;

export function registerMcpSetupTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  request: McpSetupCallback,
): void {
  registry.register({
    name: 'request_mcp_setup', category: 'auth',
    description: 'Open the existing MCP Settings form inside this task on the local Cindy Desktop. Use this shared configuration for MCPs intended for compatible Cindy engines (Claude Code, Codex and Pi), instead of writing only one engine’s native config. Suggest a public name and HTTP/SSE URL, or stdio command and arguments without secrets. Local commands run on this Desktop, not in the task project or on an SSH host. Native engine configurations remain engine-specific and are not imported. The user enters credentials in the form; never request or pass credentials in conversation, tools or files. Configuration saved does not prove connection: verify the live tool list and a successful call; distinguish not loaded from startup failure or an offline device. Wait for the tool result: it returns only saved/serverId or cancelled. Saving uses the same behavior as Settings, including when new tools become available: a buddy gets them in this same chat on its next turn, so never suggest a new task for that.',
    inputShape: {
      name: z.string().trim().min(1).max(60).optional(),
      url: z.string().url().max(2048).refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      }, 'Suggest a public endpoint without credentials or query parameters').optional(),
      transport: z.enum(['http', 'sse', 'stdio']).optional(),
      command: z.string().trim().min(1).max(2048).refine(value => !value.includes('\0')).optional(),
      args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(100).optional(),
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
