import type Database from 'better-sqlite3';

/** The session INSERT is produced by Drizzle in createUserSession, after model and directory admission. */
export interface OpenProjectCompanionSessionArgs {
  sessionId: string;
  botId: string;
  insert: { sql: string; params: unknown[] };
}

export function openProjectCompanionSession(db: Database.Database, args: OpenProjectCompanionSessionArgs): void {
  db.transaction(() => {
    db.prepare(args.insert.sql).run(...args.insert.params);
    const binding = db.prepare(
      "INSERT INTO project_task_companions (session_id, bot_id, revision) SELECT ?, id, 1 FROM bot_profiles WHERE id = ? AND status = 'active'",
    ).run(args.sessionId, args.botId);
    if (binding.changes !== 1) throw Object.assign(new Error('Conversation partner unavailable'), { code: 'PRECONDITION_FAILED' });
  })();
}
