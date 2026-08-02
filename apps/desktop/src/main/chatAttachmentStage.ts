/**
 * Copies a dangerous local attachment into a controlled cache under an inert
 * `.bin` filename before the renderer stores or sends the attachment record.
 *
 * The caller validates the selected path, resolves symlinks, then copies from
 * the same already-opened file object that was checked. This keeps the source
 * path from being swapped between validation and copy.
 */
import path from 'node:path';

import { isDangerousAttachmentName } from '../shared/attachmentSafety.js';

export type ChatAttachmentStageErrorCode =
  | 'invalid_source'
  | 'forbidden'
  | 'not_found'
  | 'not_file'
  | 'unsupported_type'
  | 'copy_failed';

export type ChatAttachmentStageResult =
  | { success: true; path: string }
  | { success: false; code: ChatAttachmentStageErrorCode };

export interface ChatAttachmentStageSourceStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile(): boolean;
}

export interface ChatAttachmentStageOpenedSource {
  stat(): Promise<ChatAttachmentStageSourceStat>;
  copyTo(targetPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface ChatAttachmentStageDeps {
  isPathAllowed(filePath: string): boolean;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<ChatAttachmentStageSourceStat>;
  openSource(filePath: string): Promise<ChatAttachmentStageOpenedSource>;
  stageCopy(params: {
    suggestedName: string;
    expectedSize: bigint;
    copyTo(targetPath: string): Promise<void>;
  }): Promise<string>;
}

function isSameFileObject(
  expected: ChatAttachmentStageSourceStat,
  actual: ChatAttachmentStageSourceStat,
): boolean {
  return expected.ino !== 0n && expected.dev === actual.dev && expected.ino === actual.ino;
}

export function createChatAttachmentStageHandler(deps: ChatAttachmentStageDeps) {
  return async function stageChatAttachment(params: {
    sourcePath?: unknown;
    suggestedName?: unknown;
  }): Promise<ChatAttachmentStageResult> {
    const sourcePath = typeof params?.sourcePath === 'string' ? params.sourcePath : '';
    const suggestedName = typeof params?.suggestedName === 'string' ? params.suggestedName : '';
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return { success: false, code: 'invalid_source' };
    }
    if (
      !suggestedName ||
      (!isDangerousAttachmentName(suggestedName) && !isDangerousAttachmentName(sourcePath))
    ) {
      return { success: false, code: 'unsupported_type' };
    }
    if (!deps.isPathAllowed(sourcePath)) {
      return { success: false, code: 'forbidden' };
    }

    let resolvedSourcePath: string;
    try {
      resolvedSourcePath = await deps.realpath(sourcePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { success: false, code: code === 'ENOENT' ? 'not_found' : 'forbidden' };
    }
    if (!deps.isPathAllowed(resolvedSourcePath)) {
      return { success: false, code: 'forbidden' };
    }

    let validatedSourceStat: ChatAttachmentStageSourceStat;
    try {
      validatedSourceStat = await deps.stat(resolvedSourcePath);
      if (!validatedSourceStat.isFile()) return { success: false, code: 'not_file' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { success: false, code: code === 'ENOENT' ? 'not_found' : 'not_file' };
    }

    let openedSource: ChatAttachmentStageOpenedSource | null = null;
    try {
      openedSource = await deps.openSource(resolvedSourcePath);
      const openedStat = await openedSource.stat();
      if (!openedStat.isFile()) return { success: false, code: 'not_file' };
      if (!isSameFileObject(validatedSourceStat, openedStat)) {
        return { success: false, code: 'forbidden' };
      }
      const stagedPath = await deps.stageCopy({
        suggestedName,
        expectedSize: openedStat.size,
        copyTo: (targetPath) => openedSource!.copyTo(targetPath),
      });
      if (!path.isAbsolute(stagedPath) || path.extname(stagedPath).toLowerCase() !== '.bin') {
        return { success: false, code: 'copy_failed' };
      }
      return { success: true, path: stagedPath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return { success: false, code: 'not_found' };
      if (code === 'ELOOP') return { success: false, code: 'forbidden' };
      return { success: false, code: 'copy_failed' };
    } finally {
      if (openedSource) await openedSource.close().catch(() => undefined);
    }
  };
}
