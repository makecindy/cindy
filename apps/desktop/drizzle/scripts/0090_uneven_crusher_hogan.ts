import type Database from 'better-sqlite3';

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return info.some((col) => col.name === column);
}

function run(db: Database.Database): void {
  const columns = [
    ['display_name', 'text'],
    ['role', 'text'],
    ['native_name', 'text'],
    ['cost_quality', 'text'],
    ['cost_total_tokens', 'integer'],
    ['cost_input_tokens', 'integer'],
    ['cost_output_tokens', 'integer'],
    ['cost_cache_read_tokens', 'integer'],
    ['cost_cache_create_tokens', 'integer'],
    ['cost_amount', 'real'],
    ['cost_currency', 'text'],
    ['cost_approximate', 'integer'],
    ['cost_frozen_at', 'integer'],
    ['transcript_file', 'text'],
  ] as const;

  for (const [name, type] of columns) {
    if (!columnExists(db, 'subagent_runs', name)) {
      db.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${type}`);
    }
  }
}

module.exports = { run };
