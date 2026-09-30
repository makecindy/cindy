import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Windows atomic rename check skipped on this platform.');
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(scriptDir, '..', 'native', 'windows-atomic-rename', 'main.rs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-atomic-rename-check-'));
const binary = path.join(root, 'cindy-windows-atomic-rename.exe');
let oldHandle;

try {
  const compile = spawnSync('rustc', [
    source,
    '--edition=2021',
    '-C', 'opt-level=s',
    '-C', 'panic=abort',
    '-o', binary,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);

  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const active = path.join(root, '.active');
  const replacement = path.join(root, '.active.next');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'SKILL.md'), 'first');
  fs.writeFileSync(path.join(second, 'SKILL.md'), 'second');
  fs.symlinkSync(first, active, 'junction');
  fs.symlinkSync(second, replacement, 'junction');

  oldHandle = fs.openSync(path.join(active, 'SKILL.md'), 'r');
  let missingObservations = 0;
  const child = spawn(binary, [replacement, active], { windowsHide: true });
  const poll = setInterval(() => {
    if (!fs.existsSync(active)) missingObservations += 1;
  }, 0);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearInterval(poll);
  assert.equal(exitCode, 0, 'native helper failed');
  assert.equal(missingObservations, 0, '.active disappeared during publication');
  assert.equal(fs.readlinkSync(active), second, 'the exact destination entry must be replaced');
  assert.equal(fs.readFileSync(path.join(active, 'SKILL.md'), 'utf8'), 'second');
  assert.equal(fs.existsSync(replacement), false);

  const oldBytes = Buffer.alloc(5);
  assert.equal(fs.readSync(oldHandle, oldBytes, 0, oldBytes.length, 0), 5);
  assert.equal(oldBytes.toString(), 'first');
  fs.closeSync(oldHandle);
  oldHandle = undefined;
  console.log('Windows atomic rename check passed.');
} finally {
  if (oldHandle !== undefined) fs.closeSync(oldHandle);
  fs.rmSync(root, { recursive: true, force: true });
}
