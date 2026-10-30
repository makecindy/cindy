import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { headlessBuildOptions } from './build-options.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await build({
  ...headlessBuildOptions,
  entryPoints: {
    cli: path.join(appDir, 'src', 'cli.ts'),
    'eval-cli': path.join(appDir, 'src', 'eval-cli.ts'),
  },
  outdir: distDir,
});
