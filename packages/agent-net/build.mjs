import { build } from 'esbuild';
await build({ entryPoints: ['src/worker.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: 'dist/node-worker.mjs', external: ['bufferutil', 'utf-8-validate'], legalComments: 'none',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
