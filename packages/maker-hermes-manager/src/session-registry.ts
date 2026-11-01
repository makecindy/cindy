/**
 * Logical session registry: Cindy sessionId ↔ Hermes session id, per-session
 * metadata, monotonic event seq, and a small in-memory replay ring.
 *
 * Durability contract: records persist to <HERMES_HOME>/hermes-mgr/sessions.json
 * (atomic tmp+rename) so logical sessions survive daemon restarts — the
 * Hermes session ids are the durable state; the replay ring is in-memory
 * only, matching cc-mgr's live-only subscription semantics (attach with
 * sinceSeq beyond the ring answers replayLossy=true).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HermesPermissionMode } from './protocol.js';

const RING_CAP = 500;

export interface HermesSessionRecord {
  sessionId: string;
  hermesSessionId?: string;
  cwd: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: HermesPermissionMode;
  /**
   * Route flags the Hermes session was created with. Hermes rejects a resume whose
   * -m/--provider differ from the launch, so resumes replay these and a model
   * change goes through `/model` instead (ROADMAP 1.8d).
   */
  launch?: { model?: string; provider?: string; baseUrl?: string; apiKey?: string };
  /** Model the Hermes session currently runs (launch model, then each `/model` switch). */
  appliedModel?: string;
  /** Cindy context preamble; consumed by the daemon on the session's first turn. */
  preamble?: string;
  lastSeq: number;
  startedAt: string;
  lastEventAt: string | null;
  running: boolean;
}

interface InternalRecord extends HermesSessionRecord {
  ring: unknown[];
}

export class SessionRegistry {
  private readonly sessions = new Map<string, InternalRecord>();

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        let repairedStaleRunning = false;
        for (const item of parsed) {
          const rec = item as HermesSessionRecord;
          if (typeof rec?.sessionId === 'string') {
            // A turn never survives a daemon restart: stop() kills the child and
            // a hard crash orphans it. A loaded `running: true` is therefore a
            // turn the restart aborted, and the record is repaired to
            // not-running instead of being trusted (ROADMAP 1.10). The Hermes
            // session id stays; the next send resumes the conversation.
            if (rec.running) repairedStaleRunning = true;
            this.sessions.set(rec.sessionId, { ...rec, running: false, ring: [] });
          }
        }
        if (repairedStaleRunning) this.persist();
      }
    } catch (error) {
      // Missing or corrupt file: start empty; Hermes-side session ids held by
      // Cindy remain usable via resume on the next send.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[hermes-mgr][warn] could not load session registry ${file}; starting empty`, error);
      }
    }
  }

  /** Returns false when the id already exists (caller maps to SESSION_ALREADY_EXISTS). */
  create(record: Omit<HermesSessionRecord, 'lastSeq' | 'startedAt' | 'lastEventAt' | 'running'>): boolean {
    if (this.sessions.has(record.sessionId)) return false;
    this.sessions.set(record.sessionId, {
      ...record,
      lastSeq: 0,
      startedAt: new Date().toISOString(),
      lastEventAt: null,
      running: false,
      ring: [],
    });
    this.persist();
    return true;
  }

  get(sessionId: string): HermesSessionRecord | undefined {
    const rec = this.sessions.get(sessionId);
    return rec ? { ...rec } : undefined;
  }

  list(): HermesSessionRecord[] {
    return [...this.sessions.values()].map(({ ring: _ring, ...rec }) => rec);
  }

  update(sessionId: string, patch: Partial<HermesSessionRecord>): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    Object.assign(rec, patch);
    this.persist();
  }

  bindHermes(sessionId: string, hermesSessionId: string): void {
    this.update(sessionId, { hermesSessionId });
  }

  /** Assign the next seq, ring-buffer the event, touch lastEventAt. */
  appendEvent(sessionId: string, event: unknown): number | null {
    const rec = this.sessions.get(sessionId);
    if (!rec) return null;
    rec.lastSeq += 1;
    rec.lastEventAt = new Date().toISOString();
    rec.ring.push(event);
    if (rec.ring.length > RING_CAP) rec.ring.shift();
    this.persist();
    return rec.lastSeq;
  }

  replaySince(
    sessionId: string,
    sinceSeq: number,
  ): { events: Array<{ seq: number; event: unknown }>; currentSeq: number; lossy: boolean } {
    const rec = this.sessions.get(sessionId);
    if (!rec) return { events: [], currentSeq: 0, lossy: true };
    const firstSeq = rec.lastSeq - rec.ring.length + 1;
    const lossy = rec.ring.length > 0 && sinceSeq + 1 < firstSeq;
    const events = rec.ring
      .map((event, i) => ({ seq: firstSeq + i, event }))
      .filter((e) => e.seq > sinceSeq);
    return { events, currentSeq: rec.lastSeq, lossy };
  }

  remove(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    if (existed) this.persist();
    return existed;
  }

  private persist(): void {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(this.list(), null, 2);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
    } catch {
      // Persistence is best-effort for in-memory operation; a read-only home
      // degrades restart recovery, not live behavior.
    }
  }
}
