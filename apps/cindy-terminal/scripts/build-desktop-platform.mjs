import { build } from 'esbuild';
import { build as buildVite } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildDesktopPlatformMain } from './desktop-platform-build.mjs';

const terminal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.resolve(terminal, '../desktop');
const output = path.join(desktop, '.vite/build');
await mkdir(output, { recursive: true });
await buildDesktopPlatformMain(path.join(output, 'terminal-platform-main.mjs'));
await build({
  entryPoints: [path.join(desktop, 'src/preload/desktopCapturePreload.ts')],
  outfile: path.join(output, 'desktopCapturePreload.js'), bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', external: ['electron'],
});
await buildVite({ configFile: path.join(desktop, 'vite.capture.config.ts'), logLevel: 'warn' });
// Electron's source launcher uses the entry directory as app.getAppPath().
// Keep the source-only loader at the existing Desktop root for native builds.
await writeFile(path.join(desktop, '.cindy-terminal-platform.mjs'), 'import "./.vite/build/terminal-platform-main.mjs";\n');
console.log(`Optional desktop platform: ${path.join(output, 'terminal-platform-main.mjs')}`);
