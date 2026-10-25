import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createWorktreeResourceLocks } from '@cindy/worktree-core/resourceLock';
const service = createWorktreeResourceLocks({ withCrossProcessLock });
export const {
  physicalWorktreeKey,
  worktreeResourceId,
  withWorktreeResourceLock,
  withWorktreeResourceLocks,
} = service;
