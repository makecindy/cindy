// Host-internal values read under the session route lock, never supplied by the controller.
export interface ProjectArchiveGuard {
  workingDir: string | null;
  projectDir: string | null;
  workspaceKind: string;
  remoteHostId: string | null;
}

// A pin or IM takeover can race even the final route-locked read. Match membership
// and protection in the status transaction, before closing any shared tasks.
export const PROJECT_ARCHIVE_GUARD_SQL = `SELECT 1 FROM sessions s
  WHERE id = ? AND working_dir IS ? AND project_dir IS ? AND workspace_kind = ? AND remote_host_id IS ?
    AND hidden_at IS NULL AND status = ?
    AND (status = 'archived' OR (pinned_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM im_bindings b WHERE b.target_session_id = s.id)))`;
