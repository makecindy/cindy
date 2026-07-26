import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  HeadlessAgentKind,
  HeadlessSessionMeta,
  HeadlessSessionStatus,
  HeadlessSessionEvent,
  HeadlessSessionEventSource,
  HeadlessSessionEventStorage,
  HeadlessSessionStorageContract,
  HeadlessWorkspaceKind,
  HeadlessInputQueueState,
  HeadlessQueuedInput,
  HeadlessHistoryMessage,
  HeadlessHistoryStorage,
} from './session-types.js';

type SessionRow = {
  id: string;
  agent_kind: HeadlessAgentKind;
  provider_id: string | null;
  work_dir: string;
  title: string;
  status: HeadlessSessionStatus | null;
  pinned_at: number | null;
  model: string;
  workspace_kind: HeadlessWorkspaceKind | null;
  effort: HeadlessSessionMeta['effort'] | null;
  permission_mode: HeadlessSessionMeta['permissionMode'] | null;
  fast_mode: number;
  sdk_session_id: string | null;
  parent_session_id: string | null;
  remote_host_id: string | null;
  extra_dirs_json: string | null;
  orca_role: 'lead' | 'worker' | null;
  pending_handoff: string | null;
  created_at: number;
  updated_at: number;
};

function toMeta(row: SessionRow): HeadlessSessionMeta {
  return {
    id: row.id,
    agentKind: row.agent_kind,
    providerId: row.provider_id ?? undefined,
    workDir: row.work_dir,
    title: row.title,
    status: row.status ?? 'active',
    pinnedAt: row.pinned_at,
    model: row.model,
    workspaceKind: row.workspace_kind ?? undefined,
    effort: row.effort ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    fastMode: row.fast_mode === 1,
    sdkSessionId: row.sdk_session_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    remoteHostId: row.remote_host_id ?? undefined,
    extraDirs: parseExtraDirs(row.extra_dirs_json),
    orcaRole: row.orca_role ?? undefined,
    pendingHandoff: row.pending_handoff ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed SessionStorage for the headless host; it deliberately owns no product UI state. */
export class HeadlessSessionStorage implements HeadlessSessionStorageContract, HeadlessSessionEventStorage, HeadlessSessionEventSource, HeadlessHistoryStorage {
  private readonly db: Database.Database;
  private readonly eventListeners = new Set<(event: HeadlessSessionEvent) => void>();

  constructor(databaseFile: string) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_sessions (
        id TEXT PRIMARY KEY,
        agent_kind TEXT NOT NULL,
        provider_id TEXT,
        work_dir TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pinned_at INTEGER,
        model TEXT NOT NULL,
        workspace_kind TEXT,
        effort TEXT,
        permission_mode TEXT,
        fast_mode INTEGER NOT NULL DEFAULT 0,
        sdk_session_id TEXT,
        parent_session_id TEXT,
        remote_host_id TEXT,
        extra_dirs_json TEXT NOT NULL DEFAULT '[]',
        orca_role TEXT,
        pending_handoff TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ensureProviderColumn();
    this.ensureOrcaRoleColumn();
    this.ensureSessionMetadataColumns();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES headless_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS headless_session_events_by_session_sequence
        ON headless_session_events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS headless_history_messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_sequence INTEGER,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        agent_meta_json TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        rewind_at INTEGER,
        UNIQUE(session_id, client_id),
        UNIQUE(event_sequence),
        FOREIGN KEY (session_id) REFERENCES headless_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS headless_history_messages_visible
        ON headless_history_messages(session_id, created_at, event_sequence)
        WHERE deleted_at IS NULL AND rewind_at IS NULL;
      CREATE TABLE IF NOT EXISTS headless_input_queue (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'active')),
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, client_id),
        FOREIGN KEY (session_id) REFERENCES headless_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS headless_input_queue_by_session_position
        ON headless_input_queue(session_id, position);
      CREATE TABLE IF NOT EXISTS headless_input_queue_state (
        session_id TEXT PRIMARY KEY,
        queue_paused INTEGER NOT NULL DEFAULT 0,
        queue_expanded INTEGER NOT NULL DEFAULT 0,
        interaction_locks_json TEXT NOT NULL DEFAULT '[]',
        edit_locks_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (session_id) REFERENCES headless_sessions(id)
      );
    `);
    this.backfillHistoryProjection();
  }

  /**
   * Headless storage is private to this new host, so its small schema is
   * versioned in-place.  The guard keeps databases created by pre-release
   * builds readable without touching Desktop's migration system.
   */
  private ensureProviderColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(headless_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'provider_id')) {
      this.db.exec('ALTER TABLE headless_sessions ADD COLUMN provider_id TEXT');
    }
  }

  private ensureOrcaRoleColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(headless_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'orca_role')) {
      this.db.exec('ALTER TABLE headless_sessions ADD COLUMN orca_role TEXT');
    }
  }

  /** Private headless schema evolves in place; existing daemon databases keep their history. */
  private ensureSessionMetadataColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(headless_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'status')) {
      this.db.exec("ALTER TABLE headless_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    }
    if (!columns.some((column) => column.name === 'pinned_at')) {
      this.db.exec('ALTER TABLE headless_sessions ADD COLUMN pinned_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'extra_dirs_json')) {
      this.db.exec("ALTER TABLE headless_sessions ADD COLUMN extra_dirs_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.some((column) => column.name === 'pending_handoff')) {
      this.db.exec('ALTER TABLE headless_sessions ADD COLUMN pending_handoff TEXT');
    }
  }

  async create(meta: Omit<HeadlessSessionMeta, 'createdAt' | 'updatedAt'>): Promise<HeadlessSessionMeta> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO headless_sessions (
        id, agent_kind, provider_id, work_dir, title, status, pinned_at, model, workspace_kind, effort,
        permission_mode, fast_mode, sdk_session_id, parent_session_id,
        remote_host_id, extra_dirs_json, orca_role, pending_handoff, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meta.id,
      meta.agentKind,
      meta.providerId ?? null,
      meta.workDir,
      meta.title,
      meta.status ?? 'active',
      meta.pinnedAt ?? null,
      meta.model,
      meta.workspaceKind ?? null,
      meta.effort ?? null,
      meta.permissionMode ?? null,
      meta.fastMode ? 1 : 0,
      meta.sdkSessionId ?? null,
      meta.parentSessionId ?? null,
      meta.remoteHostId ?? null,
      JSON.stringify(meta.extraDirs ?? []),
      meta.orcaRole ?? null,
      meta.pendingHandoff ?? null,
      now,
      now,
    );
    return { ...meta, createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<HeadlessSessionMeta | null> {
    const row = this.db.prepare('SELECT * FROM headless_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toMeta(row) : null;
  }

  async list(): Promise<HeadlessSessionMeta[]> {
    const rows = this.db.prepare('SELECT * FROM headless_sessions ORDER BY updated_at DESC').all() as SessionRow[];
    return rows.map(toMeta);
  }

  async update(id: string, patch: Partial<HeadlessSessionMeta>): Promise<HeadlessSessionMeta> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown session: ${id}`);
    const next = { ...current, ...patch, id, updatedAt: Date.now() };
    this.db.prepare(`
      UPDATE headless_sessions SET
        agent_kind = ?, provider_id = ?, work_dir = ?, title = ?, status = ?, pinned_at = ?, model = ?, workspace_kind = ?,
        effort = ?, permission_mode = ?, fast_mode = ?, sdk_session_id = ?,
        parent_session_id = ?, remote_host_id = ?, extra_dirs_json = ?, orca_role = ?, pending_handoff = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.agentKind,
      next.providerId ?? null,
      next.workDir,
      next.title,
      next.status ?? 'active',
      next.pinnedAt ?? null,
      next.model,
      next.workspaceKind ?? null,
      next.effort ?? null,
      next.permissionMode ?? null,
      next.fastMode ? 1 : 0,
      next.sdkSessionId ?? null,
      next.parentSessionId ?? null,
      next.remoteHostId ?? null,
      JSON.stringify(next.extraDirs ?? []),
      next.orcaRole ?? null,
      next.pendingHandoff ?? null,
      next.updatedAt,
      id,
    );
    return next;
  }

  async compareAndClearSdkSessionId(id: string, expectedSdkSessionId: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE headless_sessions SET sdk_session_id = NULL, updated_at = ?
      WHERE id = ? AND sdk_session_id = ?
    `).run(Date.now(), id, expectedSdkSessionId);
    return result.changes === 1;
  }

  async delete(id: string): Promise<void> {
    const remove = this.db.transaction((sessionId: string) => {
      this.db.prepare('DELETE FROM headless_session_events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM headless_history_messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM headless_sessions WHERE id = ?').run(sessionId);
    });
    remove(id);
  }

  async appendEvent(sessionId: string, type: string, data: unknown): Promise<HeadlessSessionEvent> {
    const createdAt = Date.now();
    const normalized = normalizeEventPayload(type, data);
    const payloadJson = JSON.stringify(normalized ?? null);
    const result = this.db.prepare(`
      INSERT INTO headless_session_events (session_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, type, payloadJson, createdAt);
    const sequence = Number(result.lastInsertRowid);
    const eventData = withEventClientId(type, normalized, sequence);
    if (eventData !== normalized) {
      this.db.prepare('UPDATE headless_session_events SET payload_json = ? WHERE sequence = ?')
        .run(JSON.stringify(eventData), sequence);
    }
    const event = {
      sequence,
      sessionId,
      type,
      data: eventData ?? null,
      createdAt,
    };
    this.insertHistoryProjection(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Event persistence is the source of truth; a transport listener must
        // never make the daemon lose a durable event.
      }
    }
    return event;
  }

  /** Rebuild the queryable history index for databases created before it existed. */
  private backfillHistoryProjection(): void {
    const rows = this.db.prepare(`SELECT sequence, session_id, event_type, payload_json, created_at
      FROM headless_session_events ORDER BY sequence ASC`).all() as Array<{
        sequence: number; session_id: string; event_type: string; payload_json: string; created_at: number;
      }>;
    const project = this.db.transaction((events: typeof rows) => {
      for (const row of events) {
        const exists = this.db.prepare('SELECT 1 FROM headless_history_messages WHERE event_sequence = ?').get(row.sequence);
        if (exists) continue;
        this.insertHistoryProjection({
          sequence: row.sequence,
          sessionId: row.session_id,
          type: row.event_type,
          data: parseEventPayload(row.payload_json),
          createdAt: row.created_at,
        });
      }
    });
    project(rows);
  }

  private insertHistoryProjection(event: HeadlessSessionEvent): void {
    const projection = projectHistoryMessage(event);
    if (!projection) return;
    this.db.prepare(`INSERT OR IGNORE INTO headless_history_messages
      (id, client_id, session_id, event_sequence, role, content_json, agent_meta_json, created_at, deleted_at, rewind_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(
        projection.id,
        projection.clientId,
        event.sessionId,
        event.sequence,
        projection.role,
        JSON.stringify(projection.content ?? null),
        projection.agentMeta ? JSON.stringify(projection.agentMeta) : null,
        event.createdAt,
      );
  }

  onEvent(listener: (event: HeadlessSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async listEvents(sessionId: string, afterSequence = 0, limit = 100): Promise<HeadlessSessionEvent[]> {
    const safeAfter = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1_000) : 100;
    const rows = this.db.prepare(`
      SELECT sequence, session_id, event_type, payload_json, created_at
      FROM headless_session_events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(sessionId, safeAfter, safeLimit) as Array<{
      sequence: number;
      session_id: string;
      event_type: string;
      payload_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      sessionId: row.session_id,
      type: row.event_type,
      data: parseEventPayload(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  async listHistoryMessages(sessionId: string, options: { includeHidden?: boolean } = {}): Promise<HeadlessHistoryMessage[]> {
    const rows = this.db.prepare(`
      SELECT * FROM headless_history_messages WHERE session_id = ?
      ${options.includeHidden ? '' : 'AND deleted_at IS NULL AND rewind_at IS NULL'}
      ORDER BY created_at ASC, COALESCE(event_sequence, 0) ASC
    `).all(sessionId) as HistoryRow[];
    return rows.map(historyRow);
  }

  async listAllHistoryMessages(): Promise<HeadlessHistoryMessage[]> {
    const rows = this.db.prepare(`SELECT * FROM headless_history_messages
      WHERE deleted_at IS NULL AND rewind_at IS NULL
      ORDER BY created_at ASC, COALESCE(event_sequence, 0) ASC`).all() as HistoryRow[];
    return rows.map(historyRow);
  }

  async getHistoryMessage(sessionId: string, clientId: string, options: { includeHidden?: boolean } = {}): Promise<HeadlessHistoryMessage | null> {
    const row = this.db.prepare(`
      SELECT * FROM headless_history_messages WHERE session_id = ? AND client_id = ?
      ${options.includeHidden ? '' : 'AND deleted_at IS NULL AND rewind_at IS NULL'}
      LIMIT 1
    `).get(sessionId, clientId) as HistoryRow | undefined;
    return row ? historyRow(row) : null;
  }

  async replaceHistoryContent(sessionId: string, clientId: string, content: unknown): Promise<void> {
    this.db.prepare(`UPDATE headless_history_messages SET content_json = ? WHERE session_id = ? AND client_id = ?`)
      .run(JSON.stringify(content ?? null), sessionId, clientId);
  }

  async deleteHistoryMessages(sessionId: string, clientIds: string[], handoff: string): Promise<void> {
    if (clientIds.length === 0) return;
    const now = Date.now();
    const operation = this.db.transaction((ids: string[]) => {
      const placeholders = ids.map(() => '?').join(', ');
      this.db.prepare(`UPDATE headless_history_messages SET deleted_at = ?
        WHERE session_id = ? AND client_id IN (${placeholders}) AND deleted_at IS NULL AND rewind_at IS NULL`)
        .run(now, sessionId, ...ids);
      this.db.prepare('UPDATE headless_sessions SET sdk_session_id = NULL, pending_handoff = ?, updated_at = ? WHERE id = ?')
        .run(handoff, now, sessionId);
    });
    operation(clientIds);
  }

  async rewindHistoryMessages(sessionId: string, fromClientId: string): Promise<string[]> {
    const target = await this.getHistoryMessage(sessionId, fromClientId);
    if (!target) throw new Error('Message not found or no longer visible');
    const now = Date.now();
    const operation = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT client_id FROM headless_history_messages
        WHERE session_id = ? AND deleted_at IS NULL AND rewind_at IS NULL
        AND (created_at > ? OR (created_at = ? AND COALESCE(event_sequence, 0) >= COALESCE(?, 0)))
        ORDER BY created_at ASC, COALESCE(event_sequence, 0) ASC`).all(
        sessionId, target.createdAt, target.createdAt, target.eventSequence,
      ) as Array<{ client_id: string }>;
      this.db.prepare(`UPDATE headless_history_messages SET rewind_at = ?
        WHERE session_id = ? AND deleted_at IS NULL AND rewind_at IS NULL
        AND (created_at > ? OR (created_at = ? AND COALESCE(event_sequence, 0) >= COALESCE(?, 0)))`)
        .run(now, sessionId, target.createdAt, target.createdAt, target.eventSequence);
      return rows.map((row) => row.client_id);
    });
    return operation();
  }

  async forkHistoryMessages(sourceSessionId: string, targetSessionId: string, throughClientId: string | null, uuidMap: ReadonlyMap<string, string> = new Map()): Promise<void> {
    const source = await this.listHistoryMessages(sourceSessionId);
    const end = throughClientId === null ? -1 : source.findIndex((message) => message.clientId === throughClientId);
    if (throughClientId !== null && end < 0) throw new Error('Fork source message not found');
    const selected = end < 0 ? [] : source.slice(0, end + 1);
    const now = Date.now();
    const operation = this.db.transaction((messages: HeadlessHistoryMessage[]) => {
      const insert = this.db.prepare(`INSERT INTO headless_history_messages
        (id, client_id, session_id, event_sequence, role, content_json, agent_meta_json, created_at, deleted_at, rewind_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`);
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        insert.run(randomUUID(), randomUUID(), targetSessionId, message.role,
          JSON.stringify(message.content ?? null),
          message.agentMeta ? JSON.stringify(remapUuids(message.agentMeta, uuidMap)) : null,
          now + index,
        );
      }
    });
    operation(selected);
  }

  async listInputQueue(sessionId: string): Promise<HeadlessQueuedInput[]> {
    const rows = this.db.prepare(`
      SELECT session_id, client_id, payload_json, state, position, created_at, updated_at
      FROM headless_input_queue WHERE session_id = ? ORDER BY position ASC
    `).all(sessionId) as Array<{
      session_id: string; client_id: string; payload_json: string; state: 'queued' | 'active';
      position: number; created_at: number; updated_at: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      clientId: row.client_id,
      payload: parseQueuePayload(row.payload_json),
      state: row.state,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async enqueueInput(sessionId: string, clientId: string, payload: Record<string, unknown>): Promise<HeadlessQueuedInput> {
    const existing = (await this.listInputQueue(sessionId)).find((item) => item.clientId === clientId);
    if (existing) return existing;
    const now = Date.now();
    const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM headless_input_queue WHERE session_id = ?')
      .get(sessionId) as { max_position: number };
    const position = max.max_position + 1;
    this.db.prepare(`
      INSERT INTO headless_input_queue (session_id, client_id, payload_json, state, position, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `).run(sessionId, clientId, JSON.stringify(payload), position, now, now);
    return { sessionId, clientId, payload, state: 'queued', position, createdAt: now, updatedAt: now };
  }

  async setInputState(sessionId: string, clientId: string, state: HeadlessQueuedInput['state']): Promise<void> {
    this.db.prepare('UPDATE headless_input_queue SET state = ?, updated_at = ? WHERE session_id = ? AND client_id = ?')
      .run(state, Date.now(), sessionId, clientId);
  }

  async removeInput(sessionId: string, clientId: string): Promise<void> {
    this.db.prepare('DELETE FROM headless_input_queue WHERE session_id = ? AND client_id = ?').run(sessionId, clientId);
  }

  async clearInputQueue(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM headless_input_queue WHERE session_id = ?').run(sessionId);
  }

  async updateInput(sessionId: string, clientId: string, payload: Record<string, unknown>): Promise<void> {
    this.db.prepare('UPDATE headless_input_queue SET payload_json = ?, updated_at = ? WHERE session_id = ? AND client_id = ? AND state = \'queued\'')
      .run(JSON.stringify(payload), Date.now(), sessionId, clientId);
  }

  async moveInput(sessionId: string, clientId: string, targetIndex: number): Promise<void> {
    const queued = (await this.listInputQueue(sessionId)).filter((item) => item.state === 'queued');
    const source = queued.findIndex((item) => item.clientId === clientId);
    if (source < 0) return;
    const [item] = queued.splice(source, 1);
    queued.splice(Math.max(0, Math.min(targetIndex, queued.length)), 0, item!);
    const update = this.db.transaction((entries: HeadlessQueuedInput[]) => {
      entries.forEach((entry, position) => this.db.prepare(
        'UPDATE headless_input_queue SET position = ?, updated_at = ? WHERE session_id = ? AND client_id = ?',
      ).run(position, Date.now(), sessionId, entry.clientId));
    });
    update(queued);
  }

  async getInputQueueState(sessionId: string): Promise<HeadlessInputQueueState> {
    this.db.prepare('INSERT OR IGNORE INTO headless_input_queue_state (session_id) VALUES (?)').run(sessionId);
    const row = this.db.prepare(`
      SELECT queue_paused, queue_expanded, interaction_locks_json, edit_locks_json
      FROM headless_input_queue_state WHERE session_id = ?
    `).get(sessionId) as { queue_paused: number; queue_expanded: number; interaction_locks_json: string; edit_locks_json: string };
    return {
      sessionId,
      queuePaused: row.queue_paused === 1,
      queueExpanded: row.queue_expanded === 1,
      queueInteractionLocks: parseStringArray(row.interaction_locks_json),
      queueEditLocks: parseStringArray(row.edit_locks_json),
    };
  }

  async updateInputQueueState(sessionId: string, patch: Partial<Omit<HeadlessInputQueueState, 'sessionId'>>): Promise<HeadlessInputQueueState> {
    const current = await this.getInputQueueState(sessionId);
    const next = { ...current, ...patch, sessionId };
    this.db.prepare(`
      UPDATE headless_input_queue_state SET queue_paused = ?, queue_expanded = ?, interaction_locks_json = ?, edit_locks_json = ?
      WHERE session_id = ?
    `).run(
      next.queuePaused ? 1 : 0,
      next.queueExpanded ? 1 : 0,
      JSON.stringify(next.queueInteractionLocks),
      JSON.stringify(next.queueEditLocks),
      sessionId,
    );
    return next;
  }

  /** A daemon restart cannot continue an in-process turn, so replay its active row safely. */
  async recoverActiveInputQueue(): Promise<void> {
    this.db.prepare("UPDATE headless_input_queue SET state = 'queued', updated_at = ? WHERE state = 'active'").run(Date.now());
  }

  close(): void {
    this.db.close();
  }
}

function parseEventPayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return { type: 'corrupt-event-payload' };
  }
}

function parseQueuePayload(payload: string): Record<string, unknown> {
  const value = parseEventPayload(payload);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseExtraDirs(value: string | null): string[] {
  return value === null ? [] : parseStringArray(value);
}

type HistoryRow = {
  id: string;
  client_id: string;
  session_id: string;
  event_sequence: number | null;
  role: HeadlessHistoryMessage['role'];
  content_json: string;
  agent_meta_json: string | null;
  created_at: number;
  deleted_at: number | null;
  rewind_at: number | null;
};

function historyRow(row: HistoryRow): HeadlessHistoryMessage {
  return {
    id: row.id,
    clientId: row.client_id,
    sessionId: row.session_id,
    eventSequence: row.event_sequence,
    role: row.role,
    content: parseEventPayload(row.content_json),
    agentMeta: row.agent_meta_json ? asRecord(parseEventPayload(row.agent_meta_json)) : null,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    rewindAt: row.rewind_at,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Preserve remote supplied ids, but ensure all locally-originated user rows have stable identity. */
function normalizeEventPayload(type: string, data: unknown): unknown {
  if (type !== 'user_message') return data ?? null;
  const value = asRecord(data);
  return value ?? { content: data ?? '' };
}

function withEventClientId(type: string, data: unknown, sequence: number): unknown {
  if (type !== 'user_message') return data;
  const value = asRecord(data) ?? { content: data ?? '' };
  if (typeof value.clientId === 'string' && value.clientId.trim()) return data;
  return { ...value, clientId: `headless-event-${sequence}` };
}

function projectHistoryMessage(event: HeadlessSessionEvent): {
  id: string; clientId: string; role: HeadlessHistoryMessage['role']; content: unknown; agentMeta: Record<string, unknown> | null;
} | null {
  const fallback = `headless-event-${event.sequence}`;
  if (event.type === 'user_message') {
    const data = asRecord(event.data);
    const clientId = typeof data?.clientId === 'string' && data.clientId.trim() ? data.clientId : fallback;
    return { id: clientId, clientId, role: 'user', content: data?.content ?? '', agentMeta: null };
  }
  if (event.type !== 'agent_event') return null;
  const agent = asRecord(event.data);
  const type = typeof agent?.type === 'string' ? agent.type : '';
  // A text stream can contain many partial fragments.  Index only the final
  // one, which is the same durable assistant message users see after reload.
  if (type === 'text') {
    const data = asRecord(agent?.data);
    if (data?.isFinal === false) return null;
    return { id: fallback, clientId: fallback, role: 'assistant', content: typeof data?.text === 'string' ? data.text : agent?.data ?? '', agentMeta: asRecord(agent?.agentMeta) };
  }
  const role = type === 'thinking' ? 'thinking'
    : type === 'tool_use' ? 'tool_use'
      : type === 'tool_result' || type === 'tool_result_full' ? 'tool_result'
        : type === 'error' ? 'error' : null;
  if (!role) return null;
  return { id: fallback, clientId: fallback, role, content: agent?.data ?? null, agentMeta: asRecord(agent?.agentMeta) };
}

/** Claude returns a UUID map on fork.  Preserve all unknown metadata verbatim. */
function remapUuids(value: unknown, uuidMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return uuidMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapUuids(item, uuidMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, remapUuids(item, uuidMap)]));
}
