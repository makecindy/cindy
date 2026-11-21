import { describe, expect, it } from 'vitest';

import { buildReviewBranchWebUrl } from '../webUrl';

describe('git-review web URL', () => {
  it('builds GitHub branch URLs from SCP remotes', () => {
    expect(buildReviewBranchWebUrl('git@github.com:octo/repo.git', 'feature/nav')).toBe(
      'https://github.com/octo/repo/tree/feature/nav',
    );
  });

  it('strips credentials from HTTPS remotes', () => {
    expect(buildReviewBranchWebUrl('https://user:token@github.com/octo/repo.git', 'main')).toBe(
      'https://github.com/octo/repo/tree/main',
    );
  });

  it('uses provider-specific branch routes', () => {
    expect(buildReviewBranchWebUrl('git@gitlab.com:group/repo.git', 'release/1.x')).toBe(
      'https://gitlab.com/group/repo/-/tree/release/1.x',
    );
    expect(buildReviewBranchWebUrl('git@bitbucket.org:team/repo.git', 'main')).toBe(
      'https://bitbucket.org/team/repo/src/main',
    );
  });

  it('does not turn local remotes into web URLs', () => {
    expect(buildReviewBranchWebUrl('/tmp/repo.git', 'main')).toBeNull();
    expect(buildReviewBranchWebUrl('file:///tmp/repo.git', 'main')).toBeNull();
  });
});
