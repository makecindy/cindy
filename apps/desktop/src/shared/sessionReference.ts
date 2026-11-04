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
  agentKind?: 'cc' | 'codex' | 'pi';
  /** Agent 在同账号另一台电脑(或分享来的供应商)上运行时那台的 id;null = 本机。 */
  agentDeviceId?: string | null;
}
