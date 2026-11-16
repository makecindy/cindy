// 把真实网络测试的两个入口打成自包含的 ESM 文件，放到服务器和别的电脑上用 Node（22 以上）跑。
// 核心的 WebAssembly 不打进去：和脚本放在一起，运行时用环境变量 AGENT_NET_WASM 指过去。
import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('real/dist', { recursive: true });
for (const name of ['relay-server', 'peer']) {
  await esbuild.build({
    entryPoints: [`real/${name}.ts`],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: `real/dist/${name}.mjs`,
    // ws 是 CommonJS，可选的原生加速模块不打包，没有时 ws 自动退回纯 JS。
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    // QUIC 对照只在 transport.ts 里按需加载，这两个入口用不到 iroh。
    external: ['bufferutil', 'utf-8-validate', '@number0/iroh'],
    logLevel: 'warning',
  });
}
await copyFile('../../packages/agent-net-core/target/wasm32-unknown-unknown/release/agent_net_wasm.wasm', 'real/dist/agent_net_wasm.wasm');
console.log('bundled into real/dist');
