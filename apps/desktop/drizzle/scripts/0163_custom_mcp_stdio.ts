import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('custom_mcp_servers')").all() as { name: string }[]).map(row => row.name),
  );
  if (columns.size === 0) return;
  if (!columns.has('command')) db.exec('ALTER TABLE custom_mcp_servers ADD COLUMN command text');
  if (!columns.has('args')) db.exec("ALTER TABLE custom_mcp_servers ADD COLUMN args text DEFAULT '[]' NOT NULL");
  if (!columns.has('cwd')) db.exec('ALTER TABLE custom_mcp_servers ADD COLUMN cwd text');
  if (!columns.has('env')) db.exec("ALTER TABLE custom_mcp_servers ADD COLUMN env text DEFAULT '{}' NOT NULL");
}

module.exports = { run };
