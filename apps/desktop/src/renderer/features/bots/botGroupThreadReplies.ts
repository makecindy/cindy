/** Process-local thread attempts survive panel remounts, alongside their composer drafts. */
import { useCallback, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import {
  captureDraftDiscardToken, getDraft, isDraftDiscardTokenCurrent, setBotGroupThreadAttachmentUrls,
  subscribeDraftContent, type ComposerDraftDiscardToken,
} from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import type { BotGroupMemberView, BotGroupMention } from '../../../shared/botGroupChat';
import type { BotGroupTrackedMention } from './botGroupMentions';
import { botGroupAttachmentSignature } from './botGroupAttachments';

export interface BotGroupThreadReplyAttempt {
  text: string;
  draft: string;
  clientId: string;
  attachmentSignature: string;
  files: readonly AttachedFile[];
  prepared?: readonly AttachedFile[];
  mentions: BotGroupMention;
  roster: readonly BotGroupMemberView[];
  tracked: readonly BotGroupTrackedMention[];
  sending: boolean;
  errorKey?: string;
}

interface HeldAttempt {
  token: ComposerDraftDiscardToken;
  value: BotGroupThreadReplyAttempt;
  unsubscribe: () => void;
}
const attempts = new Map<string, HeldAttempt>();
const listeners = new Set<() => void>();
let owner = getDataOwnerGeneration();

function protectMedia(): void {
  const urls: string[] = [];
  for (const { value } of attempts.values()) {
    for (const file of [...value.files, ...(value.prepared ?? [])]) {
      if (file.url) urls.push(file.url);
      if (file.annotationSourceUrl) urls.push(file.annotationSourceUrl);
    }
  }
  setBotGroupThreadAttachmentUrls(urls);
}

function ensureOwner(): void {
  if (isDataOwnerGenerationCurrent(owner)) return;
  owner = getDataOwnerGeneration();
  for (const entry of attempts.values()) entry.unsubscribe();
  attempts.clear();
  protectMedia();
}

export function getBotGroupThreadReplyAttempt(scope: string): BotGroupThreadReplyAttempt | undefined {
  ensureOwner();
  return attempts.get(captureDraftDiscardToken(scope).ownerScopedKey)?.value;
}

/** Success/edit releases a retry; explicit draft discard also fences its late callbacks. */
export function setBotGroupThreadReplyAttempt(scope: string, value: BotGroupThreadReplyAttempt | null): void {
  ensureOwner();
  const token = captureDraftDiscardToken(scope);
  const existing = attempts.get(token.ownerScopedKey);
  if (value) {
    if (existing) existing.value = value;
    else attempts.set(token.ownerScopedKey, {
      token, value,
      unsubscribe: subscribeDraftContent(scope, () => {
        const current = attempts.get(token.ownerScopedKey)?.value;
        if (!isDraftDiscardTokenCurrent(token) || (current && !current.sending
          && current.attachmentSignature !== botGroupAttachmentSignature(getDraft(scope)?.attachments ?? []))) {
          setBotGroupThreadReplyAttempt(scope, null);
        }
      }),
    });
  } else {
    existing?.unsubscribe();
    attempts.delete(token.ownerScopedKey);
  }
  protectMedia();
  for (const listener of listeners) listener();
}

export function updateBotGroupThreadReplyAttempt(
  scope: string, clientId: string, changes: Partial<BotGroupThreadReplyAttempt>,
): void {
  const current = getBotGroupThreadReplyAttempt(scope);
  if (current?.clientId === clientId) setBotGroupThreadReplyAttempt(scope, { ...current, ...changes });
}

export function useBotGroupThreadReplyAttempt(scope: string | null): BotGroupThreadReplyAttempt | undefined {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const snapshot = useCallback(() => scope ? getBotGroupThreadReplyAttempt(scope) : undefined, [scope]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
