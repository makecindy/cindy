import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  select: vi.fn(),
}));

const embeddingMocks = vi.hoisted(() => ({
  embedSync: vi.fn(),
}));

vi.mock('../client/current', () => ({
  getDbClient: () => ({
    vecAvailable: true,
    query: dbMocks.query,
    queryOne: dbMocks.queryOne,
    drizzle: {
      select: dbMocks.select,
    },
  }),
}));

vi.mock('../../embedding-host', () => ({
  getEmbeddingService: () => embeddingMocks,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-test-user-data'),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { searchChatHistoryHybrid } from '../chatHistorySearch';
import { setChatEmbeddingEnabled } from '../../embedders/chat-history-embedder';

describe('searchChatHistoryHybrid', () => {
  beforeEach(() => {
    dbMocks.query.mockReset();
    dbMocks.queryOne.mockReset();
    dbMocks.select.mockReset();
    embeddingMocks.embedSync.mockReset();
    setChatEmbeddingEnabled(true);
  });

  it('skips vector probing and embedding when requested', async () => {
    dbMocks.query.mockResolvedValue([]);

    const result = await searchChatHistoryHybrid({
      query: 'billing',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 10,
      offset: 0,
      skipVector: true,
    });

    expect(dbMocks.query).toHaveBeenCalledTimes(1);
    expect(dbMocks.queryOne).not.toHaveBeenCalled();
    expect(embeddingMocks.embedSync).not.toHaveBeenCalled();
    expect(result.vectorUsed).toBe(false);
    expect(result.vectorSkipReason).toBe('本次请求已禁用语义检索, 仅用 FTS。');
  });

  it('skips chat vector search when its runtime consumer is disabled', async () => {
    setChatEmbeddingEnabled(false);
    dbMocks.query.mockResolvedValue([]);
    dbMocks.queryOne.mockResolvedValue({ rowid: 1 });

    const result = await searchChatHistoryHybrid({
      query: 'billing',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 10,
      offset: 0,
    });

    expect(dbMocks.query).toHaveBeenCalledTimes(1);
    expect(dbMocks.queryOne).not.toHaveBeenCalled();
    expect(embeddingMocks.embedSync).not.toHaveBeenCalled();
    expect(result.vectorUsed).toBe(false);
    expect(result.vectorSkipReason).toBe('聊天记录语义索引未启用, 本次仅用 FTS 全文检索。');
  });

  it('short-circuits before both arms when the workdir filter matches no stored directory', async () => {
    // resolveStoredWorkingDirCandidates 的 distinct 扫描返回空 → 库里没有该目录任何拼写
    dbMocks.query.mockResolvedValue([]);

    const result = await searchChatHistoryHybrid({
      query: 'billing',
      sessionIds: null,
      workdir: 'D:/absent-project',
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 10,
      offset: 0,
    });

    // 只允许候选解析那一次 DB 查询;FTS arm、vec 探针、query embedding 都不该发生
    expect(dbMocks.query).toHaveBeenCalledTimes(1);
    expect(dbMocks.queryOne).not.toHaveBeenCalled();
    expect(embeddingMocks.embedSync).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.vectorUsed).toBe(false);
    expect(result.vectorSkipReason).toBe('workdir 过滤在历史库中无匹配目录, 已短路跳过检索。');
  });

  it('hydrates every radius-zero anchor with one batch query', async () => {
    dbMocks.query.mockResolvedValue([
      { messageId: 'm1', sessionId: 's1', role: 'user', createdAt: 1_000, snippet: 'first' },
      { messageId: 'm2', sessionId: 's1', role: 'assistant', createdAt: 2_000, snippet: 'second' },
    ]);
    const anchorRows = [
      {
        id: 'm1',
        clientId: 'c1',
        sessionId: 's1',
        role: 'user',
        content: JSON.stringify('first'),
        toolUseId: null,
        agentMeta: null,
        createdAt: 1_000,
        rewindAt: null,
      },
      {
        id: 'm2',
        clientId: 'c2',
        sessionId: 's1',
        role: 'assistant',
        content: JSON.stringify('second'),
        toolUseId: null,
        agentMeta: null,
        createdAt: 2_000,
        rewindAt: null,
      },
    ];
    dbMocks.select.mockImplementation((selection?: unknown) => ({
      from: () => ({
        where: () => Promise.resolve(selection ? [] : anchorRows),
      }),
    }));

    const result = await searchChatHistoryHybrid({
      query: 'message',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 10,
      offset: 0,
      skipVector: true,
    });

    expect(dbMocks.select.mock.calls.filter(([selection]) => selection === undefined)).toHaveLength(
      1,
    );
    expect(result.hits.map((hit) => hit.context.map((item) => item.id))).toEqual([['m1'], ['m2']]);
  });

  it('keeps a radius-zero hit when its anchor row is missing', async () => {
    dbMocks.query.mockResolvedValue([
      { messageId: 'm1', sessionId: 's1', role: 'user', createdAt: 1_000, snippet: 'first' },
      { messageId: 'm2', sessionId: 's1', role: 'assistant', createdAt: 2_000, snippet: 'second' },
    ]);
    dbMocks.select.mockImplementation((selection?: unknown) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            selection
              ? []
              : [
                  {
                    id: 'm1',
                    clientId: 'c1',
                    sessionId: 's1',
                    role: 'user',
                    content: JSON.stringify('first'),
                    toolUseId: null,
                    agentMeta: null,
                    createdAt: 1_000,
                    rewindAt: null,
                  },
                ],
          ),
      }),
    }));

    const result = await searchChatHistoryHybrid({
      query: 'message',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 10,
      offset: 0,
      skipVector: true,
    });

    expect(result.hits.map((hit) => [hit.messageId, hit.context.length])).toEqual([
      ['m1', 1],
      ['m2', 0],
    ]);
  });

  it('keeps the per-hit context window queries when radius is positive', async () => {
    dbMocks.query.mockResolvedValue([
      { messageId: 'm2', sessionId: 's1', role: 'assistant', createdAt: 2_000, snippet: 'anchor' },
    ]);
    const rows = {
      before: {
        id: 'm1',
        clientId: 'c1',
        sessionId: 's1',
        role: 'user',
        content: JSON.stringify('before'),
        toolUseId: null,
        agentMeta: null,
        createdAt: 1_000,
        rewindAt: null,
      },
      anchor: {
        id: 'm2',
        clientId: 'c2',
        sessionId: 's1',
        role: 'assistant',
        content: JSON.stringify('anchor'),
        toolUseId: null,
        agentMeta: null,
        createdAt: 2_000,
        rewindAt: null,
      },
      after: {
        id: 'm3',
        clientId: 'c3',
        sessionId: 's1',
        role: 'user',
        content: JSON.stringify('after'),
        toolUseId: null,
        agentMeta: null,
        createdAt: 3_000,
        rewindAt: null,
      },
    };
    let messageSelectCount = 0;
    dbMocks.select.mockImplementation((selection?: unknown) => {
      if (selection) {
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      }
      messageSelectCount += 1;
      const resultRows =
        messageSelectCount === 1
          ? [rows.anchor]
          : messageSelectCount === 2
            ? [rows.before]
            : [rows.after];
      return {
        from: () => ({
          where: () =>
            messageSelectCount === 1
              ? { limit: () => Promise.resolve(resultRows) }
              : { orderBy: () => ({ limit: () => Promise.resolve(resultRows) }) },
        }),
      };
    });

    const result = await searchChatHistoryHybrid({
      query: 'anchor',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 1,
      limit: 10,
      offset: 0,
      skipVector: true,
    });

    expect(messageSelectCount).toBe(3);
    expect(result.hits[0].context.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('can page beyond the default FTS pool for conversation search', async () => {
    const ftsRows = Array.from({ length: 51 }, (_, index) => ({
      messageId: `m${index + 1}`,
      sessionId: index < 50 ? 's1' : 's2',
      role: 'user',
      createdAt: 1_000 + index,
      snippet: `billing ${index + 1}`,
    }));
    dbMocks.query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const limit = Number(params.at(-1));
      return ftsRows.slice(0, limit);
    });
    dbMocks.select.mockImplementation((selection?: unknown) => ({
      from: () => ({
        where: () => {
          if (selection) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: 'm51',
              clientId: 'c51',
              sessionId: 's2',
              role: 'user',
              content: JSON.stringify('billing 51'),
              toolUseId: null,
              agentMeta: null,
              createdAt: 1_050,
              rewindAt: null,
            },
          ]);
        },
      }),
    }));

    const result = await searchChatHistoryHybrid({
      query: 'billing',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 50,
      offset: 50,
      skipVector: true,
      ftsPoolLimit: 51,
      fusePoolLimit: 51,
    });

    expect(dbMocks.query).toHaveBeenCalledTimes(1);
    expect(dbMocks.query.mock.calls[0][0]).toContain('substr(m.content, 1, ?)');
    expect(dbMocks.query.mock.calls[0][1][0]).toBe(16_384);
    expect(dbMocks.query.mock.calls[0][1].at(-1)).toBe(51);
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['s2']);
    expect(result.nextOffset).toBeNull();
  });

  it('can page beyond the default vector pool for conversation search', async () => {
    const vectorRows = Array.from({ length: 51 }, (_, index) => ({
      messageId: `m${index + 1}`,
      sessionId: index < 50 ? 's1' : 's2',
      role: 'user',
      createdAt: 1_000 + index,
      distance: index,
    }));
    dbMocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('messages_fts')) return [];
      const limit = Number(params.at(-1));
      return vectorRows.slice(0, limit);
    });
    dbMocks.queryOne.mockResolvedValue({ rowid: 1 });
    embeddingMocks.embedSync.mockResolvedValue({ embeddings: [[0.1, 0.2]] });
    dbMocks.select.mockImplementation((selection?: unknown) => ({
      from: () => ({
        where: () => {
          if (selection) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: 'm51',
              clientId: 'c51',
              sessionId: 's2',
              role: 'user',
              content: JSON.stringify('semantic 51'),
              toolUseId: null,
              agentMeta: null,
              createdAt: 1_050,
              rewindAt: null,
            },
          ]);
        },
      }),
    }));

    const result = await searchChatHistoryHybrid({
      query: 'semantic',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 50,
      offset: 50,
      vectorPoolLimit: 51,
      fusePoolLimit: 51,
    });

    expect(dbMocks.query).toHaveBeenCalledTimes(2);
    expect(dbMocks.query.mock.calls[1][1].at(-1)).toBe(51);
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['s2']);
    expect(result.nextOffset).toBeNull();
  });

  it('reuses query embeddings across paged conversation search calls', async () => {
    const vectorRows = [
      {
        messageId: 'm1',
        sessionId: 's1',
        role: 'user',
        createdAt: 1_000,
        distance: 1,
      },
      {
        messageId: 'm2',
        sessionId: 's2',
        role: 'user',
        createdAt: 2_000,
        distance: 2,
      },
    ];
    dbMocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('messages_fts')) return [];
      const limit = Number(params.at(-1));
      return vectorRows.slice(0, limit);
    });
    dbMocks.queryOne.mockResolvedValue({ rowid: 1 });
    embeddingMocks.embedSync.mockResolvedValue({ embeddings: [[0.1, 0.2]] });
    dbMocks.select.mockImplementation((selection?: unknown) => ({
      from: () => ({
        where: () => {
          if (selection) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: 'm1',
              clientId: 'c1',
              sessionId: 's1',
              role: 'user',
              content: JSON.stringify('semantic'),
              toolUseId: null,
              agentMeta: null,
              createdAt: 1_000,
              rewindAt: null,
            },
          ]);
        },
      }),
    }));
    const queryEmbeddingCache = new Map<string, number[]>();
    const baseArgs = {
      query: 'semantic',
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: null,
      contextRadius: 0,
      limit: 1,
      vectorPoolLimit: 2,
      fusePoolLimit: 2,
      queryEmbeddingCache,
    } as const;

    await searchChatHistoryHybrid({ ...baseArgs, offset: 0 });
    await searchChatHistoryHybrid({ ...baseArgs, offset: 1 });

    expect(embeddingMocks.embedSync).toHaveBeenCalledTimes(1);
    expect(dbMocks.query).toHaveBeenCalledTimes(4);
  });
});
