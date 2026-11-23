import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

export interface ScanAggregateRow {
  activeTaskCount: number | null;
  deletedTaskCount: number | null;
  archivedTaskCount: number | null;
  messageCount: number;
  estimatedMessageBytes: number | null;
}

export interface DbSlimmingScanInput {
  dbFilePath: string;
  archivedBeforeMs: number;
  includeActiveTasks: boolean;
  moduleEntry: string;
  nativeBinding?: string;
}

const SCAN_SQL = `WITH target_sessions AS (
           SELECT id, status
             FROM sessions
            WHERE ((status = 'deleted' AND updated_at <= ?)
               OR (status = 'archived' AND updated_at <= ?)
               OR (? = 1 AND status = 'active' AND updated_at <= ?))
              AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)
         )
         SELECT
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'active') AS activeTaskCount,
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'deleted') AS deletedTaskCount,
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'archived') AS archivedTaskCount,
           (SELECT COUNT(*)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS messageCount,
           (SELECT COALESCE(SUM(
                     length(CAST(message.id AS BLOB)) +
                     length(CAST(message.client_id AS BLOB)) +
                     length(CAST(message.role AS BLOB)) +
                     length(CAST(message.content AS BLOB)) +
                     COALESCE(length(CAST(message.tool_use_id AS BLOB)), 0) +
                     COALESCE(length(CAST(message.agent_meta AS BLOB)), 0) +
                     COALESCE(length(CAST(message.agent_kind AS BLOB)), 0)
                   ), 0)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS estimatedMessageBytes`;

/** Runs only in the isolated maintenance process; no factory migrations or writable connection. */
export function readDbSlimmingPreview(input: DbSlimmingScanInput): ScanAggregateRow {
  const DatabaseCtor = createRequire(import.meta.url)(input.moduleEntry) as typeof Database;
  const db = new DatabaseCtor(input.dbFilePath, {
    readonly: true,
    fileMustExist: true,
    ...(input.nativeBinding ? { nativeBinding: input.nativeBinding } : {}),
  });
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 1000');
    return db
      .prepare(SCAN_SQL)
      .get(
        input.archivedBeforeMs,
        input.archivedBeforeMs,
        input.includeActiveTasks ? 1 : 0,
        input.archivedBeforeMs,
      ) as ScanAggregateRow;
  } finally {
    db.close();
  }
}
