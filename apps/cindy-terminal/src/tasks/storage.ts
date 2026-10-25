import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { SessionMeta, SessionStorage, AgentEvent, UserMessage } from '@cindy/maker-core';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { ModelSelection } from '../models/config.js';
import type { NodeDatabase } from '../database.js';
import type { TerminalConversations } from './conversations.js';
import { TerminalSessionMetadata } from './session-metadata.js';
import { persistedInput } from './input.js';

type UserMessageBody = Parameters<TerminalConversations['messages']['createMessage']>[1];

export type TerminalTaskMeta = SessionMeta & {
  worktreePath?: string;
  providerId?: string; archived?: boolean; deleted?: boolean; pinnedAt?: number | null; agentDeviceId?: string;
  groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding;
  queuePaused?: boolean; queueExpanded?: boolean; clearedAt?: number; source?: string;
  feishuBotAppId?: string; feishuOpenId?: string; imBotContextId?: string; imUserId?: string; imScopeKey?: string; imDefaultRoute?: string | null;
  workspaceKind?: 'project' | 'dialogue'; userSendAt?: number;
  pendingHandoff?: { id: string; text: string; createdAt: number } | null;
  goalContinuation?: import('@cindy/im-runtime/goalInactiveNote').GoalContinuationState | null;
  thinkingEnabled?: boolean; hiddenAt?: number | null;
  orcaRole?: 'lead' | 'worker' | null;
  orcaRemoteLead?: import('@cindy/maker-shared/orca-remote-worker').OrcaRemoteLead;
  usage?: { tokenUsage: number; contextTokens: number; contextWindow: number; costUsd: number };
};
export type NewTerminalTaskMeta = Omit<TerminalTaskMeta, 'createdAt' | 'updatedAt'>;
export type Submission = { targetPlugin?: { id: string; name: string }; collaboration?: import('./orca-input.js').TerminalOrcaInput; orca?: import('./orca-remote.js').RemoteWorkerAssignment; requestId: string; sessionId: string; fingerprint: string; sendAtMs?: number; plugin?: { id: string; name: string }; sender?: {sessionId:string;title?:string}; status: 'queued' | 'sending' | 'running' | 'completed' | 'failed' | 'interrupted'; createdAt: number; updatedAt: number; error?: string; finalText?: string; message?: UserMessage; source?: 'local' | 'remote'; deviceId?: string; sourceDevice?: import('../contracts.js').InvocationContext['sourceDevice']; ownerId?: string; deliveryProof?: import('./handoff.js').TaskDeliveryProof; scheduler?: {kind:'scheduler';scheduleId:string;scheduleName:string;runId:string;firedAt?:number}; sharedTask?: import('../contracts.js').InvocationContext['sharedTask'] };
export type ContextRebuild = Parameters<import('@cindy/im-runtime/contextOverflowRollover').ContextOverflowRolloverDeps['commitRebuild']>[2] & { handoff: string };
export type HistoryRecord = { sequence: number; timestamp: number; kind: 'event' | 'user' | 'user-meta' | 'boundary' | 'boundary-meta' | 'context-rebuild'; event?: AgentEvent; message?: UserMessage; origin?: 'local' | 'remote'; agentMeta?: Record<string, unknown>; clientId?: string; boundary?: import('@cindy/im-runtime/sessionAgentSwitch').AgentSwitchBoundaryContent; contextRebuild?: ContextRebuild };
function taskId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('INVALID_TASK_ID');
  return value;
}

/** Per-task atomic metadata and append-only history. Live status is never persisted. */
export class TerminalTaskStorage implements SessionStorage {
  private databasePromise?: Promise<NodeDatabase>;
  database() { if (!this.databasePromise) throw new Error('TASK_PERSISTENCE_NOT_CONFIGURED'); return this.databasePromise; }
  private canonical?: Promise<TerminalSessionMetadata>;
  private conversationRuntime?: Promise<TerminalConversations>;
  runtime() { if (!this.conversationRuntime) throw new Error('TASK_PERSISTENCE_NOT_CONFIGURED'); return this.conversationRuntime; }
  configurePersistence(database: Promise<NodeDatabase>, conversations: Promise<TerminalConversations>) {
    if (this.canonical) throw new Error('TASK_PERSISTENCE_ALREADY_CONFIGURED');
    this.databasePromise = database;
    this.conversationRuntime = conversations;
    this.canonical = Promise.all([database, conversations]).then(([database, conversations]) => new TerminalSessionMetadata(database, conversations,()=>{
      if(!this.opening)throw new Error('TASK_OPENING_NOT_READY');return this.opening;
    }));
  }
  private opening?:ReturnType<typeof import('@cindy/app-runtime/sessionOpening').createSessionOpening>;
  configureOpening(opening:NonNullable<TerminalTaskStorage['opening']>){this.opening=opening;}
  private metadata() {
    if (!this.canonical) throw new Error('TASK_PERSISTENCE_NOT_CONFIGURED');
    return this.canonical;
  }
  private readonly rows = new Map<string, TerminalTaskMeta>();
  peek(id: string): Readonly<TerminalTaskMeta> | undefined { return this.rows.get(id); }
  peekProvider(id: string) { return this.rows.get(id)?.providerId ?? null; }
  noteProvider(id: string, provider: string | null) { const row = this.rows.get(id); if (row) row.providerId = provider ?? undefined; }
  private worktreeReferences?: { beforeWrite(row: TerminalTaskMeta): Promise<void>; afterWrite(row: TerminalTaskMeta | null, id: string): Promise<void>; reconcileResources(resources: readonly string[], rows: readonly TerminalTaskMeta[]): Promise<void> };
  configureWorktreeReferences(hooks: NonNullable<TerminalTaskStorage['worktreeReferences']>) { this.worktreeReferences = hooks; }
  async reconcileWorktreeResourceReferences(resources: readonly string[]) {
    if (!this.worktreeReferences || resources.length === 0) return;
    // Read the committed original database without waiting on storage's write
    // queue, which can itself be waiting for the physical locks held by caller.
    await this.worktreeReferences.reconcileResources(resources, await (await this.metadata()).list());
  }
  async reconcileWorktreeReferences(id: string) {
    const row = await this.get(id);
    if (row) await this.worktreeReferences?.beforeWrite(row);
    await this.worktreeReferences?.afterWrite(row, id);
  }
  private async persistMetadata(row: TerminalTaskMeta, patch: Partial<TerminalTaskMeta> = row) {
    await this.worktreeReferences?.beforeWrite(row);
    await (await this.metadata()).update(row.id, patch);
    await this.worktreeReferences?.afterWrite(row, row.id);
  }
  private readonly submissions = new Map<string, Submission[]>();
  private readonly messageRevisions=new Map<string,number>();
  noteMessageChanged(id:string){this.messageRevisions.set(id,(this.messageRevisions.get(id)??0)+1);}
  private readonly nextSequences = new Map<string, number>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private metadataBarrier: Promise<void> = Promise.resolve();
  private metadataFault: unknown;
  private readonly routeFaults = new Map<string, unknown>();
  constructor(private readonly root: string) {}
  private directory(id: string) { return path.join(this.root, taskId(id)); }
  async open(): Promise<void> {
    await privateDirectory(this.root);
    for (const row of await (await this.metadata()).list()) {
      await privateDirectory(this.directory(row.id));
      await this.repairInterruptedAppend(row.id);
      this.rows.set(row.id, row);
      const receipts = await readPrivateFile(path.join(this.directory(row.id), 'requests.json'));
      const entries: Submission[] = receipts ? JSON.parse(receipts.toString()) : [];
      for (const receipt of entries) {
        if (receipt.sessionId !== row.id || typeof receipt.requestId !== 'string') throw new Error('INVALID_SUBMISSION_METADATA');
        if (['sending', 'running'].includes(receipt.status)) { receipt.status = 'interrupted'; receipt.updatedAt = Date.now(); }
      }
      this.submissions.set(row.id, entries);
      if (receipts) await atomicPrivateWrite(path.join(this.directory(row.id), 'requests.json'), JSON.stringify(entries));
    }
  }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.metadataBarrier, this.writes.get(id)]).then(() => { this.assertRouteHealthy(id); return action(); });
    this.writes.set(id, result.catch(() => undefined));
    return result;
  }
  async create(meta: NewTerminalTaskMeta, guard: () => void = () => {}): Promise<TerminalTaskMeta> {
    return this.enqueue(meta.id, async () => {
      guard();
      if (this.rows.has(meta.id)) throw new Error('TASK_ALREADY_EXISTS');
      await privateDirectory(this.directory(meta.id));
      const proposed = { ...meta, createdAt: Date.now(), updatedAt: Date.now() };
      await this.worktreeReferences?.beforeWrite(proposed);
      const row = await (await this.metadata()).create(meta, guard);
      await this.worktreeReferences?.afterWrite(row, row.id);
      this.rows.set(meta.id, row);
      return structuredClone(row);
    });
  }
  historyRevision(id: string): number { taskId(id); return (this.nextSequences.get(id)??0)+(this.messageRevisions.get(id)??0); }
  async get(id: string): Promise<TerminalTaskMeta | null> {
    taskId(id);
    await this.metadataBarrier;
    await this.writes.get(id);
    this.assertRouteHealthy(id);
    const row = await (await this.metadata()).get(id);
    if (row) this.rows.set(id, row); else this.rows.delete(id);
    return row;
  }
  async list(): Promise<TerminalTaskMeta[]> {
    await this.flush();
    const rows = await (await this.metadata()).list();
    for (const row of rows) this.rows.set(row.id, row);
    return rows;
  }
  update(id: string, patch: Partial<TerminalTaskMeta>): Promise<TerminalTaskMeta> {
    return this.enqueue(id, async () => {
      const row = await (await this.metadata()).get(id);
      if (!row) throw new Error('TASK_NOT_FOUND');
      const next = { ...row, ...patch, id: row.id, createdAt: row.createdAt, updatedAt: Date.now() };
      await this.persistMetadata(next, patch);
      const saved = (await (await this.metadata()).get(id))!;
      this.rows.set(id, saved);
      return saved;
    });
  }
  compareAndClearSdkSessionId(id: string, expected: string): Promise<boolean> {
    return this.enqueue(id, async () => {
      const metadata = await this.metadata();
      const changed = await metadata.compareAndClearSdkSessionId(id, expected);
      const row = await metadata.get(id);
      if (row) this.rows.set(id, row);
      return changed;
    });
  }
  /** The predicate is evaluated inside the task's write lane, so accepting an
   * older turn cannot consume a handoff committed by a later model switch. */
  updateIf(id: string, predicate: (row: Readonly<TerminalTaskMeta>) => boolean, patch: Partial<TerminalTaskMeta>, guard: () => void): Promise<TerminalTaskMeta | null> {
    return this.enqueue(id, async () => {
      guard();
      const row = await (await this.metadata()).get(id);
      if (!row || !predicate(row)) return null;
      const next = { ...row, ...patch, id: row.id, createdAt: row.createdAt, updatedAt: Date.now() };
      await this.persistMetadata(next, patch);
      this.rows.set(id, next);
      return structuredClone(next);
    });
  }
  delete(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      await (await this.metadata()).delete(id);
      // Atomic rename is not needed for deletion: the host first closes the runtime.
      await rm(this.directory(id), { force: true, recursive: true });
      await this.worktreeReferences?.afterWrite(null, id);
      this.rows.delete(id);
      this.nextSequences.delete(id);
    });
  }
  setSelection(id: string, selection: ModelSelection) { return this.update(id, { agentKind: selection.agentKind, providerId: selection.providerId, model: selection.model, effort: selection.effort }); }
  private assertRouteHealthy(id: string) { if (this.routeFaults.has(id)) throw this.routeFaults.get(id); }
  commitContextRebuild(id: string, rebuild: ContextRebuild, guard: () => void, signal?: AbortSignal): Promise<void> {
    return this.enqueue(id, async () => {
      guard(); signal?.throwIfAborted();
      const { handoff, ...meta } = rebuild;
      await (await this.runtime()).contextRebuild(id, handoff, meta, signal);
    });
  }
  append(id: string, input: Omit<HistoryRecord, 'sequence' | 'timestamp'>): Promise<HistoryRecord> {
    return this.enqueue(id, async () => {
      const row = await (await this.metadata()).get(id);
      if (!row) throw new Error('TASK_NOT_FOUND');
      this.rows.set(id, row);
      if (input.kind === 'user' && input.message) {
        const clientId = input.clientId ?? randomUUID();
        const content = persistedInput(input.message);
        await (await this.runtime()).messages.createMessage(id, {
          clientId, role: 'user',
          content: typeof input.message.content === 'string' ? content : JSON.parse(content),
          agentMeta: input.agentMeta,
          agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind,
        });
        input = { ...input, clientId };
      }
      if (input.kind === 'boundary' && input.boundary) {
        const clientId = input.clientId ?? `agent-switch:${randomUUID()}`;
        await (await this.runtime()).messages.createMessage(id, { clientId, role: 'agent_switch', content: input.boundary });
        input = { ...input, clientId };
      }
      return this.appendRecord(id, input);
    });
  }
  beforeUserMessageWrite?: (id: string, body: UserMessageBody) => () => void;
  writeUserMessage(id: string, body: UserMessageBody,
    options?: Parameters<TerminalConversations['messages']['createMessage']>[2]) {
    const rollback = this.beforeUserMessageWrite?.(id, body);
    return this.enqueue(id, async () => {
      const saved = await (await this.runtime()).messages.createMessage(id, body, options);
      return saved;
    }).catch(error => { rollback?.(); throw error; });
  }
  private async appendRecord(id: string, input: Omit<HistoryRecord, 'sequence' | 'timestamp'>): Promise<HistoryRecord> {
      let next = this.nextSequences.get(id);
      if (next === undefined) {
        const page = await this.readHistory(id, 0, 1, true);
        next = page.records[0]?.sequence ?? 0;
      }
      const record: HistoryRecord = { ...input, timestamp: Date.now(), sequence: next + 1 };
      await this.writeRecord(id, record);
      return record;
  }
  private async writeRecord(id: string, record: HistoryRecord) {
      await privateDirectory(this.directory(id));
      const handle = await open(path.join(this.directory(id), 'events.jsonl'), 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      this.nextSequences.set(id, record.sequence);
  }
  /** Only an incomplete trailing record can arise from an interrupted append.
   * Drop those uncommitted bytes before reusing its sequence; never ignore a
   * corrupt committed record in the middle of the journal. */
  private async repairInterruptedAppend(id: string) {
    const handle = await open(path.join(this.directory(id), 'events.jsonl'), 'r+').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 10) return;
      let offset = size;
      while (offset > 0) {
        const start = Math.max(0, offset - 64 * 1024);
        const chunk = Buffer.alloc(offset - start);
        await handle.read(chunk, 0, chunk.length, start);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) { await handle.truncate(start + newline + 1); await handle.sync(); return; }
        offset = start;
      }
      await handle.truncate(0);
      await handle.sync();
    } finally { await handle.close(); }
  }
  async history(id: string, after = 0, limit = 200) {
    taskId(id);
    await this.metadataBarrier;
    await this.writes.get(id);
    this.assertRouteHealthy(id);
    if (!this.rows.has(id)) throw new Error('TASK_NOT_FOUND');
    return this.readHistory(id, after, Math.max(1, Math.min(1000, limit)));
  }
  private async readHistory(id: string, after: number, limit: number, tailOnly = false): Promise<{ records: HistoryRecord[]; nextCursor: number; hasMore: boolean }> {
    const records: HistoryRecord[] = [];
    const input = createReadStream(path.join(this.directory(id), 'events.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let hasMore = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let value: HistoryRecord;
        try { value = JSON.parse(line) as HistoryRecord; }
        catch { throw new Error('TASK_HISTORY_CORRUPT'); }
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error('TASK_HISTORY_CORRUPT');
        if (tailOnly) { records[0] = value; continue; }
        if (value.sequence <= after) continue;
        if (records.length >= limit) { hasMore = true; break; }
        records.push(value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally { lines.close(); input.destroy(); }
    return { records, nextCursor: records.at(-1)?.sequence ?? after, hasMore };
  }
  async queued(id: string): Promise<Submission[]> { await this.writes.get(id); return structuredClone((this.submissions.get(id) ?? []).filter(item => item.status === 'queued')); }
  async submission(id: string, requestId: string): Promise<Submission | null> {
    taskId(id); await this.writes.get(id);
    return structuredClone(this.submissions.get(id)?.find(item => item.requestId === requestId) ?? null);
  }
  async latestSubmission(id: string): Promise<Submission | null> {
    taskId(id); await this.writes.get(id);
    return structuredClone(this.submissions.get(id)?.at(-1) ?? null);
  }
  claimSubmission(id: string, requestId: string, fingerprint: string, guard: () => void, payload?: Pick<Submission, 'message' | 'source' | 'deviceId' | 'sourceDevice' | 'ownerId' | 'sharedTask' | 'scheduler' | 'sendAtMs' | 'deliveryProof' | 'sender' | 'plugin' | 'targetPlugin' | 'orca' | 'collaboration'>, atHead = false): Promise<{ receipt: Submission; created: boolean }> {
    return this.enqueue(id, async () => {
      guard();
      if (!this.rows.has(id)) throw new Error('TASK_NOT_FOUND');
      const entries = this.submissions.get(id) ?? [];
      const found = entries.find(item => item.requestId === requestId);
      if (found) {
        if (found.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return { receipt: structuredClone(found), created: false };
      }
      const receipt: Submission = { ...payload, requestId, sessionId: id, fingerprint, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
      const updated = [...entries];
      const position = atHead ? updated.findIndex(item => item.status === 'queued') : -1;
      updated.splice(position < 0 ? updated.length : position, 0, receipt);
      // Original GUI/profile services create the session in SQLite directly.
      // The terminal delivery receipt directory is materialized on first use.
      await privateDirectory(this.directory(id));
      guard();
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(updated));
      this.submissions.set(id, updated);
      return { receipt: structuredClone(receipt), created: true };
    });
  }
  updateSubmission(id: string, requestId: string, status: Submission['status'], error?: string, finalText?: string): Promise<Submission> {
    return this.enqueue(id, async () => {
      const entries = this.submissions.get(id) ?? [];
      const found = entries.find(item => item.requestId === requestId);
      if (!found) throw new Error('SUBMISSION_NOT_FOUND');
      // A fast native adapter can finish before send() returns its acceptance.
      if (['completed', 'failed', 'interrupted'].includes(found.status)) return structuredClone(found);
      const receipt = { ...found, status, updatedAt: Date.now(), error, ...(finalText === undefined ? {} : { finalText }) };
      const next = entries.map(item => item === found ? receipt : item);
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(next));
      this.submissions.set(id, next);
      return structuredClone(receipt);
    });
  }
  async flush(): Promise<void> { await Promise.all([this.metadataBarrier, ...this.writes.values()]); if (this.routeFaults.size) throw this.routeFaults.values().next().value; }
}
