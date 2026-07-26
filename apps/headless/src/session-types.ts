/**
 * The persisted part of maker-core's SessionStorage contract. Keeping this
 * structural contract local lets the headless storage be tested independently
 * from agent runtime modules; HeadlessMakerHost passes it to Maker unchanged.
 */
export type HeadlessAgentKind = 'claude-code' | 'codex';
export type HeadlessSessionStatus = 'active' | 'archived' | 'deleted';
export type HeadlessEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type HeadlessPermissionMode =
  | 'ask'
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';
export type HeadlessWorkspaceKind = 'project' | 'dialogue';

export interface HeadlessSessionMeta {
  id: string;
  agentKind: HeadlessAgentKind;
  /** Explicit provider selected for this session; undefined uses the host default. */
  providerId?: string;
  workDir: string;
  title: string;
  /** Session lifecycle state used by remote archive / restore controls. */
  status?: HeadlessSessionStatus;
  /** Unix milliseconds; converted to ISO for Desktop and Mobile clients. */
  pinnedAt?: number | null;
  model: string;
  workspaceKind?: HeadlessWorkspaceKind;
  effort?: HeadlessEffort;
  permissionMode?: HeadlessPermissionMode;
  fastMode?: boolean;
  createdAt: number;
  updatedAt: number;
  sdkSessionId?: string;
  parentSessionId?: string;
  remoteHostId?: string;
  /** Additional user-granted project directories, consumed by agents that support them. */
  extraDirs?: string[];
  /** Orca's persisted role; worker sessions are hidden from normal session lists. */
  orcaRole?: 'lead' | 'worker';
  /**
   * Host-internal wire prefix used after a destructive history edit.  It is
   * deliberately not a UI field: the next visible user message stays exactly
   * as authored while a fresh native session receives the surviving context.
   */
  pendingHandoff?: string;
}

export interface HeadlessSessionStorageContract {
  create(meta: Omit<HeadlessSessionMeta, 'createdAt' | 'updatedAt'>): Promise<HeadlessSessionMeta>;
  get(id: string): Promise<HeadlessSessionMeta | null>;
  list(): Promise<HeadlessSessionMeta[]>;
  update(id: string, patch: Partial<HeadlessSessionMeta>): Promise<HeadlessSessionMeta>;
  compareAndClearSdkSessionId(id: string, expectedSdkSessionId: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

/** A persisted, cursor-addressable event for CLI reattach and mobile replay. */
export interface HeadlessSessionEvent {
  sequence: number;
  sessionId: string;
  type: string;
  data: unknown;
  createdAt: number;
}

export interface HeadlessSessionEventStorage {
  appendEvent(sessionId: string, type: string, data: unknown): Promise<HeadlessSessionEvent>;
  listEvents(sessionId: string, afterSequence?: number, limit?: number): Promise<HeadlessSessionEvent[]>;
}

/** Optional live fan-out hook for local and Device Link transports. */
export interface HeadlessSessionEventSource {
  onEvent(listener: (event: HeadlessSessionEvent) => void): () => void;
}

/**
 * The queryable message projection of the append-only event stream.  Unlike
 * events this is a domain record: it has stable client identity, native agent
 * metadata and tombstone/rewind state, so history operations are transactional
 * rather than cosmetic UI changes.
 */
export interface HeadlessHistoryMessage {
  id: string;
  clientId: string;
  sessionId: string;
  eventSequence: number | null;
  role: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'error';
  content: unknown;
  agentMeta: Record<string, unknown> | null;
  createdAt: number;
  deletedAt: number | null;
  rewindAt: number | null;
}

export interface HeadlessHistoryStorage {
  listHistoryMessages(sessionId: string, options?: { includeHidden?: boolean }): Promise<HeadlessHistoryMessage[]>;
  /** Visible messages across all sessions, used by host-owned media garbage collection. */
  listAllHistoryMessages?(): Promise<HeadlessHistoryMessage[]>;
  getHistoryMessage(sessionId: string, clientId: string, options?: { includeHidden?: boolean }): Promise<HeadlessHistoryMessage | null>;
  replaceHistoryContent?(sessionId: string, clientId: string, content: unknown): Promise<void>;
  /** Atomically hides messages, invalidates native resume state, and records the next-send handoff. */
  deleteHistoryMessages(sessionId: string, clientIds: string[], handoff: string): Promise<void>;
  /** Atomically marks the target and all later visible messages as rewound. */
  rewindHistoryMessages(sessionId: string, fromClientId: string): Promise<string[]>;
  /** Copies visible history through a source client id into a new business session. */
  forkHistoryMessages(sourceSessionId: string, targetSessionId: string, throughClientId: string | null, uuidMap?: ReadonlyMap<string, string>): Promise<void>;
}

/** Durable, host-owned input queue row. The payload remains a presentation-neutral JSON object. */
export interface HeadlessQueuedInput {
  sessionId: string;
  clientId: string;
  payload: Record<string, unknown>;
  state: 'queued' | 'active';
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface HeadlessInputQueueState {
  sessionId: string;
  queuePaused: boolean;
  queueExpanded: boolean;
  queueInteractionLocks: string[];
  queueEditLocks: string[];
}
