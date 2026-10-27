import path from 'node:path';
import { readBranchSyncStatus, syncBranch } from './branchSync';
import { GitExecError } from './gitExec';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate';
import {
  BRANCH_SYNC_ERROR_PREFIX,
  type BranchSyncRequest,
  type BranchSyncFailureReason,
} from '../../shared/worktreeBranchSync';

/** Small IPC boundary, testable without loading Electron or the WorktreeManager. */
export function createBranchSyncHandlers<Event>(deps: {
  assertTrustedAppRendererEvent(event: Event): void;
  isDeviceLinkInvoke(): boolean;
}) {
  function request(event: Event, input: unknown): BranchSyncRequest {
    // Remote invokes already passed the same-account device-link allowlist.
    if (!deps.isDeviceLinkInvoke()) deps.assertTrustedAppRendererEvent(event);
    const body = requireObject(input);
    const baseRepo = requireString(body.baseRepo, 'baseRepo');
    const branch = requireString(body.branch, 'branch');
    if (
      !path.isAbsolute(baseRepo) ||
      baseRepo.length > 32768 ||
      baseRepo.includes('\0') ||
      branch.length > 1024 ||
      /[\x00-\x20~^:?*\\\[]/.test(branch) ||
      branch.startsWith('-') ||
      branch.includes('..')
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid repository or branch');
    }
    return { baseRepo, branch };
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Do not return raw Git output: remote URLs may contain credentials.
      let reason: BranchSyncFailureReason = 'git';
      if (error instanceof GitExecError) {
        if (error.timedOut) reason = 'timeout';
        else if (/auth|credential|permission denied|could not read Username/i.test(error.stderr))
          reason = 'auth';
        else if (/could not resolve|unable to access|connect|network/i.test(error.stderr))
          reason = 'network';
        else if (/couldn.t find remote ref/i.test(error.stderr)) reason = 'missing';
        else if (/lock|expected/i.test(error.stderr)) reason = 'busy';
      }
      if (error instanceof Error && error.message === 'A branch update is already running')
        reason = 'busy';
      if (error instanceof Error && error.message === 'The checked-out branch changed; retry')
        reason = 'changed';
      throwIpcError('INTERNAL', BRANCH_SYNC_ERROR_PREFIX + reason);
    }
  }
  return {
    status: (event: Event, input: unknown) => {
      const req = request(event, input);
      return run(() => readBranchSyncStatus(req));
    },
    sync: (event: Event, input: unknown) => {
      const req = request(event, input);
      return run(() => syncBranch(req));
    },
  };
}
