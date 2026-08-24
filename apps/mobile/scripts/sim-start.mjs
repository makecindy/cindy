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
//   - 8081 被**别的 worktree** 占 → 默认明确报错;传 `--takeover` 时仅在确认占用者是
//     Cindy Metro(cwd 以 /apps/mobile 结尾 + 注入了源码指纹)后停止它。不要求对方
//     磁盘上的 git 指纹仍与启动时一致;对方目录已删则视为孤儿 Metro,同样可接管。
//     未知进程 / 非 Metro 即使带 `--takeover` 也 fail closed。
//     确实要换端口请 `--port <p>` 显式指定(你需自行把模拟器里的 app 指过去,如 dev menu)。
//
// 用法(仓库根):
//   pnpm mobile:sim:start                 # Global，起在 8081(app 默认连这个)
//   pnpm mobile:sim:start -- --region=cn  # 中国大陆版
//   pnpm mobile:sim:start -- --region=cn --takeover # 显式接管另一个 Metro
//   pnpm mobile:sim:start -- --port 8082   # 显式换端口(透传给 expo;需自行把 app 指过去)

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { ensureMobileEnv, formatMobileEnvStatus } from './ensure-mobile-env.mjs';
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from './lib/mobile-dev-region.mjs';
import {
  classifySimMetroListener,
  extractSimMetroPortArgs,
  extractSimTakeoverArgs,
  resolveSimMetroHandoff,
} from './lib/sim-whoami.mjs';
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from './lib/mobile-local-config.mjs';
import {
  cwdOfPid,
  gitSourceIdentity,
  gitSourceOfPid,
  isMetroPid,
  listenerPid,
  portInUse,
  terminateMetro,
} from './sim-metro.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');
const DEFAULT_PORT = 8081;
const { region, passthrough: regionPassthrough } = extractMobileDevRegionArgs(process.argv.slice(2));
const { takeover, passthrough: takeoverPassthrough } = extractSimTakeoverArgs(regionPassthrough);
const portArgs = extractSimMetroPortArgs(takeoverPassthrough, DEFAULT_PORT);
if (takeover && portArgs.explicit) {
  console.error(`✗ --takeover 只用于隐式默认端口 ${DEFAULT_PORT},不能和显式 --port 混用。`);
  process.exit(1);
}
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

// 默认端口始终执行身份闸门;显式其它端口由开发者自行把 App 指过去。
const args = ['exec', 'expo', 'start', '--dev-client', ...portArgs.passthrough];
if (portArgs.port === DEFAULT_PORT) {
  if (await portInUse(DEFAULT_PORT)) {
    const pid = listenerPid(DEFAULT_PORT);
    const cwd = pid ? cwdOfPid(pid) : null;
    const runningSource = pid ? gitSourceOfPid(pid) : null;
    const listener = classifySimMetroListener({
      cwd,
      source: runningSource,
      targetWorktree: worktreeRoot,
    });
    const listenerWorktreeExists = Boolean(listener.worktree && existsSync(listener.worktree));
    const decision = resolveSimMetroHandoff({
      port: DEFAULT_PORT,
      cwd,
      takeover,
      envChanged,
      currentSource: sourceIdentity,
      runningSource,
      listener,
      listenerWorktreeExists,
    });
    if (decision.action === 'reuse') {
      for (const line of decision.lines) console.log(line);
      process.exit(0);
    }
    if (decision.action === 'refuse') {
      for (const line of decision.lines) console.error(line);
      process.exit(1);
    }

    if (!pid || !isMetroPid(pid)) {
      console.error(`✗ ${DEFAULT_PORT} 上的进程不是可确认的 Metro,拒绝接管。`);
      process.exit(1);
    }
    const stopped = await terminateMetro(pid, { worktreeRoot: listener.worktree });
    if (!stopped) {
      console.error(`✗ 无法在限定时间内停止旧 Metro(pid=${pid}),拒绝继续。`);
      process.exit(1);
    }
    if (decision.code === 'occupied-orphan') {
      console.log(`✓ 已停止已删除 worktree 的孤儿 Metro(pid=${pid}, cwd=${cwd})。`);
    } else if (listener.isTarget) {
      console.log(`✓ 已重启当前 worktree 的 Metro(pid=${pid}, cwd=${cwd})。`);
    } else {
      console.log(`✓ 已接管其他 Cindy worktree 的 Metro(pid=${pid}, cwd=${cwd})。`);
    }
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
