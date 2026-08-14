import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0081 } = (await import(
  '../../../../drizzle/scripts/0081_preserve_gateway_currency'
)) as { default: { run(db: Database.Database): void } };

const RATE = 6.7;

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE daily_spend (
      day TEXT PRIMARY KEY NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT,
      cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE daily_model_usage (
      day TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      model TEXT NOT NULL,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT,
      cost_is_approximate INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY NOT NULL,
      cost_amount REAL NOT NULL DEFAULT 0,
      estimated_value_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT,
      cost_is_approximate INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      agent_meta TEXT
    );
  `);
  return db;
}

describe('0081 preserve gateway currency relabel', () => {
  it('relabels exact CNY rows to USD without changing amounts (they were mislabeled gateway USD)', () => {
    const db = setupDb();
    try {
      db.exec(`
        INSERT INTO daily_spend (day, cost_amount, cost_currency, cost_is_approximate)
        VALUES ('2026-07-25', 273.5, 'CNY', 0);
        INSERT INTO sessions (id, total_cost_amount, total_cost_currency, total_cost_is_approximate)
        VALUES ('s1', 3631.96, 'CNY', 0);
      `);
      migration0081.run(db);
      expect(
        db.prepare('SELECT cost_amount, cost_currency FROM daily_spend').get(),
      ).toEqual({ cost_amount: 273.5, cost_currency: 'USD' });
      expect(
        db
          .prepare('SELECT total_cost_amount, total_cost_currency FROM sessions')
          .get(),
      ).toEqual({ total_cost_amount: 3631.96, total_cost_currency: 'USD' });
    } finally {
      db.close();
    }
  });

  it('inverts the fixed 6.7 conversion for approximate CNY rows and always for estimated values', () => {
    const db = setupDb();
    try {
      db.exec(`
        INSERT INTO daily_model_usage (day, agent_kind, model, cost_amount, cost_currency, cost_is_approximate)
        VALUES ('2026-07-25', 'claude-code', 'claude-opus-4-8', 6.7, 'CNY', 1);
        INSERT INTO schedule_runs (id, cost_amount, estimated_value_amount, cost_currency, cost_is_approximate)
        VALUES ('r1', 13.4, 6.7, 'CNY', 0);
      `);
      migration0081.run(db);
      const model = db
        .prepare('SELECT cost_amount, cost_currency FROM daily_model_usage')
        .get() as { cost_amount: number; cost_currency: string };
      expect(model.cost_currency).toBe('USD');
      expect(model.cost_amount).toBeCloseTo(1);
      const run = db
        .prepare(
          'SELECT cost_amount, estimated_value_amount, cost_currency FROM schedule_runs',
        )
        .get() as {
        cost_amount: number;
        estimated_value_amount: number;
        cost_currency: string;
      };
      expect(run.cost_currency).toBe('USD');
      expect(run.cost_amount).toBeCloseTo(13.4);
      expect(run.estimated_value_amount).toBeCloseTo(1);
    } finally {
      db.close();
    }
  });

  it('leaves USD rows and rows without currency untouched', () => {
    const db = setupDb();
    try {
      db.exec(`
        INSERT INTO daily_spend (day, cost_amount, cost_currency, cost_is_approximate)
        VALUES ('2026-07-24', 12, 'USD', 0), ('2026-07-23', 0, NULL, 0);
      `);
      migration0081.run(db);
      expect(
        db
          .prepare('SELECT cost_amount, cost_currency FROM daily_spend ORDER BY day')
          .all(),
      ).toEqual([
        { cost_amount: 0, cost_currency: null },
        { cost_amount: 12, cost_currency: 'USD' },
      ]);
    } finally {
      db.close();
    }
  });

  it('rewrites CNY money objects inside messages.agent_meta and drops the fixed-fx reason', () => {
    const db = setupDb();
    try {
      const meta = JSON.stringify({
        uuid: 'keep-me',
        turnCost: {
          amount: 11.17,
          currency: 'CNY',
          approximate: false,
          kind: 'actual-cost',
        },
        userTurnCost: {
          amount: 6.7,
          currency: 'CNY',
          approximate: true,
          kind: 'actual-cost',
          estimateReasons: ['fixed-fx', 'legacy-usd'],
        },
        turnUsageDetails: {
          perModelCost: [
            {
              model: 'claude-opus-4-8',
              money: {
                amount: 13.4,
                currency: 'CNY',
                approximate: true,
                kind: 'value-estimate',
                estimateReasons: ['fixed-fx'],
              },
            },
          ],
        },
      });
      const untouched = JSON.stringify({
        turnCost: {
          amount: 2,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      });
      db.prepare('INSERT INTO messages (id, agent_meta) VALUES (?, ?)').run('m1', meta);
      db.prepare('INSERT INTO messages (id, agent_meta) VALUES (?, ?)').run('m2', untouched);
      db.prepare('INSERT INTO messages (id, agent_meta) VALUES (?, ?)').run('m3', 'not json {');

      migration0081.run(db);

      const rewritten = JSON.parse(
        (db.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('m1') as {
          agent_meta: string;
        }).agent_meta,
      );
      expect(rewritten.uuid).toBe('keep-me');
      expect(rewritten.turnCost).toEqual({
        amount: 11.17,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      });
      expect(rewritten.userTurnCost.currency).toBe('USD');
      expect(rewritten.userTurnCost.amount).toBeCloseTo(6.7 / RATE);
      expect(rewritten.userTurnCost.estimateReasons).toEqual(['legacy-usd']);
      const perModel = rewritten.turnUsageDetails.perModelCost[0].money;
      expect(perModel.currency).toBe('USD');
      expect(perModel.amount).toBeCloseTo(2);
      expect(perModel.estimateReasons).toBeUndefined();

      expect(
        (db.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('m2') as {
          agent_meta: string;
        }).agent_meta,
      ).toBe(untouched);
      expect(
        (db.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('m3') as {
          agent_meta: string;
        }).agent_meta,
      ).toBe('not json {');
    } finally {
      db.close();
    }
  });

  it('is idempotent and tolerates missing tables or columns', () => {
    const db = setupDb();
    try {
      db.exec(`
        INSERT INTO daily_spend (day, cost_amount, cost_currency, cost_is_approximate)
        VALUES ('2026-07-25', 100, 'CNY', 0);
      `);
      migration0081.run(db);
      migration0081.run(db);
      expect(
        db.prepare('SELECT cost_amount, cost_currency FROM daily_spend').get(),
      ).toEqual({ cost_amount: 100, cost_currency: 'USD' });
    } finally {
      db.close();
    }

    const partial = new Database(':memory:');
    try {
      partial.exec('CREATE TABLE daily_spend (day TEXT PRIMARY KEY NOT NULL)');
      expect(() => migration0081.run(partial)).not.toThrow();
    } finally {
      partial.close();
    }
  });
});
