import type { AttachedFile } from './fileTypes';
import {
  getDraft,
  saveDraft,
} from './composerDraftStore';

export type McpAppComposerAttachmentInput = Pick<AttachedFile, 'id' | 'name' | 'path' | 'ext' | 'size' | 'category' | 'mimeType' | 'url' | 'originalName' | 'mcpAppResourceKey'>;

/** Merge a Main-owned attachment into the current task draft without sending. */
export function appendMcpAppComposerAttachment(sessionId: string, input: McpAppComposerAttachmentInput): void {
  const existing = getDraft(sessionId);
  if (existing?.attachments.some(file => file.id === input.id)) return;
  saveDraft(sessionId, {
    ...(existing ?? { text: null, attachments: [], quotes: [], browserComments: [] }),
    attachments: [...(existing?.attachments ?? []), { ...input }],
  }, { silent: true });
}
