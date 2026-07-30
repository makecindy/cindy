#!/usr/bin/env node
// 启动当前 worktree 的 Metro(dev-client 模式),并把当前 git branch/commit 注入
// EXPO_PUBLIC_XDT_GIT_*,这样 __DEV__ build label 能显示"分支 · 版本 · Metro host:port"。
//
// 为什么用 EXPO_PUBLIC_* 而不是 app.config.js 注入:app.config.js 改动会进
// @expo/fingerprint → 每个 commit 都改 runtimeVersion、破坏 OTA(实测);EXPO_PUBLIC_*
// 是 JS bundle 层注入,不进 fingerprint。
//
// 端口策略(重要):本 app **不含 expo-dev-client**,装好的 debug 包只会连它编译时的默认
// packager 端口(8081)。所以这里**坚持用 8081**,不会自动挪到 8082+ —— 否则 Metro 起在
// 8083、app 还连 8081,反而制造"看着像新版、其实是旧 bundle"的坑(正是本工具要消灭的)。
//   - 8081 空闲 → 起在 8081。
//   - 8081 已被**本 worktree** 占 → 说明 Metro 已在跑,直接 Fast Refresh 即可,不重开。
//   - 8081 被**别的 worktree** 占 → 明确报错,让你先停掉那个(sim:whoami 看归属);
//     确实要换端口请 `--port <p>` 显式指定(你需自行把模拟器里的 app 指过去,如 dev menu)。
//
// 用法(仓库根):
//   pnpm mobile:sim:start                 # Global，起在 8081(app 默认连这个)
//   pnpm mobile:sim:start -- --region=cn  # 中国大陆版
//   pnpm mobile:sim:start -- --port 8082   # 显式换端口(透传给 expo;需自行把 app 指过去)

import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { ensureMobileEnv, formatMobileEnvStatus } from './ensure-mobile-env.mjs';
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from './lib/mobile-dev-region.mjs';
import { extractSimMetroPortArgs } from './lib/sim-whoami.mjs';
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from './lib/mobile-local-config.mjs';
import {
  cwdOfPid,
  gitSourceIdentity,
  gitSourceOfPid,
  isInside,
  listenerPid,
  portInUse,
} from './sim-metro.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');
const DEFAULT_PORT = 8081;
const { region, passthrough: regionPassthrough } = extractMobileDevRegionArgs(process.argv.slice(2));
const portArgs = extractSimMetroPortArgs(regionPassthrough, DEFAULT_PORT);
const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
const localConfigStatus = formatMobileLocalConfigStatus(localConfigResult, worktreeRoot);
if (localConfigStatus) console.log(localConfigStatus);
const buildEnv = withLocalMobileRegionConfig(
  mobileClientBundleEnv({ authRegion: region }),
);

const envResult = ensureMobileEnv({ mobileDir, authRegion: region, endpointEnv: buildEnv });
console.log(formatMobileEnvStatus(envResult, worktreeRoot));
const envChanged = envResult.created || envResult.addedKeys.length > 0;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: mobileDir, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const branch = git(['branch', '--show-current']) || git(['rev-parse', '--short', 'HEAD']);
const commit = git(['rev-parse', '--short', 'HEAD']);
const sourceIdentity = gitSourceIdentity(worktreeRoot);
const hasExplicitPort = portArgs.explicit;

// 未显式指定端口时,坚持 8081(app 默认连这个),并按归属决定起 / 提示 / 拒绝。
const args = ['exec', 'expo', 'start', '--dev-client', ...portArgs.passthrough];
if (!hasExplicitPort) {
  if (await portInUse(DEFAULT_PORT)) {
    const pid = listenerPid(DEFAULT_PORT);
    const cwd = pid ? cwdOfPid(pid) : null;
    if (cwd && isInside(worktreeRoot, cwd)) {
      // 是本 worktree 的 Metro —— 但还要确认它注入了**当前分支**的 git env,否则 build label branch
      // 会是旧值/unknown(如手动 `expo start` 起的、或起好后切过分支),"已在跑"就成了假证据。
      const runningSource = pid ? gitSourceOfPid(pid) : null;
      if (runningSource && runningSource === sourceIdentity) {
        if (envChanged) {
          console.error('✗ 已补/改 apps/mobile/.env,但 8081 上的 Metro 是用旧 env 启动的(env 在 bundle 时注入)。');
          console.error('  请先停掉它再 `pnpm mobile:sim:start`,新 env 才会生效。');
          process.exit(1);
        }
        console.log(`✓ Metro 已在 ${DEFAULT_PORT} 运行(本 worktree,源码指纹 ${sourceIdentity})。改 JS 直接 Fast Refresh,无需重开。`);
        process.exit(0);
      }
      console.error(`✗ ${DEFAULT_PORT} 上是本 worktree 的 Metro,但源码指纹已过期(运行中=${runningSource || '(无)'} ≠ 当前=${sourceIdentity})。`);
      console.error('  这通常表示 Metro 启动后又 amend/rebase/reset/改过文件。先停掉它再 `pnpm mobile:sim:start` 重起。');
      process.exit(1);
    }
    console.error(`✗ 端口 ${DEFAULT_PORT} 被另一个 worktree 占用:${cwd || '(未知进程)'}`);
    console.error(`  本 app 无 expo-dev-client、只会连默认 ${DEFAULT_PORT};起在别的端口 app 也连不过去。`);
    console.error(`  先停掉那个 Metro(\`pnpm mobile:sim:whoami\` 看各端口归属)再跑;`);
    console.error('  或 `pnpm mobile:sim:start -- --port <p>` 显式换端口(需自行把模拟器 app 指过去)。');
    process.exit(1);
  }
}
// 统一规范化成 Expo 明确支持的 `--port <n>`，避免 `--port=<n>` 被本工具识别、
// 却在端口归属检查和启动参数之间产生分歧。
args.push('--port', String(portArgs.port));

console.log(`› sim:start — region=${region} source=${sourceIdentity}`);
const portArgIdx = args.indexOf('--port');
if (portArgIdx >= 0) console.log(`  Metro 端口:${args[portArgIdx + 1]}(模拟器 build label 会显示 host:port,确认没连错分支)`);
console.log('  注入 EXPO_PUBLIC_XDT_GIT_SOURCE / EXPO_PUBLIC_XDT_GIT_BRANCH / EXPO_PUBLIC_XDT_GIT_COMMIT 给 __DEV__ build label\n');

// 用 `pnpm exec expo`:pnpm 不在 apps/mobile/node_modules/.bin 放 expo bin,但 pnpm exec
// 能按包依赖解析到 expo CLI(直接 node node_modules/.bin/expo 会 MODULE_NOT_FOUND)。
const child = spawn('pnpm', args, {
  cwd: mobileDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...buildEnv,
    EXPO_PUBLIC_XDT_GIT_BRANCH: branch,
    EXPO_PUBLIC_XDT_GIT_COMMIT: commit,
    EXPO_PUBLIC_XDT_GIT_SOURCE: sourceIdentity,
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
