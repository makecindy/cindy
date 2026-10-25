import { SharedTaskHost, type SharedTaskCreationState } from '@cindy/remote-agent/host/sharedTaskHost';
import { createSharedTaskJournal, closeSharedTasksInJournalForSession } from '@cindy/runtime-db/sharedTasks';
import type { NodeDatabase } from '../database.js';
import type { TerminalRemoteAccountService } from './account.js';

/** Node lifecycle adapter for the original shared-task host and SQLite journal.
 * Leaving the application revokes in-memory grants; logout also closes shares
 * using the outgoing account capability, before its database is released. */
export class TerminalSharedTasks {
  private readonly owner: string | null;
  private readonly cleanup: ReturnType<TerminalRemoteAccountService['captureSharedTaskCleanup']> | null;
  private readonly journal: ReturnType<typeof createSharedTaskJournal>;
  private readonly lifecycle: SharedTaskCreationState = { pending: new Map(), identities: new Map(), closedSessions: new Set() };
  private readonly sessions = new Map<string, string>();
  private readonly creates = new Set<Promise<unknown>>();
  private readonly runtime: SharedTaskHost | null;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private loaded = false;
  constructor(private readonly options: {
    database: NodeDatabase; account: TerminalRemoteAccountService;
    ownerAccountId: string | null; getOwnerScope(): string | null; deviceId: string;
    readTask(id: string): Promise<{id:string;title:string;source?:string;archived?:boolean;deleted?:boolean}|null>;
    revoke(sessionId: string): void;
    changed?(sharedTaskId: string): void;
  }) {
    this.owner = options.getOwnerScope();
    this.cleanup = this.owner ? options.account.captureSharedTaskCleanup() : null;
    void this.cleanup?.catch(() => undefined);
    const journal = createSharedTaskJournal(options.database.db);
    this.journal = {
      recordAuthority: async snapshot => {
        this.sessions.set(snapshot.sharedTaskId, snapshot.sessionId);
        return journal.recordAuthority(snapshot);
      },
      close: identity => { this.sessions.set(identity.sharedTaskId, identity.sessionId); return journal.close(identity); },
      latest: async () => {
        const entries = await journal.latest();
        for (const entry of entries) this.sessions.set(entry.sharedTaskId, entry.sessionId);
        return entries;
      },
    };
    this.runtime = this.owner && options.ownerAccountId ? new SharedTaskHost({
      api: options.account.sharedTasks, journal: this.journal,
      ownerAccountId: options.ownerAccountId, hostDeviceId: options.deviceId,
      creationState: this.lifecycle, isCurrent: () => this.current(),
      readSession: async id => {
        const row = await options.readTask(id);
        return row ? { id: row.id, title: row.title, source: row.source,
          status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active' } : null;
      },
      revoke: id => {
        const session = this.sessions.get(id) ?? this.lifecycle.identities.get(id)?.sessionId;
        if (session) options.revoke(session);
      },
      changed: id => options.changed?.(id),
    }) : null;
  }
  private current() { return !this.stopped && this.owner !== null && this.options.getOwnerScope() === this.owner; }
  private host() {
    if (!this.current() || !this.runtime) throw new Error('OWNER_CHANGED');
    return this.runtime;
  }
  async capturePeer(peerId: string, sharedTaskId: string) {
    const host = this.host();
    await host.refresh(sharedTaskId);
    this.host();
    const capture = host.capturePeer(peerId);
    if (!capture) throw new Error('SHARED_TASK_PERMISSION_DENIED');
    return capture;
  }
  isBlocked(sessionId: string) {
    return !this.current() || !this.loaded || this.lifecycle.closedSessions!.has(sessionId);
  }
  isSessionShared(sessionId:string):boolean {
    const host=this.current()?this.runtime:null;
    if(!host)return false;
    try{return host.activeSharedTaskIds().some(id=>host.detail(id)?.sessionId===sessionId);}catch{return false;}
  }
  async open() {
    const host = this.host();
    await host.restore();
    this.host(); this.loaded = true;
    this.scheduleRefresh();
  }
  private scheduleRefresh() {
    clearTimeout(this.timer);
    if (!this.current() || !this.runtime?.needsAuthorityRefresh()) return;
    this.timer = setTimeout(() => {
      void this.open().catch(() => this.scheduleRefresh());
    }, 30_000);
    this.timer.unref();
  }
  async create(sessionId: string, _title: string) {
    const host = this.host();
    const work = (async () => {
      try {
        const id = await host.open(sessionId);
        this.host(); this.scheduleRefresh();
        const detail = host.detail(id);
        return { sharedTaskId: id, revision: detail?.revision };
      } catch (error) {
        if (!this.current()) await this.closeOutgoing(await host.closeLocallyForBoundary(sessionId));
        throw error;
      }
    })();
    this.creates.add(work);
    try { return await work; } finally { this.creates.delete(work); }
  }
  async closeTask(sessionId: string) {
    if (!this.runtime) {
      await closeSharedTasksInJournalForSession(this.options.database.db, sessionId);
      return;
    }
    const host = this.host();
    this.options.revoke(sessionId);
    const ids = await host.closeLocallyForBoundary(sessionId);
    // Includes an authority written by another same-profile host before it was
    // restored here. This is the same durable closure used by session deletion.
    const stored = await closeSharedTasksInJournalForSession(this.options.database.db, sessionId);
    await this.closeOutgoing([...new Set([...ids, ...stored])]);
    this.scheduleRefresh();
  }
  async closeShare(sharedTaskId: string, sessionId: string) {
    const host = this.host();
    await host.refresh(sharedTaskId);
    if (host.detail(sharedTaskId)?.sessionId !== sessionId) throw new Error('SHARED_TASK_SCOPE_CHANGED');
    try { await host.close(sharedTaskId); } finally { this.scheduleRefresh(); }
  }
  private async closeOutgoing(ids: string[]) {
    if (!ids.length || !this.cleanup) return;
    const api = await this.cleanup;
    // The original terminal journal retains failures for the next restore.
    await Promise.allSettled(ids.map(id => api.close(id)));
  }
  async logout() {
    if (!this.runtime || !this.cleanup) return;
    clearTimeout(this.timer);
    const boundary = this.runtime.closeLocallyForBoundary();
    const ids = await boundary;
    const api = await this.cleanup;
    // A lost create response may have committed remotely without an ID. Use
    // only the outgoing account and this host device for its reconciliation.
    const active = await api.list().catch(() => []);
    for (const identity of active) {
      if (identity.ownerAccountId !== this.options.ownerAccountId || identity.hostDeviceId !== this.options.deviceId) continue;
      await this.journal.close(identity); this.options.revoke(identity.sessionId);
      ids.push(identity.sharedTaskId);
    }
    await this.closeOutgoing([...new Set(ids)]);
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer);
    await Promise.allSettled([...this.creates]);
    await this.runtime?.dispose();
  }
}
