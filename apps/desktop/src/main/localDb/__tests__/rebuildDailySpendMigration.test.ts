import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const migration0085 =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../drizzle/scripts/0085_skinny_iron_man.ts') as {
    run(db: Database.Database): void;
  };

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE daily_spend (
      day TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'USD',
      cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, cost_currency)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER,
      rewind_at INTEGER,
      agent_meta TEXT
    );
  `);
  return db;
}

function dayTs(day: string, hour: number): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime();
}

function insertMessage(
  db: Database.Database,
  id: string,
  ts: number,
  turnCost: unknown,
  rewindAt: number | null = null,
): void {
  db.prepare('INSERT INTO messages (id, created_at, rewind_at, agent_meta) VALUES (?, ?, ?, ?)').run(
    id,
    ts,
    rewindAt,
    JSON.stringify({ turnCost }),
  );
}

const usd = (amount: number) => ({
  amount,
  currency: 'USD',
  approximate: false,
  kind: 'actual-cost',
});

const cny = (amount: number) => ({
  amount,
  currency: 'CNY',
  approximate: false,
  kind: 'actual-cost',
});

function spendRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT day, cost_currency, cost_amount FROM daily_spend ORDER BY day, cost_currency')
    .all() as Array<Record<string, unknown>>;
}

describe('0085 daily_spend rebuild from message ledger', () => {
  it('restores a day total that the old single-row schema had overwritten', () => {
    // 复现真实事故:当天先累计了 CNY,账本币种翻成 USD 后旧写入路径用新金额覆盖整行,
    // 149.13 永久消失、只剩 15.44。消息级 turnCost 从未丢过,据此重建。
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-31', 15.44, 'USD', 1);

    insertMessage(db, 'm1', dayTs('2026-07-31', 9), cny(100));
    insertMessage(db, 'm2', dayTs('2026-07-31', 10), cny(49.13));
    insertMessage(db, 'm3', dayTs('2026-07-31', 20), usd(15.44));

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-31', cost_currency: 'CNY', cost_amount: 149.13 },
      { day: '2026-07-31', cost_currency: 'USD', cost_amount: 15.44 },
    ]);
  });

  it('never lowers an existing total', () => {
    // 有些费用不挂在消息上(scheduler 直接归因、历史 legacy 列),重建拿不到它们。
    // 单调不减:重建只补齐被覆盖掉的部分,不会因为消息侧看不见就抹掉已记的账。
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-30', 500, 'USD', 1);
    insertMessage(db, 'm1', dayTs('2026-07-30', 9), usd(12));

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-30', cost_currency: 'USD', cost_amount: 500 },
    ]);
  });

  it('skips rewound messages', () => {
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-29', 9), usd(10));
    insertMessage(db, 'm2', dayTs('2026-07-29', 10), usd(99), 123);

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-29', cost_currency: 'USD', cost_amount: 10 },
    ]);
  });

  it('is idempotent', () => {
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-28', 9), usd(3));
    insertMessage(db, 'm2', dayTs('2026-07-28', 11), usd(4));

    migration0085.run(db);
    const first = spendRows(db);
    migration0085.run(db);

    expect(spendRows(db)).toEqual(first);
    expect(first).toEqual([{ day: '2026-07-28', cost_currency: 'USD', cost_amount: 7 }]);
  });

  it('ignores malformed or zero money without throwing', () => {
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-27', 9), { amount: 0, currency: 'USD' });
    insertMessage(db, 'm2', dayTs('2026-07-27', 10), { amount: 'nope', currency: 'USD' });
    insertMessage(db, 'm3', dayTs('2026-07-27', 11), { amount: 5, currency: 'JPY' });
    insertMessage(db, 'm4', dayTs('2026-07-27', 12), usd(2));
    db.prepare('INSERT INTO messages (id, created_at, agent_meta) VALUES (?, ?, ?)').run(
      'm5',
      dayTs('2026-07-27', 13),
      '{"turnCost": not json',
    );

    expect(() => migration0085.run(db)).not.toThrow();
    expect(spendRows(db)).toEqual([
      { day: '2026-07-27', cost_currency: 'USD', cost_amount: 2 },
    ]);
  });

  it('does nothing when the messages table has no cost data', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-26', 42, 'USD', 1);

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-26', cost_currency: 'USD', cost_amount: 42 },
    ]);
  });
});
