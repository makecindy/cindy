import type Database from 'better-sqlite3';
import type { PluginUsageHandle, PluginUsageTransaction } from '../../../../shared/pluginUsage.js';

/** Self-contained for file worker, inline worker and in-process transport. */
export function runPluginUsageTransaction(
  db: Database.Database,
  raw: unknown,
): PluginUsageHandle | null {
  const body = raw as PluginUsageTransaction;
  return db.transaction(() => {
    switch (body.action) {
      case 'bind': {
        const identity = body.identity;
        let row = (
          identity.stableKey
            ? db
                .prepare(
                  'SELECT id,history_generation AS historyGeneration FROM plugin_usage_subjects WHERE stable_key=?',
                )
                .get(identity.stableKey)
            : db
                .prepare(
                  "SELECT id,history_generation AS historyGeneration FROM plugin_usage_subjects WHERE ghost_id=? AND source_kind='manual' AND binding_revision=?",
                )
                .get(identity.ghostId, body.previousRevision ?? identity.revision)
        ) as { id: string; historyGeneration: number } | undefined;
        if (!row) {
          db.prepare(
            `INSERT INTO plugin_usage_subjects
            (id,stable_key,source_kind,plugin_id,organization_id,source_key,server_root,ghost_id,display_name,binding_revision,recording_started_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            body.newId,
            identity.stableKey,
            identity.sourceKind,
            identity.pluginId,
            identity.organizationId,
            identity.sourceKey,
            identity.serverRoot,
            identity.ghostId,
            identity.displayName,
            identity.revision,
            body.now,
          );
          row = { id: body.newId, historyGeneration: 0 };
        } else {
          db.prepare(
            'UPDATE plugin_usage_subjects SET display_name=?,binding_revision=? WHERE id=?',
          ).run(identity.displayName, identity.revision, row.id);
        }
        return { subjectId: row.id, historyGeneration: row.historyGeneration, identity };
      }
      case 'accept': {
        const { handle, callId, toolName, sessionId, occurredAt, entryKind = 'tool' } = body;
        db.prepare(
          `INSERT OR IGNORE INTO plugin_usage_events
          (call_id,subject_id,history_generation,occurred_at,tool_name,entry_kind,session_id,version,release_id,report_target,report_state)
          SELECT ?,id,history_generation,?,?,?,?,?,?,?,? FROM plugin_usage_subjects WHERE id=? AND history_generation=?`,
        ).run(
          callId,
          occurredAt,
          toolName,
          entryKind,
          sessionId,
          handle.identity.version,
          handle.identity.releaseId,
          handle.reportTarget ? JSON.stringify(handle.reportTarget) : null,
          handle.reportTarget ? 'pending' : 'not-applicable',
          handle.subjectId,
          handle.historyGeneration,
        );
        const row = db
          .prepare(
            'SELECT history_generation AS historyGeneration FROM plugin_usage_subjects WHERE id=?',
          )
          .get(handle.subjectId) as { historyGeneration: number } | undefined;
        return row ? { ...handle, historyGeneration: row.historyGeneration } : null;
      }
      case 'settle':
        db.prepare(
          'UPDATE plugin_usage_events SET outcome=? WHERE call_id=? AND subject_id=? AND history_generation=?',
        ).run(body.outcome, body.callId, body.handle.subjectId, body.handle.historyGeneration);
        return null;
      case 'clear':
        db.prepare(
          'UPDATE plugin_usage_subjects SET history_generation=history_generation+1,recording_started_at=? WHERE (? IS NULL OR id=?)',
        ).run(body.now, body.subjectId, body.subjectId);
        db.prepare('DELETE FROM plugin_usage_events WHERE (? IS NULL OR subject_id=?)').run(
          body.subjectId,
          body.subjectId,
        );
        return null;
      case 'detach':
        db.prepare('UPDATE plugin_usage_subjects SET binding_revision=NULL WHERE ghost_id=?').run(
          body.ghostId,
        );
        return null;
      case 'report': {
        const update =
          db.prepare(`UPDATE plugin_usage_events SET report_state=?,next_attempt_at=?,attempt_count=attempt_count+1
          WHERE call_id=? AND subject_id=? AND history_generation=? AND report_target=? AND report_state='pending'
          AND EXISTS (SELECT 1 FROM plugin_usage_subjects s WHERE s.id=subject_id AND s.history_generation=plugin_usage_events.history_generation)`);
        for (const { row, state, nextAttemptAt } of body.updates)
          update.run(
            state,
            nextAttemptAt,
            row.callId,
            row.subjectId,
            row.historyGeneration,
            row.reportTarget,
          );
        return null;
      }
    }
  })();
}
