/** #10568 integration: real exited requester, SQLite WAL, logical script path,
 * and production owner-DB startup with an unavailable target / unwritable receipt.
 * Only mkdtemp fixtures; no client, account, network or model calls. Run manually
 * with the Host TS loaders and a Node matching better-sqlite3's ABI (see docs).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { configureHostOwner } from '../src/agent/claude-auth.mjs';
import { hostRuntimeLayout } from '../src/runtime-layout.mjs';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.ts';
import { openOwnerDatabase } from '../../desktop/src/main/localDb/startupCore.ts';
import {
  assertWorkspaceMoveReady,
  requestWorkspaceMove,
  recoverWorkspaceMovesAtStartup,
  workspaceMoveStatus,
} from '../../desktop/src/main/workspace-migration/service.ts';
import { copyTree, directoryIdentity } from '../../desktop/src/main/workspace-migration/tree.ts';

const script = fileURLToPath(import.meta.url);
const ownerId = 'workspace-migration-fixture';
const botId = 'fixture-buddy';
const sourceFor = profile => path.join(ownerScopedPath(profile, ownerId), 'bots', botId, 'workspace');
const memoryFor = source => path.join(source, '.cindy', 'memory', 'fixture.db');
const childEnv = { ...process.env };
delete childEnv.XDT_OFFICIAL_SHARED_PROFILE;

if (process.argv[2] === '--prepare') {
  const profile = process.argv[3];
  // The child accepts only its parent's disposable sample directory.
  assert.equal(path.dirname(profile), await fs.realpath(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith('cindy-workspace-migration-e2e-'));
  const source = sourceFor(profile);
  await fs.mkdir(path.dirname(memoryFor(source)), { recursive: true });
  await fs.writeFile(path.join(source, 'input.txt'), 'scheduled-input');
  await fs.writeFile(path.join(source, 'scheduled.mjs'), `
import fs from 'node:fs';
if (fs.readFileSync('input.txt', 'utf8') !== 'scheduled-input') process.exit(1);
fs.writeFileSync('after-script.txt', 'logical-path-write');
process.stdout.write(process.argv[1]);
`);
  const memory = new Database(memoryFor(source));
  memory.pragma('journal_mode = WAL');
  memory.pragma('wal_autocheckpoint = 0');
  memory.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('wal-data');");
  await requestWorkspaceMove(ownerScopedPath(profile, ownerId), botId, path.join(profile, 'data-disk'), () => {});
  // Deliberately leave SQLite open: the parent must migrate/recover its WAL.
  process.exit(0);
}

const samples = [];
const prepare = async () => {
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-workspace-migration-e2e-')));
  samples.push(profile);
  execFileSync(process.execPath, [...process.execArgv, script, '--prepare', profile], { env: childEnv, stdio: 'pipe' });
  assert.ok((await fs.stat(`${memoryFor(sourceFor(profile))}-wal`)).size > 0);
  return profile;
};
const readMemory = source => {
  const memory = new Database(memoryFor(source));
  try { assert.equal(memory.prepare('SELECT value FROM fixture').get().value, 'wal-data'); }
  finally { memory.close(); }
};
const inheritedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
const rename = fs.rename;
try {
  const profile = await prepare();
  const owner = ownerScopedPath(profile, ownerId);
  const source = sourceFor(profile);
  await recoverWorkspaceMovesAtStartup(owner, true);
  assert.equal((await workspaceMoveStatus(owner, botId)).phase, 'completed');
  readMemory(source);
  const logicalScript = path.join(source, 'scheduled.mjs');
  assert.equal(execFileSync(process.execPath, [logicalScript], { cwd: source, encoding: 'utf8' }), logicalScript);
  await recoverWorkspaceMovesAtStartup(owner, true);
  assert.equal(await fs.readFile(path.join(source, 'after-script.txt'), 'utf8'), 'logical-path-write');

  const failedProfile = await prepare();
  const failedOwner = ownerScopedPath(failedProfile, ownerId);
  const original = sourceFor(failedProfile);
  const status = await workspaceMoveStatus(failedOwner, botId);
  const directory = path.join(failedOwner, 'workspace-migrations');
  const [name] = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  const journal = path.join(directory, name);
  const receipt = JSON.parse(await fs.readFile(journal, 'utf8'));
  await copyTree(original, status.target);
  receipt.targetIdentity = await directoryIdentity(status.target);
  receipt.phase = 'linked';
  await fs.rename(original, status.backup);
  await fs.symlink(status.target, original, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.rename(status.target, `${status.target}-offline`);
  await fs.writeFile(journal, JSON.stringify(receipt));
  fs.rename = async (from, to) => {
    if (String(to) === journal) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  configureHostOwner({ userDataDir: failedProfile, ownerId });
  const layout = hostRuntimeLayout();
  for (let startup = 0; startup < 2; startup++) {
    const opened = await openOwnerDatabase({ userDataDir: failedProfile, ownerId, isPackaged: false,
      drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
    opened.db.close();
    await assertWorkspaceMoveReady(failedOwner, botId);
    assert.equal((await fs.lstat(original)).isSymbolicLink(), false);
    readMemory(original);
    if (startup === 0) await fs.writeFile(path.join(original, 'later.txt'), 'original-remains-live');
  }
  assert.equal(await fs.readFile(path.join(original, 'later.txt'), 'utf8'), 'original-remains-live');
  assert.equal((await workspaceMoveStatus(failedOwner, botId)).startupWarning, 'MIGRATION_RECEIPT_UPDATE_FAILED');
  console.log('MIGRATION_SAMPLE_RESULT', JSON.stringify({ platform: process.platform,
    realRequestProcessExited: true, originalAbsoluteScriptAndCwd: true, migratedWalReadable: true,
    missingTargetDuringCutover: true, originalRecovered: true, originalWalReadable: true,
    ownerDatabaseOpenedTwice: true, journalWritesStillFailing: true, originalLaterWritePreserved: true }));
} finally {
  fs.rename = rename;
  if (inheritedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = inheritedProfile;
  configureHostOwner({ userDataDir: samples.at(-1) ?? os.tmpdir(), ownerId: null });
  for (const profile of samples) await fs.rm(profile, { recursive: true, force: true });
}
