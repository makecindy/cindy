import type { JSONContent } from '@tiptap/core';

import type { BrowserCommentDraftItem } from '@/lib/browserComments';
import type { AttachedFile } from '@/lib/fileTypes';

export interface ComposerSendSnapshot {
  documentToken: string;
  attachments: readonly AttachedFile[];
  browserComments: readonly BrowserCommentDraftItem[];
}

/** Captures object versions without serializing potentially large attachment bytes. */
export function captureComposerSendSnapshot(
  document: JSONContent,
  attachments: AttachedFile[],
  browserComments: BrowserCommentDraftItem[],
): ComposerSendSnapshot {
  return {
    documentToken: JSON.stringify(document),
    attachments,
    browserComments,
  };
}

export function isComposerSendSnapshotCurrent(
  snapshot: ComposerSendSnapshot,
  document: JSONContent,
  attachments: AttachedFile[],
  browserComments: BrowserCommentDraftItem[],
): boolean {
  return (
    snapshot.documentToken === JSON.stringify(document) &&
    snapshot.attachments.length === attachments.length &&
    snapshot.attachments.every((item, index) => item === attachments[index]) &&
    snapshot.browserComments.length === browserComments.length &&
    snapshot.browserComments.every((item, index) => item === browserComments[index])
  );
}
