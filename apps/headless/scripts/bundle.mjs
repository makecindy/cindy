import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = path.join(root, 'dist', 'bundle');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const entries = {
  'cindy-headless': path.join(root, 'src', 'bin', 'cindy-headless.ts'),
  cindy: path.join(root, 'src', 'bin', 'cindy.ts'),
  cindyctl: path.join(root, 'src', 'bin', 'cindyctl.ts'),
};

await build({
  entryPoints: entries,
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Some transitive Node dependencies are CommonJS and esbuild preserves their
  // runtime requires in an ESM bundle.  Give those requires Node's canonical
  // ESM-compatible loader instead of the browser-style throwing shim.
  banner: { js: "import { createRequire as __cindyCreateRequire } from 'node:module'; const require = __cindyCreateRequire(import.meta.url);" },
  packages: 'bundle',
  // Native SQLite is target-ABI-specific and shipped beside this bundle by
  // package-linux.mjs. gray-matter is CommonJS and calls require('fs')
  // dynamically, so leave both to Node's runtime loader.
  external: ['better-sqlite3', 'gray-matter'],
  loader: { '.md': 'text' },
  logLevel: 'info',
});
