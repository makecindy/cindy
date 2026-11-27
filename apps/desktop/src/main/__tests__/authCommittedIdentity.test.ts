import { describe, expect, it } from 'vitest';
import { projectCommittedAuthIdentity } from '../authCommittedIdentity.js';

// peekCommittedAuthIdentity (authManager) returns this projection of its in-memory user and token.
// Cloud settings and Host settings authorize owner-scoped reads with it, so it fails closed for any
// unready identity and carries no token or profile data.
describe('committed auth identity projection', () => {
  it.each(['personal', 'org'] as const)('projects only %s identity and token presence', (membershipKind) => {
    const user = { id: 'membership-test', membershipKind, email: 'private@example.invalid', displayName: 'Private' };
    const result = projectCommittedAuthIdentity(user, 'test-only-memory-token');
    expect(result).toEqual({ userId: 'membership-test', membershipKind, isAuthenticated: true });
    expect(Object.keys(result!).sort()).toEqual(['isAuthenticated', 'membershipKind', 'userId']);
  });

  it.each([null, undefined, '', 0, false, {}])('does not authenticate with absent or non-string token %j', (token) => {
    expect(projectCommittedAuthIdentity({ id: 'membership-test', membershipKind: 'org' }, token))
      .toEqual({ userId: 'membership-test', membershipKind: 'org', isAuthenticated: false });
  });

  it.each([null, undefined, {}, { id: 'member' }, { id: 'member', membershipKind: 'unknown' },
    { id: 'member', membershipKind: null }, { id: '', membershipKind: 'org' }, { id: 3, membershipKind: 'org' }])
  ('fails closed for unready or unknown identity %j', (user) => {
    expect(projectCommittedAuthIdentity(user, 'test-only-memory-token')).toBeNull();
  });

  it('returns a detached identity object and does not mutate the current user', () => {
    const user = Object.freeze({ id: 'membership-test', membershipKind: 'org' });
    const first = projectCommittedAuthIdentity(user, 'test-only-memory-token')!;
    first.userId = 'changed';
    first.membershipKind = 'personal';
    expect(projectCommittedAuthIdentity(user, 'test-only-memory-token'))
      .toEqual({ userId: 'membership-test', membershipKind: 'org', isAuthenticated: true });
    expect(user).toEqual({ id: 'membership-test', membershipKind: 'org' });
  });
});
