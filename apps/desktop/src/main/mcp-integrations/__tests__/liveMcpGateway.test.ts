// Unit: actual MCP SDK wire through the production gateway. Previously a new
// provider was invisible to a running Codex process. Cover late registration,
// stale task/account/provider identities, frozen mounts, cancellation and schema
// errors; no network or credentials. Existing native mount tests cannot cover this entry.
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLiveMcpGateway } from '../liveMcpGateway.js';

const context = { agentKind: 'codex', workingDir: '/test', sessionId: 'task', sessionInstanceId: 'instance', mcpCallerKind: 'root' as const };
function fixture() {
  let current = true;
  let saved = false;
  const called = vi.fn(async ({ text }: { text: string }) => ({ content: [{ type: 'text' as const, text }] }));
  const resolve = vi.fn(() => saved ? { isCurrent: () => current, create: () => {
    const instance = new McpServer({ name: 'fixture', version: '1' });
    instance.registerTool('ping', { inputSchema: { text: z.string() } }, called);
    return { type: 'sdk', instance };
  } } : null);
  return { gateway: createLiveMcpGateway({ resolve }), resolve, called,
    save: () => { saved = true; }, invalidate: () => { current = false; } };
}
const payload = (result: { content: Array<{ type: string; [key: string]: unknown }> }) => JSON.parse(result.content[0].text as string);

describe('stable live MCP entry', () => {
  it.each(['codex', 'claude-code', 'pi'])('discovers and invokes a provider saved after %s gateway startup', async agentKind => {
    const f = fixture();
    const ctx = { ...context, agentKind };
    expect(payload(await f.gateway(ctx, { action: 'list', server: 'custom_example' }))).toMatchObject({ errorCode: 'MCP_GATEWAY_UNAVAILABLE' });
    f.save();
    const listed = payload(await f.gateway(ctx, { action: 'list', server: 'custom_example' }));
    expect(listed.tools).toEqual([expect.objectContaining({ name: 'ping', inputSchema: expect.objectContaining({ required: ['text'] }) })]);
    expect(f.called).not.toHaveBeenCalled();
    expect(await f.gateway(ctx, { action: 'call', server: 'custom_example', tool: 'ping', arguments: { text: 'pong' } }))
      .toMatchObject({ content: [{ type: 'text', text: 'pong' }] });
    expect(f.called).toHaveBeenCalledOnce();
  });
  it.each([
    { remoteHostId: 'another-computer' }, { sessionInstanceId: undefined }, { mcpCallerKind: 'descendant' as const },
    { vendorOptions: { __cindyAllowedBuiltinPluginIds: [], cindyRuntimeMcpServerNames: [] } },
  ])('denies a caller outside its local live mount scope: %j', async patch => {
    const f = fixture(); f.save();
    expect(payload(await f.gateway({ ...context, ...patch }, { action: 'list', server: 'custom_example' })))
      .toMatchObject({ errorCode: 'MCP_GATEWAY_NOT_ALLOWED' });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('rejects stale sessions and builtins before any upstream call', async () => {
    const f = fixture(); f.save(); f.invalidate();
    expect(payload(await f.gateway(context, { action: 'list', server: 'custom_example' })))
      .toMatchObject({ errorCode: 'MCP_GATEWAY_UNAVAILABLE' });
    expect(payload(await f.gateway(context, { action: 'list', server: 'cindy_helper' })))
      .toMatchObject({ errorCode: 'MCP_GATEWAY_NOT_ALLOWED' });
    expect(f.called).not.toHaveBeenCalled();
  });
  it('validates the actual server schema and preserves its error result', async () => {
    const f = fixture(); f.save();
    expect(await f.gateway(context, { action: 'call', server: 'custom_example', tool: 'ping', arguments: { text: 2 } }))
      .toMatchObject({ isError: true });
    expect(f.called).not.toHaveBeenCalled();
  });
  it('does not start a cancelled call or return data after task invalidation', async () => {
    const f = fixture(); f.save();
    const abort = new AbortController(); abort.abort();
    expect(payload(await f.gateway(context, { action: 'list', server: 'custom_example' }, abort.signal)))
      .toMatchObject({ errorCode: 'MCP_GATEWAY_CANCELLED' });
    f.called.mockImplementationOnce(async () => { f.invalidate(); return { content: [{ type: 'text', text: 'private result' }] }; });
    const result = await f.gateway(context, { action: 'call', server: 'custom_example', tool: 'ping', arguments: { text: 'x' } });
    expect(payload(result)).toMatchObject({ errorCode: 'MCP_GATEWAY_REQUEST_FAILED' });
    expect(JSON.stringify(result)).not.toContain('private result');
  });
});
