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
    throw new Error(`Clipboard build failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
const protocol = 'wlr-data-control-unstable-v1';
for (const [mode, extension] of [
  ['client-header', 'h'],
  ['private-code', 'c'],
])
  run('wayland-scanner', [
    mode,
    path.join(source, protocol + '.xml'),
    path.join(output, protocol + '.' + extension),
  ]);
const flags = run('pkg-config', ['--cflags', '--libs', 'wayland-client', 'json-c']).split(/\s+/);
const binary = path.join(output, 'cindy-linux-desktop-clipboard');
run('cc', [
  '-std=c11',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  path.join(source, 'main.c'),
  path.join(output, protocol + '.c'),
  '-I',
  output,
  ...flags,
  '-o',
  binary + '.tmp',
]);
fs.renameSync(binary + '.tmp', binary);
