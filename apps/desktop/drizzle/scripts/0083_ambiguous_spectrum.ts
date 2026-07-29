import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_mcp_servers'")
    .get();
  if (!table) return;

  const columns = new Set(
    db
      .prepare('PRAGMA table_info(custom_mcp_servers)')
      .all()
      .map((column: { name: string }) => column.name),
  );
  if (!columns.has('command'))
    db.exec("ALTER TABLE custom_mcp_servers ADD COLUMN command TEXT NOT NULL DEFAULT ''");
  if (!columns.has('args'))
    db.exec("ALTER TABLE custom_mcp_servers ADD COLUMN args TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('cwd'))
    db.exec("ALTER TABLE custom_mcp_servers ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
}

module.exports = { run };
