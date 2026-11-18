import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
await esbuild.build({
  entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: 'dist/relay.mjs', external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __agentNetRequire } from 'node:module'; const require = __agentNetRequire(import.meta.url);" },
  legalComments: 'none', sourcemap: false,
  plugins: [{ name: 'normalize-eol', setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'),
      loader: path.endsWith('.ts') ? 'ts' : path.endsWith('.json') ? 'json' : 'js',
    }));
  } }],
});
