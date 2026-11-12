// Bundle src/bin/proxy.ts → dist/proxy.mjs (self-contained ESM, deployable
// to remote SSH machines). Zero runtime deps (node:http only), expect
// ~20-50KB output.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

// Cross-platform deterministic bundle plugin — see maker-cc-manager/build.mjs
// for the full explanation. TL;DR: Windows CRLF source vs POSIX LF source
// bundles to different bytes; force LF before esbuild reads.
const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n');
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      const loader = ext === 'ts' ? 'ts' : ext === 'json' ? 'json' : 'js';
      return { contents: normalized, loader };
    });
  },
};

const opencodexLicense = (await readFile(new URL('../model-compat/LICENSE.opencodex', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

await esbuild.build({
  entryPoints: ['src/bin/proxy.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/proxy.mjs',
  // SSH deployment copies this single file, so its third-party notice must travel with it.
  banner: { js: '#!/usr/bin/env node\n/*\n' + opencodexLicense.replace(/\*\//g, '* /') + '\n*/' },
  external: [],
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/proxy.mjs');
