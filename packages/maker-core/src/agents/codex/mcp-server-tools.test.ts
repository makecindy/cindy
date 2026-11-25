import { describe, expect, it, vi } from 'vitest';
import { readCodexThreadMcpServerTools, readCodexThreadMcpServersTools } from './mcp-server-tools.js';

type Page = { data: Array<Record<string, unknown>>; nextCursor: string | null };

function requestFor(pages: Record<string, Page>) {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    pages[`${params.serverName}:${params.cursor ?? 'first'}`] ?? pages[String(params.cursor ?? 'first')]!);
  return { request, invoke: request as Parameters<typeof readCodexThreadMcpServerTools>[0] };
}

describe('Codex thread MCP server tools', () => {
  // Supplier helper outage 2026-11-18: a fresh catalog is not an exact ready
  // thread client. Unit tier; prior tests only covered runtimes without state.
  it.each([
    ['failed', 'failed'], ['starting', 'pending'], ['notStarted', 'pending'],
    ['authenticationRequired', 'needs-auth'], ['cancelled', 'disabled'], ['disabled', 'disabled'],
    ['future-native-state', 'pending'],
  ])('honors native %s despite tools returned by catalog discovery', async (runtimeStatus, state) => {
    const { invoke } = requestFor({ first: { nextCursor: null, data: [{
      name: 'cindy_helper', runtimeStatus, tools: { list_tools: {}, call_tool: {} },
    }] } });
    expect(await readCodexThreadMcpServerTools(invoke, 'thread-1', 'cindy_helper')).toEqual({ state, tools: [] });
  });

  // #11380: explicit null after a config change has no exact runtime yet.
  // Unit tier, production reader; missing-field legacy coverage below does
  // not cover null with a stale or empty catalog, which must stay unready.
  it.each([{ list_tools: {}, call_tool: {} }, {}])('keeps explicit null pending regardless of catalog %j', async tools => {
    const { invoke } = requestFor({ first: { nextCursor: null, data: [{
      name: 'cindy_helper', runtimeStatus: null, tools,
    }] } });
    expect(await readCodexThreadMcpServerTools(invoke, 'thread-1', 'cindy_helper'))
      .toEqual({ state: 'pending', tools: [] });
  });

  it('reads the caller thread status, not the shared host list', async () => {
    const { request, invoke } = requestFor({ first: { nextCursor: null, data: [
      { name: 'custom_omc', authStatus: 'bearerToken', tools: {
        search: { name: 'search', description: 'Search OMC', inputSchema: {} },
        open: { name: 'open', inputSchema: {} },
      } },
    ] } });
    expect(await readCodexThreadMcpServerTools(invoke, 'thread-1', 'custom_omc')).toEqual({
      state: 'connected',
      tools: [{ name: 'search', description: 'Search OMC', inputSchema: {} }, { name: 'open', inputSchema: {} }],
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

  // Gateway recovery must see a failed plugin client even beside a healthy
  // helper, without unscoped native discovery or confusing missing legacy state.
  // Unit tier, production reader; each selected server owns its pagination cursor.
  it('reads independent gateway states through selected-server requests', async () => {
    const { request, invoke } = requestFor({
      'cindy_helper:first': { nextCursor: null, data: [{ name: 'cindy_helper', runtimeStatus: 'connected', tools: { list_tools: {}, call_tool: {} } }] },
      'cindy:first': { nextCursor: 'next', data: [] },
      'cindy:next': { nextCursor: null, data: [{ name: 'cindy', runtimeStatus: 'failed', tools: { ghost_info: {} } }] },
      'missing:first': { nextCursor: null, data: [] },
    });
    const reports = await readCodexThreadMcpServersTools(invoke, 'thread-1', ['cindy_helper', 'cindy', 'missing']);
    expect(reports.get('cindy_helper')).toMatchObject({ state: 'connected' });
    expect(reports.get('cindy')).toEqual({ state: 'failed', tools: [] });
    expect(reports.get('missing')).toEqual({ state: 'not-mounted', tools: [] });
    expect(request.mock.calls.map(([, params]) => [params.serverName, params.cursor])).toEqual([
      ['cindy_helper', null], ['cindy', null], ['cindy', 'next'], ['missing', null],
    ]);
  });

  // #12627 + ea2df3b merge regression: selected requests must still share the
  // original total deadline. Unit tier; advancing Date.now avoids real waits.
  it.each([2_000, 5_000])('shares the deadline across selected servers after %d ms', async elapsed => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = vi.fn(async (_method: string, params: Record<string, unknown>, _opts: { timeoutMs: number }) => {
      now += elapsed;
      return { data: [{ name: params.serverName, runtimeStatus: 'connected', tools: { list_tools: {} } }], nextCursor: null };
    });
    try {
      const read = readCodexThreadMcpServersTools(request as Parameters<typeof readCodexThreadMcpServerTools>[0],
        'thread-1', ['cindy_helper', 'cindy_helper', 'cindy']);
      if (elapsed === 5_000) {
        await expect(read).rejects.toThrow('timed out');
        expect(request.mock.calls.map(([, params]) => params.serverName)).toEqual(['cindy_helper']);
      } else {
        expect([...(await read).keys()]).toEqual(['cindy_helper', 'cindy']);
        expect(request.mock.calls.map(([, , opts]) => opts.timeoutMs)).toEqual([5_000, 3_000]);
      }
    } finally { clock.mockRestore(); }
  });

  // Keep the existing five-page cap global, rather than granting each server
  // a new budget. Minimal unit input: the first target consumes all five pages.
  it('shares the page budget across selected servers', async () => {
    let pages = 0;
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      pages++;
      return pages === 5
        ? { data: [{ name: params.serverName, tools: { list_tools: {} } }], nextCursor: null }
        : { data: [], nextCursor: String(pages) };
    });
    await expect(readCodexThreadMcpServersTools(request as Parameters<typeof readCodexThreadMcpServerTools>[0],
      'thread-1', ['cindy_helper', 'cindy'])).rejects.toThrow('exceeded 5 pages');
    expect(request.mock.calls.map(([, params]) => params.serverName)).toEqual(Array(5).fill('cindy_helper'));
  });
});
