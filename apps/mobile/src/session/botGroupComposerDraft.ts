import { clearComposerDraftsWithPrefix } from './composerDraftStore';

/**
 * Group composer text drafts live in the task draft store on this device (docs/product-rules/bot-group-chat.md
 * §11 默认「草稿先按设备保存」). One draft per account, computer, group and topic; signing out clears them all.
 */
const DRAFT_ID_PREFIX = 'bot-group:';

export function botGroupComposerDraftId(scope: {
  accountId: string | null | undefined;
  deviceId: string;
  groupId: string;
  threadRootId?: string;
}): string | null {
  if (!scope.accountId || !scope.groupId) return null;
  return DRAFT_ID_PREFIX + [scope.accountId, scope.deviceId, scope.groupId, scope.threadRootId ?? '']
    .map(encodeURIComponent).join(':');
}

let clearGeneration = 0;

/** Changes on every sign-out clear; a send that began before it must not put its text back. */
export function botGroupComposerDraftGeneration(): number {
  return clearGeneration;
}

export function clearBotGroupComposerDrafts(): Promise<void> {
  clearGeneration += 1;
  return clearComposerDraftsWithPrefix(DRAFT_ID_PREFIX);
}
