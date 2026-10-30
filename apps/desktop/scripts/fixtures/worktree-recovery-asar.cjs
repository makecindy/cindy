const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const physicalFs = require('original-fs').promises;
const { app } = require('electron');
const { runRecoveryArchiveTask: run } = require('./client.cjs');
const io = require('./io.cjs');
const root = process.env.CINDY_RECOVERY_TEST_ROOT;
app.setPath('userData', path.join(root, 'profile'));

(async () => {
  const source = path.join(root, 'source');
  const directory = path.join(root, 'archives');
  const staging = path.join(root, 'restored');
  const asar = path.join(source, 'app.asar');
  const bytes = await physicalFs.readFile(asar);
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const originalNoAsar = process.noAsar;
  assert.equal((await fs.lstat(asar)).isDirectory(), true, 'fixture must reproduce Electron virtual ASAR');
  assert.equal((await io.inventoryWorktree(source))['app.asar'].kind, 'directory');
  if (process.platform !== 'win32') {
    await assert.rejects(io.createRecoveryArchive(source, 'abcd', directory, key, 'test-only', iv), /archive content does not match/);
  }
  const inventory = await run({ operation: 'inventory', root: source });
  assert.equal(inventory['app.asar'].kind, 'file');
  assert.equal(inventory['app.asar'].hash, crypto.createHash('sha256').update(bytes).digest('hex'));
  const archive = await run({ operation: 'create', root: source, resourceId: 'abcd', directory, key, encryptedKey: 'test-only', iv });
  // The existing verifier can read the new archive: no archive-format migration.
  await io.verifyRecoveryArchive(archive, directory, key);
  await run({ operation: 'verify', archive, directory, key });
  await fs.mkdir(staging);
  await run({ operation: 'extract', archive, staging, keep: false, directory, key });
  assert.deepEqual(await physicalFs.readFile(path.join(staging, 'app.asar')), bytes);
  assert.equal(await fs.readFile(path.join(staging, 'app.asar.unpacked', 'native.node'), 'utf8'), 'unpacked fixture');
  assert.equal(await fs.readFile(path.join(staging, '.env'), 'utf8'), 'synthetic ignored fixture');
  await fs.unlink(path.join(staging, '.env'));
  await run({ operation: 'extract', archive, staging, keep: true, directory, key });
  assert.deepEqual(await run({ operation: 'inventory', root: staging }), inventory);
  // Authentication failure must not emit restored plaintext.
  const corrupt = { ...archive, tag: Buffer.alloc(16).toString('base64') };
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  await assert.rejects(run({ operation: 'extract', archive: corrupt, staging: empty, keep: false, directory, key }));
  assert.deepEqual(await fs.readdir(empty), []);
  assert.equal(process.noAsar, originalNoAsar);
  assert.equal((await fs.lstat(asar)).isDirectory(), true, 'main must retain ASAR support');
  key.fill(0);
  process.stdout.write('PASS: old failure reproduced; packaged worker inventory/create/verify/restore/keep/authentication; main ASAR unchanged\n');
})().then(() => app.exit(0), (error) => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
