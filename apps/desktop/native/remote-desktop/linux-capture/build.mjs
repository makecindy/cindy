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
    throw new Error(`Linux capture build failed: ${command}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
const protocols = [
  'wlr-screencopy-unstable-v1',
  'ext-image-copy-capture-v1',
  'ext-image-capture-source-v1',
  'ext-foreign-toplevel-list-v1',
];
for (const name of protocols) {
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
  'libturbojpeg',
  'libpng',
]).split(/\s+/);
const binary = path.join(output, 'cindy-linux-desktop-capture');
run('cc', [
  '-std=c11',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  path.join(source, 'main.c'),
  ...protocols.map((name) => path.join(output, name + '.c')),
  '-I',
  output,
  ...flags,
  '-lm',
  '-o',
  binary + '.tmp',
]);
fs.renameSync(binary + '.tmp', binary);
