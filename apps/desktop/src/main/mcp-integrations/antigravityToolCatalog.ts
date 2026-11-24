import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCResultResponse, type JSONRPCMessage, type RequestId, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// agy ACP can evict the largest declarations entirely when its shared eager budget is full.
// See https://github.com/google-antigravity/antigravity-cli/issues/1530.
// Keep these entry points directly callable. Only the discovery response is shortened.
const entryPoints: Record<string, Record<string, string>> = {
  cindy_orca: {
    start_team: 'Start an Orca team.',
    create_worker: 'Create one Worker.',
    create_workers: 'Create multiple Workers with initial tasks.',
    list_available_models: 'List available Worker models.',
    send_to_worker: 'Send a message to a Worker.',
    set_worker_runtime: 'Change a Worker runtime.',
  },
  cindy: { ghost_info: 'Inspect a Cindy plugin.', ghost_call: 'Call a Cindy plugin tool.' },
  cindy_browser: { call_tool: 'Invoke a browser tool.' },
};

function parameterTypes(schema: Tool['inputSchema']) {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const type = property && typeof property === 'object' && 'type' in property ? property.type : undefined;
    return [name, type === 'array' ? { type, items: {} } : type ? { type } : {}];
  }));
}

class AntigravityCatalogTransport extends StreamableHTTPServerTransport {
  private readonly listing = new AsyncLocalStorage<RequestId>();
  private readonly definitions = new Map<string, Pick<Tool, 'name' | 'description' | 'inputSchema'>>();

  constructor(options: StreamableHTTPServerTransportOptions, server: McpServer, private readonly entries: Record<string, string>) {
    super(options);
    server.registerTool('describe_tool', {
      description: 'Read the full usage and input schema for a compact tool on this server.',
      inputSchema: { name: z.string() }, annotations: { readOnlyHint: true },
    }, ({ name }) => {
      const definition = this.definitions.get(name);
      return definition ? { content: [{ type: 'text', text: JSON.stringify(definition) }] }
        : { isError: true, content: [{ type: 'text', text: 'No compact declaration for this tool.' }] };
    });
  }

  // SDK handlers may run concurrently, including requests in the same JSON-RPC batch.
  // Bind the projection to the individual tools/list handler, never to tools/call output.
  override set onmessage(handler: Transport['onmessage']) {
    super.onmessage = handler && ((message, extra) => {
      if ('method' in message && message.method === 'tools/list' && 'id' in message) {
        return this.listing.run(message.id, () => handler(message, extra));
      }
      return handler(message, extra);
    });
  }
  override get onmessage(): Transport['onmessage'] { return super.onmessage; }

  override send(message: JSONRPCMessage, options?: TransportSendOptions) {
    const listId = this.listing.getStore();
    if (listId !== undefined && isJSONRPCResultResponse(message) && listId === message.id && Array.isArray(message.result.tools)) {
      const tools = message.result.tools.map((tool: Tool) => {
        if (!Object.hasOwn(this.entries, tool.name)) return tool;
        const { name, description, inputSchema } = tool;
        this.definitions.set(name, { name, description, inputSchema });
        return {
          ...tool, description: this.entries[name] + ' Read describe_tool for usage and parameters.',
          inputSchema: { type: 'object', properties: parameterTypes(inputSchema), required: inputSchema.required ?? [] },
        };
      });
      return super.send({ ...message, result: { ...message.result, tools } }, options);
    }
    return super.send(message, options);
  }
}

export function createCatalogTransport(
  clientName: string, serverName: string, server: McpServer, options: StreamableHTTPServerTransportOptions,
): StreamableHTTPServerTransport {
  return clientName === 'antigravity-client' && Object.hasOwn(entryPoints, serverName)
    ? new AntigravityCatalogTransport(options, server, entryPoints[serverName])
    : new StreamableHTTPServerTransport(options);
}
