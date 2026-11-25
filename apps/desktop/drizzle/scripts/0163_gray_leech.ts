import type Database from 'better-sqlite3';

// 存量库可能已经有这一列（早期并入 main 前试用过 stdio 配置），所以按 PRAGMA 判断再加，
// 不依赖 ALTER TABLE 的报错。表不存在时（历史回放夹具只建了部分表）直接跳过。
function run(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_mcp_servers'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(custom_mcp_servers)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'stdio')) db.exec('ALTER TABLE custom_mcp_servers ADD stdio TEXT');
}

module.exports = { run };
