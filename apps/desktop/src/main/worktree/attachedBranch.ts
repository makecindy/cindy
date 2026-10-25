import { gitExec } from './gitExec';
import { createAttachedBranchReader } from '@cindy/worktree-core/attachedBranch';
const service = createAttachedBranchReader({ gitExec });
export const { readAttachedWorktreeBranch } = service;
