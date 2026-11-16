import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';

export type AccountUsageProvider = 'anthropic' | 'openai';

/** The database is owner-scoped; placement in a different provider never changes account identity. */
export function accountUsageStorageKey(provider: AccountUsageProvider, accountId: string): string {
  return `${provider === 'anthropic' ? 'claude-code' : 'codex'}:${accountId}`;
}

// One in-flight write, a clear barrier, and one latest replacement per row. Slow SQLite must
// neither build an unbounded event queue nor resurrect a removed login after its tombstone.
type PendingWrite = { clear?: () => Promise<void>; next?: () => Promise<void>; promise: Promise<void> };
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
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
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
): Promise<void> {
  const s = scope(provider, accountId);
  const json = JSON.stringify(snapshot);
  const write = async () => {
    if (!s.current() || !isCurrent()) return;
    await s.db.exec(
      `INSERT INTO account_usage_snapshots (agent_kind, snapshot, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_kind) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      [s.key, json, Date.now()],
    );
  };
  const existing = pending.get(s.queueKey);
  if (existing) {
    if (snapshot === null) { existing.clear = write; existing.next = undefined; }
    else existing.next = write;
    return existing.promise;
  }
  const entry: PendingWrite = { ...(snapshot === null ? { clear: write } : { next: write }), promise: Promise.resolve() };
  entry.promise = Promise.resolve().then(async () => {
    let failure: unknown;
    try {
      while (entry.clear || entry.next) {
        const next = entry.clear ?? entry.next!;
        if (entry.clear) entry.clear = undefined;
        else entry.next = undefined;
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
