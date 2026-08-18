#!/usr/bin/env node
/**
 * dev-remote-env.mjs — dev:remote / dev:inspect 的构建身份注入包装。
 *
 * 2026-07 端点清单重构后,运行期业务端点全部来自启动时解析的端点清单
 * (restart 按 --region 读仓内 config/endpoint*.json,--endpoints-cdn 走对应区域
 * 线上 CDN),本包装
 * 不再注入任何端点 URL;剩余职责是「remote 模式不读 apps/desktop/.env」的
 * 构建身份注入只剩 VITE_CINDY_AUTH_REGION(强制覆盖,不吃 .env 同名变量)。
 *
 * 用法:node scripts/dev-remote-env.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';

import {
  applyDesktopDevStartupConfig,
  clearInheritedIsolationOverrides,
  resolveWorktreeIsolationFromCwd,
  stripDesktopDevRegionArgs,
} from '../../../scripts/shared/desktop-dev-region.mjs';

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/dev-remote-env.mjs <command> [args...]');
  process.exit(2);
}

const startupConfig = applyDesktopDevStartupConfig({ argv: rawArgs, mode: 'remote' });
const args = stripDesktopDevRegionArgs(rawArgs);
const env = {
  ...process.env,
  XDT_DESKTOP_DEV_MODE: 'remote',
  VITE_CINDY_AUTH_REGION: startupConfig.region,
};

// XDT_RESTART_MANAGED 是 restart 链路的一跳（one-hop）启动标记：只在判定「本进程
// 是不是 restart 拉起的」时有意义。**判定必须用含标记的环境**——restart 链路靠它
// 识别「受 restart 管理」而免于自动隔离（无参=共库+正常调度契约）；进入 Electron 后
// 该标记会被 agent 进程继承，导致 agent 在 worktree 跑裸 dev:remote 时误判「受 restart
// 管理」而禁用自动隔离（review-pr P1/P2, PR #2640）——因此判定完成后从传给 Electron
// 的 env 删除标记，只用于本次启动判定。
const worktreeIsolation = resolveWorktreeIsolationFromCwd({
  argv: rawArgs,
  env: process.env,
});
delete env.XDT_RESTART_MANAGED;

// 内置 worktree 会话里的裸 dev 启动默认按隔离沙箱处理（issue #2635）：worktree 内
// 不带 --isolated 裸启动会沿用区域默认 profile + 物理机 deviceId，dev 登录会把同机
// release 的服务端 refresh token 顶掉、把 release 挤下线。显式传了 --isolated /
// --passive（或已设 XDT_ISOLATED=1 / XDT_USER_DATA_DIR）时不干预；baseRepo 直跑保持
// 既有共库语义。restart 链路经 XDT_RESTART_MANAGED / XDT_SCHEDULER_PASSIVE 识别。
// 注意 --preserve-running 不在豁免清单：裸路径上 Electron 侧不认这个参数（只有
// restart 会翻译成 XDT_SCHEDULER_PASSIVE=1），豁免它会共享 userData 却正常调度 +
// 正常单实例锁（review-pr P1, PR #2640）。
if (worktreeIsolation) {
  // 清除继承自宿主（--isolated Desktop → agent 子进程）的启动覆写：XDT_USER_DATA_DIR
  // / XDT_USER_DATA_DIR_EPOCH / XDT_DEVICE_ID_OVERRIDE 残留会让 resolveDevCliFlags
  // 优先采用宿主 userData、且因已有 device override 不派生新身份，覆盖掉这里注入的
  // worktree 沙箱语义（review-pr P1, PR #2640）。清除后沙箱目录与独立 deviceId 由
  // 注入的 XDT_ISOLATED / XDT_ISOLATED_NAME 正常派生。
  Object.assign(env, clearInheritedIsolationOverrides(env));
  env.XDT_ISOLATED = '1';
  if (worktreeIsolation.worktreeName) {
    env.XDT_ISOLATED_NAME = worktreeIsolation.worktreeName;
  }
  console.log(
    `[dev-remote-env] managed worktree detected → isolated sandbox` +
      (worktreeIsolation.worktreeName
        ? ` "${worktreeIsolation.worktreeName}"`
        : ' (default)') +
      ' (独立 userData / 登录态 / 设备身份，不影响正式版)',
  );
}
const isWindows = process.platform === 'win32';

// Windows 下 electron-forge 等 .cmd shim 需要经 shell 解析;shell 模式下 Node 不转义
// args 数组(DEP0190),这里自行做最小引号处理(实际参数均为简单 token,含空格时兜底)。
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
const child = isWindows
  ? spawn([command, ...args].map(quote).join(' '), { stdio: 'inherit', env, shell: true })
  : spawn(command, args, { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`[dev-remote-env] failed to launch ${command}: ${err.message}`);
  process.exit(1);
});
