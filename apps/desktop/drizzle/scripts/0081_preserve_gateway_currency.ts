import type Database from 'better-sqlite3';

const USD_TO_CNY_FIXED_RATE = 6.7;

interface TableInfoRow {
  name: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function tableColumnNames(
  db: Database.Database,
  tableName: string,
): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info('${tableName}')`).all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  );
}

function relabelMoneyColumns(
  db: Database.Database,
  tableName: string,
  amountColumn: string,
  currencyColumn: string,
  approximateColumn: string,
  alwaysConvertedColumns: string[],
): void {
  if (!tableExists(db, tableName)) return;
  const columns = tableColumnNames(db, tableName);
  if (
    !columns.has(amountColumn) ||
    !columns.has(currencyColumn) ||
    !columns.has(approximateColumn)
  ) {
    return;
  }
  for (const column of alwaysConvertedColumns) {
    if (!columns.has(column)) continue;
    db.prepare(
      `UPDATE ${tableName} SET ${column} = ${column} / ${USD_TO_CNY_FIXED_RATE} WHERE ${currencyColumn} = 'CNY'`,
    ).run();
  }
  db.prepare(
    `UPDATE ${tableName} SET ${amountColumn} = ${amountColumn} / ${USD_TO_CNY_FIXED_RATE} WHERE ${currencyColumn} = 'CNY' AND ${approximateColumn} = 1`,
  ).run();
  db.prepare(
    `UPDATE ${tableName} SET ${currencyColumn} = 'USD' WHERE ${currencyColumn} = 'CNY'`,
  ).run();
}

interface MoneyLike {
  amount?: unknown;
  currency?: unknown;
  approximate?: unknown;
  estimateReasons?: unknown;
}

function relabelMoneyObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const money = value as MoneyLike;
  if (money.currency !== 'CNY') return false;
  if (typeof money.amount !== 'number' || !Number.isFinite(money.amount)) {
    return false;
  }
  if (money.approximate === true) {
    money.amount = money.amount / USD_TO_CNY_FIXED_RATE;
  }
  money.currency = 'USD';
  if (Array.isArray(money.estimateReasons)) {
    const reasons = money.estimateReasons.filter(
      (reason) => reason !== 'fixed-fx',
    );
    if (reasons.length > 0) {
      money.estimateReasons = reasons;
    } else {
      delete money.estimateReasons;
    }
  }
  return true;
}

function relabelMessageAgentMeta(db: Database.Database): void {
  if (!tableExists(db, 'messages')) return;
  const columns = tableColumnNames(db, 'messages');
  if (!columns.has('id') || !columns.has('agent_meta')) return;
  const rows = db
    .prepare(
      `SELECT id, agent_meta FROM messages WHERE agent_meta LIKE '%"currency":"CNY"%'`,
    )
    .all() as Array<{ id: string; agent_meta: string | null }>;
  const update = db.prepare('UPDATE messages SET agent_meta = ? WHERE id = ?');
  for (const row of rows) {
    if (!row.agent_meta) continue;
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.agent_meta) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    let changed = false;
    changed = relabelMoneyObject(meta.turnCost) || changed;
    changed = relabelMoneyObject(meta.userTurnCost) || changed;
    const details = meta.turnUsageDetails;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const perModelCost = (details as Record<string, unknown>).perModelCost;
      if (Array.isArray(perModelCost)) {
        for (const entry of perModelCost) {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            changed =
              relabelMoneyObject((entry as Record<string, unknown>).money) ||
              changed;
          }
        }
      }
    }
    if (changed) {
      update.run(JSON.stringify(meta), row.id);
    }
  }
}

function run(db: Database.Database): void {
  db.transaction(() => {
    relabelMoneyColumns(
      db,
      'daily_spend',
      'cost_amount',
      'cost_currency',
      'cost_is_approximate',
      [],
    );
    relabelMoneyColumns(
      db,
      'daily_model_usage',
      'cost_amount',
      'cost_currency',
      'cost_is_approximate',
      [],
    );
    relabelMoneyColumns(
      db,
      'sessions',
      'total_cost_amount',
      'total_cost_currency',
      'total_cost_is_approximate',
      [],
    );
    relabelMoneyColumns(
      db,
      'schedule_runs',
      'cost_amount',
      'cost_currency',
      'cost_is_approximate',
      ['estimated_value_amount'],
    );
    relabelMessageAgentMeta(db);
  })();
}

module.exports = { run };
