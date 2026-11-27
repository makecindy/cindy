import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { sessions } from '../../desktop/src/main/localDb/schema.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { configureHostOwner } from '../src/agent/claude-auth.mjs';
import { createHostWorktreeLifecycle } from '../src/agent/worktree-lifecycle.ts';

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry: createHostWorktreeLifecycle, the Node Host's real Worktree
 *   lifecycle, including its shared registry and DB backfill.
 * - Bug/rule basis: remote precreated Worktrees must survive the create → claim
 *   transition and remain recoverable when the controller abandons creation.
 * - Existing coverage gap: the default Device Link transport fixture covers
 *   channel registration, not the real Git lifecycle or compensation behavior.
 * - Minimal failing input: create a precreated Worktree, claim it, then discard
 *   it by its recovery key after the claim is abandoned.
 * - Tier: git-integration; this creates a real temporary repository and runs Git.
 */
test('Host Worktree lifecycle creates, claims and discards a precreated Worktree', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-worktree-git-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'worktree-git-integration' });
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE "${getTableName(sessions)}" (${Object.values(getTableColumns(sessions)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  db.readLocalWorktreeReferences = async () => {
    const rows = await db.drizzle.select({
      id: sessions.id, status: sessions.status, source: sessions.source,
      workingDir: sessions.workingDir, worktreePath: sessions.worktreePath,
    }).from(sessions);
    return rows.map(row => ({ ...row, currentDatabase: true }));
  };
  setCurrentDbClient(db, 'worktree-git-integration');
  t.after(() => {
    clearCurrentDbClient(db);
    sqlite.close();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  const lifecycle = createHostWorktreeLifecycle(profile);
  const detected = await lifecycle.detect(profile);
  assert.equal(detected.gitInstalled, true);
  assert.equal(detected.isGitRepo, false);
  assert.equal(detected.supportsRecoveryKeyDiscard, true);
  assert.equal(detected.supportsCheckout, false);

  const repo = path.join(profile, 'worktree-repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'host-test@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Host Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'host worktree test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

  const branches = await lifecycle.listBranches(repo);
  assert.equal(branches.current, 'main');
  assert.ok(branches.branches.includes('main'));
  assert.equal(typeof (await lifecycle.suggestName(repo)), 'string');

  const sessionId = 'remote-precreated-worktree';
  const recoveryKey = 'remote-recovery-key-1234567890-1234567890-1234567890';
  const created = await lifecycle.createWorktree({
    sessionId, baseRepo: repo, name: 'remote-test', sourceBranch: 'main', recoveryKey,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const worktreePath = created.meta.path;
  assert.ok(fs.existsSync(worktreePath));
  const registry = JSON.parse(fs.readFileSync(path.join(profile, 'worktrees.json'), 'utf8'));
  assert.equal(registry.worktrees[sessionId].path, worktreePath);

  await db.drizzle.insert(sessions).values({
    id: sessionId, title: 'Precreated Worktree', source: 'desktop', status: 'active',
    workingDir: worktreePath, workspaceKind: 'project', createdAt: Date.now(), updatedAt: Date.now(),
  });
  await lifecycle.backfillWorktreePath(sessionId);
  const [claimed] = await db.drizzle.select({ worktreePath: sessions.worktreePath })
    .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  assert.equal(claimed.worktreePath, worktreePath);

  const preserved = await lifecycle.cancelPrecreatedWorktree(sessionId, { path: worktreePath }, {
    canRemove: async () => false,
  });
  assert.deepEqual(preserved, { status: 'preserved' });
  assert.ok(fs.existsSync(worktreePath));

  await db.drizzle.delete(sessions).where(eq(sessions.id, sessionId));
  let discarded;
  for (let attempt = 0; attempt < 30; attempt++) {
    discarded = await lifecycle.discardPrecreatedWorktreeByRecoveryKey(sessionId, recoveryKey, {
      canRemove: async () => true,
    });
    if (discarded.status === 'discarded') break;
    // real-wait: the external Git checkout releases a filesystem lease; fake timers cannot advance it.
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(discarded.status, 'discarded', JSON.stringify(discarded));
  assert.equal(fs.existsSync(worktreePath), false);
});
