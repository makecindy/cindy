

import { gitExec, GitExecError, type GitExecResult } from '../worktree/gitExec';

import { getHead } from './gitSnapshotService';
import {createCodexFileRewindExecutor} from '@cindy/app-runtime/codexFileRewindExecutor';
export type * from '@cindy/app-runtime/codexFileRewindExecutor';
export {CodexFileRewindExecutionError} from '@cindy/app-runtime/codexFileRewindExecutor';
export const {executeCodexFileRewindPlan,executeCodexFileRewindPlanWithThreadRollback,compensateCodexFileRewindExecution}=createCodexFileRewindExecutor({gitExec,GitExecError,getHead});
