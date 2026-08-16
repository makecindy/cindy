/**
 * ChatInput reuses one Tiptap editor across session switches. A send the user
 * already requested must still go to that source session, even after the live
 * editor has been swapped to the next task's draft.
 *
 * Restore is immediate: the next task must not keep showing the source
 * session's listening or refining text. Detached voice text is merged back
 * into the source draft after stop/refine settles.
 */

import type { JSONContent } from '@tiptap/core';

import {
  captureDraftDiscardToken,
  getDraft as getComposerDraft,
  isDraftDiscardTokenCurrent,
  saveDraft as saveComposerDraft,
  type ComposerDraftDiscardToken,
} from '@/lib/composerDraftStore';
import { plainTextToComposerDocument } from '@/lib/composerListDocument';

export function editorOwnsSourceDraft(input: {
  editorDestroyed: boolean;
  editorStorageKey: string | undefined;
  sourceStorageKey: string | undefined;
}): boolean {
  return !input.editorDestroyed && input.editorStorageKey === input.sourceStorageKey;
}

export function voiceLocksCurrentComposer(input: {
  isBusy: boolean;
  ownerStorageKey: string | undefined;
  currentStorageKey: string | undefined;
}): boolean {
  return input.isBusy && input.ownerStorageKey === input.currentStorageKey;
}

export function applyRefinementToSerializedText(
  text: string,
  basedOnText: string,
  refinedText: string,
): string {
  if (!basedOnText || basedOnText === refinedText) return text;
  const index = text.lastIndexOf(basedOnText);
  if (index === -1) return text;
  return text.slice(0, index) + refinedText + text.slice(index + basedOnText.length);
}

/** Patch a frozen composer payload after ASR/refine lands off the live editor. */
export function applyVoiceResultToSerializedText(
  text: string,
  submittedText: string,
  refinedText: string,
): string {
  if (refinedText) {
    const replaced = applyRefinementToSerializedText(
      text,
      submittedText || refinedText,
      refinedText,
    );
    if (replaced !== text) return replaced;
    if (text.includes(refinedText)) return text;
    return text ? `${text}\n${refinedText}` : refinedText;
  }
  if (submittedText && !text.includes(submittedText)) {
    return text ? `${text}\n${submittedText}` : submittedText;
  }
  return text;
}

/**
 * After a session switch the live attachment/comment refs belong to the next
 * task. A send that started on the source session must keep using the source
 * draft extras, never the newly restored composer.
 */
export function resolveSourceOwnedComposerExtras<TAttachment, TComment>(input: {
  editorOwnsSource: boolean;
  liveAttachments: readonly TAttachment[];
  liveComments: readonly TComment[];
  sourceAttachments?: readonly TAttachment[];
  sourceComments?: readonly TComment[];
}): { attachments: TAttachment[]; comments: TComment[] } {
  if (input.editorOwnsSource) {
    return {
      attachments: [...input.liveAttachments],
      comments: [...input.liveComments],
    };
  }
  return {
    attachments: [...(input.sourceAttachments ?? [])],
    comments: [...(input.sourceComments ?? [])],
  };
}

function composerBlockPlainText(block: JSONContent): string {
  if (block.type === 'text') return block.text ?? '';
  return (block.content ?? []).map(composerBlockPlainText).join('');
}

function composerBlocksPlainText(blocks: JSONContent[]): string {
  return blocks.map(composerBlockPlainText).join('\n');
}

/**
 * Land detached ASR / refined text on the source session draft after the live
 * editor has already been swapped to another task.
 */
export function mergeDetachedVoiceTextIntoDocument(
  document: JSONContent | null | undefined,
  previousVoiceText: string,
  nextVoiceText: string,
): JSONContent {
  if (!nextVoiceText) {
    return document?.type === 'doc'
      ? document
      : { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  const voiceBlocks = plainTextToComposerDocument(nextVoiceText).content ?? [];
  const existing = document?.type === 'doc' ? [...(document.content ?? [])] : [];
  const existingText = composerBlocksPlainText(existing).trim();
  if (existing.length === 0 || existingText.length === 0) {
    return { type: 'doc', content: voiceBlocks };
  }
  if (previousVoiceText) {
    const previousBlocks = plainTextToComposerDocument(previousVoiceText).content ?? [];
    if (
      previousBlocks.length > 0 &&
      previousBlocks.length <= existing.length &&
      composerBlocksPlainText(existing.slice(-previousBlocks.length)) ===
        composerBlocksPlainText(previousBlocks)
    ) {
      return {
        type: 'doc',
        content: [...existing.slice(0, -previousBlocks.length), ...voiceBlocks],
      };
    }
  }
  return { type: 'doc', content: [...existing, ...voiceBlocks] };
}

type ArmedDetachedVoiceDraft = {
  storageKey: string;
  previousVoiceText: string;
  token: ComposerDraftDiscardToken;
};

let armedDetachedVoiceDraft: ArmedDetachedVoiceDraft | null = null;

export function persistDetachedVoiceToDraft(
  storageKey: string,
  previousVoiceText: string,
  nextVoiceText: string,
  token?: ComposerDraftDiscardToken,
): void {
  if (!nextVoiceText) return;
  if (token && !isDraftDiscardTokenCurrent(token)) return;
  const existing = getComposerDraft(storageKey);
  saveComposerDraft(
    storageKey,
    {
      text: mergeDetachedVoiceTextIntoDocument(existing?.text, previousVoiceText, nextVoiceText),
      attachments: existing?.attachments ?? [],
      quotes: existing?.quotes ?? [],
      browserComments: existing?.browserComments ?? [],
      ...(existing?.pendingGhostId ? { pendingGhostId: existing.pendingGhostId } : {}),
      ...(existing?.pendingHostCapabilityGhostId
        ? { pendingHostCapabilityGhostId: existing.pendingHostCapabilityGhostId }
        : {}),
      ...(existing?.focusAtEnd ? { focusAtEnd: true } : {}),
    },
    { silent: false },
  );
}

export function armDetachedVoiceDraftPersist(
  storageKey: string,
  previousVoiceText: string,
): void {
  armedDetachedVoiceDraft = {
    storageKey,
    previousVoiceText,
    token: captureDraftDiscardToken(storageKey),
  };
  if (previousVoiceText) {
    persistDetachedVoiceToDraft(
      storageKey,
      '',
      previousVoiceText,
      armedDetachedVoiceDraft.token,
    );
  }
}

export function hasArmedDetachedVoiceDraft(): boolean {
  return armedDetachedVoiceDraft !== null;
}

export function settleArmedDetachedVoiceDraft(nextVoiceText: string): void {
  if (!armedDetachedVoiceDraft) return;
  const { storageKey, previousVoiceText, token } = armedDetachedVoiceDraft;
  armedDetachedVoiceDraft = null;
  persistDetachedVoiceToDraft(
    storageKey,
    previousVoiceText || nextVoiceText,
    nextVoiceText,
    token,
  );
}

export function clearArmedDetachedVoiceDraft(): void {
  armedDetachedVoiceDraft = null;
}
