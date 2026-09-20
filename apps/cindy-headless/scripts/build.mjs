import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await build({
  entryPoints: {
    cli: path.join(appDir, 'src', 'cli.ts'),
    'eval-cli': path.join(appDir, 'src', 'eval-cli.ts'),
  },
  outdir: distDir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  loader: { '.md': 'text' },
});
