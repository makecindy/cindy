import type Database from 'better-sqlite3';

// 0150 — 幂等添加 orca_workers.latest_report(text, nullable)：列已存在则 no-op，缺失则补。
// ⚠ 本脚本必须保持 CommonJS(function + module.exports)，禁止顶层 ESM export /
// value import——生产 Electron 以 raw 形式 require() 加载。
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const workerColumns = new Set(tableColumnNames(db, 'orca_workers'));
  if (workerColumns.size === 0) {
    // 表不存在(0040 之前的残缺合成库):0150 的前置条件是真实库自 0040 起必有
    // orca_workers,这里守卫跳过,保证迁移链能走完。
    return;
  }
  if (!workerColumns.has('latest_report')) {
    db.exec('ALTER TABLE orca_workers ADD COLUMN latest_report text');
  }
}

module.exports = { run };
