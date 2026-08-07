/**
 * Host-owned, repository-scoped New Maker source branch IPC.
 *
 * Local Cindy renderers and allowlisted device-link controllers use the same
 * GET/APPLY handlers. APPLY updates the host cache before broadcasting the
 * accepted snapshot to local renderers and subscribed controllers.
 */
import path from 'node:path';

import type { NewMakerWorktreeBranchPreferenceSnapshot } from '../maker-host/newMakerWorktreeBranchPreferenceCache.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const MAX_BASE_REPO_LENGTH = 4096;
const MAX_SOURCE_BRANCH_LENGTH = 1024;

export interface NewMakerWorktreeBranchPreferenceHandlerDeps {
  isDeviceLinkInvoke(): boolean;
  assertTrustedCaller(event: unknown): void;
  getPreference(baseRepo: string): NewMakerWorktreeBranchPreferenceSnapshot | null;
  applyPreference(input: {
    baseRepo: string;
    sourceBranch: string;
  }): NewMakerWorktreeBranchPreferenceSnapshot;
  broadcast(
    channel: typeof MAKER_PUSH.NEW_MAKER_WORKTREE_BRANCH_CHANGED,
    payload: NewMakerWorktreeBranchPreferenceSnapshot,
  ): void;
}

function requireRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'request required');
  }
  return value as Record<string, unknown>;
}

function requireBaseRepo(value: unknown): string {
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', 'baseRepo must be string');
  }
  const baseRepo = value.trim();
  if (!baseRepo || baseRepo.length > MAX_BASE_REPO_LENGTH || baseRepo.includes('\0')) {
    throwIpcError('INVALID_PARAMS', 'baseRepo is invalid');
  }
  if (!path.isAbsolute(baseRepo)) {
    throwIpcError('INVALID_PARAMS', 'baseRepo must be absolute');
  }
  return baseRepo;
}

function requireSourceBranch(value: unknown): string {
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', 'sourceBranch must be string');
  }
  const sourceBranch = value.trim();
  if (
    !sourceBranch ||
    sourceBranch.length > MAX_SOURCE_BRANCH_LENGTH ||
    sourceBranch.includes('\0')
  ) {
    throwIpcError('INVALID_PARAMS', 'sourceBranch is invalid');
  }
  return sourceBranch;
}

export function registerNewMakerWorktreeBranchPreferenceHandler(
  registry: IpcHandlerRegistry,
  deps: NewMakerWorktreeBranchPreferenceHandlerDeps,
): void {
  const assertOrigin = (event: unknown): void => {
    if (!deps.isDeviceLinkInvoke()) deps.assertTrustedCaller(event);
  };

  registry.handle(MAKER_INVOKE.GET_NEW_MAKER_WORKTREE_BRANCH_PREF, (event, request: unknown) => {
    assertOrigin(event);
    const baseRepo = requireBaseRepo(requireRequest(request).baseRepo);
    return deps.getPreference(baseRepo);
  });

  registry.handle(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_BRANCH_PREF, (event, request: unknown) => {
    assertOrigin(event);
    const record = requireRequest(request);
    const snapshot = deps.applyPreference({
      baseRepo: requireBaseRepo(record.baseRepo),
      sourceBranch: requireSourceBranch(record.sourceBranch),
    });
    deps.broadcast(MAKER_PUSH.NEW_MAKER_WORKTREE_BRANCH_CHANGED, snapshot);
    return snapshot;
  });
}
