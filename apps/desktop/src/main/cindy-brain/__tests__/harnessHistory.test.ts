import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const query = vi.fn();
  const limit = vi.fn();
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const snapshot = { clientEpoch: 1, client: { query, drizzle: { select } } };
  return { query, limit, snapshot, current: true, read: vi.fn(), drain: vi.fn() };
});
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => (f.current ? f.snapshot : null),
}));
vi.mock('../../localDb/chatHistoryReader.js', () => ({ getMessagesForHistory: f.read }));
vi.mock('../../messagePersistBroadcaster.js', () => ({ drainPersistQueue: f.drain }));
vi.mock('../subscriptionGateway.js', () => ({
  ghostActivityId: (runtime: string, id: string) => `${runtime}:${id}`,
}));
import { readHarnessHistory } from '../harnessHistory.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.current = true;
  f.query.mockResolvedValue([{ changes: 5, version: 1 }]);
  f.limit.mockResolvedValue([{ clearedAt: 100 }]);
  f.read.mockResolvedValue({
    items: [
      {
        id: 'm',
        role: 'user',
        content: 'text',
        createdAt: 101,
        agentMeta: { signature: 'private' },
      },
    ],
    nextCursor: { id: 'm', createdAt: 101, rowid: 1 },
  });
});

describe('Harness saved-history boundary', () => {
  it('scopes the reader to public roles in one task after its clear boundary', async () => {
    const page = await readHarnessHistory('s', 'messages', 'r', 25);
    expect(f.drain).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ['s'],
        roles: ['user', 'assistant'],
        fromMs: 101,
        includeRewound: false,
      }),
    );
    expect(page.items).toEqual([{ id: 'm', role: 'user', createdAt: 101, content: 'text' }]);
    expect(JSON.stringify(page)).not.toContain('private');
    await expect(
      readHarnessHistory('other', 'messages', 'r', 25, page.nextCursor!),
    ).rejects.toMatchObject({ code: 'STALE_RUNTIME' });
  });

  it('rejects a page if history changes during the read', async () => {
    f.query
      .mockResolvedValueOnce([{ changes: 5, version: 1 }])
      .mockResolvedValueOnce([{ changes: 6, version: 1 }]);
    await expect(readHarnessHistory('s', 'messages', 'r', 25)).rejects.toMatchObject({
      code: 'STALE_RUNTIME',
    });
  });

  it('rejects account changes while the reader is awaiting data', async () => {
    f.read.mockImplementationOnce(async () => {
      f.current = false;
      return { items: [], nextCursor: null };
    });
    await expect(readHarnessHistory('s', 'tool-content', 'r', 25)).rejects.toMatchObject({
      code: 'STALE_RUNTIME',
    });
  });
});
