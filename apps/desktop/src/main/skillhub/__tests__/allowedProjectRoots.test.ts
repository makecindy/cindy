import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deriveAllowedSkillhubProjectRoots } from '../allowedProjectRoots';

describe('deriveAllowedSkillhubProjectRoots', () => {
  it('matches renderer grouping by folding managed and conventional worktrees to the base repo', () => {
    const repo = path.resolve('/repo');
    const normalizedRepo = repo.replaceAll(path.sep, '/');

    expect(deriveAllowedSkillhubProjectRoots([
      path.join(repo, '.cindy-worktrees', 'managed-task'),
      path.join(repo, '.worktrees', 'user-task'),
      repo,
      null,
    ])).toEqual([normalizedRepo]);
  });
});
