import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tx } from '../worker/opHandlers/tx.js';
import type { PiUsageWrite } from '../worker/opHandlers/piUsageTx.js';

// #8887, db tier: unlike turn-only coverage, verifies durable duplicate receipts,
// rollback and delayed pricing through the production named transaction.
describe('Pi request usage transaction', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pi_usage_receipts(session_id TEXT, settlement_id TEXT, receipt_id TEXT,
        recorded_at INTEGER, priced INTEGER DEFAULT 0, PRIMARY KEY(session_id, settlement_id, receipt_id));
      CREATE TABLE daily_model_usage(day TEXT, agent_kind TEXT, model TEXT, cost_currency TEXT,
        cost_amount REAL DEFAULT 0, cost_is_approximate INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_create_tokens INTEGER DEFAULT 0,
        updated_at INTEGER, PRIMARY KEY(day, agent_kind, model, cost_currency));
      CREATE TABLE daily_session_usage(day TEXT, session_id TEXT, tokens INTEGER, updated_at INTEGER,
        PRIMARY KEY(day, session_id));
      CREATE TABLE daily_spend(day TEXT, cost_currency TEXT, cost_amount REAL DEFAULT 0,
        cost_is_approximate INTEGER DEFAULT 0, updated_at INTEGER, PRIMARY KEY(day, cost_currency));
      CREATE TABLE sessions(id TEXT PRIMARY KEY, total_token_usage INTEGER DEFAULT 0,
        total_cost_amount REAL DEFAULT 0, total_cost_currency TEXT, total_cost_is_approximate INTEGER DEFAULT 0);
      INSERT INTO sessions(id) VALUES ('task');
    `);
  });
  afterEach(() => db.close());
  const receipt = (overrides: Partial<PiUsageWrite> = {}): PiUsageWrite => ({
    sessionId: 'task', settlementId: 'turn-1', receiptId: 'pi:1', recordedAt: 1,
    day: '2026-11-05', model: 'model-a', currency: 'USD', inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 30, cacheCreateTokens: 4, amount: null, approximate: false, actualCost: false, ...overrides,
  });
  const write = (...rows: PiUsageWrite[]) => tx(db, { name: 'usage.recordPiUsage', args: rows });
  const total = () => db.prepare('SELECT total_token_usage AS tokens, total_cost_amount AS cost FROM sessions').get();

  it('commits tokens before prices and ignores replayed live and terminal receipts', () => {
    write(receipt());
    expect(total()).toEqual({ tokens: 154, cost: 0 });
    const priced = receipt({ amount: 0.2, actualCost: true });
    write(priced, priced);
    const checkpoint = db.serialize();
    db.close();
    db = new Database(checkpoint);
    write(receipt(), priced); // New consumer after reconnect uses only durable receipts.
    expect(total()).toEqual({ tokens: 154, cost: 0.2 });
    expect(db.prepare('SELECT input_tokens, cost_amount FROM daily_model_usage').get())
      .toEqual({ input_tokens: 100, cost_amount: 0.2 });
  });

  it('keeps request models, days, turns and sessions independent', () => {
    write(receipt(), receipt({ receiptId: 'pi:2', model: 'model-b', day: '2026-11-06' }),
      receipt({ settlementId: 'turn-2' }), receipt({ sessionId: 'worker' }));
    expect(total()).toEqual({ tokens: 462, cost: 0 });
    expect(db.prepare('SELECT SUM(tokens) AS tokens FROM daily_session_usage').get()).toEqual({ tokens: 616 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_model_usage').get()).toEqual({ n: 2 });
  });

  it('rolls back the receipt with its aggregates so a failed write can be retried', () => {
    db.exec(`CREATE TRIGGER reject_usage BEFORE INSERT ON daily_session_usage BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() => write(receipt())).toThrow('fixture failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pi_usage_receipts').get()).toEqual({ n: 0 });
    expect(total()).toEqual({ tokens: 0, cost: 0 });
    db.exec('DROP TRIGGER reject_usage');
    write(receipt());
    expect(total()).toEqual({ tokens: 154, cost: 0 });
  });

  it('does not turn subscription value into spend, and rejects a partially invalid batch atomically', () => {
    expect(() => write(receipt(), receipt({ receiptId: 'bad', inputTokens: NaN }))).toThrow('Invalid Pi usage receipt');
    expect(total()).toEqual({ tokens: 0, cost: 0 });
    write(receipt({ model: 'model-a#billing=subscription', amount: 0.2, approximate: true }));
    expect(total()).toEqual({ tokens: 154, cost: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_spend').get()).toEqual({ n: 0 });
  });
});
