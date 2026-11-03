import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../brand-terminology-guard.mjs', import.meta.url));

// Real CLI and pipe, synthetic Git output and virtual files: no dependency on
// checkout size or thousands of filesystem fixtures (#8132). The existing brand
// identity tests only cover static mirrors, so this needs its own CLI fixture.
function runGuard(mode) {
  const producer = "process.stdout.write(('virtual-' + 'a'.repeat(200) + '\\0').repeat(6000) + 'tail.txt\\0')";
  const preload = [
    "import cp from 'node:child_process';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const originalSpawn = cp.spawnSync;',
    'const originalRead = fs.readFileSync;',
    'const mode = ' + JSON.stringify(mode) + ';',
    'cp.spawnSync = (_command, _args, options) => {',
    "  if (mode === 'spawn-error') return { status: 0, error: Object.assign(new Error('synthetic buffer failure'), { code: 'ENOBUFS' }), stdout: Buffer.alloc(0) };",
    "  if (mode === 'git-error') return { status: 128, stderr: Buffer.from('not a git repository') };",
    '  return originalSpawn(process.execPath, ["-e", ' + JSON.stringify(producer) + '], options);',
    '};',
    "fs.readFileSync = (file, ...args) => String(file).startsWith('virtual-') || file === 'tail.txt' ? Buffer.from(file === 'tail.txt' && mode === 'violation' ? 'XDT' + ' Maker' : '') : originalRead(file, ...args);",
    'syncBuiltinESMExports();',
  ].join('\n');
  return spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), guard], {
    encoding: 'utf8',
  });
}

test('brand CLI scans a Git listing larger than 1 MiB, including the last file', () => {
  const clean = runGuard('clean');
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /PASS/);
  const violation = runGuard('violation');
  assert.equal(violation.status, 1);
  assert.match(violation.stderr, /tail\.txt:1:1/);
});

test('brand CLI rejects spawn errors even when the exit status is zero', () => {
  const result = runGuard('spawn-error');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOBUFS/);
  assert.doesNotMatch(result.stdout, /PASS/);
});

test('brand CLI preserves Git failure diagnostics', () => {
  const result = runGuard('git-error');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exit 128/);
  assert.match(result.stderr, /not a git repository/);
});
