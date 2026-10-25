import { gitExec } from './gitExec';
import { createWorktreeIncludeEngine } from '@cindy/worktree-core/includePatternsEngine';
const service = createWorktreeIncludeEngine({ gitExec });
export const {
  parseWorktreeIncludePatterns,
  copyWorktreeIncludeFiles,
  listChangedWorktreeIncludeFiles,
  applyWorktreeIncludeFile,
  _internal,
} = service;
export type {
  IncludeFileStatus,
  CopyWorktreeIncludeOptions,
  IncludeFileResult,
  ChangedIncludeFile,
} from '@cindy/worktree-core/includePatternsEngine';
