import { CINDY_MAKE_SESSION_SOURCE } from '../../../shared/cindyMakeSession.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { isCindyMakeWorktreePath } from '../../cindy-make/taskWorkspace.js';
import { normalizeRemoteHostId } from '../mapper.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

/**
 * Renderer may only request the Cindy Make purpose, and only for a task
 * worktree Cindy created under its managed source root: the marker later
 * exposes the `cindy_make` tool and commits the worktree on completion. Bot
 * tasks keep going through the Bot lifecycle service.
 */
export function assertRendererSessionSourceAllowed(input: {
  source: unknown;
  workingDir: string | undefined;
  remoteHostId: unknown;
  userData: string;
}): void {
  if (input.source === undefined) return;
  if (input.source !== CINDY_MAKE_SESSION_SOURCE) {
    throwIpcError(
      'UNSUPPORTED_CAPABILITY',
      'Bot task creation is only available through the Bot lifecycle service',
    );
  }
  if (normalizeRemoteHostId(typeof input.remoteHostId === 'string' ? input.remoteHostId : null)) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make tasks are local-only');
  }
  const requested = normalizeWorkingDirForStorage(input.workingDir);
  if (!requested || !isCindyMakeWorktreePath(input.userData, requested)) {
    throwIpcError('INVALID_PARAMS', 'Cindy Make tasks can only use a managed task worktree');
  }
}
