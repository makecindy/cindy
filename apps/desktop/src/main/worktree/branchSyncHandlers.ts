import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBranchSyncStatus, syncBranch } from './branchSync';
import { GitExecError } from './gitExec';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate';
import {
  BRANCH_SYNC_ERROR_PREFIX,
  type BranchSyncRequest,
  type BranchSyncFailureReason,
  type BranchSyncResult,
  type BranchSyncReply,
} from '../../shared/worktreeBranchSync';

/** Small IPC boundary, testable without loading Electron or the WorktreeManager. */
export function createBranchSyncHandlers<Event>(deps: {
  assertTrustedAppRendererEvent(event: Event): void;
  isDeviceLinkInvoke(): boolean;
  getCallerScope(): string | null;
}) {
  type Outcome = { result: BranchSyncResult } | { error: unknown };
  const operations = new Map<
    string,
    {
      scope: string;
      req: BranchSyncRequest;
      outcome: Promise<Outcome>;
    }
  >();
  let activeOperations = 0;
  const completed = new Map<string, ReturnType<typeof setTimeout>>();
  function forgetCompleted(id: string) {
    clearTimeout(completed.get(id));
    completed.delete(id);
    operations.delete(id);
  }

  // Each poll fits inside the existing invoke budget. Only the initial request
  // starts work; lost replies, changed peers and expired tokens never replay it.
  async function wait(operationId: string): Promise<BranchSyncReply> {
    const operation = operations.get(operationId)!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 10_000);
    });
    try {
      const outcome = await Promise.race([operation.outcome, pending]);
      if (!outcome) return { pending: true, operationId };
      if ('error' in outcome) throw outcome.error;
      return outcome.result;
    } finally {
      clearTimeout(timer);
    }
  }
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
      const body = requireObject(input);
      if (body.waitForResult !== undefined && typeof body.waitForResult !== 'boolean')
        throwIpcError('INVALID_PARAMS', 'Invalid branch sync wait mode');
      if (
        body.operationId !== undefined &&
        (body.waitForResult !== true ||
          typeof body.operationId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(body.operationId))
      )
        throwIpcError('INVALID_PARAMS', 'Invalid branch sync operation');
      if (body.waitForResult !== true) return run(() => syncBranch(req));
      const scope = deps.getCallerScope();
      if (!scope) throwIpcError('INTERNAL', BRANCH_SYNC_ERROR_PREFIX + 'changed');
      let operationId = body.operationId as string | undefined;
      if (operationId) {
        const operation = operations.get(operationId);
        if (
          !operation ||
          operation.scope !== scope ||
          operation.req.baseRepo !== req.baseRepo ||
          operation.req.branch !== req.branch
        )
          throwIpcError('INTERNAL', BRANCH_SYNC_ERROR_PREFIX + 'changed');
      } else {
        if (activeOperations >= 64) throwIpcError('INTERNAL', BRANCH_SYNC_ERROR_PREFIX + 'busy');
        activeOperations += 1;
        operationId = randomUUID();
        const id = operationId;
        const outcome: Promise<Outcome> = Promise.resolve()
          .then(() => run(() => syncBranch(req)))
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        operations.set(id, { scope, req, outcome });
        // Retain terminal outcomes briefly for a delayed continuation. Running
        // downloads are bounded by Git inactivity, not by polling wall time.
        void outcome.then(() => {
          activeOperations -= 1;
          const timer = setTimeout(() => forgetCompleted(id), 5 * 60_000);
          timer.unref?.();
          completed.set(id, timer);
          // Bound retained outcomes independently; never evict active work or
          // reject a new fetch just because earlier fetches completed quickly.
          if (completed.size > 64) forgetCompleted(completed.keys().next().value!);
        });
      }
      return wait(operationId);
    },
  };
}
