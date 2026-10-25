import path from 'node:path';
import type Database from 'better-sqlite3';

interface CandidateRow {
  id: string;
  workingDir: string | null;
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function isManagedDialogueWorkspace(rootDir: string, sessionId: string, workingDir: string | null): boolean {
  if (!workingDir) return false;
  const root = path.resolve(rootDir);
  const target = path.resolve(workingDir);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? '') && parts[1] === sessionId;
}

export function repairManagedDialogueWorkspaceSessions(
  db: Database.Database,
  dialogueRootDir: string,
): number {
  const sessionColumns = tableColumnNames(db, 'sessions');
  if (
    !sessionColumns.has('id') ||
    !sessionColumns.has('working_dir') ||
    !sessionColumns.has('workspace_kind')
  ) {
    return 0;
  }

  const candidates = db.prepare(`
    SELECT id, working_dir AS workingDir
    FROM sessions
    WHERE workspace_kind != 'dialogue'
      AND working_dir IS NOT NULL
  `).all() as CandidateRow[];
  const ids = candidates
    .filter((row) => isManagedDialogueWorkspace(dialogueRootDir, row.id, row.workingDir))
    .map((row) => row.id);
  if (ids.length === 0) return 0;

  const update = db.prepare(`
    UPDATE sessions
    SET workspace_kind = 'dialogue'
    WHERE id = ?
      AND workspace_kind != 'dialogue'
  `);
  const tx = db.transaction(() => {
    let changed = 0;
    for (const id of ids) {
      changed += update.run(id).changes;
    }
    return changed;
  });
  return tx();
}
