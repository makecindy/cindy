import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { pluginToolVisible, type GhostToolDecl, type GhostUiNeeds } from '@cindy/plugin-protocol';
import { consumePluginPageTicket, type PluginPageCall } from './pluginPageCall.js';

export const PLUGIN_PAGE_TICKET = 'cindy/plugin-page-ticket';
export function pluginAppTool(_instance: string, tool: GhostToolDecl, ui: GhostUiNeeds): Tool {
  const link = ui.tools[tool.name];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.parameters, type: 'object' },
    _meta: {
      ui: link ? { ...link } : { visibility: ['model'] },
    },
  };
}
/** Ordinary MCP server, exclusively in Main. Views speak the unmodified MCP Apps protocol. */
export function createPluginAppTransport(options: {
  instance: string;
  revision: string;
  tools: GhostToolDecl[];
  ui: GhostUiNeeds;
  hosts?: string[];
  assertCurrent(): void;
  readHtml(html: string): string;
  call(
    grant: PluginPageCall,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
}) {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: options.instance, version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  const resources = options.ui.resources;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    options.assertCurrent();
    return {
      tools: options.tools.map((tool) => pluginAppTool(options.instance, tool, options.ui)),
    };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    options.assertCurrent();
    return {
      resources: resources.map(({ uri }) => ({ uri, name: uri, mimeType: RESOURCE_MIME_TYPE })),
    };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    options.assertCurrent();
    const resource = resources.find((resource) => resource.uri === params.uri);
    if (!resource) throw new Error('MCP_APP_RESOURCE_NOT_FOUND');
    const text = options.readHtml(resource.file);
    options.assertCurrent();
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text,
          _meta: {
            ui: {
              ...(resource.csp !== undefined ? { csp: resource.csp } : {}),
              ...(resource.prefersBorder !== undefined ? { prefersBorder: resource.prefersBorder } : {}),
              ...(resource.domain !== undefined ? { domain: resource.domain } : {}),
              ...(resource.permissions !== undefined ? { permissions: resource.permissions } : {}),
            },
          },
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    options.assertCurrent();
    const tool = options.tools.find((tool) => tool.name === params.name);
    if (
      !tool ||
      !pluginToolVisible(
        { mcpApps: { ui: options.ui }, tools: options.tools, network: { hosts: options.hosts ?? [] } },
        tool.name,
        'app',
      )
    )
      throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
    return consumePluginPageTicket(
      params._meta?.[PLUGIN_PAGE_TICKET],
      options.instance,
      options.revision,
      tool.name,
      (grant) => options.call(grant, params.arguments ?? {}, extra.signal),
    );
  });
  void server.connect(transport).catch((error) => client.onerror?.(error));
  return client;
}
