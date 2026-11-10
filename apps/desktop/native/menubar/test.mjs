import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit native integration tier; compile the complete production helper once.
// No source extraction or TS reimplementation: the probe observes real AppKit writes.
assert.equal(process.platform, 'darwin', 'Menu bar integration tests require macOS and swiftc');
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-menubar-test-'));
const binary = path.join(output, 'status-button-test');
const run = (command, args, timeout) => {
  const started = performance.now();
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (${result.signal ?? result.status})`);
  process.stdout.write(`${path.basename(command)}: ${(performance.now() - started).toFixed(0)}ms\n`);
};
try {
  run('swiftc', [
    '-O', '-parse-as-library', '-D', 'MENUBAR_TEST',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    path.join(directory, 'macos-menubar-helper.swift'),
    path.join(directory, 'status-button.test.swift'), '-o', binary,
  ], 180_000);
  run(binary, [], 10_000);
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
