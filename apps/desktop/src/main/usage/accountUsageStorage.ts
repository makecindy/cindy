import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';

export type AccountUsageProvider = 'anthropic' | 'openai';

/** The database is owner-scoped; placement in a different provider never changes account identity. */
export function accountUsageStorageKey(provider: AccountUsageProvider, accountId: string): string {
  return `${provider === 'anthropic' ? 'claude-code' : 'codex'}:${accountId}`;
}

// One in-flight write and a clear/latest replacement per source, serialized on the account row.
// Slow SQLite cannot build an unbounded queue or mix legacy observations into verified identity.
type Source = 'verified' | 'legacy';
type PendingWrite = { clears: Map<Source, () => Promise<void>>; next: Map<Source, () => Promise<void>>; promise: Promise<void> };
const pending = new Map<string, PendingWrite>();
function scope(provider: AccountUsageProvider, accountId: string) {
  const owner = activeOwnerScopeKey();
  const dbOwner = getCurrentDbClientUserId();
  const db = getDbClient();
  const key = accountUsageStorageKey(provider, accountId);
  const current = () => !!dbOwner && owner === activeOwnerScopeKey()
    && dbOwner === getCurrentDbClientUserId() && !isAppSessionBoundaryPending();
  return { db, key, queueKey: `${owner}:${key}`, current };
}

/** Read old keys only when no new-format row exists. A null row is an intentional clear. */
export async function readStoredAccountUsage(
  provider: AccountUsageProvider,
  accountId: string,
  legacyKeys: readonly string[] = [],
  source: Source = 'verified',
): Promise<Record<string, unknown> | null> {
  const s = scope(provider, accountId);
  await pending.get(s.queueKey)?.promise;
  if (!s.current()) return null;
  for (const key of [s.key, ...legacyKeys]) {
    const row = await s.db.queryOne<{ snapshot: string | null }>(
      'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?', [key],
    );
    if (!s.current()) return null;
    if (!row) continue;
    try {
      const value: unknown = row.snapshot ? JSON.parse(row.snapshot) : null;
      const record = plainRecord(value);
      if (!record) return null;
      if (source === 'legacy' && 'legacySnapshot' in record) return plainRecord(record.legacySnapshot);
      const { legacySnapshot: _legacy, ...snapshot } = record;
      return Object.keys(snapshot).length ? snapshot : null;
    } catch { return null; }
  }
  return null;
}

/** Only non-secret quota projections belong here. Null tombstones prevent legacy fallback revival. */
export async function writeStoredAccountUsage(
  provider: AccountUsageProvider,
  accountId: string,
  snapshot: object | null,
  isCurrent: () => boolean = () => true,
  source: Source = 'verified',
): Promise<void> {
  const s = scope(provider, accountId);
  const write = async () => {
    if (!s.current() || !isCurrent()) return;
    let payload = snapshot;
    // Native pool identity and old native/WHAM observations have different proofs. Keep them
    // in the SAME account row without attaching an unverified observation to a verified digest.
    if (source === 'legacy' || typeof (snapshot as Record<string, unknown> | null)?.accountFingerprint === 'string') {
      const row = await s.db.queryOne<{ snapshot: string | null }>(
        'SELECT snapshot FROM account_usage_snapshots WHERE agent_kind = ?', [s.key],
      );
      if (!s.current() || !isCurrent()) return;
      let previous: Record<string, unknown> | null = null;
      try { previous = plainRecord(row?.snapshot ? JSON.parse(row.snapshot) : null); } catch { /* replace corrupt data */ }
      if (source === 'legacy') {
        payload = typeof previous?.accountFingerprint === 'string'
          ? { ...previous, legacySnapshot: snapshot } : { legacySnapshot: snapshot };
      } else if (source === 'verified' && snapshot) {
        const incoming = snapshot as Record<string, unknown>;
        const same = previous?.accountFingerprint === incoming.accountFingerprint;
        const legacy = same ? previous?.legacySnapshot
          : previous && !previous.accountFingerprint ? previous.legacySnapshot ?? previous : undefined;
        if (legacy !== undefined) payload = { ...snapshot, legacySnapshot: legacy };
      }
    }
    await s.db.exec(
      `INSERT INTO account_usage_snapshots (agent_kind, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_kind) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      [s.key, JSON.stringify(payload), Date.now()],
    );
  };
  const existing = pending.get(s.queueKey);
  if (existing) {
    if (snapshot === null) {
      if (source === 'verified') { existing.clears.clear(); existing.next.clear(); }
      else existing.next.delete(source);
      existing.clears.set(source, write);
    } else existing.next.set(source, write);
    return existing.promise;
  }
  const entry: PendingWrite = { clears: new Map(), next: new Map(), promise: Promise.resolve() };
  (snapshot === null ? entry.clears : entry.next).set(source, write);
  entry.promise = Promise.resolve().then(async () => {
    let failure: unknown;
    try {
      while (entry.clears.size || entry.next.size) {
        const queue = entry.clears.size ? entry.clears : entry.next;
        const [origin, next] = queue.entries().next().value!;
        queue.delete(origin);
        try { await next(); } catch (error) { failure = error; }
      }
      // A failed observation must not discard a removal already queued behind it.
      if (failure) throw failure;
    } finally {
      if (pending.get(s.queueKey) === entry) pending.delete(s.queueKey);
    }
  });
  pending.set(s.queueKey, entry);
  return entry.promise;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readStoredLegacyAccountUsage(provider: AccountUsageProvider, accountId: string, legacyKeys: readonly string[] = []) {
  return readStoredAccountUsage(provider, accountId, legacyKeys, 'legacy');
}

export function writeStoredLegacyAccountUsage(provider: AccountUsageProvider, accountId: string, snapshot: object | null, isCurrent?: () => boolean) {
  return writeStoredAccountUsage(provider, accountId, snapshot, isCurrent, 'legacy');
}
