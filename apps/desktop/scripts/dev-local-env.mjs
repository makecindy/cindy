#!/usr/bin/env node
/**
 * dev-local-env.mjs — dev(local 模式)的端点清单包装。
 *
 * 生成 config/endpoint.local.json(api/auth/device-link 指 localhost,其余抄
 * 所选 region 正本;见 scripts/shared/endpoint-local-file.mjs)并经
 * XDT_ENDPOINT_MANIFEST_FILE 指给主进程(clientEndpointsService file 模式)。
 * 已显式设置 XDT_ENDPOINT_MANIFEST_FILE 时尊重用户值,不生成不覆盖。
 *
 * 用法:node scripts/dev-local-env.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyDesktopDevStartupConfig,
  stripDesktopDevRegionArgs,
} from '../../../scripts/shared/desktop-dev-region.mjs';
import { generateEndpointLocalFile } from '../../../scripts/shared/endpoint-local-file.mjs';

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/dev-local-env.mjs <command> [args...]');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env = { ...process.env, XDT_DESKTOP_DEV_MODE: 'local' };
const startupConfig = applyDesktopDevStartupConfig({ argv: rawArgs, env, mode: 'local' });
const args = stripDesktopDevRegionArgs(rawArgs);
if (!env.XDT_ENDPOINT_MANIFEST_FILE?.trim()) {
  env.XDT_ENDPOINT_MANIFEST_FILE = generateEndpointLocalFile({
    repoRoot,
    region: startupConfig.region,
  });
  console.log(`[dev-local-env] endpoint manifest → ${env.XDT_ENDPOINT_MANIFEST_FILE}`);
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
  console.error(`[dev-local-env] failed to launch ${command}: ${err.message}`);
  process.exit(1);
});
