/**
 * `cindy_artifacts`: the three Open Artifact tools (Artifact, ArtifactData, ArtifactComments) as a built-in MCP
 * server, toggled by the `artifacts` built-in plugin.
 *
 * The caller (task and workspace) is taken from the host-attested MCP context at call time
 * (`resolveLiziMcpSessionContext`), never from tool arguments, so an agent cannot act as another task. The same
 * handlers serve Claude Code in-process and Codex / Pi through the HTTP bridge, which restores that context.
 * SSH remote tasks are excluded: their files are on another computer, which the local daemon cannot read.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { mcpTool, toolCallContent } from '@open-artifact/protocol';
import type { LiziMcpProvider, LiziMcpSessionContext } from '@cindy/mcps';
import type { OpenArtifactService } from './service.js';

export const CINDY_ARTIFACTS_MCP_NAME = 'cindy_artifacts';

const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** What a thrown error tells the agent: the message, and the kit's `fix` when it gave one. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const fix = (error as { fix?: unknown } | null)?.fix;
  return typeof fix === 'string' && fix ? `${message}\n${fix}` : message;
}

/** `resolveLiziMcpSessionContext` from `@cindy/mcps`, passed in so this module does not load that whole package. */
export type ResolveSessionContext = (context: LiziMcpSessionContext) => LiziMcpSessionContext;

/** Handlers of the server, separate from the MCP plumbing so tests call them directly. */
export function createArtifactsHandlers(
  service: Pick<OpenArtifactService, 'tools' | 'call'>,
  context: LiziMcpSessionContext,
  resolveLiziMcpSessionContext: ResolveSessionContext,
) {
  return {
    async list(): Promise<{ tools: Tool[] }> {
      return { tools: (await service.tools()).map((tool) => mcpTool(tool) as Tool) };
    },
    async call(name: string, args: Record<string, unknown> | undefined) {
      const caller = resolveLiziMcpSessionContext(context);
      if (caller.remoteHostId) {
        return errorResult('Open Artifact is not available in a task that runs on a remote (SSH) computer.');
      }
      if (!caller.sessionId) {
        return errorResult('Open Artifact needs the task this call belongs to, and Cindy could not tell which one it is.');
      }
      try {
        const result = await service.call(name, args ?? {}, {
          session: caller.sessionId,
          workspace: caller.workingDir || null,
        });
        return toolCallContent(result);
      } catch (error) {
        return errorResult(errorText(error));
      }
    },
  };
}

export function createArtifactsProvider(
  getService: () => OpenArtifactService,
  resolveSessionContext: ResolveSessionContext,
): LiziMcpProvider {
  return {
    name: CINDY_ARTIFACTS_MCP_NAME,
    // Local desktop tasks only; the plugin gate (provider-gate.ts) adds the `artifacts` toggle on top.
    isEnabled: (context) => !context.remoteHostId,
    toClaudeSdkConfig(context) {
      const server = new McpServer({ name: CINDY_ARTIFACTS_MCP_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
      const handlers = createArtifactsHandlers(getService(), context, resolveSessionContext);
      server.server.setRequestHandler(ListToolsRequestSchema, () => handlers.list());
      server.server.setRequestHandler(CallToolRequestSchema, (request) =>
        handlers.call(request.params.name, request.params.arguments as Record<string, unknown> | undefined));
      return { type: 'sdk', name: CINDY_ARTIFACTS_MCP_NAME, instance: server };
    },
  };
}
