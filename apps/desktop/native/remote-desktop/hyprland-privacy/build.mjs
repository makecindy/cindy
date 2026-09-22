import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const root = path.dirname(fileURLToPath(import.meta.url));
const [output] = process.argv.slice(2);
if (!output || !path.isAbsolute(output)) throw new Error('Absolute output directory required');
fs.mkdirSync(output, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
const version = run('pkg-config', ['--modversion', 'hyprland']);
// Internal render/input hooks are deliberately version-bound, never best-effort.
if (version !== '0.56.2') throw new Error('Unsupported Hyprland headers');
const flags = run('pkg-config', ['--cflags', 'hyprland']).split(/\s+/);
const digest = createHash('sha256');
for (const name of ['main.cpp', 'gate.hpp', 'build.mjs'])
  digest.update(fs.readFileSync(path.join(root, name)));
// Embed the exact Mac artwork; no runtime file or network access in Hyprland.
const artwork = [];
for (const [symbol, name] of [
  ['hero', 'illustration.webp'],
  ['wordmarkDark', 'wordmark.png'],
  ['wordmarkLight', 'wordmark-light.png'],
]) {
  const bytes = fs.readFileSync(path.join(root, '../../../src/renderer/assets/splash', name));
  digest.update(bytes);
  const png = await sharp(bytes).png().toBuffer();
  artwork.push(`static const unsigned char ${symbol}Png[] = {${Array.from(png).join(',')}};`);
}
fs.writeFileSync(path.join(output, 'privacy-artwork.hpp'), artwork.join('\n'));
const source = digest.digest('hex');
const temporary = path.join(output, `privacy-${process.pid}.so`);
run('c++', [
  '-std=c++26',
  '-shared',
  '-fPIC',
  '-O2',
  '-Wall',
  '-Wextra',
  `-DCINDY_PRIVACY_SOURCE="${source}"`,
  '-Wno-unused-parameter',
  '-Wno-missing-field-initializers',
  ...flags,
  '-I',
  output,
  path.join(root, 'main.cpp'),
  '-ljson-c',
  '-o',
  temporary,
]);
fs.renameSync(temporary, path.join(output, 'cindy-hyprland-privacy.so'));
const header = fs.readFileSync('/usr/include/hyprland/src/version.h', 'utf8');
const hash = header.match(/#define GIT_COMMIT_HASH\s+"([a-f0-9]+)"/)?.[1];
if (!hash) throw new Error('Missing Hyprland build identity');
fs.writeFileSync(
  path.join(output, 'cindy-hyprland-privacy.json'),
  JSON.stringify({ version, hash, source }),
);
