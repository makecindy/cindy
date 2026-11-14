import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_mcp_servers'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(custom_mcp_servers)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'stdio')) db.exec('ALTER TABLE custom_mcp_servers ADD stdio TEXT');
}

module.exports = { run };
