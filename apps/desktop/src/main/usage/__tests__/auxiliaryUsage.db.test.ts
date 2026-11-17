import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuxiliaryUsageRecorder } from '../auxiliaryUsage.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { waitForRetainedDbClient } from '../../localDb/client/pendingOperations.js';
import type { DbClient } from '../../localDb/client/DbClient.js';

const databases: Database.Database[] = [];
function owner() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`CREATE TABLE auxiliary_usage_receipts (
    receipt_id TEXT PRIMARY KEY, provider_id TEXT, model TEXT, source TEXT, session_id TEXT,
    transport TEXT, day TEXT, recorded_at INTEGER, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER)`);
  // Production DbClient runs Drizzle asynchronously; awaiting a synchronous fixture has the same result.
  const client = { drizzle: drizzle(sqlite) } as unknown as DbClient;
  return { sqlite, client };
}
afterEach(() => {
  vi.useRealTimers();
  clearCurrentDbClient();
  for (const db of databases.splice(0)) db.close();
});

describe('auxiliary receipts', () => {
  it('settles each usage receipt on its own day across a midnight retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 17, 23, 59, 59, 900));
    const { sqlite, client } = owner();
    setCurrentDbClient(client, 'owner');
    const record = createAuxiliaryUsageRecorder();
    try {
      await record({ inputTokens: 10, outputTokens: 1 }, {}, 'attempt-1');
      vi.setSystemTime(new Date(2026, 10, 18, 0, 0, 1));
      await record({ inputTokens: 20, outputTokens: 2 }, {}, 'attempt-2');
      expect(
        sqlite
          .prepare('SELECT day, input_tokens FROM auxiliary_usage_receipts ORDER BY receipt_id')
          .all(),
      ).toEqual([
        { day: '2026-11-17', input_tokens: 10 },
        { day: '2026-11-18', input_tokens: 20 },
      ]);
    } finally {
      record.close();
    }
  });
  it('keeps late responses in their original account and retains the client until settlement', async () => {
    const first = owner();
    const second = owner();
    setCurrentDbClient(first.client, 'first');
    const record = createAuxiliaryUsageRecorder({
      source: 'title',
      sessionId: 'task',
      model: 'requested',
    });
    let drained = false;
    const drain = waitForRetainedDbClient(first.client).then(() => {
      drained = true;
    });
    setCurrentDbClient(second.client, 'second');
    await record(
      { inputTokens: 10, outputTokens: 2 },
      { model: 'served', providerId: 'actual' },
      'request-1',
    );
    expect(drained).toBe(false);
    record.close();
    await drain;
    expect(
      first.sqlite
        .prepare('SELECT source, session_id, model, provider_id FROM auxiliary_usage_receipts')
        .all(),
    ).toEqual([{ source: 'title', session_id: 'task', model: 'served', provider_id: 'actual' }]);
    expect(second.sqlite.prepare('SELECT COUNT(*) n FROM auxiliary_usage_receipts').get()).toEqual({
      n: 0,
    });
  });
  it('deduplicates the same receipt while keeping separate retries and unknown fields', async () => {
    const { sqlite, client } = owner();
    setCurrentDbClient(client, 'owner');
    const record = createAuxiliaryUsageRecorder();
    try {
      await record({ inputTokens: 100 }, {}, 'request-1');
      await record({ inputTokens: 100 }, {}, 'request-1');
      await record({ outputTokens: 7 }, {}, 'request-2');
      await record({});
      expect(
        sqlite
          .prepare(
            'SELECT input_tokens, output_tokens FROM auxiliary_usage_receipts ORDER BY receipt_id',
          )
          .all(),
      ).toEqual([
        { input_tokens: 100, output_tokens: null },
        { input_tokens: null, output_tokens: 7 },
      ]);
    } finally {
      record.close();
    }
  });
});
