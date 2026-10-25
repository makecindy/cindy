import { gitExec, KILL_CLEANUP_BUDGET_MS } from './gitExec';
import { createLogger } from '../logger';
import { createFreshWorktreeBase } from '@cindy/worktree-core/freshBase';
export { NET_TOTAL_BUDGET_MS, boundedNetworkGitOpts } from '@cindy/worktree-core/freshBase';
export type { FreshSourceResolution } from '@cindy/worktree-core/freshBase';
export const { resolveFreshSourceBranch } = createFreshWorktreeBase({
  gitExec,
  KILL_CLEANUP_BUDGET_MS,
  log: createLogger('worktree'),
});
