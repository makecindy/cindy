#!/usr/bin/env node
// 编译并启动灵动岛角色动画预览窗口:
//   pnpm --filter desktop preview:island-mascots
// 窗口里按「角色 × 动画状态」铺网格, 角色列表取自 helper 里的
// AgentIslandMascotCatalog.skins, 新增角色后无需改本脚本。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(HERE, '..');
const ASSET_DIR = path.join(DESKTOP_DIR, 'native', 'agent-island');
const SOURCE = path.join(ASSET_DIR, 'macos-agent-island-helper.swift');

if (process.platform !== 'darwin') {
  console.error('[island-preview] 灵动岛 helper 只在 macOS 上可编译运行。');
  process.exit(1);
}

if (!existsSync(SOURCE)) {
  console.error(`[island-preview] 找不到源码: ${SOURCE}`);
  process.exit(1);
}

const outDir = path.join(tmpdir(), 'xdt-agent-island-preview');
mkdirSync(outDir, { recursive: true });
const binary = path.join(outDir, 'xdt-macos-agent-island-mascot-preview');

// 与 build.sh 一致: 即使 xcode-select 指向 CLT, 也优先用 Xcode 工具链。
const env = { ...process.env };
if (existsSync('/Applications/Xcode.app/Contents/Developer')) {
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
}

console.log('[island-preview] 编译 helper...');
const build = spawnSync('swiftc', [SOURCE, '-O', '-o', binary], {
  stdio: 'inherit',
  env,
});
if (build.error) {
  console.error(`[island-preview] 无法执行 swiftc: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error('[island-preview] 编译失败, 见上方 swiftc 输出。');
  process.exit(build.status ?? 1);
}

console.log('[island-preview] 启动预览窗口 (关窗即退出)...');
// 预览模式走命令行参数而不是环境变量：主进程 spawn helper 时会继承 process.env，
// 用环境变量当开关会让「用户 shell 里恰好设了它」污染产品运行路径。
const child = spawn(binary, ['--mascot-preview'], {
  stdio: 'inherit',
  env: {
    ...env,
    XDT_AGENT_ISLAND_ASSET_DIR: ASSET_DIR,
  },
});
child.on('error', (error) => {
  console.error(`[island-preview] 无法启动预览进程: ${error.message}`);
  process.exit(1);
});

// Ctrl-C / kill 时把信号转发给预览窗口，否则子进程会留在后台。
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
