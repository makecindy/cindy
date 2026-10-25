import { gitExec } from './gitExec';

import { physicalWorktreeKey } from './resourceLock';

import { createWorktreeResourceSafety } from '@cindy/worktree-core/resourceSafety';
const service = createWorktreeResourceSafety({ gitExec, physicalWorktreeKey });
export const {
  assertManagedResourcePath,
  assertManagedResourceLocation,
  assertWorktreeGitIdentity,
} = service;
