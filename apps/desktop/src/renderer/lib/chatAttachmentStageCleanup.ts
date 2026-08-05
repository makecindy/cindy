import type { AttachedFile } from './fileTypes';
import { createLogger } from './logger';

const log = createLogger('ChatAttachmentStageCleanup');

function stagedPaths(files: readonly Pick<AttachedFile, 'path'>[]): string[] {
  return [
    ...new Set(
      files
        .map((file) => file.path)
        .filter((filePath): filePath is string =>
          typeof filePath === 'string' && filePath.toLowerCase().endsWith('.bin'),
        ),
    ),
  ];
}

/**
 * Best-effort cleanup for physical `.bin` copies owned by an unsent draft.
 * Main re-checks the controlled cache root, so legacy/original paths are safe
 * to pass through and are simply ignored there.
 */
export function cleanupStagedChatAttachmentFiles(
  files: readonly Pick<AttachedFile, 'path'>[],
): void {
  const paths = stagedPaths(files);
  if (paths.length === 0) return;
  try {
    void window.electronAPI.cleanupStagedChatAttachments(paths).catch((error: unknown) => {
      log.warn('staged attachment cleanup failed', error);
    });
  } catch (error) {
    log.warn('staged attachment cleanup failed', error);
  }
}

