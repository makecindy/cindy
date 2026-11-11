import { describe, expect, it } from 'vitest';

import { reviewSourceIdentityMatches } from '../reviewSourceIdentity.js';

const launched = {
  workingDir: '/workspace/a',
  workspaceKind: 'local',
  status: 'active',
};

describe('review source identity', () => {
  it('accepts the unchanged active source workspace', () => {
    expect(reviewSourceIdentityMatches(launched, { ...launched })).toBe(true);
  });

  it('rejects a moved, archived, deleted, or missing source workspace', () => {
    expect(reviewSourceIdentityMatches(launched, { ...launched, workingDir: '/workspace/b' })).toBe(
      false,
    );
    expect(reviewSourceIdentityMatches(launched, { ...launched, workspaceKind: 'worktree' })).toBe(
      false,
    );
    expect(reviewSourceIdentityMatches(launched, { ...launched, status: 'archived' })).toBe(false);
    expect(reviewSourceIdentityMatches(launched, null)).toBe(false);
  });
});
