import { expect, it } from 'vitest';
import { managedAuthRetryEpoch } from '../authRetryEpoch.js';

// Unit: committing the rotated tokens moves the auth state on as it starts. A commit that then fails
// keeps its retry; a change by anything else in between still drops it.
it('keeps the retry of a commit that failed after moving the auth state on', () => {
  expect(managedAuthRetryEpoch(4, null, 4)).toBe(4); // Rotation failed before any commit.
  expect(managedAuthRetryEpoch(4, 4, 4)).toBe(4); // The commit refused before moving on.
  expect(managedAuthRetryEpoch(4, 4, 5)).toBe(5); // The commit moved on, then failed.
  expect(managedAuthRetryEpoch(4, 5, 6)).toBe(4); // Something else moved first: not this attempt.
  expect(managedAuthRetryEpoch(4, 4, 7)).toBe(4); // Something else moved during the commit.
});
