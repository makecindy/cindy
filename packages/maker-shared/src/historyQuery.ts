/** Read-only history contract shared by local queries and device-link consumers. */
export interface HistoryCursor {
  createdAt: number; // unix ms
  id: string;
  /** SQLite insertion-order tie-breaker for message history cursors. */
  rowid?: number;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor: HistoryCursor | null;
  hasMore: boolean;
}

export interface HistoryMessage {
  id: string;
  /** Stable send/terminal identity, distinct from the storage row ID. */
  clientId?: string;
  sessionId: string;
  sessionWorkingDir: string | null;
  sessionAgentKind: string;
  sessionTitle: string;
  role: string;
  content: unknown; // JSON.parse 后原样
  toolUseId: string | null;
  agentMeta: unknown; // JSON.parse 后原样 (可能 null)
  createdAt: number; // unix ms
  rewindAt: number | null;
}

