import { clearComposerDraftsWithPrefix } from './composerDraftStore';

/**
 * Group composer text drafts live in the task draft store on this device (docs/product-rules/bot-group-chat.md
 * §11 默认「草稿先按设备保存」). One draft per signed-in account (realm-qualified key), computer, group and
 * topic. Signing out keeps them for the same account in the same realm; a session that ends (expired,
 * unavailable, deleted, rejected) clears only that account's drafts.
 */
const DRAFT_ID_PREFIX = 'bot-group:';

export function botGroupComposerDraftId(scope: {
  accountKey: string | null | undefined;
  deviceId: string;
  groupId: string;
  threadRootId?: string;
}): string | null {
  if (!scope.accountKey || !scope.groupId) return null;
  return DRAFT_ID_PREFIX + [scope.accountKey, scope.deviceId, scope.groupId, scope.threadRootId ?? '']
    .map(encodeURIComponent).join(':');
}

function accountPrefix(accountKey: string): string {
  return `${DRAFT_ID_PREFIX}${encodeURIComponent(accountKey)}:`;
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

function forgetVersions(prefix: string): void {
  for (const draftId of [...draftVersions.keys()]) {
    if (draftId.startsWith(prefix)) draftVersions.delete(draftId);
  }
}

/**
 * These accounts' sessions ended (expired, unavailable, rejected on start or on switching, or deleted); other
 * saved accounts keep their drafts. Signing out is not an ending: it keeps the drafts.
 */
export async function clearBotGroupComposerDraftsForAccounts(accountKeys: readonly string[]): Promise<void> {
  const ended = [...new Set(accountKeys.filter(Boolean))];
  for (const accountKey of ended) {
    const encoded = encodeURIComponent(accountKey);
    accountClearGenerations.set(encoded, (accountClearGenerations.get(encoded) ?? 0) + 1);
    forgetVersions(accountPrefix(accountKey));
  }
  await Promise.all(ended.map(accountKey => clearComposerDraftsWithPrefix(accountPrefix(accountKey))));
}
