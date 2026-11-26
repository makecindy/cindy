import { describe, expect, it, vi } from 'vitest';
import { readCodexThreadMcpServerTools, readCodexThreadMcpServersTools } from './mcp-server-tools.js';

type Page = { data: Array<Record<string, unknown>>; nextCursor: string | null };

function requestFor(pages: Record<string, Page>) {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    pages[String(params.cursor ?? 'first')]!);
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

  // Unit tier, production batch reader: native accepts only one serverName.
  // The existing selector fixture only paginated the gateway. Use the same
  // cursor for both healthy helper and failed gateway to catch cursor sharing.
  it('selects each gateway independently and keeps pagination scoped to that selector', async () => {
    const pages: Record<string, Record<string, Page>> = {
      cindy_helper: {
        first: { nextCursor: 'next', data: [] },
        next: { nextCursor: null, data: [{ name: 'cindy_helper', runtimeStatus: 'connected', tools: { list_tools: {}, call_tool: {} } }] },
      },
      cindy: {
        first: { nextCursor: 'next', data: [] },
        next: { nextCursor: null, data: [{ name: 'cindy', runtimeStatus: 'failed', tools: { ghost_info: {} } }] },
      },
      missing: { first: { nextCursor: null, data: [] } },
    };
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      pages[String(params.serverName)]![String(params.cursor ?? 'first')]!);
    const reports = await readCodexThreadMcpServersTools(request as Parameters<typeof readCodexThreadMcpServersTools>[0],
      'thread-1', ['cindy_helper', 'cindy', 'missing', 'cindy_helper']);
    expect(reports.get('cindy_helper')).toMatchObject({ state: 'connected' });
    expect(reports.get('cindy')).toEqual({ state: 'failed', tools: [] });
    expect(reports.get('missing')).toEqual({ state: 'not-mounted', tools: [] });
    expect(request.mock.calls.map(([, params]) => [params.threadId, params.serverName, params.cursor])).toEqual([
      ['thread-1', 'cindy_helper', null], ['thread-1', 'cindy', null], ['thread-1', 'missing', null],
      ['thread-1', 'cindy_helper', 'next'], ['thread-1', 'cindy', 'next'],
    ]);
  });

  it('reads each target from legacy pages that ignore the server selector', async () => {
    const { request, invoke } = requestFor({
      first: { nextCursor: 'next', data: [{ name: 'cindy_helper', runtimeStatus: 'connected', tools: { list_tools: {}, call_tool: {} } }] },
      next: { nextCursor: null, data: [{ name: 'cindy', runtimeStatus: 'failed', tools: { ghost_info: {} } }] },
    });
    const reports = await readCodexThreadMcpServersTools(invoke, 'thread-1', ['cindy_helper', 'cindy']);
    expect(reports.get('cindy_helper')).toMatchObject({ state: 'connected' });
    expect(reports.get('cindy')).toEqual({ state: 'failed', tools: [] });
    expect(request.mock.calls.map(([, params]) => [params.serverName, params.cursor])).toEqual([
      ['cindy_helper', null], ['cindy', null], ['cindy', 'next'],
    ]);
  });

  // Every selector shares the same deadline, including later pages. The
  // independent-selector fixture above does not exercise time or page bounds.
  // Unit tier, fake clock; no sockets or real waits.
  it('passes only the remaining batch budget to later selected pages', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const request = vi.fn(async (_method: string, params: Record<string, unknown>, _options: { timeoutMs: number }) => {
        vi.setSystemTime(Date.now() + (params.serverName === 'cindy_helper' ? 3_000 : 1_000));
        return params.serverName === 'cindy' && params.cursor === null
          ? { data: [], nextCursor: 'next' }
          : { data: [{ name: params.serverName, runtimeStatus: 'failed' }], nextCursor: null };
      });
      const reports = await readCodexThreadMcpServersTools(request as Parameters<typeof readCodexThreadMcpServersTools>[0],
        't', ['cindy_helper', 'cindy']);
      expect([...reports.values()].map(report => report.state)).toEqual(['failed', 'failed']);
      expect(request.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([5_000, 2_000, 1_000]);
      vi.setSystemTime(0);
      request.mockClear();
      await expect(readCodexThreadMcpServersTools(request as Parameters<typeof readCodexThreadMcpServersTools>[0],
        't', ['cindy_helper', 'cindy'], 3_000)).rejects.toThrow(/timed out/);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('caps each selected server at five pages and makes no requests for an empty batch', async () => {
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      data: [], nextCursor: params.serverName === 'cindy_helper' ? null : String(Number(params.cursor ?? 0) + 1),
    }));
    const invoke = request as Parameters<typeof readCodexThreadMcpServersTools>[0];
    expect(await readCodexThreadMcpServersTools(invoke, 't', [])).toEqual(new Map());
    expect(request).not.toHaveBeenCalled();
    await expect(readCodexThreadMcpServersTools(invoke, 't', ['cindy_helper', 'cindy'])).rejects.toThrow(/exceeded 5 pages/);
    expect(request.mock.calls.filter(([, params]) => params.serverName === 'cindy')).toHaveLength(5);
    expect(request.mock.calls.filter(([, params]) => params.serverName === 'cindy_helper')).toHaveLength(1);
  });
});
