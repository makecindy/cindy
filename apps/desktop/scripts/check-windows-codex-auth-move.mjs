// Integration tier: execute the production Windows move against fake credentials.
// #9316 publishes symlinks and read-only Dev snapshots with a no-overwrite move.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveCodexAuthFile } from '../src/main/maker-host/codex-auth-file-move.ts';

if (process.platform !== 'win32') {
  console.log('Windows Codex auth move integration skipped on this platform.');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth ' 中文 $test [1]-"));
try {
  const source = path.join(root, 'auth.json.1.0.copytmp');
  const target = path.join(root, 'auth.json');
  fs.writeFileSync(source, 'fake-local-token');
  fs.writeFileSync(target, 'fake-new-system-token');
  // A known collision must not depend on a cold/available PowerShell process.
  // CI #10413 returned EIO after shell startup hit 15s instead of EEXIST.
  const systemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = path.join(root, 'no-powershell');
    await assert.rejects(moveCodexAuthFile(source, target), { code: 'EEXIST' });
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-new-system-token');
  assert.equal(fs.readFileSync(source, 'utf8'), 'fake-local-token');

  fs.unlinkSync(target);
  await moveCodexAuthFile(source, target);
  assert.equal(fs.existsSync(source), false, 'publication must consume the staging name');
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-local-token');
  assert.equal(fs.statSync(target).nlink, 1, 'publication must not create a hardlink');
  await assert.rejects(moveCodexAuthFile(source, target), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-local-token');
  // The early collision check is only an optimization: a concurrent winner
  // after lstat must still survive the real atomic File.Move unchanged.
  fs.writeFileSync(source, 'fake-late-token');
  const lateTarget = path.join(root, 'late-auth.json');
  const lstat = fs.promises.lstat;
  fs.promises.lstat = async function (filename, ...options) {
    try { return await lstat.call(this, filename, ...options); }
    catch (error) {
      if (filename === lateTarget && error.code === 'ENOENT') {
        fs.writeFileSync(lateTarget, 'fake-concurrent-winner');
      }
      throw error;
    }
  };
  try {
    await assert.rejects(moveCodexAuthFile(source, lateTarget), { code: 'EEXIST' });
  } finally { fs.promises.lstat = lstat; }
  assert.equal(fs.readFileSync(lateTarget, 'utf8'), 'fake-concurrent-winner');
  assert.equal(fs.readFileSync(source, 'utf8'), 'fake-late-token');
  const linked = path.join(root, 'auth.json.linktmp');
  const published = path.join(root, 'shared-auth.json');
  let canSymlink = true;
  try {
    fs.symlinkSync(target, linked, 'file');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    canSymlink = false;
  }
  if (canSymlink) {
    await moveCodexAuthFile(linked, published);
    assert.equal(fs.lstatSync(published).isSymbolicLink(), true);
    assert.equal(fs.existsSync(linked), false);
    assert.equal(fs.readFileSync(published, 'utf8'), 'fake-local-token');
    assert.equal(fs.statSync(target).nlink, 1);
  } else {
    console.log('File symlink publication skipped: runner lacks symlink privilege.');
  }
  console.log('Windows Codex auth no-overwrite move integration passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
