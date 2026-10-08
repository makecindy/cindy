import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const PREFIX = 'cindy.mobile.shared-task.clipboard-history.v1.';
const LIMIT = 16;
const TTL = 30 * 24 * 60 * 60_000;
type Entry = { digest: string; seenAt: number };
type History = {
  entries: Entry[];
  hydrated: boolean;
  hydrating: Promise<void> | null;
  writes: Promise<void>;
  persisted: string | null;
  retired: boolean;
  clearing: Promise<void> | null;
};
const histories = new Map<string, History>();

export function invitationDigest(invitation: string): string {
  return bytesToHex(sha256(invitation));
}

function historyFor(accountKey: string): History {
  let history = histories.get(accountKey);
  if (!history) {
    history = { entries: [], hydrated: false, hydrating: null, writes: Promise.resolve(), persisted: null, retired: false, clearing: null };
    histories.set(accountKey, history);
  }
  return history;
}

function prune(entries: Entry[]): Entry[] {
  const now = Date.now();
  const seen = new Set<string>();
  return entries.filter(entry => entry.seenAt <= now && now - entry.seenAt < TTL)
    .sort((a, b) => b.seenAt - a.seenAt)
    .filter(entry => {
      if (seen.has(entry.digest)) return false;
      seen.add(entry.digest); return true;
    }).slice(0, LIMIT);
}

function parse(raw: string | null): Entry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.entries)) return [];
    return value.entries.filter((entry: unknown): entry is Entry => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Partial<Entry>;
      return typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest)
        && typeof item.seenAt === 'number' && Number.isFinite(item.seenAt);
    }).map(({ digest, seenAt }: Entry) => ({ digest, seenAt }));
  } catch { return []; }
}

async function hydrate(accountKey: string, history: History): Promise<void> {
  if (history.hydrated || history.retired) return;
  if (!history.hydrating) {
    history.hydrating = AsyncStorage.getItem(PREFIX + accountKey).then(raw => {
      if (history.retired) return;
      // Invitations can be offered while this read is in flight. Preserve those records.
      history.entries = prune([...history.entries, ...parse(raw)]);
      history.hydrated = true;
      history.persisted = raw;
    }).catch(() => {
      // Retry later; an unread history must never be overwritten by an empty cache.
    }).finally(() => { history.hydrating = null; });
  }
  await history.hydrating;
}

/** Callers revalidate their captured auth generation after this asynchronous read. */
export async function hasSeenClipboardInvitation(accountKey: string, digest: string): Promise<boolean> {
  if (!accountKey) return false;
  const history = historyFor(accountKey);
  if (history.retired) {
    // A failed terminal cleanup must not disable deduplication for a later login.
    if (!history.clearing) await clearClipboardInvitationHistory(accountKey).catch(() => undefined);
    return false;
  }
  await hydrate(accountKey, history);
  if (history.retired) return false;
  history.entries = prune(history.entries);
  // Persist expiry/normalization even when no new invitation is recorded.
  if (history.hydrated) await persistHistory(accountKey, history);
  return history.entries.some(entry => entry.digest === digest);
}

/** Remember synchronously in memory; serialize best-effort writes within the captured account. */
export function rememberClipboardInvitation(accountKey: string, digest: string): Promise<void> {
  if (!accountKey) return Promise.resolve();
  const history = historyFor(accountKey);
  if (history.retired) return Promise.resolve();
  history.entries = prune([{ digest, seenAt: Date.now() }, ...history.entries]);
  return persistHistory(accountKey, history);
}

function persistHistory(accountKey: string, history: History): Promise<void> {
  history.writes = history.writes.then(async () => {
    await hydrate(accountKey, history);
    if (!history.hydrated || history.retired) return;
    history.entries = prune(history.entries);
    const value = history.entries.length ? JSON.stringify({ version: 1, entries: history.entries }) : null;
    if (value === history.persisted) return;
    if (value === null) await AsyncStorage.removeItem(PREFIX + accountKey);
    else await AsyncStorage.setItem(PREFIX + accountKey, value);
    history.persisted = value;
  }).catch(() => {
    // Storage failure must not interrupt admission; memory still deduplicates this run.
  });
  return history.writes;
}

/** Invalidate synchronously, then delete after older reads/writes have settled. */
export function clearClipboardInvitationHistory(accountKey: string): Promise<void> {
  if (!accountKey) return Promise.resolve();
  const history = historyFor(accountKey);
  if (history.clearing) return history.clearing;
  history.retired = true;
  history.entries = [];
  const clearing = history.writes.then(async () => {
    await history.hydrating;
    // Erase digests durably before removing the key. If removal fails and the
    // process exits, hydration sees an empty record and retries its removal.
    // Still attempt removal if overwriting fails (e.g. storage is full).
    await AsyncStorage.setItem(PREFIX + accountKey, JSON.stringify({ version: 1, entries: [] }))
      .catch(() => undefined);
    await AsyncStorage.removeItem(PREFIX + accountKey);
    if (histories.get(accountKey) === history) histories.delete(accountKey);
  }).finally(() => { history.clearing = null; });
  history.clearing = clearing;
  // Keep deletion errors visible to cleanup callers while allowing a later retry.
  history.writes = clearing.catch(() => undefined);
  return clearing;
}

export const __testing = {
  storageKey: (accountKey: string) => PREFIX + accountKey,
  reset: () => histories.clear(),
  flush: () => Promise.all([...histories.values()].map(history => history.writes)),
};
