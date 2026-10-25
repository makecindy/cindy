import { worktreeResourceId } from './resourceLock';
import { createWorktreeRecycleEvents } from '@cindy/worktree-core/recycleEvents';
export type { WorktreeRecycleEvent } from '@cindy/worktree-core/recycleEvents';
export const {
  subscribeWorktreeRecycleEvents,
  notifyWorktreeRecycleRecordChanged,
  notifyWorktreeRecycleOpportunity,
} = createWorktreeRecycleEvents(worktreeResourceId);
