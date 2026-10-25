import { createScheduledWorkdirResolver } from '@cindy/worktree-core/scheduledWorkdir';
import { resolveFreshSourceBranch, WorktreeManager, WorktreePool } from '../worktree';
export type { WorkdirResolveResult } from '@cindy/worktree-core/scheduledWorkdir';
export const resolveWorkingDir = createScheduledWorkdirResolver({ resolveFreshSourceBranch, WorktreeManager, WorktreePool });
