import { describe, expect, it } from 'vitest';
import {
  hasMoreOlderMessages,
  hasOlderMessagesAfterReopen,
  hasOlderMessagesByServerCount,
  listMessagesWithPayloadRetry,
  MESSAGE_PAGE_SIZE,
  oldestMessageCursor,
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

  it('returns null when no stable message id exists', () => {
    expect(oldestMessageCursor([
      { ...message('', '2026-01-01T00:00:01.000Z'), clientId: 'client-only' },
    ])).toBeNull();
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
