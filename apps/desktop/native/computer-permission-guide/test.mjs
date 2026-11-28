import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit macOS native integration tier, like native/menubar/test.mjs.
assert.equal(process.platform, 'darwin', 'Permission guide integration tests require macOS');
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-permission-guide-test-'));
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
  // Keep the complete production classes and their file-private access intact.
  // Only the executable entry is disabled; no implementation is extracted or replaced.
  const source = path.join(output, 'test.swift');
  fs.writeFileSync(source, [
    fs.readFileSync(path.join(directory, 'macos-computer-permission-guide-helper.swift'), 'utf8'),
    fs.readFileSync(path.join(directory, 'hit-test.test.swift'), 'utf8'),
  ].join('\n'));
  const binary = path.join(output, 'hit-test');
  run('xcrun', ['swiftc', '-D', 'COMPUTER_PERMISSION_GUIDE_TEST',
    source, '-o', binary], 180_000);
  run(binary, [], 10_000);
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
