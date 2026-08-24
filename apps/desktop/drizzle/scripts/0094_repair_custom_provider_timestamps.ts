import type Database from 'better-sqlite3';

interface ProviderTimestampRow {
  id: string;
  created_at: unknown;
  updated_at: unknown;
  storage_type: string;
}

function finiteInteger(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const integer = Math.trunc(numeric);
  return Number.isSafeInteger(integer) ? integer : null;
}

function normalizeUpdatedAt(value: unknown, createdAt: unknown, now: number): number {
  const numeric = finiteInteger(value);
  if (numeric !== null) return numeric;

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && Number.isSafeInteger(parsed)) return parsed;
  }

  return Math.max(now, finiteInteger(createdAt) ?? 0);
}

function run(db: Database.Database): void {
  let rows: ProviderTimestampRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, created_at, updated_at, typeof(updated_at) AS storage_type
         FROM custom_providers`,
      )
      .all() as ProviderTimestampRow[];
  } catch (error) {
    if (error instanceof Error && /no such table:\s*custom_providers/i.test(error.message)) {
      return;
    }
    throw error;
  }

  const now = Date.now();
  const update = db.prepare('UPDATE custom_providers SET updated_at = ? WHERE id = ?');
  const repair = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeUpdatedAt(row.updated_at, row.created_at, now);
      if (row.storage_type === 'integer' && row.updated_at === normalized) continue;
      update.run(normalized, row.id);
    }
  });
  repair();
}

module.exports = { run };
