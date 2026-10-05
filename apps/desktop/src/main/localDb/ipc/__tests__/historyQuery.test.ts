import { describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_QUERY_CHANNEL, REMOTE_INVOKE_ALLOWLIST } from '@cindy/device-link';
import { createHistoryQueryHandler, registerHistoryQueryIpc } from '../historyQuery.js';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context.js';
import { listSessionsForHistory } from '../../chatHistoryReader.js';
import { searchChatHistoryHybrid } from '../../chatHistorySearch.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  },
}));
vi.mock('../../chatHistorySearch.js', () => ({ searchChatHistoryHybrid: vi.fn() }));
vi.mock('../../chatHistoryReader.js', () => ({
  listSessionsForHistory: vi.fn(),
  getMessagesForHistory: vi.fn(),
}));

function setup() {
  const listSessions = vi.fn(async () => ({
    ok: true as const,
    page: { items: [], nextCursor: { createdAt: 4, id: 'source-cursor' }, hasMore: true },
  }));
  const searchChatHistory = vi.fn(async () => ({
    ok: true as const,
    result: {
      hits: [],
      sessions: {},
      vectorUsed: false,
      vectorSkipReason: 'disabled',
      nextOffset: null,
      hasMore: false,
      poolSize: 0,
      poolCapped: false,
    },
  }));
  return {
    listSessions,
    searchChatHistory,
    execute: createHistoryQueryHandler({ listSessions, searchChatHistory }),
  };
}
describe('remote history query handler', () => {
  it('preserves listing filters and source cursor with the same MCP schema', async () => {
    const s = setup();
    const first = await s.execute({
      tool: 'list_sessions',
      args: { from: '2026-10-01', order: 'asc', limit: 3 },
    });
    expect(first).toMatchObject({ ok: true, hasMore: true, sessions: [] });
    expect(s.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMs: Date.parse('2026-10-01'),
        order: 'asc',
        limit: 3,
        cursor: null,
      }),
    );
    await s.execute({ tool: 'list_sessions', args: { cursor: first.nextCursor } });
    expect(s.listSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { createdAt: 4, id: 'source-cursor' } }),
    );
  });
  it('rejects unknown tools, recursive forwarding and invalid filters without querying', async () => {
    const s = setup();
    await expect(s.execute({ tool: 'get_chat_history', args: {} })).rejects.toThrow(
      'Unsupported history query',
    );
    await expect(s.execute({ tool: 'list_sessions', args: { device: 'all' } })).rejects.toThrow(
      'cannot forward',
    );
    for (const args of [{ limit: 1001 }, { from: 'invalid' }, { sessionIds: ['guess'] }]) {
      expect(await s.execute({ tool: 'list_sessions', args })).toMatchObject({
        ok: false,
        errorCode: 'INVALID_ARGS',
      });
    }
    expect(s.listSessions).not.toHaveBeenCalled();
  });
  it('searches on the source host and bounds context while marking truncated text', async () => {
    const s = setup();
    s.searchChatHistory.mockResolvedValueOnce({
      ok: true,
      result: {
        hits: [
          {
            messageId: 'm',
            sessionId: 's',
            role: 'user',
            createdAt: 1,
            snippet: 'found',
            score: 1,
            ftsRank: 1,
            vectorRank: null,
            vectorDistance: null,
            context: [
              {
                id: 'm',
                sessionId: 's',
                role: 'user',
                content: 'x'.repeat(3000),
                createdAt: 1,
                isHit: true,
                toolUseId: null,
                agentMeta: { private: 'metadata' },
                rewindAt: null,
              },
            ],
          },
        ],
        sessions: { s: { title: 'Found', workingDir: null, agentKind: 'codex' } },
        vectorUsed: false,
        vectorSkipReason: 'disabled',
        nextOffset: 1,
        hasMore: true,
        poolSize: 2,
        poolCapped: false,
      },
    } as any);
    const result = await s.execute({
      tool: 'search_chat_history',
      args: { query: 'found', session_ids: ['s'], context_radius: 1, limit: 1 },
    });
    expect(s.searchChatHistory).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'found', sessionIds: ['s'], contextRadius: 1, limit: 1 }),
    );
    expect(result).toMatchObject({ ok: true, hasMore: true, vector_used: false });
    const row = (result.hits as any[])[0].context[0];
    expect(row.content).toHaveLength(2000);
    expect(row.agentMeta).toEqual({ remoteContentTruncated: true });
  });
  it('registers a linked read-only channel and rejects local/guest IPC calls', async () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(DL_HISTORY_QUERY_CHANNEL)).toBe(true);
    registerHistoryQueryIpc();
    const handler = handlers.get(DL_HISTORY_QUERY_CHANNEL)!;
    await expect(handler({}, { tool: 'list_sessions', args: {} })).rejects.toThrow(
      'authorized device link',
    );
    await expect(
      runDeviceLinkInvokeContext(
        { controllerDeviceId: 'guest', channel: DL_HISTORY_QUERY_CHANNEL, sharedTask: {} as any },
        () => handler({}, {}),
      ),
    ).rejects.toThrow('authorized device link');
  });
  it('forces source-side visibility on both readers without accepting an override from the wire', async () => {
    vi.mocked(listSessionsForHistory).mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    vi.mocked(searchChatHistoryHybrid).mockResolvedValue({
      hits: [],
      sessions: {},
      hasMore: false,
      nextOffset: null,
      poolSize: 0,
      poolCapped: false,
      vectorUsed: false,
      vectorSkipReason: 'disabled',
    });
    registerHistoryQueryIpc();
    const handler = handlers.get(DL_HISTORY_QUERY_CHANNEL)!;
    for (const tool of ['list_sessions', 'search_chat_history']) {
      const invoke = (args: Record<string, unknown>) =>
        runDeviceLinkInvokeContext(
          { controllerDeviceId: 'owner', channel: DL_HISTORY_QUERY_CHANNEL },
          () => handler({}, { tool, args }),
        );
      const args = tool === 'list_sessions' ? {} : { query: 'needle' };
      expect(await invoke(args)).toMatchObject({ ok: true });
      expect(await invoke({ ...args, remoteVisibleOnly: false })).toMatchObject({
        ok: false,
        errorCode: 'INVALID_ARGS',
      });
    }
    expect(listSessionsForHistory).toHaveBeenCalledWith(
      expect.objectContaining({ remoteVisibleOnly: true }),
    );
    expect(searchChatHistoryHybrid).toHaveBeenCalledWith(
      expect.objectContaining({ remoteVisibleOnly: true }),
    );
  });
});
