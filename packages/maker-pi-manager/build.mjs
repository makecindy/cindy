// Bundle src/bin/pi-manager.ts into a self-contained ESM file deployable to
// remote SSH machines. Mirrors packages/maker-cc-manager/build.mjs — the
// pattern is intentionally copied (not shared) to keep cc-mgr's build
// byte-identical and its behavior untouched.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

// Cross-platform deterministic bundle plugin: force LF line endings so
// Windows/macOS checkouts produce byte-identical bundles (see cc-mgr build.mjs
// comment for the empirical hash mismatch history).
const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n');
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      const loader =
        ext === 'ts'
          ? 'ts'
          : ext === 'json'
            ? 'json'
            : 'js';
      return { contents: normalized, loader };
    });
  },
};

await esbuild.build({
  entryPoints: ['src/bin/pi-manager.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/pi-manager.mjs',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  legalComments: 'none',
  minify: false, // keep stack traces readable in production logs
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/pi-manager.mjs');
