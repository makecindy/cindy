import { extractIpcError } from '../../shared/ipcError';
import {
  COMPOSER_MENTION_MIME,
  decodeComposerMentionPayload,
  type ComposerFileMentionPayload,
} from './composerMentionDrag';

interface ComposerMentionDataTransfer {
  getData(type: string): string;
}

interface ComposerMentionTarget {
  addFileMention(payload: ComposerFileMentionPayload): void;
  addFolderPath(folderPath: string, source?: 'task'): void;
}

export function consumeComposerMentionDrop(
  dataTransfer: ComposerMentionDataTransfer,
  target: ComposerMentionTarget,
): boolean {
  const mentionPayload = decodeComposerMentionPayload(
    dataTransfer.getData(COMPOSER_MENTION_MIME),
  );
  if (!mentionPayload) return false;
  if (mentionPayload.type === 'directory') {
    target.addFolderPath(mentionPayload.relPath, 'task');
    return true;
  }
  target.addFileMention(mentionPayload);
  return true;
}

export const COMPOSER_ATTACHMENT_MIME = 'application/x-cindy-composer-attachment-v1';

export function isComposerAttachmentDrag(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data?.types?.includes(COMPOSER_ATTACHMENT_MIME);
}

export function composerAttachmentDropError(error: unknown): string {
  switch (extractIpcError(error)?.message) {
    case 'MCP_APP_COMPOSER_ATTACHMENT_BUSY':
    case 'MCP_APP_COMPOSER_ATTACHMENT_RATE_LIMIT':
      return 'mcpApps.composerAttachmentBusy';
    case 'MCP_APP_COMPOSER_ATTACHMENT_TOO_LARGE':
    case 'MCP_APP_COMPOSER_ATTACHMENT_UNSUPPORTED_TYPE':
    case 'MCP_APP_COMPOSER_ATTACHMENT_CONTENT_MISMATCH':
      return 'mcpApps.composerAttachmentFormat';
    default:
      return 'mcpApps.composerDragFailed';
  }
}
