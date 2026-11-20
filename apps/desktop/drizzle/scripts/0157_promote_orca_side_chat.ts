import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const has = (table: string, ...names: string[]) => {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table);
    return names.every(name => columns.includes(name));
  };
  if (has('sessions', 'id') && !has('sessions', 'side_chat_promoted')) {
    db.exec('ALTER TABLE sessions ADD side_chat_promoted integer DEFAULT false NOT NULL');
  }
  if (!has('sessions', 'source', 'status', 'side_chat_promoted') || !has('orca_teams', 'id', 'lead_session_id', 'status')
      || !has('orca_workers', 'team_id')) return;
  db.exec(`
    UPDATE sessions SET side_chat_promoted = 1
    WHERE source = 'side-chat' AND status <> 'deleted'
      AND id IN (
        SELECT team.lead_session_id
        FROM orca_teams team
        WHERE team.status IN ('active', 'completed', 'cancelled')
          AND EXISTS (SELECT 1 FROM orca_workers worker WHERE worker.team_id = team.id)
      )
  `);
}

module.exports = { run };
