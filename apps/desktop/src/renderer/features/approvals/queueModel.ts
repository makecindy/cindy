/**
 * Window-local order and lifetime of approval rows. The store owns the requests; this only
 * remembers when this window first saw each one (append-only order, never re-sorted) and keeps a
 * non-interactive placeholder for a request that vanished so the rows below do not jump.
 */
export const ENDED_HOLD_MS = 5000;
export const LEAVE_MS = 200;

export interface LiveRequest { sessionId: string; requestId: string }

export interface QueueEntry {
  key: string;
  sessionId: string;
  requestId: string;
  /** First time THIS window saw the request (not the time it was made). */
  firstSeenAt: number;
  phase: 'pending' | 'ended' | 'leaving';
  /** When the current phase began (ended / leaving). */
  since: number;
}

export const requestKey = (sessionId: string, requestId: string) => `${sessionId}\u0000${requestId}`;

/** Fold the store's live requests into the ordered entries. Returns `entries` itself if unchanged. */
export function syncQueue(entries: QueueEntry[], live: LiveRequest[], now: number): QueueEntry[] {
  const liveKeys = new Set(live.map((item) => requestKey(item.sessionId, item.requestId)));
  let changed = false;
  const next = entries.map((entry) => {
    if (liveKeys.has(entry.key)) {
      if (entry.phase === 'pending') return entry;
      changed = true;
      return { ...entry, phase: 'pending' as const, since: now };
    }
    if (entry.phase !== 'pending') return entry;
    changed = true;
    return { ...entry, phase: 'ended' as const, since: now };
  });
  const known = new Set(entries.map((entry) => entry.key));
  for (const item of live) {
    const key = requestKey(item.sessionId, item.requestId);
    if (known.has(key)) continue;
    known.add(key);
    changed = true;
    next.push({ key, sessionId: item.sessionId, requestId: item.requestId, firstSeenAt: now, phase: 'pending', since: now });
  }
  return changed ? next : entries;
}

/** Move overdue placeholders to `leaving`, and drop the ones whose collapse finished. */
export function expireQueue(entries: QueueEntry[], now: number): QueueEntry[] {
  let changed = false;
  const next: QueueEntry[] = [];
  for (const entry of entries) {
    if (entry.phase === 'ended' && now - entry.since >= ENDED_HOLD_MS) {
      changed = true;
      next.push({ ...entry, phase: 'leaving', since: now });
    } else if (entry.phase === 'leaving' && now - entry.since >= LEAVE_MS) {
      changed = true;
    } else {
      next.push(entry);
    }
  }
  return changed ? next : entries;
}

export function nextDeadline(entries: QueueEntry[]): number | null {
  let deadline: number | null = null;
  for (const entry of entries) {
    if (entry.phase === 'pending') continue;
    const at = entry.since + (entry.phase === 'ended' ? ENDED_HOLD_MS : LEAVE_MS);
    if (deadline === null || at < deadline) deadline = at;
  }
  return deadline;
}
