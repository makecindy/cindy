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
  stripDesktopDevRegionArgs,
} from '../../../scripts/shared/desktop-dev-region.mjs';
import { withDesktopDevNodeOptions } from '../../../scripts/shared/desktop-dev-node-options.mjs';

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/dev-remote-env.mjs <command> [args...]');
  process.exit(2);
}

const startupConfig = applyDesktopDevStartupConfig({ argv: rawArgs, mode: 'remote' });
const args = stripDesktopDevRegionArgs(rawArgs);
const env = withDesktopDevNodeOptions({
  ...process.env,
  XDT_DESKTOP_DEV_MODE: 'remote',
  VITE_CINDY_AUTH_REGION: startupConfig.region,
});
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
