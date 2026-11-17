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
  await assert.rejects(moveCodexAuthFile(source, target), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-new-system-token');
  assert.equal(fs.readFileSync(source, 'utf8'), 'fake-local-token');

  fs.unlinkSync(target);
  await moveCodexAuthFile(source, target);
  assert.equal(fs.existsSync(source), false, 'publication must consume the staging name');
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-local-token');
  assert.equal(fs.statSync(target).nlink, 1, 'publication must not create a hardlink');
  await assert.rejects(moveCodexAuthFile(source, target), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'fake-local-token');
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
