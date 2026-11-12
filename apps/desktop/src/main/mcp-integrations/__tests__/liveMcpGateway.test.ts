// Unit: actual MCP SDK wire through the production gateway. Previously a new
// provider was invisible to a running Codex process. Cover late registration,
// stale task/account/provider identities, frozen mounts, cancellation and schema
// errors; no network or credentials. Existing native mount tests cannot cover this entry.
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLiveMcpGateway, isRecoverableMcpRejection } from '../liveMcpGateway.js';

const context = { agentKind: 'codex', workingDir: '/test', sessionId: 'task', sessionInstanceId: 'instance', mcpCallerKind: 'root' as const };
function fixture() {
  let current = true;
  let saved = false;
  let signature = 'config-1';
  const called = vi.fn(async ({ text }: { text: string }) => ({ content: [{ type: 'text' as const, text }] }));
  const resolve = vi.fn(() => saved ? { isCurrent: () => current, signature: () => signature, create: () => {
    const instance = new McpServer({ name: 'fixture', version: '1' });
    instance.registerTool('ping', { inputSchema: { text: z.string() } }, called);
    return { type: 'sdk', instance };
  } } : null);
  return { gateway: createLiveMcpGateway({ resolve }), resolve, called,
    save: () => { saved = true; }, invalidate: () => { current = false; },
    editConfig: () => { signature = 'config-2'; } };
}

/** The remote server keeps per-session state, like `Mcp-Session-Id`-bound databases. */
function statefulFixture(gate?: Promise<void>) {
  let signature = 'config-1';
  let created = 0;
  let resolveCalls = 0;
  const resolve = vi.fn(() => {
    resolveCalls += 1;
    return { isCurrent: () => true, signature: () => signature, create: () => {
      created += 1;
      let sessionCounter = 0;
      const instance = new McpServer({ name: 'stateful', version: '1' });
      instance.registerTool('increment', { inputSchema: {} }, async () => {
        sessionCounter += 1;
        return { content: [{ type: 'text' as const, text: String(sessionCounter) }] };
      });
      if (gate) {
        const connect = instance.connect.bind(instance);
        (instance as unknown as { connect: typeof connect }).connect = async (
          transport: Parameters<typeof connect>[0],
        ) => { await gate; return connect(transport); };
      }
      return { type: 'sdk', instance };
    } };
  });
  return { gateway: createLiveMcpGateway({ resolve }), resolve, created: () => created,
    resolveCalls: () => resolveCalls, editConfig: () => { signature = 'config-2'; } };
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
  it('keeps one upstream session across calls in the same task', async () => {
    const f = statefulFixture();
    const call = () => f.gateway(context, { action: 'call', server: 'custom_example', tool: 'increment', arguments: {} });
    expect(await call()).toMatchObject({ content: [{ type: 'text', text: '1' }] });
    // A second call must reach the same `Mcp-Session-Id` state, not a fresh session.
    expect(await call()).toMatchObject({ content: [{ type: 'text', text: '2' }] });
    expect(f.created()).toBe(1);
    // Registry refreshes hand back a new provider object each call; that is not a new server.
    expect(f.resolveCalls()).toBe(2);
  });
  it('shares one handshake when the same task calls a server concurrently', async () => {
    const f = statefulFixture();
    const call = () => f.gateway(context, { action: 'call', server: 'custom_example', tool: 'increment', arguments: {} });
    // Two first calls race before either handshake finishes; the losers must not leak.
    await Promise.all([call(), call(), call()]);
    expect(f.created()).toBe(1);
    expect(await call()).toMatchObject({ content: [{ type: 'text', text: '4' }] });
    expect(f.created()).toBe(1);
  });
  it("starts a new upstream session when this server's configuration changes", async () => {
    const f = statefulFixture();
    const call = () => f.gateway(context, { action: 'call', server: 'custom_example', tool: 'increment', arguments: {} });
    expect(await call()).toMatchObject({ content: [{ type: 'text', text: '1' }] });
    f.editConfig();
    expect(await call()).toMatchObject({ content: [{ type: 'text', text: '1' }] });
    expect(f.created()).toBe(2);
  });
  it('keeps the session when a rejection never reached the upstream server', async () => {
    const f = statefulFixture();
    const call = (tool: string) => f.gateway(context, { action: 'call', server: 'custom_example', tool, arguments: {} });
    expect(await call('increment')).toMatchObject({ content: [{ type: 'text', text: '1' }] });
    // Unknown tool names rejected by the facade are request-level: the transport is healthy.
    expect(await call('missing')).toMatchObject({ isError: true });
    expect(await call('increment')).toMatchObject({ content: [{ type: 'text', text: '2' }] });
    expect(f.created()).toBe(1);
  });
  it.each([
    [{ code: 'MCP_APP_TOOL_NOT_VISIBLE' }, true],
    [{ message: 'MCP error -32601: Method not found' }, true],
    [{ message: 'INVALID_ARGS: tool arguments rejected' }, true],
    [new Error('socket hang up'), false],
    [Object.assign(new Error('boom'), { code: 'ECONNRESET' }), false],
    [undefined, false],
  ])('classifies %j as recoverable=%s', (error, expected) => {
    expect(isRecoverableMcpRejection(error)).toBe(expected);
  });
  it('does not join a handshake started under an older configuration', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = statefulFixture(gate);
    const call = () => f.gateway(context, { action: 'call', server: 'custom_example', tool: 'increment', arguments: {} });
    const first = call();
    // Config changes while the first handshake is still in flight.
    f.editConfig();
    const second = call();
    release();
    await first.catch(() => undefined);
    // The newer request must not inherit the stale session; it opens its own.
    expect(await second).toMatchObject({ content: [{ type: 'text', text: '1' }] });
    expect(f.created()).toBe(2);
  });
  it('never reaps a connection while one of its calls is still in flight', async () => {
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    let created = 0;
    const resolve = vi.fn(() => ({ isCurrent: () => true, signature: () => 'config-1', create: () => {
      created += 1;
      const instance = new McpServer({ name: 'slow', version: '1' });
      instance.registerTool('wait', { inputSchema: {} }, async () => {
        await slow;
        return { content: [{ type: 'text' as const, text: 'done' }] };
      });
      return { type: 'sdk', instance };
    } }));
    // A 1ms idle window would reap the session if in-flight work did not protect it.
    const gateway = createLiveMcpGateway({ resolve, idleMs: 1 });
    const pending = gateway(context, { action: 'call', server: 'custom_example', tool: 'wait', arguments: {} });
    await new Promise(resolveTimer => setTimeout(resolveTimer, 30));
    release();
    expect(await pending).toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    expect(created).toBe(1);
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
