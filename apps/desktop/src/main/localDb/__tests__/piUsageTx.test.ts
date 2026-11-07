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
        recorded_at INTEGER, priced INTEGER DEFAULT 0, pricing_payload TEXT, PRIMARY KEY(session_id, settlement_id, receipt_id));
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

  // #9030 P2, db: resolving a message-only estimate must leave the pending
  // queue, including after restart, without adding spend or repeating tokens.
  it('finalizes a non-ledgerable estimate without retaining pending data or spend', () => {
    const pending = receipt({ pricingPayload: '{"version":1}' });
    write(pending);
    const finalized = { ...pending, amount: 0 };
    write(finalized);
    const checkpoint = db.serialize();
    db.close();
    db = new Database(checkpoint);
    write(pending, finalized);
    expect(total()).toEqual({ tokens: 154, cost: 0 });
    expect(db.prepare('SELECT priced, pricing_payload FROM pi_usage_receipts').get())
      .toEqual({ priced: 1, pricing_payload: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_spend').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT cost_amount FROM daily_model_usage').get()).toEqual({ cost_amount: 0 });
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

  it('adds recovered-currency subscription value without repeating fallback-row tokens', () => {
    const pending = receipt({ model: 'model-a#billing=subscription', approximate: true });
    write(pending);
    const confirmed = { ...pending, currency: 'CNY' as const, amount: 1.34 };
    write(confirmed, pending, confirmed);
    expect(total()).toEqual({ tokens: 154, cost: 0 });
    expect(db.prepare('SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens FROM daily_model_usage').get())
      .toEqual({ tokens: 154 });
    expect(db.prepare('SELECT cost_currency, cost_amount, cost_is_approximate FROM daily_model_usage ORDER BY cost_currency').all())
      .toEqual([
        { cost_currency: 'CNY', cost_amount: 1.34, cost_is_approximate: 1 },
        { cost_currency: 'USD', cost_amount: 0, cost_is_approximate: 1 },
      ]);
    expect(db.prepare('SELECT priced FROM pi_usage_receipts').get()).toEqual({ priced: 1 });
  });

  // #9030 P1: simulate termination after the token transaction, before pricing.
  // The old identity-only receipt could not be reconstructed after reopening.
  it('retains pending facts across reopen and clears them only with a successful money commit', () => {
    const payload = JSON.stringify({ receipt: { id: 'pi:1', model: 'model-a' }, day: '2026-11-05' });
    write(receipt({ pricingPayload: payload }));
    const checkpoint = db.serialize();
    db.close();
    db = new Database(checkpoint);
    expect(db.prepare('SELECT priced, pricing_payload FROM pi_usage_receipts').get())
      .toEqual({ priced: 0, pricing_payload: payload });
    db.exec(`CREATE TRIGGER reject_money BEFORE INSERT ON daily_spend BEGIN SELECT RAISE(ABORT, 'price failure'); END`);
    const priced = receipt({ amount: 0.2, actualCost: true, pricingPayload: payload });
    expect(() => write(priced)).toThrow('price failure');
    expect(total()).toEqual({ tokens: 154, cost: 0 });
    expect(db.prepare('SELECT priced, pricing_payload FROM pi_usage_receipts').get())
      .toEqual({ priced: 0, pricing_payload: payload });
    db.exec('DROP TRIGGER reject_money');
    write(priced, priced);
    expect(total()).toEqual({ tokens: 154, cost: 0.2 });
    expect(db.prepare('SELECT priced, pricing_payload FROM pi_usage_receipts').get())
      .toEqual({ priced: 1, pricing_payload: null });
  });
});
