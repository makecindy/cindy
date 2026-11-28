import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  const names = new Set(columns.map(column => column.name));
  if (!names.has('primary_host_key')) {
    db.exec('ALTER TABLE schedules ADD COLUMN primary_host_key TEXT');
  }
  if (!names.has('name') || !names.has('prompt') || !names.has('execution_mode')) return;

  db.exec(`
    UPDATE schedules SET primary_host_key = 'public/cindy-contacts'
    WHERE primary_host_key IS NULL AND coalesce(execution_mode, 'agent') = 'agent'
      AND instr(prompt, 'cindy-contacts') > 0 AND instr(prompt, 'maintenance') > 0
      AND instr(prompt, 'begin') > 0 AND instr(prompt, 'run_id') > 0
      AND (name IN ('整理通讯录', 'Tidy up contacts', '連絡先を整理', '연락처 정리') OR prompt LIKE '整理我的通讯录（cindy-contacts 插件）。%')
      AND instr(prompt, 'namespace 传「') = 0
      AND instr(prompt, '不要传 namespace') = 0
  `);
}

module.exports = { run };
