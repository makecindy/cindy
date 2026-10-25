export function worktreeReferenceQuery(db: {
  prepare(sql: string): { all(): unknown[] };
}): string {
  const info = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  const columns = new Set(info.map((column) => column.name));
  const hasWorktree = columns.has("worktree_path");
  const hasSource = columns.has("source");
  const hasRemote = columns.has("remote_host_id");
  // These columns were added in 0005, 0007 and 0038 respectively. Unknown
  // layouts must not silently become an incomplete set of deletion evidence.
  if (
    !["id", "status", "working_dir"].every((name) => columns.has(name)) ||
    (hasSource && !hasWorktree) ||
    (hasRemote && !hasSource)
  ) {
    throw new Error("unsupported task reference schema");
  }
  // Keep every legacy row protective, including terminal rows: missing metadata
  // is not evidence that a directory can be deleted. No other owner's DB is migrated.
  const status = hasRemote ? "status" : "NULL";
  return (
    `SELECT id, ${status} AS status, ${hasSource ? "source" : "NULL"} AS source, ` +
    `working_dir AS workingDir, ${hasWorktree ? "worktree_path" : "NULL"} AS worktreePath ` +
    `FROM sessions${hasRemote ? " WHERE remote_host_id IS NULL" : ""}`
  );
}
