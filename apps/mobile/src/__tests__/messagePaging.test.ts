import { describe, expect, it } from 'vitest';
import {
  hasMoreOlderMessages,
  hasOlderMessagesAfterReopen,
  collectCompleteIncrementalMessages,
  hasOlderMessagesByServerCount,
  incrementalMessagePageNeedsFallback,
  latestMessageCursor,
  listMessagesWithPayloadRetry,
  MESSAGE_PAGE_SIZE,
  oldestMessageCursor,
  projectLoadedMessageWindow,
  projectLoadedMessageWindowIncrementally,
  shouldKeepOlderMessagesAffordance,
  shouldRefreshLatestMessageWindowOnReopen,
} from '@/session/messagePaging';
import type { RemoteMessage, RemoteSession } from '@/session/types';

function message(id: string, createdAt: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'assistant',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

function sessionVersion(patch: Partial<Pick<RemoteSession, '_count' | 'updatedAt'>> = {}): Pick<RemoteSession, '_count' | 'updatedAt'> {
  return {
    updatedAt: '2026-01-01T00:00:01.000Z',
    _count: { messages: 2 },
    ...patch,
  };
}

describe('messagePaging', () => {
  it('finds the oldest message id without relying on current array order', () => {
    expect(oldestMessageCursor([
      message('m3', '2026-01-01T00:00:03.000Z'),
      message('m1', '2026-01-01T00:00:01.000Z'),
      message('m2', '2026-01-01T00:00:02.000Z'),
    ])).toBe('m1');
  });

  it('finds the latest host cursor and skips local system cards', () => {
    expect(latestMessageCursor([
      message('m1', '2026-01-01T00:00:01.000Z'),
      message('mobile-system-context-1', '2026-01-01T00:00:03.000Z'),
      message('m2', '2026-01-01T00:00:02.000Z'),
    ])).toBe('m2');
  });

  it('uses the host rowid to choose a same-timestamp cursor', () => {
    const createdAt = '2026-01-01T00:00:01.000Z';
    expect(latestMessageCursor([
      { ...message('z-older', createdAt), rowid: 4 },
      { ...message('a-newer', createdAt), rowid: 5 },
    ])).toBe('a-newer');
  });

  it('returns null when no stable message id exists', () => {
    expect(oldestMessageCursor([
      { ...message('', '2026-01-01T00:00:01.000Z'), clientId: 'client-only' },
    ])).toBeNull();
  });

  describe('projectLoadedMessageWindow', () => {
    const compact = (id: string, createdAt: string): RemoteMessage => ({
      ...message(`mobile-system-compact:${id}`, createdAt),
      systemCardType: 'compact',
    });

    it('hides detached Compact cards older than the loaded host window', () => {
      const detached = compact('old', '2026-01-01T00:00:01.000Z');
      const rows = [
        detached,
        message('m10', '2026-01-01T00:00:10.000Z'),
        message('m11', '2026-01-01T00:00:11.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows).map((row) => row.id)).toEqual(['m10', 'm11']);
    });

    it('restores a Compact card when older host rows reach its time range', () => {
      const rows = [
        message('m0', '2026-01-01T00:00:00.000Z'),
        compact('in-window', '2026-01-01T00:00:01.000Z'),
        message('m2', '2026-01-01T00:00:02.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows)).toBe(rows);
    });

    it('collapses adjacent replay-time Compact cards to the latest boundary', () => {
      const rows = [
        message('m1', '2026-01-01T00:00:01.000Z'),
        compact('replay-1', '2026-01-01T00:00:10.000Z'),
        compact('replay-2', '2026-01-01T00:00:11.000Z'),
        compact('replay-3', '2026-01-01T00:00:12.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows).map((row) => row.id)).toEqual([
        'm1',
        'mobile-system-compact:replay-3',
      ]);
    });

    it('keeps only the latest detached tail Compact across temporary streaming rows', () => {
      const temporaryStream = message('mobile-stream-1', '2026-01-01T00:00:11.000Z');
      const rows = [
        message('m1', '2026-01-01T00:00:01.000Z'),
        compact('replay-1', '2026-01-01T00:00:10.000Z'),
        temporaryStream,
        compact('replay-2', '2026-01-01T00:00:12.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows).map((row) => row.id)).toEqual([
        'm1',
        'mobile-stream-1',
        'mobile-system-compact:replay-2',
      ]);
    });

    it('does not let a generated streaming client id widen the persisted host window', () => {
      const temporaryStream = {
        ...message('temporary-row', '2026-01-01T00:00:11.000Z'),
        clientId: 'mobile-stream-2',
      };
      const rows = [
        message('m1', '2026-01-01T00:00:01.000Z'),
        compact('replay-1', '2026-01-01T00:00:10.000Z'),
        temporaryStream,
        compact('replay-2', '2026-01-01T00:00:12.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows).map((row) => row.id)).toEqual([
        'm1',
        'temporary-row',
        'mobile-system-compact:replay-2',
      ]);
    });

    it('keeps Compact boundaries separated by host body rows', () => {
      const rows = [
        message('m0', '2026-01-01T00:00:00.000Z'),
        compact('first', '2026-01-01T00:00:01.000Z'),
        message('body', '2026-01-01T00:00:02.000Z'),
        compact('second', '2026-01-01T00:00:03.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows)).toBe(rows);
    });

    it('keeps current-tail Compact and unrelated local system cards', () => {
      const contextCard = {
        ...message('mobile-system-context:1', '2025-12-31T23:59:59.000Z'),
        systemCardType: 'context' as const,
      };
      const rows = [
        contextCard,
        message('m1', '2026-01-01T00:00:01.000Z'),
        compact('tail', '2026-01-01T00:00:02.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows)).toBe(rows);
    });

    it('does not erase Compact-only local state when no host cursor is loaded', () => {
      const rows = [compact('only', '2026-01-01T00:00:01.000Z')];
      expect(projectLoadedMessageWindow(rows)).toBe(rows);
    });

    it('collapses an adjacent Compact-only wall when no host cursor is loaded', () => {
      const rows = [
        compact('first', '2026-01-01T00:00:01.000Z'),
        compact('second', '2026-01-01T00:00:02.000Z'),
        compact('latest', '2026-01-01T00:00:03.000Z'),
      ];

      expect(projectLoadedMessageWindow(rows).map((row) => row.id)).toEqual([
        'mobile-system-compact:latest',
      ]);
    });

    it('patches a visible streaming row without rescanning a Compact projection', () => {
      const rows = [
        message('m1', '2026-01-01T00:00:01.000Z'),
        compact('replay-1', '2026-01-01T00:00:02.000Z'),
        compact('replay-2', '2026-01-01T00:00:03.000Z'),
        message('streaming', '2026-01-01T00:00:04.000Z'),
      ];
      const structureToken = {};
      const first = projectLoadedMessageWindowIncrementally({
        changedIndexes: new Set(),
        messages: rows,
        structureToken,
      });
      expect(first.projected.map((row) => row.id)).toEqual([
        'm1',
        'mobile-system-compact:replay-2',
        'streaming',
      ]);

      const nextRows = [...rows];
      nextRows[3] = { ...rows[3], content: 'next token' };
      let unrelatedSourceReads = 0;
      const observedRows = new Proxy(nextRows, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) !== 3) {
            unrelatedSourceReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const next = projectLoadedMessageWindowIncrementally({
        changedIndexes: new Set([3]),
        messages: observedRows,
        previous: first,
        structureToken,
      });

      expect(unrelatedSourceReads).toBe(0);
      expect(next.sourceToProjectedIndex).toBe(first.sourceToProjectedIndex);
      expect(next.changedIndexes).toEqual(new Set([2]));
      expect(next.projected.map((row) => row.content)).toEqual([
        'hello',
        'hello',
        'next token',
      ]);
    });
  });

  it('keeps the load-earlier affordance only when the remote page is full', () => {
    expect(hasMoreOlderMessages([message('m1', '2026-01-01T00:00:01.000Z')], 2)).toBe(false);
    expect(hasMoreOlderMessages([
      message('m1', '2026-01-01T00:00:01.000Z'),
      message('m2', '2026-01-01T00:00:02.000Z'),
    ], 2)).toBe(true);
  });

  it('keeps the load-earlier affordance for a short page trimmed by the remote frame limit', () => {
    // 被控端帧超限裁行时保留行带 agentMeta.remoteRowsTrimmed:短页不代表历史到头。
    const trimmed = {
      ...message('m1', '2026-01-01T00:00:01.000Z'),
      agentMeta: { remoteRowsTrimmed: true, remoteOriginalRowCount: 80 },
    };
    expect(hasMoreOlderMessages([trimmed], 2)).toBe(true);
  });

  it('retries message pages with smaller limits when device-link payload exceeds frame size', async () => {
    const calls: number[] = [];
    const page = [message('m1', '2026-01-01T00:00:01.000Z')];
    const result = await listMessagesWithPayloadRetry(async (limit) => {
      calls.push(limit);
      if (limit > 10) {
        const err = new Error('frame exceeds 2097152 bytes');
        (err as Error & { code: string }).code = 'PAYLOAD_TOO_LARGE';
        throw err;
      }
      return page;
    }, [80, 20, 10]);

    expect(calls).toEqual([80, 20, 10]);
    expect(result).toEqual({
      messages: page,
      limit: 10,
      reducedByPayloadTooLarge: true,
    });
    expect(shouldKeepOlderMessagesAffordance(result)).toBe(true);
  });

  it('does not retry non-payload pagination errors', async () => {
    const calls: number[] = [];
    await expect(listMessagesWithPayloadRetry(async (limit) => {
      calls.push(limit);
      throw new Error('remote unavailable');
    }, [80, 40])).rejects.toThrow('remote unavailable');
    expect(calls).toEqual([80]);
  });

  it('keeps the load-earlier affordance after a reduced payload page', () => {
    expect(shouldKeepOlderMessagesAffordance({
      messages: [message('m1', '2026-01-01T00:00:01.000Z')],
      limit: 10,
      reducedByPayloadTooLarge: true,
    })).toBe(true);
    expect(shouldKeepOlderMessagesAffordance({
      messages: [message('m1', '2026-01-01T00:00:01.000Z')],
      limit: 10,
      reducedByPayloadTooLarge: false,
    })).toBe(false);
    expect(shouldKeepOlderMessagesAffordance({
      messages: [],
      limit: 1,
      reducedByPayloadTooLarge: true,
    })).toBe(false);
  });

  describe('incrementalMessagePageNeedsFallback', () => {
    const page = {
      messages: [message('m2', '2026-01-01T00:00:02.000Z')],
      limit: 20,
      reducedByPayloadTooLarge: false,
    };

    it('accepts a complete page when the fresh count delta matches it', () => {
      expect(incrementalMessagePageNeedsFallback({
        page,
        totalCount: 2,
        previousTotalCount: 1,
      })).toBe(false);
    });

    it('falls back when the fresh count delta is larger than the returned page', () => {
      expect(incrementalMessagePageNeedsFallback({
        page,
        totalCount: 3,
        previousTotalCount: 1,
      })).toBe(true);
    });

    it('falls back when the fresh count regresses', () => {
      expect(incrementalMessagePageNeedsFallback({
        page,
        totalCount: 1,
        previousTotalCount: 2,
      })).toBe(true);
    });

    it('falls back when an older host ignores the after cursor', () => {
      expect(incrementalMessagePageNeedsFallback({
        page: {
          ...page,
          messages: [
            message('m1', '2026-01-01T00:00:01.000Z'),
            message('m2', '2026-01-01T00:00:02.000Z'),
          ],
        },
        afterMessage: message('m1', '2026-01-01T00:00:01.000Z'),
      })).toBe(true);
    });

    it('uses rowid when checking an incremental cursor with equal timestamps', () => {
      const createdAt = '2026-01-01T00:00:01.000Z';
      expect(incrementalMessagePageNeedsFallback({
        page: {
          ...page,
          messages: [{ ...message('m2', createdAt), rowid: 5 }],
        },
        afterMessage: { ...message('m1', createdAt), rowid: 4 },
      })).toBe(false);
      expect(incrementalMessagePageNeedsFallback({
        page: {
          ...page,
          messages: [{ ...message('m0', createdAt), rowid: 3 }],
        },
        afterMessage: { ...message('m1', createdAt), rowid: 4 },
      })).toBe(true);
    });

    it('falls back for a full or payload-reduced page when the total is unknown', () => {
      const fullPage = {
        messages: Array.from({ length: 20 }, (_, index) =>
          message(`m${index}`, `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`)),
        limit: 20,
        reducedByPayloadTooLarge: false,
      };
      expect(incrementalMessagePageNeedsFallback({
        page: fullPage,
      })).toBe(true);
      expect(incrementalMessagePageNeedsFallback({
        page: { ...page, reducedByPayloadTooLarge: true },
      })).toBe(true);
      expect(incrementalMessagePageNeedsFallback({
        page,
      })).toBe(false);
    });
  });


  describe('collectCompleteIncrementalMessages', () => {
    it('walks multiple after pages to collect a large delta', async () => {
      const anchor = message('m0', '2026-01-01T00:00:00.000Z');
      const pages = new Map([
        ['m2', { messages: [message('m3', '2026-01-01T00:00:03.000Z'), message('m4', '2026-01-01T00:00:04.000Z')], limit: 2, reducedByPayloadTooLarge: false }],
      ]);
      const result = await collectCompleteIncrementalMessages({
        initialPage: { messages: [message('m1', '2026-01-01T00:00:01.000Z'), message('m2', '2026-01-01T00:00:02.000Z')], limit: 2, reducedByPayloadTooLarge: false },
        afterMessage: anchor,
        fetchAfter: async (cursor) => pages.get(cursor) ?? { messages: [], limit: 2, reducedByPayloadTooLarge: false },
        fetchLatest: async () => { throw new Error('tail fallback should not run'); },
        fetchBefore: async () => { throw new Error('before fallback should not run'); },
      });
      expect(result?.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('walks backward from the latest tail when after is ignored', async () => {
      const anchor = message('m1', '2026-01-01T00:00:01.000Z');
      const result = await collectCompleteIncrementalMessages({
        initialPage: { messages: [message('m4', '2026-01-01T00:00:04.000Z'), message('m5', '2026-01-01T00:00:05.000Z')], limit: 2, reducedByPayloadTooLarge: false },
        afterMessage: anchor,
        fetchAfter: async () => ({ messages: [message('m4', '2026-01-01T00:00:04.000Z'), message('m5', '2026-01-01T00:00:05.000Z')], limit: 2, reducedByPayloadTooLarge: false }),
        fetchLatest: async () => ({ messages: [message('m4', '2026-01-01T00:00:04.000Z'), message('m5', '2026-01-01T00:00:05.000Z')], limit: 2, reducedByPayloadTooLarge: false }),
        fetchBefore: async (before) => before === 'm4'
          ? { messages: [message('m2', '2026-01-01T00:00:02.000Z'), message('m3', '2026-01-01T00:00:03.000Z')], limit: 2, reducedByPayloadTooLarge: false }
          : before === 'm2'
            ? { messages: [message('m1', '2026-01-01T00:00:01.000Z')], limit: 2, reducedByPayloadTooLarge: false }
            : { messages: [], limit: 2, reducedByPayloadTooLarge: false },
      });
      expect(result?.map((item) => item.id)).toEqual(['m2', 'm3', 'm4', 'm5']);
    });
    it('keeps paging until a short page even when a net delta would be smaller', async () => {
      const anchor = message('m0', '2026-01-01T00:00:00.000Z');
      const calls: string[] = [];
      const result = await collectCompleteIncrementalMessages({
        initialPage: { messages: [message('m1', '2026-01-01T00:00:01.000Z'), message('m2', '2026-01-01T00:00:02.000Z')], limit: 2, reducedByPayloadTooLarge: false },
        afterMessage: anchor,
        fetchAfter: async (cursor) => {
          calls.push(cursor);
          return cursor === 'm2'
            ? { messages: [message('m3', '2026-01-01T00:00:03.000Z'), message('m4', '2026-01-01T00:00:04.000Z')], limit: 2, reducedByPayloadTooLarge: false }
            : { messages: [message('m5', '2026-01-01T00:00:05.000Z')], limit: 2, reducedByPayloadTooLarge: false };
        },
        fetchLatest: async () => { throw new Error('tail fallback should not run'); },
        fetchBefore: async () => { throw new Error('before fallback should not run'); },
      });
      expect(calls).toEqual(['m2', 'm4']);
      expect(result?.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    });

    it('does not accept a forward prefix after reaching the page limit', async () => {
      const anchor = message('m0', '2026-01-01T00:00:00.000Z');
      const result = await collectCompleteIncrementalMessages({
        initialPage: {
          messages: [
            message('m1', '2026-01-01T00:00:01.000Z'),
            message('m2', '2026-01-01T00:00:02.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        },
        afterMessage: anchor,
        fetchAfter: async () => ({
          messages: [
            message('m3', '2026-01-01T00:00:03.000Z'),
            message('m4', '2026-01-01T00:00:04.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
        fetchLatest: async () => {
          throw new Error('tail fallback should not run');
        },
        fetchBefore: async () => {
          throw new Error('before fallback should not run');
        },
        maxPages: 1,
      });

      expect(result).toBeNull();
    });

    it('does not accept an unknown after cursor from an empty continuation', async () => {
      const anchor = message('deleted-anchor', '2026-01-01T00:00:01.000Z');
      const result = await collectCompleteIncrementalMessages({
        initialPage: {
          messages: [
            message('m4', '2026-01-01T00:00:04.000Z'),
            message('m5', '2026-01-01T00:00:05.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        },
        afterMessage: anchor,
        fetchAfter: async () => ({
          messages: [],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
        fetchLatest: async () => ({
          messages: [
            message('m4', '2026-01-01T00:00:04.000Z'),
            message('m5', '2026-01-01T00:00:05.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
        fetchBefore: async () => ({
          messages: [message('m2', '2026-01-01T00:00:02.000Z')],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
      });

      expect(result).toBeNull();
    });

    it('rejects a short backward page that never reaches the original cursor', async () => {
      const anchor = message('deleted-anchor', '2026-01-01T00:00:01.000Z');
      const result = await collectCompleteIncrementalMessages({
        initialPage: {
          messages: [
            message('m4', '2026-01-01T00:00:04.000Z'),
            message('m5', '2026-01-01T00:00:05.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        },
        afterMessage: anchor,
        fetchAfter: async () => ({
          messages: [
            message('m4', '2026-01-01T00:00:04.000Z'),
            message('m5', '2026-01-01T00:00:05.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
        fetchLatest: async () => ({
          messages: [
            message('m4', '2026-01-01T00:00:04.000Z'),
            message('m5', '2026-01-01T00:00:05.000Z'),
          ],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
        fetchBefore: async () => ({
          messages: [message('m2', '2026-01-01T00:00:02.000Z')],
          limit: 2,
          reducedByPayloadTooLarge: false,
        }),
      });

      expect(result).toBeNull();
    });
  });

  describe('shouldRefreshLatestMessageWindowOnReopen', () => {
    it('refreshes when the cached message window was never synced to the current session meta', () => {
      const freshSession = sessionVersion();

      expect(shouldRefreshLatestMessageWindowOnReopen({
        freshSession,
        messageWindowSynced: false,
        storedSession: freshSession,
      })).toBe(true);
    });

    it('refreshes when session updatedAt or message count changed', () => {
      expect(shouldRefreshLatestMessageWindowOnReopen({
        freshSession: sessionVersion({ updatedAt: '2026-01-01T00:00:02.000Z' }),
        messageWindowSynced: true,
        storedSession: sessionVersion(),
      })).toBe(true);

      expect(shouldRefreshLatestMessageWindowOnReopen({
        freshSession: sessionVersion({ _count: { messages: 3 } }),
        messageWindowSynced: true,
        storedSession: sessionVersion({ _count: { messages: 2 } }),
      })).toBe(true);
    });

    it('skips refresh only when meta is unchanged and the message window is marked synced', () => {
      const freshSession = sessionVersion();

      expect(shouldRefreshLatestMessageWindowOnReopen({
        freshSession,
        messageWindowSynced: true,
        storedSession: freshSession,
      })).toBe(false);
    });
  });

  describe('hasOlderMessagesAfterReopen (reopen skip-fetch path)', () => {
    const loaded = [
      message('m2', '2026-01-01T00:00:02.000Z'),
      message('m3', '2026-01-01T00:00:03.000Z'),
    ];

    it('keeps affordance when server total exceeds in-store loaded count', () => {
      expect(hasOlderMessagesAfterReopen(10, loaded)).toBe(true);
    });

    it('hides affordance when in-store already holds the full history', () => {
      expect(hasOlderMessagesAfterReopen(2, loaded)).toBe(false);
    });

    it('ignores locally-appended system cards when counting loaded real messages', () => {
      const withSystemCard = [
        ...loaded,
        message('mobile-system-1', '2026-01-01T00:00:04.000Z'),
      ];
      // total 2 == 2 real loaded (system card excluded) → no older.
      expect(hasOlderMessagesAfterReopen(2, withSystemCard)).toBe(false);
      // total 3 > 2 real loaded → older exist.
      expect(hasOlderMessagesAfterReopen(3, withSystemCard)).toBe(true);
    });

    it('falls back to window heuristic when server total is unknown', () => {
      const fullWindow = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, index) =>
        message(`w${index}`, `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`));
      expect(hasOlderMessagesAfterReopen(undefined, fullWindow)).toBe(true);
      expect(hasOlderMessagesAfterReopen(undefined, loaded)).toBe(false);
    });

    it('returns false when nothing is loaded', () => {
      expect(hasOlderMessagesAfterReopen(5, [])).toBe(false);
      expect(hasOlderMessagesAfterReopen(undefined, [])).toBe(false);
    });
  });

  describe('hasOlderMessagesByServerCount (optimistic affordance on cache hydrate)', () => {
    const loaded = [
      message('m2', '2026-01-01T00:00:02.000Z'),
      message('m3', '2026-01-01T00:00:03.000Z'),
    ];

    it('lights the affordance only when a known server total exceeds loaded real messages', () => {
      expect(hasOlderMessagesByServerCount(10, loaded)).toBe(true);
      expect(hasOlderMessagesByServerCount(2, loaded)).toBe(false);
    });

    it('never lights up when the server total is unknown (no window fallback)', () => {
      // 与 hasOlderMessagesAfterReopen 不同:_count 未知一律 false,绝不凭空点亮入口。
      const fullWindow = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, index) =>
        message(`w${index}`, `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`));
      expect(hasOlderMessagesByServerCount(undefined, fullWindow)).toBe(false);
      expect(hasOlderMessagesByServerCount(undefined, loaded)).toBe(false);
    });

    it('excludes locally-appended system cards from the loaded count', () => {
      const withSystemCard = [...loaded, message('mobile-system-1', '2026-01-01T00:00:04.000Z')];
      expect(hasOlderMessagesByServerCount(2, withSystemCard)).toBe(false);
      expect(hasOlderMessagesByServerCount(3, withSystemCard)).toBe(true);
    });
  });
});
