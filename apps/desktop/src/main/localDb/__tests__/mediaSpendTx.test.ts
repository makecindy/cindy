import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tx } from '../worker/opHandlers/tx.js';

describe('media spend transaction', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE daily_spend (
        day TEXT, cost_amount REAL DEFAULT 0, cost_currency TEXT, updated_at INTEGER,
        PRIMARY KEY(day, cost_currency));
      CREATE TABLE daily_model_usage (
        day TEXT, agent_kind TEXT, model TEXT, cost_amount REAL DEFAULT 0,
        cost_currency TEXT, updated_at INTEGER, input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
        cache_create_tokens INTEGER DEFAULT 0,
        PRIMARY KEY(day, agent_kind, model, cost_currency));
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, total_cost_usd REAL DEFAULT 0, total_cost_amount REAL DEFAULT 0,
        total_cost_currency TEXT, total_cost_is_approximate INTEGER DEFAULT 0);
      CREATE TABLE messages (session_id TEXT, client_id TEXT, role TEXT, agent_meta TEXT);
      CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, cost_amount REAL DEFAULT 0,
        cost_currency TEXT, cost_attribution TEXT DEFAULT 'unavailable');
      INSERT INTO sessions(id, total_cost_usd, total_cost_amount, total_cost_currency)
        VALUES ('session-1', 2, 3, 'USD');
    `);
  });
  afterEach(() => db.close());

  const spend = (currency: 'USD' | 'CNY' = 'USD', sessionId?: string) =>
    tx(db, {
      name: 'usage.recordMediaSpend',
      args: { day: '2026-10-15', model: 'image-model', amount: 0.75, currency, sessionId, now: 1 },
    });

  it('adds costs to day, model and task without changing chat tokens or historical USD', () => {
    expect(spend('USD', 'session-1')).toEqual({
      legacyUsd: 2,
      amount: 3.75,
      currency: 'USD',
      approximate: 0,
    });
    spend('USD', 'session-1');
    expect(db.prepare('SELECT cost_amount FROM daily_spend').get()).toEqual({ cost_amount: 1.5 });
    expect(
      db
        .prepare(
          'SELECT agent_kind, cost_amount, input_tokens, output_tokens FROM daily_model_usage',
        )
        .get(),
    ).toEqual({ agent_kind: 'media', cost_amount: 1.5, input_tokens: 0, output_tokens: 0 });
    expect(db.prepare('SELECT total_cost_usd, total_cost_amount FROM sessions').get()).toEqual({
      total_cost_usd: 2,
      total_cost_amount: 4.5,
    });
  });

  it('keeps separate currency rows and follows the existing task currency rollover', () => {
    spend('USD', 'session-1');
    expect(spend('CNY', 'session-1')).toEqual({
      legacyUsd: 2,
      amount: 0.75,
      currency: 'CNY',
      approximate: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_spend').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_model_usage').get()).toEqual({ n: 2 });
  });

  it('keeps unassociated media in day and model totals', () => {
    expect(spend()).toBeNull();
    expect(db.prepare('SELECT cost_amount FROM daily_spend').get()).toEqual({ cost_amount: 0.75 });
    expect(db.prepare('SELECT total_cost_amount FROM sessions').get()).toEqual({
      total_cost_amount: 3,
    });
  });

  it.each(['unavailable', 'exact', 'direct', 'mixed'])(
    'persists the original user ledger and respects %s run snapshots',
    (attribution) => {
      const origin = { kind: 'scheduler', runId: 'run-1', scheduleId: 'schedule-1' };
      db.prepare(`INSERT INTO messages VALUES ('session-1', 'user-1', 'user', ?)`).run(
        JSON.stringify({ origin, model: 'keep-model' }),
      );
      db.prepare(
        `INSERT INTO schedule_runs(id, cost_amount, cost_attribution) VALUES ('run-1', 1, ?)`,
      ).run(attribution);
      const record = () =>
        tx(db, {
          name: 'usage.recordMediaSpend',
          args: {
            day: '2026-10-15',
            model: 'image',
            amount: 0.75,
            currency: 'USD',
            sessionId: 'session-1',
            userClientId: 'user-1',
            now: 1,
          },
        });
      record();
      record();
      const meta = JSON.parse(
        (db.prepare('SELECT agent_meta FROM messages').get() as { agent_meta: string }).agent_meta,
      );
      expect(meta).toEqual({
        origin,
        model: 'keep-model',
        mediaCosts: [{ amount: 1.5, currency: 'USD', approximate: false, kind: 'actual-cost' }],
        mediaCostDetails: [{ model: 'image', category: 'additional', providerId: 'xd', billingSource: 'cindy-ai',
          money: { amount: 1.5, currency: 'USD', approximate: false, kind: 'actual-cost' } }],
      });
      expect(db.prepare('SELECT cost_amount, cost_attribution FROM schedule_runs').get()).toEqual({
        cost_amount: attribution === 'direct' ? 1 : 2.5,
        cost_attribution: ['direct', 'mixed'].includes(attribution) ? attribution : 'exact',
      });
    },
  );

  it('rolls back daily and task amounts if saving the user ledger fails', () => {
    db.exec(`INSERT INTO messages VALUES ('session-1', 'user-1', 'user', '{}');
      CREATE TRIGGER reject_user_cost BEFORE UPDATE ON messages
      BEGIN SELECT RAISE(ABORT, 'message write failed'); END;`);
    expect(() =>
      tx(db, {
        name: 'usage.recordMediaSpend',
        args: {
          day: '2026-10-15',
          model: 'image',
          amount: 1,
          currency: 'USD',
          sessionId: 'session-1',
          userClientId: 'user-1',
          now: 1,
        },
      }),
    ).toThrow('message write failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_spend').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_cost_amount FROM sessions').get()).toEqual({
      total_cost_amount: 3,
    });
  });

  it('rolls all aggregates back if a later write fails', () => {
    db.exec(`CREATE TRIGGER reject_media_cost BEFORE INSERT ON daily_model_usage
      BEGIN SELECT RAISE(ABORT, 'model write failed'); END;`);
    expect(() => spend('USD', 'session-1')).toThrow('model write failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_spend').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT total_cost_amount FROM sessions').get()).toEqual({
      total_cost_amount: 3,
    });
  });
});
