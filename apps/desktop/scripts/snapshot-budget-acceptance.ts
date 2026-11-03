/**
 * Opt-in, real-I/O acceptance for #7259; deliberately outside default unit tests.
 * Run from the repo root:
 * pnpm --dir apps/desktop exec vite-node --config vitest.config.ts scripts/snapshot-budget-acceptance.ts --files=100000
 * Uses production coordinator, directory detection, journal, Git and planner.
 * Electron is stubbed by the existing test config; no account or provider is used.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GitSnapshotCoordinator } from '../src/main/git-snapshot/gitSnapshotCoordinator';
import { SnapshotAttemptStore } from '../src/main/git-snapshot/snapshotAttemptStore';
import { createShadowMarker, createShadowSavepoint, listShadowSavepoints } from '../src/main/git-snapshot/gitSnapshotService';
import { buildCodexFileRewindPlan } from '../src/main/git-snapshot/codexFileRewindPlanner';
import { readSavepointTip } from '../src/main/git-snapshot/savepointRefs';
import { isolatedGitExec } from '../src/main/git-snapshot/isolatedGitExec';
import { detectCwd } from '../src/main/worktree/WorktreeManager';
import { gitExec } from '../src/main/worktree/gitExec';
import { OperationBudget } from '../src/main/utils/operationBudget';

const countArg = process.argv.find((arg) => arg.startsWith('--files='));
const files = Number(countArg?.slice('--files='.length) ?? 10_000);
const keepFixture = process.argv.includes('--keep');
assert(Number.isSafeInteger(files) && files >= 1 && files <= 1_000_000, '--files must be 1..1000000');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-snapshot-acceptance-'));
const large = path.join(root, 'large');
const small = path.join(root, 'small');
const journal = new SnapshotAttemptStore(path.join(root, 'owner'));
const report: Record<string, unknown> = { files, platform: process.platform, node: process.version };
const warnings: Array<{ message: string; error?: unknown }> = [];
const logger = { info() {}, debug() {}, warn(message: string, meta?: Record<string, unknown>) {
  warnings.push({ message, ...(meta?.error ? { error: meta.error } : {}) });
} };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const rounded = (value: number) => Math.round(value);

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir);
  await isolatedGitExec(['init'], dir);
  for (const [key, value] of [
    ['user.name', 'Snapshot Acceptance'], ['user.email', 'acceptance@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.fsmonitor', 'false'],
    ['core.untrackedCache', 'false'], ['core.excludesFile', path.join(dir, '.git', 'empty-excludes')],
  ]) await gitExec(['config', '--local', key, value], dir);
  await fs.writeFile(path.join(dir, '.git', 'empty-excludes'), '');
  await fs.writeFile(path.join(dir, 'seed.txt'), 'base\n');
  await isolatedGitExec(['add', 'seed.txt'], dir);
  await isolatedGitExec(['commit', '--no-gpg-sign', '-m', 'seed'], dir);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'staged\n');
  await isolatedGitExec(['add', 'seed.txt'], dir);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'unstaged\n');
}

async function visibleState(dir: string) {
  return {
    head: (await gitExec(['rev-parse', 'HEAD'], dir)).stdout,
    index: digest(await fs.readFile(path.join(dir, '.git', 'index'))),
    seed: await fs.readFile(path.join(dir, 'seed.txt'), 'utf8'),
  };
}

const coordinator = new GitSnapshotCoordinator({
  recordTurnAttempt: async (sessionId) => {
    const attempt = await journal.record(sessionId, 'message-1');
    return { attemptId: attempt.id, anchor: attempt.anchor };
  },
  readAutoSnapshotEnabled: () => true,
  getSessionContext: async (id) => ({ workingDir: id === 'large' ? large : small, agentKind: 'codex' }),
  detectRepoRoot: async (dir) => (await detectCwd(dir)).repoRoot ?? null,
  createShadowSavepoint,
  createShadowMarker,
  oneShot: async () => 'acceptance',
  logger,
});

try {
  await initRepo(large);
  await initRepo(small);
  console.log(`Creating ${files} untracked files in an isolated temporary repository...`);
  const setupAt = performance.now();
  for (let batch = 0; batch < files; batch += 500) {
    const dir = path.join(large, 'bulk', String(batch));
    await fs.mkdir(dir, { recursive: true });
    // Bound open files/promises even at one million entries.
    for (let offset = batch; offset < Math.min(files, batch + 500); offset += 32) {
      await Promise.all(Array.from({ length: Math.min(32, files - offset, batch + 500 - offset) },
        (_, i) => fs.writeFile(path.join(dir, `${offset + i}.txt`), 'fixture\n')));
    }
    if ((batch + 500) % 100_000 === 0) console.log(`Created ${batch + 500}/${files} files`);
  }
  report.fixtureMs = rounded(performance.now() - setupAt);
  const before = await visibleState(large);
  const started = performance.now();
  const pendingLarge = coordinator.onTurnStart('large').then(() => rounded(performance.now() - started));
  const pendingSmall = coordinator.onTurnStart('small').then(() => rounded(performance.now() - started));
  const [largeMs, smallMs] = await Promise.all([pendingLarge, pendingSmall]);
  report.largeStartMs = largeMs;
  report.concurrentSmallStartMs = smallMs;
  report.largeBaselineCreated = !!await readSavepointTip(large, 'large');
  assert(largeMs < 12_000, 'Snapshot exceeded 8s + 3s cleanup + 1s measurement headroom');
  assert(await readSavepointTip(small, 'small'), 'Independent repository failed to create baseline');
  assert(smallMs < 8_000, 'Independent repository consumed the whole snapshot budget');
  assert.deepEqual(await visibleState(large), before, 'Snapshot changed user HEAD/index/seed');
  report.headIndexSeedUnchanged = true;
  await coordinator.onTurnEnd('small');

  // Read persisted evidence with a new store, then add a retry with no Git result.
  const { entries } = await listShadowSavepoints(small, 'small');
  const planInput = {
    sessionId: 'small', targetMessageClientId: 'message-1',
    userMessages: [{ clientId: 'message-1', createdAt: 1 }],
    repo: { kind: 'local-git' as const, repoRoot: small, currentHead: (await visibleState(small)).head.trim(),
      currentBranch: '', savepointsNewestFirst: entries.map((entry) => ({ ...entry, source: 'shadow' as const, branch: entry.branch ?? '' })) },
  };
  assert.equal(buildCodexFileRewindPlan({ ...planInput, snapshotAttempts: await journal.read('small') }).mode, 'file-restore');
  await journal.record('small', 'message-1');
  const restored = new SnapshotAttemptStore(path.join(root, 'owner'));
  const retryPlan = buildCodexFileRewindPlan({ ...planInput, snapshotAttempts: await restored.read('small') });
  assert.equal(retryPlan.mode, 'conversation-only');
  report.failedRetryAfterStoreReload = retryPlan.mode;

  // Real blocked Git, not a rejected mock: cancel only after receiving its PID.
  const budget = new OperationBudget(8_000);
  let onSpawn!: (pid: number) => void;
  const spawned = new Promise<number>((resolve) => { onSpawn = resolve; });
  const running = budget.run(() => gitExec(['hash-object', '--stdin'], small, { onSpawn }));
  const rejected = assert.rejects(running, /acceptance stop/);
  const pid = await spawned;
  const cancelledAt = performance.now();
  budget.cancel(new Error('acceptance stop'));
  await rejected;
  report.cancelCleanupMs = rounded(performance.now() - cancelledAt);
  assert.throws(() => process.kill(pid, 0), 'Cancelled Git is still alive');
  report.cancelledGitExited = true;
  report.warnings = warnings;
  report.result = 'pass';
  console.log(JSON.stringify(report, null, 2));
} finally {
  coordinator.onSessionClosed('large');
  coordinator.onSessionClosed('small');
  // Only remove the unique directory created above, never an input path.
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('cindy-snapshot-acceptance-'));
  if (keepFixture) console.log(`Fixture retained for isolated Desktop acceptance: ${resolved}`);
  else await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
