import type { LocalOwnerImportResult } from '../../localOwnerDataImport.js';

export type DbTxName =
  | 'codex.importMessages'
  | 'claude.importMessages'
  | 'rewind.commit'
  | 'fork.session'
  | 'embedding.markDone'
  | 'embedding.commit'
  | 'embedding.recordFailures'
  | 'embedding.enqueue'
  | 'orca.reserveWorkerCreation'
  | 'orca.renewWorkerCreationReservation'
  | 'orca.releaseWorkerCreationReservation'
  | 'orca.upsertWorker'
  | 'orca.setWorkerFocus'
  | 'orca.removeWorker'
  | 'orca.cancelStaleTeams'
  | 'sessions.renameTitles'
  | 'sessions.setStatus'
  | 'session.agentSwitchFallback'
  | 'message.delete'
  | 'im.deleteBindings'
  | 'im.replaceBinding'
  | 'session.importShare'
  | 'localOwner.importData';

export interface CodexImportMessagesArgs {
  sessionId: string;
  importClientIdPrefix: string;
  sdkSessionId: string;
  model: string;
  rows: Array<{
    lineNo: number;
    role: 'user' | 'assistant';
    text: string;
    content: unknown;
    createdAt: number;
  }>;
}

export interface ClaudeImportMessagesArgs {
  sessionId: string;
  importClientIdPrefix: string;
  sdkSessionId: string;
  rows: Array<{
    lineNo: number;
    partIndex: number;
    role: string;
    content: unknown;
    toolUseId: string | null;
    agentMeta: Record<string, unknown> | null;
    createdAt: number;
  }>;
}

export interface RewindCommitArgs {
  sessionId: string;
  targetCreatedAt: number;
  /** Exact DB message id for ordering ties at the same createdAt millisecond. */
  targetMessageId?: string;
  /** Exact DB client_id for the user message that starts the rewind branch. */
  targetClientId?: string;
  /** SDK uuid for the target user message, when available. */
  targetMessageUuid?: string;
  /** SDK uuid for the prior assistant anchor that must remain visible. */
  preserveMessageUuid?: string;
  /** Replacement SDK session/thread id to persist atomically with rewind. */
  sdkSessionId?: string;
  now: number;
}

export interface ForkSessionArgs {
  sourceSessionId: string;
  /** /clear 之前的行不属于当前可见/原生上下文，fork 时不得重新带回。 */
  sourceClearedAt?: number | null;
  targetCreatedAt: number;
  /** 与 targetCreatedAt 同毫秒时按 SQLite 插入顺序截断；null/缺省表示整毫秒前缀。 */
  targetRowid?: number | null;
  newSession: {
    id: string;
    title: string;
    workingDir: string | null;
    model: string;
    /** 凭证形态来源。fork 必须继承 source 的值(null = 跟随系统默认),否则新会话首发会触发共享 codex 进程重启。 */
    providerId: string | null;
    effort: string;
    permissionMode: string;
    status: string;
    sdkSessionId: string | null;
    totalTokenUsage: number;
    totalCostUsd: number;
    contextTokens: number;
    contextWindow: number;
    fastMode: boolean | number;
    clearedAt: number | null;
    pinnedAt: number | null;
    userSendAt: number | null;
    agentKind: string;
    workspaceKind: string;
    codexHistoryHasProductPrompt: boolean | null;
    parentSessionId: string | null;
    forkedAtMessageId: string | null;
    createdAt: number;
    updatedAt: number;
  };
  uuidMap: Array<[string, string]> | Record<string, string>;
  /** Legacy Claude imports may have stored transcript parentage in parentUuid. */
  legacyTranscriptParentUuids?: string[];
  /** Imported Claude assistant rows may retain an external tool-use parent id. */
  toolParentUuids?: string[];
  /**
   * 复制的 agent_switch 只保留展示/交接信息，不继承父会话的停泊原生 session。
   * 否则父子分支稍后切回旧引擎时会共同续写同一个 vendor session。
   */
  detachAgentSwitchSessions?: boolean;
  /**
   * user 目标恰好是切换后的首条消息时，该消息不会被复制；把对应边界恢复为
   * consumed=false，使新分支首次发送时重新注入同一份 handoff。
   */
  resetHandoffBoundaryClientId?: string | null;
  /**
   * main 侧预生成的新 message id 列表,顺序对应 source 消息按 created_at ASC 的遍历顺序。
   * 长度必须等于 source message 数。
   */
  newMessageIds: Array<{ id: string; clientId: string }>;
}

export interface EmbeddingMarkDoneArgs {
  rowids: number[];
}

export interface EmbeddingCommitArgs {
  items: Array<{
    rowid: number;
    vecTable: string;
    embedding: Float32Array;
  }>;
}

export interface EmbeddingRecordFailuresArgs {
  jobs: Array<{ rowid: number; attempts: number }>;
  errMsg: string;
  now: number;
}

export interface EmbeddingEnqueueArgs {
  source: string;
  now: number;
  items: Array<{
    sourceId: string;
    chunkIndex?: number;
    modelId: string;
    vecTable: string;
  }>;
}

/**
 * F-COLLAB: orca worker 的 upsert(含 focus 互斥清理)。事务体在 worker 内复刻
 * orcaTeamStore.addOrUpdateWorker 原同步事务逻辑。可选字段值为 undefined 表示
 * "保留 existing 行的当前值",与原 drizzle 写法语义一致。
 */
export interface OrcaUpsertWorkerArgs {
  id: string;
  teamId: string;
  sessionId: string;
  status?: string;
  label?: string | null;
  worktreeBranch?: string | null;
  role?: string;
  focused?: boolean;
  idleSince?: number | null;
  now: number;
}

export interface OrcaReserveWorkerCreationArgs {
  reservationId: string;
  teamId: string;
  label: string;
  hardLimit: number;
  now: number;
  expiresAt: number;
}

export type OrcaReserveWorkerCreationResult =
  | { ok: true; occupiedSlotsBefore: number }
  | { ok: false; errorCode: 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'WORKER_LIMIT_HARD_EXCEEDED' };

export interface OrcaReleaseWorkerCreationReservationArgs {
  reservationId: string;
}

export interface OrcaRenewWorkerCreationReservationArgs {
  reservationId: string;
  now: number;
  expiresAt: number;
}

/** F-COLLAB: 原子切换 team 内 focused worker(清旧 + set 新)。 */
export interface OrcaSetWorkerFocusArgs {
  teamId: string;
  workerId: string;
  now: number;
}

/** F-COLLAB: create_worker 派发失败时移除 worker link，并归档对应 session。 */
export interface OrcaRemoveWorkerArgs {
  workerId: string;
  now: number;
}

/**
 * F-COLLAB: 取消同一 lead 下除 keepTeamId 外的所有 active team(partial unique 约束
 * 缺失时的 read-time dedup 兜底)。用 `id != keepTeamId` 而非显式 staleIds,避免
 * read(main 侧 async select) 与 cancel(本事务) 之间的 TOCTOU 窗口误伤新写入。
 */
export interface OrcaCancelStaleTeamsArgs {
  leadSessionId: string;
  keepTeamId: string;
  now: number;
}

export interface SessionsRenameTitleChange {
  sessionId: string;
  title: string;
  expectedCurrentTitle?: string;
  expectedUpdatedAt?: string;
}

export interface SessionsRenameTitlesArgs {
  changes: SessionsRenameTitleChange[];
}

export interface SessionsRenameTitleResult {
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}

export interface SessionsSetStatusArgs {
  sessionIds: string[];
  status: 'active' | 'archived';
}

/** resume 停泊失败后的原子回落:清失效绑定并把边界改成全量交接。 */
export interface SessionAgentSwitchFallbackArgs {
  sessionId: string;
  boundaryClientId: string;
  boundaryContent: string;
  updatedAt: number;
}

/**
 * 一次消息删除动作涉及的全部本地记录。删除 assistant 时，这里会包含同一真实
 * 用户轮中的 thinking / tool / 自动续跑 / 多段 assistant；删除 user 时只有目标行。
 * 正文/元数据清空为最小 tombstone、清原生会话绑定、写入隐藏的上下文重建标记
 * 必须在同一事务内提交，避免崩溃后继续 resume 含被删消息的旧 transcript。
 */
export interface MessageDeleteArgs {
  sessionId: string;
  clientIds: string[];
  contextMarker: {
    id: string;
    clientId: string;
    content: string;
    createdAt: number;
  };
  updatedAt: number;
}

export interface MessageDeleteResult {
  messages: Array<{
    messageId: string;
    clientId: string;
  }>;
}

export interface SessionsSetStatusResultItem {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  workspaceKind: string | null;
  status: 'active' | 'archived';
}

/**
 * 会话分享(.xdtshare)导入落库:单事务插入 session 行 + 全量 messages。
 * session id / message id 均由 main 侧预生成(message id 重新生成防 PK 撞库);
 * content / agentMeta 传已完成媒体 URL 重写的 JSON 字符串,事务体不再加工。
 * 任一行非法或 PK/UNIQUE 冲突 → 整体回滚,零写入。
 */
export interface SessionImportShareArgs {
  session: {
    id: string;
    title: string;
    workingDir: string | null;
    workspaceKind: string;
    /** 导入时勾选"在 worktree 中创建"产出的 worktree 路径快照;null = 未用 worktree。 */
    worktreePath: string | null;
    model: string;
    effort: string;
    permissionMode: string;
    /** 来源(供应商)显式选择;null = 跟随该 agent 默认路由。与 sessions.provider_id 同语义。 */
    providerId: string | null;
    status: string;
    sdkSessionId: string | null;
    totalTokenUsage: number;
    totalCostUsd: number;
    contextTokens: number;
    contextWindow: number;
    fastMode: boolean;
    planModeEnabled: boolean;
    agentKind: string;
    source: string;
    extraDirs: string;
    codexHistoryHasProductPrompt: boolean | null;
    /** /clear 边界(unix ms):不携带会让导入端把 pre-clear 历史重新显示出来。 */
    clearedAt: number | null;
    userSendAt: number | null;
    createdAt: number;
    updatedAt: number;
  };
  messages: Array<{
    id: string;
    clientId: string;
    role: string;
    content: string;
    toolUseId: string | null;
    agentMeta: string | null;
    /** 产出该行的 agent；旧分享包缺失时导入为 NULL。 */
    agentKind?: string | null;
    createdAt: number;
    rewindAt: number | null;
  }>;
}

/**
 * Atomically replace every persisted owner of a desktop session with one IM
 * identity. The same identity may already point at another session.
 */
export interface ImReplaceBindingArgs {
  channel: string;
  botContextId: string;
  userId: string;
  scopeKey: string;
  targetSessionId: string;
  attachedAt: number;
  attachedViaCardMessageId: string | null;
}

export interface ImDeleteBindingsArgs {
  identities: Array<{
    channel: string;
    botContextId: string;
    userId: string;
    scopeKey: string;
  }>;
}

/**
 * local 模式(local-v1)库的数据行导入当前账号库(登录后的一次性认领)。事务体
 * 只做 ATTACH + 逐表 `INSERT OR IGNORE`,清单与列交集规则见
 * localDb/localOwnerDataImport.ts(唯一正本)。
 *
 * 注意:`client/WorkerThreadTransport.ts` 里的 inline worker 回滚口**故意不实现**
 * 这个 tx——导入涉及表清单、外键父子顺序、会话冲突过滤,复制一份等着 drift 的
 * 风险大于收益(那份 inline 代码本身也是待删除的打包回滚口)。它会返回
 * UNKNOWN_TX,认领流程按「当前 db 运行时不支持」推迟,下次在正常 file worker
 * 下照常认领,不影响数据安全。
 */
export interface LocalOwnerImportDataArgs {
  /** 已关闭的 local-v1 库文件绝对路径。 */
  localDbPath: string;
}

export type DbTxArgsByName = {
  'codex.importMessages': CodexImportMessagesArgs;
  'claude.importMessages': ClaudeImportMessagesArgs;
  'rewind.commit': RewindCommitArgs;
  'fork.session': ForkSessionArgs;
  'embedding.markDone': EmbeddingMarkDoneArgs;
  'embedding.commit': EmbeddingCommitArgs;
  'embedding.recordFailures': EmbeddingRecordFailuresArgs;
  'embedding.enqueue': EmbeddingEnqueueArgs;
  'orca.reserveWorkerCreation': OrcaReserveWorkerCreationArgs;
  'orca.renewWorkerCreationReservation': OrcaRenewWorkerCreationReservationArgs;
  'orca.releaseWorkerCreationReservation': OrcaReleaseWorkerCreationReservationArgs;
  'orca.upsertWorker': OrcaUpsertWorkerArgs;
  'orca.setWorkerFocus': OrcaSetWorkerFocusArgs;
  'orca.removeWorker': OrcaRemoveWorkerArgs;
  'orca.cancelStaleTeams': OrcaCancelStaleTeamsArgs;
  'sessions.renameTitles': SessionsRenameTitlesArgs;
  'sessions.setStatus': SessionsSetStatusArgs;
  'session.agentSwitchFallback': SessionAgentSwitchFallbackArgs;
  'message.delete': MessageDeleteArgs;
  'im.deleteBindings': ImDeleteBindingsArgs;
  'im.replaceBinding': ImReplaceBindingArgs;
  'session.importShare': SessionImportShareArgs;
  'localOwner.importData': LocalOwnerImportDataArgs;
};

export type DbTxResultByName = {
  'codex.importMessages': { changed: number };
  'claude.importMessages': { changed: number };
  'rewind.commit': undefined;
  'fork.session': { messageCount: number };
  'embedding.markDone': undefined;
  'embedding.commit': undefined;
  'embedding.recordFailures': { failCount: number };
  'embedding.enqueue': { inserted: number; skipped: number };
  'orca.reserveWorkerCreation': OrcaReserveWorkerCreationResult;
  'orca.renewWorkerCreationReservation': boolean;
  'orca.releaseWorkerCreationReservation': undefined;
  'orca.upsertWorker': undefined;
  'orca.setWorkerFocus': undefined;
  'orca.removeWorker': string | null;
  'orca.cancelStaleTeams': undefined;
  'sessions.renameTitles': SessionsRenameTitleResult[];
  'sessions.setStatus': SessionsSetStatusResultItem[];
  'session.agentSwitchFallback': undefined;
  'message.delete': MessageDeleteResult;
  'im.deleteBindings': undefined;
  'im.replaceBinding': undefined;
  'session.importShare': { messageCount: number };
  // 结构以 localOwnerDataImport.ts 的返回类型为唯一正本,避免两处 drift。
  'localOwner.importData': LocalOwnerImportResult;
};
