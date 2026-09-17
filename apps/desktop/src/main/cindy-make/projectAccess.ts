import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../i18n.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeWorktreePath, makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';

export async function assertCindyMakeWorkspace(
  userData: string,
  workingDir: string,
): Promise<void> {
  if (!isCindyMakeWorktreePath(userData, workingDir)) return;
  try {
    const [directory, worktreeGit, sourceGit] = await Promise.all([
      lstat(workingDir),
      lstat(path.join(workingDir, '.git')),
      lstat(path.join(makeSourceCheckoutPath(userData), '.git')),
    ]);
    if (
      directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      worktreeGit.isFile() &&
      sourceGit.isDirectory()
    )
      return;
  } catch {}
  throwIpcError('PRECONDITION_FAILED', t('cindyMake.code.workspaceUnavailable'));
}

export async function withCindyMakeProjectUse<T>(
  userData: string,
  workingDir: string | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!workingDir || !isCindyMakeWorktreePath(userData, workingDir)) return run();
  try {
    return await cindyMakeManager.withProjectUse(makeSourceRoot(userData), async () => {
      await assertCindyMakeWorkspace(userData, workingDir);
      return run();
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'busy')
      throwIpcError('DEVICE_BUSY', t('cindyMake.code.projectClearing'));
    throw error;
  }
}
