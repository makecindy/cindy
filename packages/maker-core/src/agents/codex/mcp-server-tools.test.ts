import { describe, expect, it, vi } from 'vitest';
import { readCodexThreadMcpServerTools } from './mcp-server-tools.js';

type Page = { data: Array<Record<string, unknown>>; nextCursor: string | null };

function requestFor(pages: Record<string, Page>) {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    pages[String(params.cursor ?? 'first')]!);
  return { request, invoke: request as Parameters<typeof readCodexThreadMcpServerTools>[0] };
}

describe('Codex thread MCP server tools', () => {
  it('reads the caller thread status, not the shared host list', async () => {
    const { request, invoke } = requestFor({ first: { nextCursor: null, data: [
      { name: 'custom_omc', authStatus: 'bearerToken', tools: {
        search: { name: 'search', description: 'Search OMC', inputSchema: {} },
        open: { name: 'open', inputSchema: {} },
      } },
    ] } });
    expect(await readCodexThreadMcpServerTools(invoke, 'thread-1', 'custom_omc')).toEqual({
      state: 'connected',
      tools: [{ name: 'search', description: 'Search OMC' }, { name: 'open' }],
    });
    expect(request).toHaveBeenCalledWith('mcpServerStatus/list',
      { cursor: null, limit: 100, detail: 'toolsAndAuthOnly', threadId: 'thread-1', serverName: 'custom_omc' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it('keeps a configured server without tools distinct from one the thread never mounted', async () => {
    const { invoke } = requestFor({ first: { nextCursor: 'next', data: [
      { name: 'custom_omc', authStatus: 'unsupported', tools: {} },
      { name: 'oauth_server', authStatus: 'notLoggedIn', tools: {} },
    ] }, next: { nextCursor: null, data: [{ name: 'other', tools: { a: {} } }] } });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'custom_omc'))
      .toEqual({ state: 'no-tools', tools: [] });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'oauth_server'))
      .toEqual({ state: 'needs-auth', tools: [] });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'missing'))
      .toEqual({ state: 'not-mounted', tools: [] });
  });

  it('rejects a repeating cursor instead of looping', async () => {
    const { invoke } = requestFor({
      first: { nextCursor: 'a', data: [] },
      a: { nextCursor: 'a', data: [] },
    });
    await expect(readCodexThreadMcpServerTools(invoke, 't', 'custom_omc')).rejects.toThrow(/repeated a cursor/);
  });

  it.each([
    ['notStarted', 'pending'], ['starting', 'pending'],
    ['failed', 'failed'], ['cancelled', 'failed'],
    ['authenticationRequired', 'needs-auth'], ['disabled', 'disabled'],
  ])('does not expose cached tools while runtime is %s', async (runtimeStatus, state) => {
    const { invoke } = requestFor({ first: { nextCursor: null, data: [
      { name: 'custom_omc', runtimeStatus, tools: { search: {} } },
    ] } });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'custom_omc'))
      .toEqual({ state, tools: [] });
  });

  it.each(['connected', null])('does not expose cached tools after discovery fails with runtime %s', async (runtimeStatus) => {
    const { invoke } = requestFor({ first: { nextCursor: null, data: [
      { name: 'custom_omc', runtimeStatus, toolsError: 'secret endpoint', tools: { search: {} } },
    ] } });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'custom_omc'))
      .toEqual({ state: 'failed', tools: [] });
  });

  it.each([{}, { search: { description: 'Cached tool' } }])(
    'keeps an explicitly unknown runtime pending regardless of its cached tools', async (tools) => {
      const { invoke } = requestFor({ first: { nextCursor: null, data: [
        { name: 'custom_omc', runtimeStatus: null, toolsError: null, tools },
      ] } });
      expect(await readCodexThreadMcpServerTools(invoke, 't', 'custom_omc'))
        .toEqual({ state: 'pending', tools: [] });
    },
  );

  it('reports a connected runtime with an empty catalog as no-tools', async () => {
    const { invoke } = requestFor({ first: { nextCursor: null, data: [
      { name: 'custom_omc', runtimeStatus: 'connected', toolsError: null, tools: {} },
    ] } });
    expect(await readCodexThreadMcpServerTools(invoke, 't', 'custom_omc'))
      .toEqual({ state: 'no-tools', tools: [] });
  });
});
