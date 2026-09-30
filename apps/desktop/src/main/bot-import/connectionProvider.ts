import { ensureBotWorkspaceDir } from '../maker-ipc/botProfileFolder.js';
import { importedProcessEnvironment, runImportedProcess, redactEnvironmentValues } from './process.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpProvider } from '@cindy/maker-core';
import { resolveLiziMcpSessionContext } from '@cindy/mcps';
import { readCompanionSessionDiscovery, readCompanionSessionEnvironment, readCompanionSessionScope } from './runtime.js';
import { IMPORTED_TOOL_LIMIT, listImportedTools, withImportedConnection } from './connections.js';
import { fingerprint } from './files.js';
import { continueCompanionImport, getCompanionImportSetupStatus, useCindyImportSettings } from './host.js';
import { connectionRedactions, importedContentRedactions, publicConnectionName, redactImportedResult, redactImportedTool, restoreImportedArguments } from './connectionCatalog.js';
import { withImportedSkillResources } from './skillResources.js';

export const COMPANION_CONNECTIONS_MCP_NAME = 'companion_connections';

/** The shared bridge recovers the caller for every operation, including tools/list. */
export function createCompanionConnectionsProvider(): McpProvider {
  return {
    name: COMPANION_CONNECTIONS_MCP_NAME,
    toClaudeSdkConfig(context) {
      const server = new McpServer({ name: COMPANION_CONNECTIONS_MCP_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
      const resolve = async <T>(read: (sessionId: string) => Promise<T>) => {
        const session = resolveLiziMcpSessionContext(context);
        if (!session.sessionId) return undefined;
        return read(session.sessionId);
      };
      const toolName = (connection: string, tool: string, publicName = tool) => `c_${fingerprint(connection).slice(0, 12)}_${publicName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${fingerprint(tool).slice(0, 8)}`;
      server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const scope = await resolve(readCompanionSessionDiscovery);
        if (!scope) return { tools: [] };
        const tools: Tool[] = [{ name: 'run_command', description: 'Run a command with this companion’s imported environment and API credentials. Use this for imported skills and data queries that require their original environment. This executes arbitrary shell code with private credentials and may write files or use the network; it requires the current task’s command authorization. Output masking is not a security sandbox.', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }];
        if (scope.environment.pendingImport) tools.push({ name: 'import_setup',
          description: 'Inspect this teammate’s remaining import setup, or retry saved checks after the user is ready. Import is already saved; keep ordinary chat available and let the user defer setup. For login use the relevant existing account/plugin connection card, never ask for secrets in chat. The retry operation may check data connections and hand over originally selected automations only after verification. Source jobs keep running until then. If the user explicitly chooses this teammate’s current model and tool settings instead of source-specific model/tool settings, use_cindy_settings accepts entryIds from status; this saves that choice and never enables a task or bypasses a data check. Other unsupported semantics remain pending. Inspect first; never claim a connection or handover succeeded without its result.',
          inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['status', 'retry', 'use_cindy_settings'] }, offset: { type: 'integer', minimum: 0 }, entryIds: { type: 'array', items: { type: 'string' } } }, required: ['operation'], additionalProperties: false } });
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false)) {
          const secrets = connectionRedactions(connection, scope.environment.env);
          // Keep a failed or partially paginated catalog local to its connection.
          // Never swallow cancellation or an account change as an optional outage.
          try {
            const available = await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
              const entries = await listImportedTools(client, IMPORTED_TOOL_LIMIT - tools.length);
              return entries.map(tool => {
                const redacted = redactImportedTool({ ...tool, description: `${connection.name} · ${tool.name}\n${tool.description ?? ''}` }, secrets);
                return { ...redacted, name: toolName(connection.name, tool.name, redacted.name) };
              });
            }, { identity: scope.identity, signal: extra.signal });
            tools.push(...available);
          } catch {
            scope.assertOwner();
            extra.signal.throwIfAborted();
          }
        }
        scope.assertOwner();
        return { tools };
      });
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (request.params.name === 'import_setup') {
          const operation = request.params.arguments?.operation;
          const offset = request.params.arguments?.offset ?? 0;
          if (!['status', 'retry', 'use_cindy_settings'].includes(String(operation)) || !Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('Invalid import setup request');
          const session = resolveLiziMcpSessionContext(context);
          const scope = session.sessionId ? await readCompanionSessionScope(session.sessionId) : undefined;
          if (!scope) throw new Error('Companion connection unavailable');
          if (operation === 'use_cindy_settings') await useCindyImportSettings(scope.botId, scope.userData, request.params.arguments?.entryIds, scope.assertOwner);
          if (operation === 'retry') await continueCompanionImport(scope.botId, scope.userData, scope.assertOwner);
          const response = await getCompanionImportSetupStatus(scope.botId, scope.userData, scope.assertOwner, Number(offset));
          scope.assertOwner();
          return { content: [{ type: 'text', text: JSON.stringify(response) }] };
        }
        const scope = await resolve(readCompanionSessionEnvironment);
        if (!scope) throw new Error('Companion connection unavailable');
        if (request.params.name === 'run_command') {
          const command = request.params.arguments?.command;
          if (typeof command !== 'string' || !command.trim() || command.length > 32000) throw new Error('Invalid command');
          const cwd = await ensureBotWorkspaceDir(scope.userData, scope.botId);
          // cmd /s strips the outer quotes; its command text must bypass CRT argv escaping.
          const output = await withImportedSkillResources(scope.environment, scope.assertOwner, env => runImportedProcess({ command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
            args: process.platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
            windowsVerbatimArguments: process.platform === 'win32',
            cwd, env: importedProcessEnvironment(env), timeoutMs: 120_000,
            signal: extra.signal, assertOwner: scope.assertOwner }));
          return { content: [{ type: 'text', text: redactEnvironmentValues(output.stdout, importedContentRedactions(scope.environment)) }], isError: output.exitCode !== 0 };
        }
        // Resolve against the actual catalog; an arbitrary model-supplied name cannot choose a server.
        for (const connection of scope.environment.mcp.filter(connection => connection.enabled !== false && request.params.name.startsWith(`c_${fingerprint(connection.name).slice(0, 12)}_`))) {
          const secrets = connectionRedactions(connection, scope.environment.env);
          const result = await withImportedConnection(connection, scope.environment.env, scope.assertOwner, async client => {
            const tools = await listImportedTools(client);
            const tool = tools.find(item => toolName(connection.name, item.name, publicConnectionName(item.name, secrets)) === request.params.name);
            return tool ? client.callTool({ name: tool.name, arguments: restoreImportedArguments(request.params.arguments ?? {}, tool.inputSchema, secrets) }, undefined, { timeout: 120_000 }) : undefined;
          }, { identity: scope.identity, signal: extra.signal });
          if (result) return redactImportedResult(result, secrets);
        }
        throw new Error('Companion tool unavailable');
      });
      return { type: 'sdk', name: COMPANION_CONNECTIONS_MCP_NAME, instance: server };
    },
  };
}
