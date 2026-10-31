import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCleanupCommands, planLocalCleanup } from '../../apps/desktop/resources/system-skills/pr/scripts/lib/cleanup-plan.mjs';

const PRIMARY = '/repo';
const SIBLING = '/repo-pr-branch';

function plan(overrides = {}) {
  return planLocalCleanup({
    terminal: true,
    merged: true,
    longLivedBranch: false,
    primaryStatus: { ok: true, dirty: false },
    primaryIsHead: false,
    dirtyTargetCount: 0,
    hasLocalArtifacts: true,
    ...overrides,
  });
}

function commandKinds(commands) {
  return commands.map(entry => entry.argv.slice(3).join(' '));
}

test('dirty primary does not block sibling worktree cleanup', () => {
  const result = plan({ primaryStatus: { ok: true, dirty: true } });
  assert.equal(result.recommendation, 'remove_local_worktree_and_branch');
  assert.equal(result.canCleanupLocal, true);
  assert.equal(result.canSyncPrimary, false);
  assert.ok(!result.blockers.includes('primary_worktree_dirty'));
  assert.match(result.notes.join('\n'), /Primary worktree is dirty/);
});

test('dirty primary blocks cleanup only when PR branch is checked out there', () => {
  const result = plan({
    primaryIsHead: true,
    primaryStatus: { ok: true, dirty: true },
  });
  assert.equal(result.recommendation, 'do_not_cleanup');
  assert.equal(result.canCleanupLocal, false);
  assert.ok(result.blockers.includes('primary_worktree_dirty'));
});

test('unreadable primary skips sync but still allows sibling cleanup', () => {
  const result = plan({ primaryStatus: { ok: false, dirty: true } });
  assert.equal(result.recommendation, 'remove_local_worktree_and_branch');
  assert.equal(result.canSyncPrimary, false);
  assert.ok(!result.blockers.includes('primary_worktree_status_unavailable'));
});

test('unreadable primary blocks cleanup when PR branch is checked out there', () => {
  const result = plan({
    primaryIsHead: true,
    primaryStatus: { ok: false, dirty: true },
  });
  assert.equal(result.recommendation, 'do_not_cleanup');
  assert.ok(result.blockers.includes('primary_worktree_status_unavailable'));
});

test('dirty target worktree still blocks', () => {
  const result = plan({ dirtyTargetCount: 1 });
  assert.equal(result.recommendation, 'do_not_cleanup');
  assert.ok(result.blockers.includes('dirty_worktree'));
});

test('Cindy-managed worktree is left to its task', () => {
  const result = plan({ cindyManagedWorktree: true });
  assert.equal(result.recommendation, 'leave_to_cindy_task');
  assert.equal(result.canCleanupLocal, false);
  assert.ok(result.blockers.includes('cindy_managed_worktree'));
});

test('closed unmerged still requires a decision', () => {
  const result = plan({ merged: false });
  assert.equal(result.recommendation, 'do_not_cleanup');
  assert.ok(result.blockers.includes('closed_unmerged_requires_user_decision'));
});

test('clean primary emits switch, pull, prune, and forced worktree remove', () => {
  const commands = buildCleanupCommands({
    primaryWorktree: PRIMARY,
    baseRef: 'main',
    headRef: 'feature/pr',
    localBranchExists: true,
    targetWorktrees: [{ path: SIBLING }],
    syncPrimary: true,
  });
  assert.deepEqual(commandKinds(commands), [
    `worktree remove --force ${SIBLING}`,
    'branch -D feature/pr',
    'switch main',
    'pull --ff-only origin main',
    'worktree prune',
  ]);
});

test('dirty primary omits switch/pull but still removes sibling worktree and branch', () => {
  const commands = buildCleanupCommands({
    primaryWorktree: PRIMARY,
    baseRef: 'main',
    headRef: 'feature/pr',
    localBranchExists: true,
    targetWorktrees: [{ path: SIBLING }],
    syncPrimary: false,
  });
  assert.deepEqual(commandKinds(commands), [
    `worktree remove --force ${SIBLING}`,
    'branch -D feature/pr',
    'worktree prune',
  ]);
});
