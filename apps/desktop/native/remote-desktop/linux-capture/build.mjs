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
/** pkg-config flags, or null when a development package is absent. */
function optional(...packages) {
  const result = spawnSync('pkg-config', ['--cflags', '--libs', ...packages], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : null;
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
const flags = run('pkg-config', ['--cflags', '--libs', 'wayland-client', 'libpng']).split(/\s+/);
// X11 capture needs XFIXES for the separate cursor; MIT-SHM (libXext) only
// speeds it up. Builders without these headers keep the Wayland helper and
// report X11 capture unavailable at runtime.
const x11 = optional('x11', 'xfixes');
const shm = x11 && optional('xext');
const binary = path.join(output, 'cindy-linux-desktop-capture');
run('cc', [
  '-std=c11',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-O2',
  ...(x11 ? ['-DCINDY_X11'] : []),
  ...(shm ? ['-DCINDY_XSHM'] : []),
  path.join(source, 'main.c'),
  ...protocols.map((name) => path.join(output, name + '.c')),
  '-I',
  output,
  ...flags,
  ...(x11 ?? []),
  ...(shm ?? []),
  '-lm',
  // JPEG backends are loaded at runtime (jpeg.h); none is a link dependency.
  '-ldl',
  '-o',
  binary + '.tmp',
]);
fs.renameSync(binary + '.tmp', binary);

// GNOME (Mutter) capture is a separate binary so a missing PipeWire library
// can never stop the Wayland/X11 helper above from loading.
const gnome = path.join(output, 'cindy-linux-gnome-capture');
fs.rmSync(gnome, { force: true });
const gnomeFlags = optional('gio-2.0', 'libpipewire-0.3', 'xcursor', 'libpng');
if (gnomeFlags) {
  run('cc', [
    '-std=gnu11',
    '-Wall',
    '-Wextra',
    '-Werror',
    // PipeWire's inline SPA helpers trip these in their own headers.
    '-Wno-missing-field-initializers',
    '-Wno-unused-parameter',
    '-O2',
    path.join(source, 'gnome.c'),
    ...gnomeFlags,
    '-lm',
    '-ldl',
    '-o',
    gnome + '.tmp',
  ]);
  fs.renameSync(gnome + '.tmp', gnome);
} else {
  console.warn(
    'Linux capture: GNOME capture skipped (gio-2.0, libpipewire-0.3 or xcursor missing)',
  );
}
