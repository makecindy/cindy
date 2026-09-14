#!/usr/bin/env node
/**
 * ensure-dev-runtime-assets — make sure the current platform's dev runtime
 * binaries are in place before desktop dev starts. Hybrid sourcing:
 *
 *   - Desktop runtime binaries (claude / codex / ripgrep / pi): NOT in git/LFS anymore.
 *     Downloaded on demand from upstream (pinned version in tools/<kind>/latest.json)
 *     via ensure-agent-binaries.mjs into apps/<kind>-bin/<platform>/.
 *   - sqlite-vec native extension: still Git-LFS managed. The repo uses
 *     `lfs.fetchexclude=*` so it can remain a 134-byte LFS pointer after a plain
 *     `git pull`; this guard fetches/checks out only the current platform's file.
 *
 * Without this, Electron fails much later with `spawn ENOEXEC` (missing CLI) or
 * `no such module: vec0` (pointer-only sqlite-vec).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ensureBinary,
  currentPlatformKey,
  SUPPORTED_BINARY_KINDS,
  updateScriptForKind,
} from './ensure-agent-binaries.mjs';
import { fixNodePtyExecutables } from './fix-node-pty-perms.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
const MIN_EXPECTED_BYTES = 1024;

const log = (msg) => console.log(`\x1b[36m[ensure-dev-runtime-assets]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[ensure-dev-runtime-assets]\x1b[0m ${msg}`);
const err = (msg) => console.error(`\x1b[31m[ensure-dev-runtime-assets]\x1b[0m ${msg}`);

// Desktop runtime 二进制走上游按需下载（不再 LFS）。直接复用
// ensure-agent-binaries 的 kind 真源，保证新 clone / worktree 首次启动 dev
// 时会自动准备 Pi，与 Claude Code / Codex 一致。
const AGENT_KINDS = SUPPORTED_BINARY_KINDS;

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function sqliteVecName() {
  if (process.platform === 'win32') return 'vec0.dll';
  if (process.platform === 'linux') return 'vec0.so';
  return 'vec0.dylib';
}

// 仍由 Git LFS 管理、需要校验/拉取的资产（当前只剩 sqlite-vec）
function requiredLfsAssets() {
  const platform = platformKey();
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
    return [];
  }

  return [
    {
      label: 'sqlite-vec native extension',
      relPath: path.posix.join('apps', 'desktop', 'native', 'sqlite-vec', platform, sqliteVecName()),
    },
  ];
}

function readPrefix(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function assetStatus(asset) {
  const absPath = path.join(ROOT, asset.relPath);
  if (!fs.existsSync(absPath)) {
    return { ...asset, absPath, ok: false, reason: 'missing' };
  }

  const stat = fs.statSync(absPath);
  const prefix = readPrefix(absPath);
  if (prefix.startsWith(LFS_POINTER_HEADER)) {
    return { ...asset, absPath, ok: false, reason: 'lfs-pointer' };
  }

  if (stat.size < MIN_EXPECTED_BYTES) {
    return { ...asset, absPath, ok: false, reason: `too-small:${stat.size}` };
  }

  return { ...asset, absPath, ok: true, reason: 'ok' };
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      COREPACK_ENABLE: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    },
  });
}

function ensureGitLfsAvailable() {
  const result = spawnSync('git', ['lfs', 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return;

  err('git-lfs 不可用，无法自动恢复 Dev 运行资产。');
  err('请先安装 git-lfs 并完成认证，然后重新运行 Dev 启动命令。');
  process.exit(1);
}

function fetchAndCheckout(paths) {
  ensureGitLfsAvailable();

  const include = paths.join(',');
  log(`检测到 ${paths.length} 个 LFS 运行资产缺失或仍是 pointer，开始拉取当前平台文件...`);

  const fetch = run('git', [
    '-c',
    'lfs.fetchexclude=',
    'lfs',
    'fetch',
    'origin',
    `--include=${include}`,
    '--exclude=',
  ]);
  if (fetch.status !== 0) {
    err('git lfs fetch 失败。请检查 GitLab LFS 权限 / 网络 / SSH 认证。');
    process.exit(fetch.status ?? 1);
  }

  const checkout = run('git', ['lfs', 'checkout', ...paths]);
  if (checkout.status !== 0) {
    err('git lfs checkout 失败。请检查工作区文件权限。');
    process.exit(checkout.status ?? 1);
  }
}

// ① agent CLI 二进制：上游按需下载（缺失才下，已存在跳过）
async function ensureAgentBinaries() {
  const platform = currentPlatformKey();
  for (const kind of AGENT_KINDS) {
    try {
      await ensureBinary(kind, platform);
    } catch (e) {
      err(`无法准备 ${kind} 的 dev 二进制（${platform}）：${e.message}`);
      err(`请检查网络 / 上游可用性，或手动运行 "pnpm update:${updateScriptForKind(kind)}"。`);
      process.exit(1);
    }
  }
}

// ② sqlite-vec：仍走 Git LFS fetch/checkout
function ensureLfsAssets() {
  const assets = requiredLfsAssets();
  if (assets.length === 0) {
    warn(`当前平台 ${platformKey()} 没有定义 desktop dev runtime LFS 资产，跳过检查。`);
    return;
  }

  let statuses = assets.map(assetStatus);
  const broken = statuses.filter((item) => !item.ok);
  if (broken.length > 0) {
    for (const item of broken) {
      warn(`${item.label}: ${item.relPath} (${item.reason})`);
    }
    fetchAndCheckout(broken.map((item) => item.relPath));
    statuses = assets.map(assetStatus);
  }

  const stillBroken = statuses.filter((item) => !item.ok);
  if (stillBroken.length > 0) {
    err('Dev 运行资产仍不可用：');
    for (const item of stillBroken) {
      err(`- ${item.label}: ${item.relPath} (${item.reason})`);
    }
    err('请不要继续启动 Dev，否则可能在运行时遇到 no such module: vec0。');
    process.exit(1);
  }
}

async function main() {
  await ensureAgentBinaries();
  ensureLfsAssets();
  // node-pty 的 spawn-helper 可执行位可能被 pnpm install 剥掉（终端面板会因此报
  // posix_spawnp failed）。best-effort 补回，never throw，不阻断 dev 启动。
  fixNodePtyExecutables({ quiet: true });
  log(`当前平台 ${platformKey()} 的 Dev 运行资产正常。`);
}

main().catch((e) => {
  err(e.message ?? String(e));
  process.exit(1);
});
