import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { isFrozenMcpServerAllowed } from './codexBuiltinToolPolicy.js';

type Invoke = NonNullable<XdtHelperMcpDeps['mcpGateway']>;
/** Per-call facade: never reuse another task's credentials, policy or connection.
 * The provider is resolved live. Its normal App facade retains owner/revision checks,
 * schema validation, model visibility, result filtering and App-card delivery.
 */
export function createLiveMcpGateway(deps: {
  resolve(context: Parameters<Invoke>[0], server: string): {
    create(context: McpProviderContext): unknown;
    isCurrent(): boolean;
  } | null;
}): Invoke {
  return async (context, request, signal) => {
    const failure = (code: string) => ({ isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, errorCode: code }) }] });
    if (!context.sessionId || !context.sessionInstanceId || context.remoteHostId || context.mcpCallerKind !== 'root'
      || !/^custom_[a-z0-9_-]{1,33}$/.test(request.server)
      || !isFrozenMcpServerAllowed(context.vendorOptions, request.server)) return failure('MCP_GATEWAY_NOT_ALLOWED');
    const entry = deps.resolve(context, request.server);
    if (!entry?.isCurrent()) return failure('MCP_GATEWAY_UNAVAILABLE');
    const assertCurrent = () => { signal?.throwIfAborted(); if (!entry.isCurrent()) throw new Error('MCP_GATEWAY_STALE'); };
    let config: { type?: string; instance?: McpServer } | null;
    try {
      assertCurrent();
      config = entry.create({ ...context, agentKind: context.agentKind as McpProviderContext['agentKind'],
      getSessionContext: () => { assertCurrent(); return context as McpProviderContext; } }) as typeof config;
    } catch {
      return failure(signal?.aborted ? 'MCP_GATEWAY_CANCELLED' : 'MCP_GATEWAY_UNAVAILABLE');
    }
    if (config?.type !== 'sdk' || !config.instance) return failure('MCP_GATEWAY_UNAVAILABLE');
    const server = config.instance;
    const client = new Client({ name: 'cindy-task-mcp', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const close = () => { void client.close().catch(() => {}); void server.close().catch(() => {}); };
    signal?.addEventListener('abort', close, { once: true });
    try {
      assertCurrent();
      await Promise.all([server.connect(st), client.connect(ct, { signal, timeout: 15_000 })]);
      assertCurrent();
      if (request.action === 'list') {
        const result = await client.listTools(request.cursor ? { cursor: request.cursor } : {}, { signal, timeout: 15_000 });
        assertCurrent();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, server: request.server, ...result }) }] };
      }
      // Native helper approval has already reviewed this exact server/tool/arguments.
      // The existing facade enforces the current upstream schema and model visibility.
      const result = await client.callTool({ name: request.tool, arguments: request.arguments }, undefined,
        { signal, timeout: 120_000 });
      assertCurrent();
      return result as Awaited<ReturnType<Invoke>>;
    } catch {
      return failure(signal?.aborted ? 'MCP_GATEWAY_CANCELLED' : 'MCP_GATEWAY_REQUEST_FAILED');
    } finally {
      signal?.removeEventListener('abort', close);
      await Promise.allSettled([client.close(), server.close()]);
    }
  };
}
