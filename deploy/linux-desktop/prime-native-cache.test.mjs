// The packaging gate: cached native bytes and ABI must agree with the final
// package, including modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPackage, restorePackage, clearMetadata } from './prime-native-cache.cjs';

test('native packaging rejects changed bytes, permissions or Electron target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-cache-'));
  try {
    const manifest = { electronVersion: '42.11.12', arch: 'x64', platform: 'linux', binaries: {} };
    const files = [];
    for (const [name, binary] of [['better-sqlite3', 'better_sqlite3.node'], ['node-pty', 'pty.node']]) {
      const file = path.join(dir, 'node_modules', name, 'build/Release', binary);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name); fs.chmodSync(file, 0o755);
      manifest.binaries[name] = { sha256: createHash('sha256').update(name).digest('hex'), mode: 0o755 };
      files.push(file);
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const meta = path.join(path.dirname(files[0]), '.forge-meta');
    fs.writeFileSync(meta, 'x64--145');
    clearMetadata(dir);
    assert.equal(fs.existsSync(meta), false);
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'better-sqlite3');
    const verify = (version = '42.11.12', arch = 'x64') => verifyPackage(dir, version, arch, 'linux', dir);
    verify();
    assert.throws(() => verify('43.0.0'), /TARGET_MISMATCH/);
    assert.throws(() => verify('42.11.12', 'arm64'), /TARGET_MISMATCH/);
    fs.chmodSync(files[1], 0o644); assert.throws(() => verify(), /BINARY_MISMATCH:node-pty/);
    restorePackage(dir, '42.11.12', 'x64', 'linux', dir); verify();
    assert.equal(fs.statSync(files[1]).mode & 0o777, 0o755);
    fs.chmodSync(files[1], 0o755); fs.writeFileSync(files[1], 'wrong ABI bytes');
    assert.throws(() => verify(), /BINARY_MISMATCH:node-pty/);
    fs.unlinkSync(files[1]); assert.throws(() => verify(), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
