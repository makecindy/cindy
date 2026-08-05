/**
 * A scheduler-facing snapshot of a session reference.
 *
 * The main process owns this classification because soft-deleted rows remain in
 * SQLite while ordinary session lists intentionally hide them. Consumers must
 * not infer "openable" from the mere presence of a persisted session id.
 */
export interface SessionReference {
  sessionId: string;
  state: 'available' | 'deleted' | 'missing';
  status?: 'active' | 'archived' | 'deleted';
  title?: string;
  agentKind?: 'cc' | 'codex';
}
