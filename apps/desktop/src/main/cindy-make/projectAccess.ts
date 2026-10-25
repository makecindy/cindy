import {createCindyMakeWorkspace} from '@cindy/app-runtime/cindyMakeWorkspace';
import { t } from '../i18n.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeManagedWorktreePath, makeSourceRoot } from './sourcePaths.js';

export const {assertCindyMakeWorkspace}=createCindyMakeWorkspace((...args)=>t(...args));

export async function withCindyMakeProjectUse<T>(
  userData: string,
  workingDir: string | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!workingDir || !isCindyMakeManagedWorktreePath(userData, workingDir)) return run();
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
