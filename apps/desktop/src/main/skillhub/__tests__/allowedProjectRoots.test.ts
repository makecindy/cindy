import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deriveAllowedSkillhubProjectRoots } from '../allowedProjectRoots';

describe('deriveAllowedSkillhubProjectRoots', () => {
  it('allows both the grouped repo and real cwd of managed and conventional worktrees', () => {
    const repo = path.resolve('/repo');
    const normalizedRepo = repo.replaceAll(path.sep, '/');

    expect(deriveAllowedSkillhubProjectRoots([
      path.join(repo, '.cindy-worktrees', 'managed-task'),
      path.join(repo, '.worktrees', 'user-task'),
      repo,
      null,
    ])).toEqual([normalizedRepo, `${normalizedRepo}/.cindy-worktrees/managed-task`, `${normalizedRepo}/.worktrees/user-task`]);
  });
});
