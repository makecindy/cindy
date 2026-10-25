

import { createLogger } from '../logger';

import { gitExec, GitExecError, type GitExecResult } from '../worktree/gitExec';

import {
  chunkPathspecArgs,
  createShadowMarker,
  createShadowSavepoint,
  withPathspecFile,
  writeWorktreeTreeForPaths,
  type CreateShadowMarkerInput,
  type CreateShadowSavepointInput,
  type ShadowSavepointResult,
} from './gitSnapshotService';

import { resolveSnapshotGitPath } from './snapshotFileFilter';
import {createCodexFileRestoreExecutor} from '@cindy/app-runtime/codexFileRestoreExecutor';
export type * from '@cindy/app-runtime/codexFileRestoreExecutor';

export const {executeCodexFileRestorePlan,executeCodexFileRestorePlanWithThreadRollback,compensateCodexFileRestoreExecution}=createCodexFileRestoreExecutor({createLogger,gitExec,GitExecError,chunkPathspecArgs,createShadowMarker,createShadowSavepoint,withPathspecFile,writeWorktreeTreeForPaths,resolveSnapshotGitPath});
