import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.dirname(fileURLToPath(import.meta.url));
const [output] = process.argv.slice(2);
if (!output || !path.isAbsolute(output)) throw new Error('Absolute output directory required');
fs.mkdirSync(output, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0)
    throw new Error(`Linux input build failed: ${command}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
for (const name of ['virtual-keyboard-unstable-v1', 'wlr-virtual-pointer-unstable-v1']) {
  run('wayland-scanner', [
    'client-header',
    path.join(source, name + '.xml'),
    path.join(output, name + '.h'),
  ]);
  run('wayland-scanner', [
    'private-code',
    path.join(source, name + '.xml'),
    path.join(output, name + '.c'),
  ]);
}
const flags = run('pkg-config', [
  '--cflags',
  '--libs',
  'wayland-client',
  'xkbcommon',
  'json-c',
]).split(/\s+/);
const binary = path.join(output, 'cindy-linux-desktop-input');
run('cc', [
  '-std=c11',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  path.join(source, 'main.c'),
  path.join(output, 'virtual-keyboard-unstable-v1.c'),
  path.join(output, 'wlr-virtual-pointer-unstable-v1.c'),
  '-I',
  output,
  ...flags,
  '-lm',
  '-o',
  binary + '.tmp',
]);
fs.renameSync(binary + '.tmp', binary);
