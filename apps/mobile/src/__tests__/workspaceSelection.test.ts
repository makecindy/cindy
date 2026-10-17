import { expect, it } from 'vitest';
import { workspacePathsEqual } from '@/session/workspaceSelection';

// Remote host path strings; independent of the test runner's filesystem.
it.each([
  ['D:\\projects\\cindy', 'd:/PROJECTS/cindy/'],
  ['D:\\', 'd:/'],
  ['\\\\Server\\Share\\cindy', '//server/share/CINDY/'],
  ['/repo/app/', '/repo/app'],
  ['/', '/'],
  ['D:\\repo\\.cindy-worktrees\\branch', 'd:/REPO/.cindy-worktrees/BRANCH/'],
  ['/repo/.worktrees/branch/', '/repo/.worktrees/branch'],
])('matches equivalent directory spellings: %s and %s', (left, right) => {
  expect(workspacePathsEqual(left, right)).toBe(true);
  expect(workspacePathsEqual(right, left)).toBe(true);
});

it.each([
  ['/repo', '/repo/.cindy-worktrees/branch'],
  ['D:/repo', 'd:\\repo\\.cindy-worktrees\\branch'],
  ['/repo', '/repo/.xdt-worktrees/branch'],
  ['/repo', '/repo/.worktrees/branch'],
  ['/repo', '/repo/.claude/worktrees/branch'],
  ['/repo/.cindy-worktrees/one', '/repo/.cindy-worktrees/two'],
  ['/repo/App', '/repo/app'],
  ['/repo/weird\\name', '/repo/weird/name'],
  ['/repo/weird\\', '/repo/weird'],
  ['D:/', 'D:'],
  ['/', ''],
])('keeps different target directories distinct: %s and %s', (left, right) => {
  expect(workspacePathsEqual(left, right)).toBe(false);
  expect(workspacePathsEqual(right, left)).toBe(false);
});
