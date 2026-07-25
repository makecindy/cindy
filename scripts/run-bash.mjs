#!/usr/bin/env node
/**
 * run-bash — 跨平台 bash 启动器
 *
 * 背景：pnpm 在 Windows 上用 cmd.exe 执行 npm script，`bash xxx.sh` 会被解析到
 * C:\Windows\System32\bash.exe（WSL 入口）。未安装 WSL 发行版的机器上直接报
 * "适用于 Linux 的 Windows 子系统没有已安装的分发"。本脚本在 Windows 上定位
 * Git Bash（git for windows 必装，仓库 clone 即依赖它），macOS / Linux 直接用
 * 系统 bash，让 `pnpm release:server` 等脚本两端行为一致。
 *
 * 用法：node scripts/run-bash.mjs <script.sh> [args...]（cwd 即脚本所在包目录）
 */
import { spawnSync } from 'node:child_process';
import { resolvePosixShell } from './lib/posix-shell.mjs';

const err = (msg) => console.error(`\x1b[31m[run-bash]\x1b[0m ${msg}`);

const [, , script, ...args] = process.argv;
if (!script) {
  err('usage: node scripts/run-bash.mjs <script.sh> [args...]');
  process.exit(1);
}

const bash = resolvePosixShell('bash');
if (!bash) {
  err('未找到 Git Bash（bin\\bash.exe）。请安装 Git for Windows: https://git-scm.com/download/win');
  process.exit(1);
}

const result = spawnSync(bash, [script, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
