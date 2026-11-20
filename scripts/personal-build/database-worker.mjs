/** Bundled with the selected release's production migration runner and schema leases.
 * No Electron app, auth, models or network is initialized. Only explicit plan paths are opened. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMigrationRuntimeManifest, checkMigrationCompatibility, prepareMigrationRuntimeManifest,
  migrationRuntimeManifestPath, runMigrationReplay } from '@personal/migrations';
import { acquireSchemaMigrationWriterLease } from '@personal/leases';

const check = (value, message) => { if (!value) throw Error(message); };
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function largeDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const save = (file, value) => {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
function files(dataDir) {
  return fs.readdirSync(dataDir).filter(n => /^cindy-.+\.db$/.test(n)).sort().map(name => {
    const file = path.join(dataDir, name), st = fs.lstatSync(file);
    check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'Database must be a private regular file');
    return { name, dev: st.dev, ino: st.ino, sidecarHash: digest(migrationRuntimeManifestPath(file)) };
  });
}
function compatible(db, dir, file) {
  const result = checkMigrationCompatibility(db, dir, file);
  check(result.compatible, `Schema compatibility failed (${result.databaseVersion} -> ${result.checkoutVersion}): ${result.issues.map(i => i.kind).join(',')}`);
}
function quickCheck(db) { check(db.pragma('quick_check', { simple: true }) === 'ok', 'SQLite quick_check failed'); }
function flush(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export async function executeDatabasePlan(plan, action) {
  check(['rehearse', 'preflight', 'apply', 'verify-applied'].includes(action), 'Invalid database action');
  if (action === 'apply') check(process.platform === 'darwin', 'Production database apply currently requires macOS');
  if (action === 'apply') check(plan.authorized === true && plan.rehearsal?.ready === true,
    'Production apply requires an explicitly authorized, rehearsed plan');
  check(fs.realpathSync(plan.dataDir) === plan.dataDir, 'Profile must be its canonical path');
  const Database = createRequire(path.join(plan.candidate.directory, 'package.json'))('better-sqlite3');
  const oldDir = path.join(plan.baseline.directory, 'apps/desktop/drizzle');
  const newDir = path.join(plan.candidate.directory, 'apps/desktop/drizzle');
  const oldManifest = createMigrationRuntimeManifest(oldDir), next = createMigrationRuntimeManifest(newDir);
  check(same(oldManifest.migrations, next.migrations.slice(0, oldManifest.migrations.length)), 'Historical migration identities changed');
  const pending = next.migrations.slice(oldManifest.migrations.length);
  check(pending.length > 0 && same(pending, plan.pending), 'Approved migration identities changed');
  check(pending.every(p => p.scriptHash === null), 'Companion migrations require their own reviewed workflow');
  const inventory = files(plan.dataDir);
  check(inventory.length > 0, 'No existing account databases found');
  if (action === 'verify-applied') {
    const target = plan.backupDir;
    check(path.dirname(target) === path.join(plan.dataDir, 'personal-upgrade-backups'), 'Invalid backup location');
    const receipt = JSON.parse(fs.readFileSync(path.join(target, 'completed.json'), 'utf8'));
    const backups = JSON.parse(fs.readFileSync(path.join(target, 'backups.json'), 'utf8'));
    check(receipt.ready === true && receipt.action === 'apply' && receipt.directory === target &&
      same(receipt.pending, pending) && same(receipt.databases, plan.databases) &&
      backups.candidate === plan.candidate.id, 'Completed migration receipt does not match');
    check(inventory.length === plan.databases.length, 'Migrated database inventory changed');
    for (const [index, entry] of inventory.entries()) {
      const previous = plan.databases[index];
      check(entry.name === previous.name && entry.dev === previous.dev && entry.ino === previous.ino,
        'Migrated database was replaced');
      const file = path.join(plan.dataDir, entry.name);
      const db = new Database(file, {readonly:true, fileMustExist:true});
      try {
        const result = checkMigrationCompatibility(db, newDir, file);
        check(result.compatible && result.databaseVersion === pending.at(-1).seq &&
          result.checkoutVersion === result.databaseVersion, 'Migrated schema differs from candidate');
        quickCheck(db);
      } finally { db.close(); }
    }
    return {ready:true, action};
  }
  if (action !== 'rehearse') check(same(inventory, plan.databases), 'Database inventory or runtime manifest changed; prepare again');
  const space = fs.statfsSync(plan.dataDir);
  const bytes = inventory.reduce((n, f) => n + fs.statSync(path.join(plan.dataDir, f.name)).size, 0);
  check(space.bavail * space.bsize > bytes * 3 + 1024 ** 3, 'Insufficient space for backup and migration');
  const leases = [], databases = [];
  const target = action === 'rehearse' ? plan.rehearsalDir : plan.backupDir;
  try {
    if (action === 'apply') {
      // Cooperate with all Desktop/Host readers before any database is opened writable.
      for (const entry of inventory) {
        const file = path.join(plan.dataDir, entry.name);
        const lease = await acquireSchemaMigrationWriterLease(file);
        check(lease.acquired, `Database is in use: ${lease.reason ?? ''}`);
        leases.push(lease.lease);
        const opened = spawnSync('/usr/sbin/lsof', ['-t', '--', file, file + '-wal'], { encoding: 'utf8', timeout: 15000 });
        check(opened.status === 1 && !opened.stdout.trim(), 'Another process still has the database open');
      }
      check(same(files(plan.dataDir), inventory), 'Database replaced during lease acquisition');
    }
    for (const entry of inventory) {
      const file = path.join(plan.dataDir, entry.name);
      const db = new Database(file, { readonly: action !== 'apply', fileMustExist: true, timeout: 5000 });
      databases.push({ db, file, entry });
      compatible(db, oldDir, file);
    }
    if (action === 'preflight') return { ready: true, databases: inventory };
    check(path.dirname(target) === path.join(plan.dataDir, 'personal-upgrade-backups'), 'Backup must remain in the profile backup directory');
    check(!fs.existsSync(target), 'Backup destination already exists; inspect the previous attempt');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 }); fs.chmodSync(target, 0o700);
    // Back up EVERY database before migrating any of them. Never restore over live data.
    const backups = [];
    for (const { db, file, entry } of databases) {
      const copy = path.join(target, entry.name);
      await db.backup(copy); fs.chmodSync(copy, 0o600); flush(copy);
      fs.copyFileSync(migrationRuntimeManifestPath(file), migrationRuntimeManifestPath(copy), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(migrationRuntimeManifestPath(copy), 0o600); flush(migrationRuntimeManifestPath(copy));
      const inspect = new Database(copy, { readonly: true, fileMustExist: true });
      try { quickCheck(inspect); compatible(inspect, oldDir, copy); } finally { inspect.close(); }
      backups.push({ name: entry.name, sha256: await largeDigest(copy), bytes: fs.statSync(copy).size });
    }
    save(path.join(target, 'backups.json'), { at: new Date().toISOString(), backups, candidate: plan.candidate.id });
    for (const { db, file, entry } of databases) {
      const selected = action === 'rehearse' ? path.join(target, entry.name) : file;
      const writer = action === 'rehearse' ? new Database(selected, { fileMustExist: true }) : db;
      try {
        prepareMigrationRuntimeManifest(selected, newDir, oldManifest.migrations.at(-1).seq);
        runMigrationReplay(writer, { drizzleDir: newDir,
          onMigrationHistoryWriteFailed: () => { throw Error('Migration history write failed'); } });
        compatible(writer, newDir, selected); quickCheck(writer);
        writer.pragma('wal_checkpoint(TRUNCATE)');
        flush(selected); flush(migrationRuntimeManifestPath(selected));
      } finally { if (writer !== db) writer.close(); }
    }
    const result = { ready: true, action, databases: inventory, pending, directory: target, at: new Date().toISOString() };
    save(path.join(target, 'completed.json'), result);
    return result;
  } finally {
    for (const { db } of databases.reverse()) db.close();
    for (const lease of leases.reverse()) lease.release();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  executeDatabasePlan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3])
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
