import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const taskTables = db.prepare(`SELECT count(*) FROM sqlite_master
    WHERE type = 'table' AND name IN ('messages', 'sessions')`).pluck().get();
  if (taskTables !== 2) return;

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_purge_deleted_history
    AFTER UPDATE OF status ON sessions WHEN NEW.status = 'deleted'
    BEGIN
      INSERT INTO deleted_chat_vector_rows (rowid)
        SELECT j.rowid FROM messages m JOIN embedding_jobs j ON j.source_id = m.id
        WHERE m.session_id = NEW.id AND j.source = 'chat';
      DELETE FROM embedding_jobs WHERE source = 'chat' AND source_id IN (
        SELECT id FROM messages WHERE session_id = NEW.id
      );
      DELETE FROM auto_review_projections WHERE session_id = NEW.id OR lead_id = NEW.id;
      DELETE FROM mcp_app_view_states WHERE session_id = NEW.id;
      DELETE FROM messages WHERE session_id = NEW.id;
      DELETE FROM subagent_runs WHERE session_id = NEW.id;
      DELETE FROM session_goals WHERE session_id = NEW.id;
      DELETE FROM agent_input_queue_snapshots WHERE session_id = NEW.id;
      UPDATE sessions SET title = '', summary = NULL, list_preview = NULL, list_preview_role = NULL,
        list_message_count = 0, codex_plan_json = NULL, sdk_session_id = NULL WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS sessions_scrub_late_deleted_preview
    AFTER UPDATE OF title, summary, list_preview, list_preview_role, list_message_count, codex_plan_json, sdk_session_id ON sessions
    WHEN NEW.status = 'deleted' AND (NEW.title <> '' OR NEW.summary IS NOT NULL OR NEW.list_preview IS NOT NULL
      OR NEW.list_preview_role IS NOT NULL OR NEW.list_message_count IS NOT 0
      OR NEW.codex_plan_json IS NOT NULL OR NEW.sdk_session_id IS NOT NULL)
    BEGIN
      UPDATE sessions SET status = 'deleted' WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS sessions_scrub_inserted_tombstone
    AFTER INSERT ON sessions WHEN NEW.status = 'deleted'
    BEGIN
      UPDATE sessions SET status = 'deleted' WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS auto_review_skip_deleted_task BEFORE INSERT ON auto_review_projections
    WHEN (SELECT status FROM sessions WHERE id = NEW.session_id) = 'deleted'
      OR (SELECT status FROM sessions WHERE id = NEW.lead_id) = 'deleted'
    BEGIN SELECT RAISE(IGNORE); END;

    CREATE TRIGGER IF NOT EXISTS embedding_jobs_skip_missing_chat BEFORE INSERT ON embedding_jobs
    WHEN NEW.source = 'chat' AND NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.source_id)
    BEGIN SELECT RAISE(IGNORE); END;
  `);
  for (const table of ['messages', 'subagent_runs', 'session_goals', 'agent_input_queue_snapshots']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_reject_deleted_task BEFORE INSERT ON ${table}
      WHEN (SELECT status FROM sessions WHERE id = NEW.session_id) = 'deleted'
      BEGIN SELECT RAISE(ABORT, 'Cannot write history to a deleted task'); END`);
  }

  db.exec("UPDATE sessions SET status = 'deleted' WHERE status = 'deleted'");
  if (db.prepare("SELECT 1 FROM pragma_module_list WHERE name = 'vec0'").get()
      && db.prepare('SELECT 1 FROM deleted_chat_vector_rows LIMIT 1').get()) {
    db.exec('DELETE FROM chat_messages_vec_v1 WHERE rowid IN (SELECT rowid FROM deleted_chat_vector_rows)');
    db.exec('DELETE FROM deleted_chat_vector_rows');
  }
}

module.exports = { run };
