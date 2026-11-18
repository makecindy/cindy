import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type McpSetupCallback = (
  context: LiziMcpSessionContext,
  proposal: { name?: string; url?: string; transport?: 'http' | 'sse' | 'stdio'; command?: string; args?: string[]; cwd?: string; envKeys?: string[] },
) => Promise<{ status: 'saved'; serverId: string } | { status: 'cancelled' }>;

export function registerMcpSetupTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  request: McpSetupCallback,
): void {
  registry.register({
    name: 'request_mcp_setup', category: 'auth',
    description: 'Open the existing MCP Settings form inside this task on the local Cindy Desktop. Suggest only public configuration: name and HTTP/SSE URL, or stdio command, separate args, optional cwd and envKeys (names only). Never put secrets in args or environment suggestions. Cindy starts stdio on demand on the host computer; it does not install the command. The user enters credentials in the form; never request or pass credentials in conversation, tools or files. Wait for the tool result: it returns only saved/serverId or cancelled. Saving preserves existing tasks and their current MCP configuration. Newly started local tasks, including Codex tasks sharing an app-server, load the updated configuration without restarting Cindy. Existing runtimes are not forced to reload, so do not promise availability on the next turn of this task. Confirm tool discovery and a successful call before saying the connection works; saved alone proves neither.',
    inputShape: {
      name: z.string().trim().min(1).max(60).optional(),
      url: z.string().url().max(2048).refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      }, 'Suggest a public endpoint without credentials or query parameters').optional(),
      transport: z.enum(['http', 'sse', 'stdio']).optional(),
      command: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0')).optional(),
      args: z.array(z.string().max(16384).refine(value => !value.includes('\0'))).max(256).optional(),
      cwd: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0')).optional(),
      envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256)).max(256).optional(),
    },
    handler: async proposal => {
      const context = getContext();
      if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId ||
        context.mcpCallerKind === 'descendant') {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use the local parent Desktop task.');
      }
      if ((proposal.transport !== 'stdio' && (proposal.command !== undefined || proposal.args !== undefined ||
        proposal.cwd !== undefined || proposal.envKeys !== undefined)) || (proposal.transport === 'stdio' && proposal.url !== undefined)) {
        return errorPayload('INVALID_ARGUMENT', 'Use URL suggestions for HTTP/SSE, or command suggestions for stdio.');
      }
      try { return okPayload({ ...await request(context, proposal) }); }
      catch { return errorPayload('MCP_SETUP_UNAVAILABLE', 'Could not open the MCP Settings form.'); }
    },
  });
}
