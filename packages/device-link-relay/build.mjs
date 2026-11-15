// 把中转命令行入口(src/cli.ts)打成一个自包含的 ESM 文件 dist/relay.mjs,部署时经 SSH 传到用户的
// 服务器、用 Node 运行。与 remote-file-service/build.mjs 同款管线(含跨平台 EOL 归一,保证 Win/mac
// 构建产物一致);产物由 apps/desktop/scripts/build-remote-bundles.mjs 在 dev/prepackage 阶段交给 desktop。

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

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

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/relay.mjs',
  // ws 是 CommonJS,可选的原生加速模块(bufferutil / utf-8-validate)不打包:没有时 ws 自动退回纯 JS。
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cindyCreateRequire } from 'node:module';\nconst require = __cindyCreateRequire(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  minify: false, // 远端日志里的堆栈保持可读
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/relay.mjs');
