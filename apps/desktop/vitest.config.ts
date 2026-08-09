import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { desktopClientBuildEnv } from '../../scripts/shared/client-endpoint-build-env.mjs';
import { parseVitestCliExclude } from './src/test/vitest/cliExclude';

const clientBuildEnv = desktopClientBuildEnv({ allowEnvOverride: false });
const cliTestExclude = parseVitestCliExclude(process.argv.slice(2));
const desktopTestInclude = [
  'src/main/__tests__/**/*.test.ts',
  'src/main/**/__tests__/**/*.test.ts',
  'src/renderer/__tests__/**/*.test.ts',
  'src/renderer/**/__tests__/**/*.test.ts',
  // renderer 组件测试(React,tsx):按文件头 `// @vitest-environment jsdom`
  // 切 DOM 环境;此前 include 只收 .test.ts,tsx 用例根本不会被跑。
  'src/renderer/**/__tests__/**/*.test.tsx',
  'src/preload/__tests__/**/*.test.ts',
  // shared 是 main/renderer 共用的纯函数层;此前漏配导致 src/shared/__tests__
  // 下的测试(如 workingDir.test.ts)从未跑过。
  'src/shared/__tests__/**/*.test.ts',
];
const gitIntegrationTestInclude = [
  'src/main/**/*.git-integration.test.ts',
];

export default defineConfig({
  define: {
    // 业务端点烘焙 define 已随端点清单重构退役;测试固定值统一走
    // src/test/vitest/clientEndpointsFixture.ts,不再从生产配置取"真值"。
    'import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL': JSON.stringify(
      clientBuildEnv.VITE_ENDPOINT_MANIFEST_BASE_URL,
    ),
    'import.meta.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL': JSON.stringify(
      clientBuildEnv.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL,
    ),
  },
  plugins: [
    {
      // 仓库根 scripts/*.mjs 带 shebang(#!/usr/bin/env node)。vite-node 内联
      // 执行这类 root 外模块时不剥 hashbang,包进函数体后成非法 token,
      // ensureDepsElectronBinary.test.ts 在本地(Windows + Node 25 实测)整文件
      // SyntaxError;CI(ubuntu + Node 22)不复现。统一在 transform 前把首行
      // shebang 置空(保留换行,行号不漂移,无需 sourcemap)。
      name: 'strip-hashbang',
      enforce: 'pre' as const,
      transform(code: string) {
        if (code.startsWith('#!')) return { code: code.replace(/^#![^\n]*/, ''), map: null };
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      // Mirror the renderer alias from tsconfig.json so any test that reaches
      // into renderer code can resolve '@/...' the same way the build does.
      '@': path.resolve(__dirname, 'src/renderer'),
      electron: path.resolve(__dirname, 'src/test/vitest/electron-stub.ts'),
      // original-fs is provided by Electron at runtime. Unit tests run in Node,
      // where the standard fs module has the same physical-filesystem semantics.
      'original-fs': 'node:fs',
    },
  },
  test: {
    globals: true,
    // Main-process tests do real IO (loopback HTTP servers, git subprocesses,
    // heavy module imports through the vite-node transform). On Windows those
    // are markedly slower and, under the full desktop suite's worker-pool
    // contention, light tests intermittently blow past vitest's 5s default and
    // time out non-deterministically (a different test each run). Give Windows
    // a wider default so those pass reliably; keep the standard 5s on
    // Linux/macOS/CI so genuine hangs still surface promptly. Tests that need
    // even more (multi-step real-git orchestration) still set their own higher
    // per-file timeout, which overrides this.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // Node 25 默认开启 webstorage,globalThis.localStorage 变成一个未配
    // --localstorage-file 时方法全缺的残缺对象:node 环境下骗过
    // `typeof localStorage !== 'undefined'` 探测,jsdom 环境下又因 key 已存在
    // 顶掉 jsdom 注入的可用实现(vitest 填充全局时跳过已存在的 key)。统一在
    // worker 里关掉该全局(flag 自 Node 22 起有效),恢复两种环境的原语义。
    // 配置放这里(而非 test 脚本注 NODE_OPTIONS)是因为根 test-workspaces runner
    // 走 `exec vitest run` 直调、不经 package.json 脚本,只有 config 层对所有
    // 入口一致生效。
    //
    // 只给 forks 池配这个 execArgv,threads 池一律不配:给 worker thread 传自定义
    // execArgv 会让 isolate 销毁时段错误(实测数据见 scripts/shared/node-webstorage.mjs),
    // 所以哪怕有人手动 `--pool=threads` 也不该拿到这份配置。需要这个 flag 的 Node 上,
    // 根 manifest 会用同一个 nodeWebstorageEnabled() 判据把 unit tier 留在 forks,
    // 两者不会同时生效;不需要 flag 的 Node(本机与 CI 的 22)上压根没有 webstorage 全局。
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
    },
    // Main-process code is pure Node — no DOM needed. Renderer tests (if/when
    // added) should switch to 'jsdom' via per-file `// @vitest-environment`.
    environment: 'node',
    // Keep include arrays project-local: Vitest merges array options inherited
    // through extends:true, so a root include would make the resource project
    // collect standard tests too. The two projects remain mutually exclusive.
    projects: [
      {
        extends: true,
        test: {
          name: 'standard',
          include: desktopTestInclude,
          exclude: [...gitIntegrationTestInclude, ...cliTestExclude],
        },
      },
      {
        extends: true,
        test: {
          name: 'git-integration',
          include: gitIntegrationTestInclude,
          exclude: cliTestExclude,
          globalSetup: ['src/test/vitest/desktopTestResourceLock.ts'],
        },
      },
    ],
  },
});
