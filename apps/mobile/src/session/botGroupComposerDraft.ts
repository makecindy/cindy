import { randomUUID } from 'expo-crypto';
import { useEffect, useState } from 'react';
import { clearComposerDraft, clearComposerDraftsWithPrefix, listComposerDraftIds } from './composerDraftStore';

/**
 * Group composer text drafts live in the task draft store on this device (docs/product-rules/bot-group-chat.md
 * §11 默认「草稿先按设备保存」). One draft per signed-in account (realm-qualified key), draft generation,
 * computer, group and topic.
 *
 * The generation comes from the account record (mobileAccountVault `groupDraftEpochs`). Ending an account's
 * session removes it in the same write that ends the session, so its old drafts can no longer be read even if
 * deleting them from storage fails; deleting is cleanup afterwards. Signing out keeps it: the same account in the
 * same realm gets its drafts back.
 */
const DRAFT_ID_PREFIX = 'bot-group:';

export interface InvalidatedBotGroupDraftEpoch {
  accountKey: string;
  epoch: string;
}

/** Where generations come from: the account record, connected by AuthContext (session code never reads credentials). */
export interface BotGroupDraftEpochSource {
  ensure(accountKey: string, createEpoch: () => string): Promise<string | null>;
  read(): Promise<Record<string, string> | null>;
  subscribe(listener: (invalidated: readonly InvalidatedBotGroupDraftEpoch[]) => void): () => void;
}

let epochSource: BotGroupDraftEpochSource | null = null;
let unsubscribeEpochSource: (() => void) | null = null;

/** Without a source there is no generation, so group drafts stay in memory only. */
export function connectBotGroupDraftEpochs(source: BotGroupDraftEpochSource | null): void {
  unsubscribeEpochSource?.();
  epochSource = source;
  unsubscribeEpochSource = source?.subscribe((invalidated) => { void dropVoidedGenerations(invalidated); }) ?? null;
}

export function botGroupComposerDraftId(scope: {
  accountKey: string | null | undefined;
  /** Null until the account's generation is known; there is no draft without one. */
  epoch: string | null | undefined;
  deviceId: string;
  groupId: string;
  threadRootId?: string;
}): string | null {
  if (!scope.accountKey || !scope.epoch || !scope.groupId) return null;
  return DRAFT_ID_PREFIX + [scope.accountKey, scope.epoch, scope.deviceId, scope.groupId, scope.threadRootId ?? '']
    .map(encodeURIComponent).join(':');
}

function generationPrefix(accountKey: string, epoch: string): string {
  return `${DRAFT_ID_PREFIX}${encodeURIComponent(accountKey)}:${encodeURIComponent(epoch)}:`;
}

/** The decoded account key and generation of a draft id, or null for anything else (including older ids). */
function draftScope(draftId: string): { accountKey: string; epoch: string } | null {
  if (!draftId.startsWith(DRAFT_ID_PREFIX)) return null;
  const parts = draftId.slice(DRAFT_ID_PREFIX.length).split(':');
  if (parts.length !== 5) return null;
  try {
    return { accountKey: decodeURIComponent(parts[0]), epoch: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

const accountClearGenerations = new Map<string, number>();
const draftVersions = new Map<string, number>();

/**
 * Changes when this draft's account is cleared; a send that began before must not put its text back. Ending
 * another account's session leaves it unchanged.
 */
export function botGroupComposerDraftGeneration(draftId: string): number {
  const account = draftId.slice(DRAFT_ID_PREFIX.length, draftId.indexOf(':', DRAFT_ID_PREFIX.length));
  return accountClearGenerations.get(account) ?? 0;
}

/**
 * Every edit, send and put-back of a draft moves its version. A send that ends after its chat was left may
 * put its text back only while it still owns the current version: nothing was typed, cleared or sent since.
 */
export function markBotGroupComposerDraftChanged(draftId: string): number {
  const next = (draftVersions.get(draftId) ?? 0) + 1;
  draftVersions.set(draftId, next);
  return next;
}

export function botGroupComposerDraftVersion(draftId: string): number {
  return draftVersions.get(draftId) ?? 0;
}

/** After the account record voided these generations: forget them in memory, then delete them from storage. */
async function dropVoidedGenerations(invalidated: readonly InvalidatedBotGroupDraftEpoch[]): Promise<void> {
  for (const { accountKey } of invalidated) {
    const encoded = encodeURIComponent(accountKey);
    accountClearGenerations.set(encoded, (accountClearGenerations.get(encoded) ?? 0) + 1);
  }
  const prefixes = invalidated.map(({ accountKey, epoch }) => generationPrefix(accountKey, epoch));
  for (const draftId of [...draftVersions.keys()]) {
    if (prefixes.some(prefix => draftId.startsWith(prefix))) draftVersions.delete(draftId);
  }
  await Promise.all(prefixes.map(prefix => clearComposerDraftsWithPrefix(prefix).catch(() => undefined)));
}

let staleSweep: Promise<void> | null = null;

/**
 * Deletes stored group drafts whose generation is no longer current (voided, or written before generations
 * existed). Runs once per process; skipped and retried later when the account record cannot be read. A draft is
 * stale only if the generations read before and after listing both disagree with it, so one written under a
 * generation created meanwhile is kept.
 */
export function sweepStaleBotGroupDrafts(): Promise<void> {
  staleSweep ??= (async () => {
    const read = epochSource?.read ?? (async () => null);
    const before = await read();
    const draftIds = before ? await listComposerDraftIds(DRAFT_ID_PREFIX) : [];
    const after = before ? await read() : null;
    if (!before || !after) {
      staleSweep = null;
      return;
    }
    for (const draftId of draftIds) {
      const scope = draftScope(draftId);
      const stale = !scope || (before[scope.accountKey] !== scope.epoch && after[scope.accountKey] !== scope.epoch);
      if (stale) clearComposerDraft(draftId);
    }
  })().catch(() => { staleSweep = null; });
  return staleSweep;
}


/**
 * The signed-in account's draft generation, created on first use. Null while it loads or when the account
 * record cannot be read or written; the composer then keeps its text in memory and saves it once one arrives.
 */
export function useBotGroupDraftEpoch(accountKey: string | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ accountKey: string; epoch: string | null } | null>(null);
  useEffect(() => {
    // Signed out (or no source): forget the loaded generation, so signing back in never starts from a voided one.
    if (!accountKey || !epochSource) {
      setLoaded(null);
      return;
    }
    let live = true;
    void epochSource.ensure(accountKey, randomUUID).then((epoch) => {
      if (live) setLoaded({ accountKey, epoch });
      if (epoch) void sweepStaleBotGroupDrafts();
    });
    return () => { live = false; };
  }, [accountKey]);
  return accountKey && loaded?.accountKey === accountKey ? loaded.epoch : null;
}

export const __testing = {
  resetStaleSweep(): void { staleSweep = null; },
};
