#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDesktopDevStartupConfig,
  DESKTOP_DEV_REGIONS,
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const gracefulTimeoutMs = 3000;
const forceTimeoutMs = 5000;
const pollIntervalMs = 150;
const startupReadyTimeoutMs = 120_000;
const forceKillLabel = process.platform === 'win32' ? 'taskkill /F /T' : 'kill -9';
const desktopDevCacheRelativeDirs = Object.freeze([
  path.join('apps', 'desktop', 'node_modules', '.vite'),
  path.join('apps', 'desktop', '.vite'),
]);

/**
 * 产品默认 userData 目录基名。⚠️ 值必须与
 * packages/maker-shared/src/brandIdentity.ts 的 BRAND_IDENTITY.userDataDirName
 * 一致——.mjs 无法 import TS 单点,只能镜像字面量;
 * 一致性由 scripts/__tests__/brand-identity-sync.test.mjs 断言兜底。
 */
export const BRAND_USER_DATA_DIR_NAME = 'Cindy';

// 桌面端 .env 默认值。2026-07 端点清单重构后 .env 不再承载任何端点 URL
// (运行期端点全部来自清单:remote restart 按 region 读 config/endpoint*.json,
// local 模式读生成的 config/endpoint.local.json,--endpoints-cdn 走线上 CDN),这里只
// 保留 region 身份。飞书登录构建变量已退役,不再创建或补写。
function desktopEnvSpec() {
  return [{ key: 'VITE_CINDY_AUTH_REGION', value: 'global', force: false }];
}
const closeDarwinTerminalTtyScript = Object.freeze([
  'on closeMatchingTerminalTab(targetTty)',
  'tell application "Terminal"',
  'repeat with terminalWindow in windows',
  'repeat with terminalTab in tabs of terminalWindow',
  'if (tty of terminalTab) is targetTty then',
  'try',
  'if busy of terminalTab is false then do script "exit" in terminalTab',
  'end try',
  'delay 1',
  'try',
  'if not (exists terminalWindow) then return',
  'if not (exists terminalTab) then return',
  'if (count of tabs of terminalWindow) is 1 then',
  'close terminalWindow',
  'else',
  'close terminalTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'end closeMatchingTerminalTab',
  'on run argv',
  'my closeMatchingTerminalTab(item 1 of argv)',
  'end run',
]);
const launchDarwinTerminalScript = Object.freeze([
  'on run argv',
  'set devCommand to item 1 of argv',
  'tell application "Terminal"',
  'set targetTab to do script devCommand',
  'set targetWindow to front window',
  'activate',
  'end tell',
  'repeat',
  'delay 1',
  'tell application "Terminal"',
  'if not (exists targetWindow) then return',
  'if not (exists targetTab) then return',
  'if busy of targetTab is false then',
  'try',
  'if (count of tabs of targetWindow) is 1 then',
  'close targetWindow',
  'else',
  'close targetTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end tell',
  'end repeat',
  'end run',
]);

function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

export function commandContainsPath(command, candidatePath) {
  const normalizedCommand = normalize(command);
  const normalizedPath = stripTrailingSlashes(normalize(candidatePath));
  if (!normalizedPath) return false;
  let index = normalizedCommand.indexOf(normalizedPath);
  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPath.length];
    const hasStartBoundary = before === undefined || /\s|["'=]/.test(before);
    // 命令行字符串无法安全区分裸 root 参数后接参数，和带空格的 sibling 路径。
    // kill 旧进程宁可漏杀也不能误杀其它 checkout，所以这里不把空格当结束边界。
    const hasEndBoundary = after === undefined || after === '/' || after === '"' || after === "'";
    if (hasStartBoundary && hasEndBoundary) return true;
    index = normalizedCommand.indexOf(normalizedPath, index + 1);
  }
  return false;
}

/**
 * 判断进程命令行是否带 `--user-data-dir=<userDataDir>`(Electron helper 进程携带)。
 * 结束边界必须是行尾 / 空白 / 引号 / 斜杠 —— `Cindy-dev` 不得命中
 * `Cindy-dev-pi-latest` 这类前缀同名沙箱。路径本身可含空格(macOS 的
 * "Application Support"),所以整段 needle 精确匹配、只对尾部做边界判定。
 */
export function commandUsesUserDataDir(command, userDataDir) {
  const normalizedCommand = normalize(command);
  const normalizedDir = stripTrailingSlashes(normalize(userDataDir));
  if (!normalizedDir) return false;
  // 值可能带引号(Windows 常见: --user-data-dir="C:\..."), 裸值与引号包裹
  // 两种形态都要命中, 否则冲突检测漏判会放行进共享 SQLite/登录态。
  const needles = [
    `--user-data-dir=${normalizedDir}`,
    `--user-data-dir="${normalizedDir}`,
    `--user-data-dir='${normalizedDir}`,
  ];
  for (const needle of needles) {
    let index = normalizedCommand.indexOf(needle);
    while (index !== -1) {
      const after = normalizedCommand[index + needle.length];
      if (after === undefined || after === '/' || after === '"' || after === "'" || /\s/.test(after)) {
        return true;
      }
      index = normalizedCommand.indexOf(needle, index + 1);
    }
  }
  return false;
}

/**
 * 重启的 kill 作用域:只收当前 checkout(ownRootDir)自己的 dev 进程。其他
 * worktree / 命名沙箱一律保留 ——「重启」的语义是重启这份 checkout 的实例,
 * 不是清场(2026-07-30 约束:PI 沙箱启动器曾全灭掉并行的 tgbot-review 沙箱)。
 */
export function partitionDesktopDevProcesses(processes, ownRootDir) {
  const targets = [];
  const preserved = [];
  for (const proc of processes) {
    (commandContainsPath(proc.command, ownRootDir) ? targets : preserved).push(proc);
  }
  return { targets, preserved };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function ensureDesktopEnv() {
  const envPath = path.join(rootDir, 'apps', 'desktop', '.env');
  const examplePath = path.join(rootDir, 'apps', 'desktop', '.env.example');
  let content = '';
  let created = false;

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    created = true;
    content = fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, 'utf8')
      : '';
  }

  for (const { key, value, force } of desktopEnvSpec(content)) {
    content = upsertEnvValue(content, key, value, { overwrite: created || force });
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);

  if (created) {
    console.log(`==> Created desktop env: ${path.relative(rootDir, envPath)}`);
  } else {
    console.log(`==> Checked desktop env: ${path.relative(rootDir, envPath)}`);
  }
}

function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, 'm');
  return content.match(pattern)?.[1]?.trim() ?? '';
}

function upsertEnvValue(content, key, value, options = {}) {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = line.slice(line.indexOf('=') + 1).trim();
    return current && !options.overwrite ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function desktopDevCacheDirs(root = rootDir) {
  return desktopDevCacheRelativeDirs.map((entry) => path.join(root, entry));
}

function assertDesktopDevCachePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const allowedTargets = new Set(desktopDevCacheDirs(resolvedRoot).map((entry) => path.resolve(entry)));
  if (!allowedTargets.has(resolvedTarget)) {
    throw new Error(`Refusing to remove unexpected desktop dev cache path: ${resolvedTarget}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove desktop dev cache outside repository: ${resolvedTarget}`);
  }
}

export function clearDesktopDevCaches(root = rootDir, { logger = console } = {}) {
  const removed = [];
  for (const cacheDir of desktopDevCacheDirs(root)) {
    assertDesktopDevCachePath(root, cacheDir);
    if (!fs.existsSync(cacheDir)) continue;
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed.push(cacheDir);
  }

  if (removed.length > 0) {
    logger.log(
      `==> Cleared desktop dev cache: ${removed.map((entry) => path.relative(root, entry)).join(', ')}`,
    );
  } else {
    logger.log('==> Desktop dev cache already clean.');
  }
  return removed;
}

function listWindowsProcesses() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
  const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId) || 0,
      command: String(item.CommandLine ?? ''),
    }));
  } catch {
    return [];
  }
}

function listPosixProcesses() {
  const result = run('ps', ['-eo', 'pid=,ppid=,tty=,command=']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]) || 0,
        tty: match[3],
        command: match[4],
      };
    })
    .filter(Boolean);
}

export function parseWorktreePaths(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

function repositoryWorktreePaths() {
  const result = run('git', ['worktree', 'list', '--porcelain'], { cwd: rootDir });
  if (result.status !== 0) return [rootDir];
  const worktrees = parseWorktreePaths(result.stdout);
  return worktrees.length > 0 ? worktrees : [rootDir];
}

function hasRepositoryCheckoutPath(command, checkoutPaths = repositoryWorktreePaths()) {
  return checkoutPaths.some((checkoutPath) => commandContainsPath(command, checkoutPath));
}

// 沿 ppid 链向上找祖先里有没有 Cindy desktop dev 进程。
// 用途：拦住"agent 跑在 Cindy desktop dev 进程内还调 restart"这种自杀场景——
// 一旦 taskkill /T 走到祖先 dev 进程，整棵树（包括正在跑的本脚本）都会被收掉，
// 新 cmd 要么没机会起、要么撞上未释放的端口/文件锁，结果是看不懂的 ELIFECYCLE。
// 检测到就直接 exit 1 + 清晰提示，让 agent 把控制权交回给开发者。
function findDevAncestor() {
  const processes = process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const checkoutPaths = repositoryWorktreePaths();
  let cursor = byPid.get(process.pid)?.ppid ?? 0;
  for (let i = 0; cursor && i < 64; i += 1) {
    const ancestor = byPid.get(cursor);
    if (!ancestor) break;
    const command = normalize(ancestor.command);
    if (
      !command.includes('apps/claude-code-bin') &&
      !command.includes('apps/codex-bin') &&
      hasRepositoryCheckoutPath(command, checkoutPaths) &&
      hasDesktopDevSignature(command)
    ) {
      return ancestor;
    }
    cursor = ancestor.ppid;
  }
  return null;
}

function hasDesktopDevSignature(command) {
  return (
    command.includes('electron-forge') ||
    command.includes('@electron-forge') ||
    command.includes('dev:desktop') ||
    command.includes('pnpm --filter desktop dev') ||
    command.includes('/node_modules/electron/') ||
    (command.includes('/apps/desktop/') && (
      command.includes('vite.main.config') ||
      command.includes('vite.renderer.config') ||
      command.includes('vite.preload.config') ||
      command.includes('--app-path=')
    ))
  );
}

export function isRepositoryDesktopDevProcess(proc, checkoutPaths, currentPid = process.pid) {
  if (!proc.pid || proc.pid === currentPid) return false;
  const command = normalize(proc.command);
  if (command.includes('apps/claude-code-bin') || command.includes('apps/codex-bin')) return false;

  return hasRepositoryCheckoutPath(command, checkoutPaths) && hasDesktopDevSignature(command);
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    return run('taskkill.exe', ['/F', '/T', '/PID', String(pid)]).status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

function forceKillProcess(pid) {
  if (process.platform === 'win32') {
    return killProcess(pid);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listDesktopDevProcesses() {
  const processes = process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  const checkoutPaths = repositoryWorktreePaths();
  return processes.filter((proc) => isRepositoryDesktopDevProcess(proc, checkoutPaths));
}

async function waitForDesktopDevProcessesToExit(timeoutMs, filter = () => true) {
  const deadline = Date.now() + timeoutMs;
  let remaining = listDesktopDevProcesses().filter(filter);

  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    remaining = listDesktopDevProcesses().filter(filter);
  }

  return remaining;
}

function hasInteractiveTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdDoubleQuote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function osascriptCloseDarwinTerminalTtyArgs(ttyPath) {
  return closeDarwinTerminalTtyScript
    .flatMap((line) => ['-e', line])
    .concat(ttyPath);
}

export function osascriptLaunchDarwinTerminalArgs(command) {
  return launchDarwinTerminalScript
    .flatMap((line) => ['-e', line])
    .concat(command);
}

function darwinTtyPath(tty) {
  if (!tty || tty === '??' || tty === '?') return null;
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

function darwinTerminalTtysForProcesses(processes) {
  if (process.platform !== 'darwin') return [];
  return [...new Set(processes.map((proc) => darwinTtyPath(proc.tty)).filter(Boolean))];
}

function closeDarwinTerminalTtys(ttys) {
  if (process.platform !== 'darwin' || ttys.length === 0) return;

  for (const ttyPath of ttys) {
    const result = run('osascript', osascriptCloseDarwinTerminalTtyArgs(ttyPath));
    if (result.status !== 0 && result.stderr.trim()) {
      console.warn(`==> Failed to close Terminal tab for ${ttyPath}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * --isolated 的默认独立 userData 目录:与当前区域正式目录平级、名字带 -dev2 后缀,
 * 稳定不随 checkout 变(多个 worktree 共享同一个 dev 沙箱,想再细分用命名沙箱
 * `--isolated=<名字>` 或自己设 XDT_USER_DATA_DIR 覆盖)。命名沙箱目录再追加
 * `-<名字>` 后缀,每个名字一条完全独立的沙箱。只在 dev 生效——主进程入口只在
 * 非 packaged 时应用该覆写。
 */
function userDataDirNamed(dirName) {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', dirName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return path.join(xdgConfig, dirName);
}

export function hasIsolationIntent(argv = [], env = process.env) {
  return argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='))
    || env.XDT_ISOLATED === '1';
}

export function officialProductionUserDataDirs() {
  return DESKTOP_DEV_REGIONS.map((region) => productionUserDataDir(region));
}

/** 与 devCliFlags ISOLATION_NAME_RE 一致：非法名字回落默认沙箱，不把路径段写进目录。 */
export const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeIsolationName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return ISOLATION_NAME_RE.test(name) ? name : '';
}

function volumeIsCaseInsensitive(existingDir) {
  let dir = existingDir;
  for (;;) {
    const parent = path.dirname(dir);
    const atRoot = parent === dir;
    if (!atRoot) {
      try {
        if (fs.statSync(parent).dev !== fs.statSync(dir).dev) return false;
      } catch {
        return false;
      }
    }
    const name = path.basename(dir);
    const flipped = name.replace(/[a-zA-Z]/g, (ch) => (
      ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
    ));
    if (flipped !== name) {
      try {
        return fs.realpathSync.native(path.join(parent, flipped))
          === fs.realpathSync.native(dir);
      } catch {
        return false;
      }
    }
    if (atRoot) return false;
    dir = parent;
  }
}

export function canonicalizeUserDataDir(dir) {
  const resolved = path.resolve(dir);
  try {
    const real = fs.realpathSync.native(resolved);
    return volumeIsCaseInsensitive(real) ? real.toLowerCase() : real;
  } catch {
    // 叶子还不存在:沿最近存在祖先做 realpath,再按该卷语义接回剩余段。
  }
  let current = resolved;
  const suffix = [];
  for (;;) {
    const parent = path.dirname(current);
    suffix.unshift(path.basename(current));
    if (parent === current) return resolved;
    current = parent;
    try {
      const ancestorReal = fs.realpathSync.native(current);
      const joined = path.join(ancestorReal, ...suffix);
      return volumeIsCaseInsensitive(ancestorReal) ? joined.toLowerCase() : joined;
    } catch {
      // 继续上溯
    }
  }
}

export function isOfficialProductionUserDataDir(dir) {
  const resolved = canonicalizeUserDataDir(dir);
  return officialProductionUserDataDirs().some(
    (official) => canonicalizeUserDataDir(official) === resolved,
  );
}

export function resolveRestartTargetUserDataDir({
  envUserDataDir,
  isolatedArg,
  isolatedEnv,
  isolatedName,
  selectedRegion,
}) {
  const isolationName = sanitizeIsolationName(
    isolatedArg ? parseIsolationName(isolatedArg) : isolatedName,
  );
  const isolated = Boolean(isolatedArg) || isolatedEnv === '1';
  return envUserDataDir
    || (isolated
      ? defaultIsolatedUserDataDir(isolationName, selectedRegion)
      : productionUserDataDir(selectedRegion));
}

export function defaultIsolatedUserDataDir(isolationName, region = 'global') {
  // 目录纪元 v2(-dev2),与 devCliFlags.ts 的派生保持一字不差:#871 起隔离沙箱用
  // CindyDev 钥匙串身份,旧 -dev 目录留给旧 checkout(#912 review)。
  const baseName = desktopUserDataDirNameForRegion(region);
  return userDataDirNamed(`${baseName}-dev2${isolationName ? `-${isolationName}` : ''}`);
}

/** 非隔离 dev 与正式版共用的 userData 目录。 */
export function productionUserDataDir(region = 'global') {
  return userDataDirNamed(desktopUserDataDirNameForRegion(region));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * --preserve-running 只有在目标 profile 的所有存活实例都明确声明同一区域时
 * 才能共享。旧记录没有 region，属于无法证明兼容，必须 fail closed。
 */
export function inspectSharedUserDataRegion(userDataDir, expectedRegion, processes = []) {
  const recordsDir = path.join(userDataDir, '.dev-instances');
  const liveRecords = [];
  try {
    for (const name of fs.readdirSync(recordsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8'));
        if (Number.isInteger(record?.pid) && isProcessAlive(record.pid)) liveRecords.push(record);
      } catch {
        // 损坏记录不能证明兼容；若确有 helper 占用，下面的 process guard 会拒绝。
      }
    }
  } catch {
    // 没有注册表时继续看进程扫描。
  }

  const incompatibleRecords = liveRecords.filter(
    (record) => record.region !== expectedRegion || typeof record.rootDir !== 'string',
  );
  if (incompatibleRecords.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has live instance record(s) with incompatible or unknown region: ` +
        incompatibleRecords
          .map(
            (record) =>
              `pid=${record.pid},region=${record.region ?? 'unknown'},` +
              `root=${record.rootDir ?? 'unknown'}`,
          )
          .join('; '),
    };
  }

  const scannedUsers = processes.filter((proc) => commandUsesUserDataDir(proc.command, userDataDir));
  const unprovenUsers = scannedUsers.filter(
    (proc) => !liveRecords.some((record) => commandContainsPath(proc.command, record.rootDir)),
  );
  if (unprovenUsers.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has active process(es) not covered by a live ` +
        `region=${expectedRegion} instance record: ` +
        unprovenUsers.map((proc) => `pid=${proc.pid}`).join(', '),
    };
  }
  return { compatible: true, reason: null };
}

function parseIsolationName(isolatedArg) {
  if (!isolatedArg || !isolatedArg.includes('=')) return '';
  return isolatedArg.slice('--isolated='.length);
}

function devScriptForMode(mode) {
  return mode === 'local' ? 'dev:desktop' : 'dev:desktop:remote';
}

function packageManagerCommand(mode) {
  const runnerPath = path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs');
  if (process.platform === 'win32') {
    return `${cmdDoubleQuote(process.execPath)} ${cmdDoubleQuote(runnerPath)} ${mode}`;
  }
  return `${shellSingleQuote(process.execPath)} ${shellSingleQuote(runnerPath)} ${shellSingleQuote(mode)}`;
}

function darwinEnvPrefix() {
  const corepackShimDir = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'shims');
  const pnpmExecPath = process.env.npm_execpath;
  const preferredPathParts = [
    pnpmExecPath ? path.dirname(pnpmExecPath) : null,
    path.dirname(process.execPath),
  ].filter(Boolean);
  // corepack shims 只能放在 "$PATH" 之后兜底:它的 pnpm 版本由 corepack 自己决定,
  // 排在用户 PATH 前面会盖掉用户自己装好的 pnpm(proto / homebrew 等),
  // corepack 默认版本漂到 pnpm 11 后就会撞本仓 engines 上限炸掉 dev 启动。
  const fallbackPathParts = [
    ...(fs.existsSync(corepackShimDir) ? [corepackShimDir] : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  return `export PATH=${shellSingleQuote([...new Set(preferredPathParts)].join(path.delimiter))}:"$PATH":${shellSingleQuote([...new Set(fallbackPathParts)].join(path.delimiter))}; `;
}

export function devEnvPrefix(env = process.env, platform = process.platform) {
  const envEntries = [
    // --region 经 CINDY_AUTH_REGION 注入 dev-remote-env / Forge / Vite，同一个值
    // 同时决定区域身份与 --endpoints-cdn 的自举 CDN 基址。
    ['CINDY_AUTH_REGION', env.CINDY_AUTH_REGION],
    ['XDT_VOICE_INPUT_RECORD', env.XDT_VOICE_INPUT_RECORD],
    // 登录 scenario harness(dev-only 状态遍历,implementation-plan Step 0):
    // XDT_LOGIN_SCENARIO 由 authManager 消费(附录 A 值域);
    // VITE_SPLASH_PHASE_FIXTURE 由 renderer useSplash fixture 读取点消费
    // (Vite 会把进程级 VITE_* 暴露进 import.meta.env,dev-only)。
    ['XDT_LOGIN_SCENARIO', env.XDT_LOGIN_SCENARIO],
    ['VITE_SPLASH_PHASE_FIXTURE', env.VITE_SPLASH_PHASE_FIXTURE],
    ['XDT_USER_DATA_DIR', env.XDT_USER_DATA_DIR],
    ['XDT_USER_DATA_DIR_EPOCH', env.XDT_USER_DATA_DIR_EPOCH],
    ['XDT_DEVICE_ID_OVERRIDE', env.XDT_DEVICE_ID_OVERRIDE],
    ['XDT_SCHEDULER_PASSIVE', env.XDT_SCHEDULER_PASSIVE],
    ['XDT_ISOLATED', env.XDT_ISOLATED],
    ['XDT_ISOLATED_NAME', env.XDT_ISOLATED_NAME],
    // 沙箱凭证隔离(--isolated-auth):不与 ~/.codex 共享 auth 硬链,auth-adapters 消费。
    ['XDT_ISOLATED_AUTH', env.XDT_ISOLATED_AUTH],
    // CDP 端口覆写(bootstrap-electron 消费): 并行多开沙箱时给后起实例换端口。
    ['XDT_CDP_PORT', env.XDT_CDP_PORT],
    ['CINDY_IOS_SIMULATOR_NATIVE_H264', env.CINDY_IOS_SIMULATOR_NATIVE_H264],
    ['CINDY_IOS_SIMULATOR_NATIVE_HID', env.CINDY_IOS_SIMULATOR_NATIVE_HID],
    ['XDT_TAPDB_DEV', env.XDT_TAPDB_DEV],
    // 端点清单来源覆写:--endpoints-cdn(dev 走线上 CDN)/ local 模式的
    // endpoint.local.json 文件路径,均由主进程 clientEndpointsService 消费。
    ['XDT_ENDPOINTS_CDN', env.XDT_ENDPOINTS_CDN],
    ['XDT_ENDPOINT_MANIFEST_FILE', env.XDT_ENDPOINT_MANIFEST_FILE],
    // 模型目录闭环调试覆写。dev 默认仍不联网；只有显式给 URL 时，主进程才允许
    // 从该地址拉取 Catalog。PATH / DISABLE 同步透传，避免 runner 吞掉已有契约。
    ['XDT_MODELS_URL', env.XDT_MODELS_URL],
    ['XDT_MODELS_PATH', env.XDT_MODELS_PATH],
    ['XDT_DISABLE_MODELS_FETCH', env.XDT_DISABLE_MODELS_FETCH],
    // 启动即自动打开 DevTools(main 的 ready-to-show 里消费;见 bootstrap-electron)。
    // 给"快捷键/菜单打不开 DevTools"的环境兜底,QA 控制台验证依赖它。
    ['OPEN_DEVTOOLS', env.OPEN_DEVTOOLS],
    // --wait-ready 的一次性状态文件：runner 写失败，Electron main ready-to-show 写成功。
    ['XDT_DESKTOP_DEV_STARTUP_STATUS_FILE', env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE],
    // 插件存储启动边界的 dev 黑盒验收：仅显式临时结果路径时启用。
    ['XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', env.XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE],
  ].filter(([, value]) => value);
  if (envEntries.length === 0) return '';

  if (platform === 'win32') {
    return envEntries
      .map(([key, value]) => `set "${key}=${String(value).replaceAll('"', '')}" && `)
      .join('');
  }

  return envEntries
    .map(([key, value]) => `${key}=${shellSingleQuote(String(value))}`)
    .join(' ') + ' ';
}

function launchInSystemTerminal(mode) {
  if (process.platform === 'win32') {
    const command = `cd /d ${cmdDoubleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}`;
    const script = [
      "Start-Process -FilePath 'cmd.exe'",
      `-ArgumentList @('/c', ${psSingleQuote(command)})`,
      `-WorkingDirectory ${psSingleQuote(rootDir)}`,
    ].join(' ');
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`==> Opened desktop ${mode} dev in a new cmd window.`);
    return;
  }

  if (process.platform === 'darwin') {
    const command = `${darwinEnvPrefix()}cd ${shellSingleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}; exitCode=$?; exit $exitCode`;
    const child = spawn('osascript', osascriptLaunchDarwinTerminalArgs(command), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (child.pid === undefined) {
      console.error('Failed to open Terminal.app');
      process.exit(1);
    }
    console.log(`==> Opened desktop ${mode} dev in a new Terminal window.`);
    return;
  }

  console.warn('==> Non-interactive terminal detected, but no system terminal launcher is configured for this platform.');
  console.warn('==> Falling back to current process; this may fail if electron-forge requires a TTY.');
}

function startDesktopDev(mode) {
  console.log(`==> Starting desktop ${mode} dev...`);

  if (!hasInteractiveTty() && (process.platform === 'win32' || process.platform === 'darwin')) {
    launchInSystemTerminal(mode);
    return;
  }

  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs'), mode], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function createStartupStatusPath() {
  return path.join(
    os.tmpdir(),
    `cindy-desktop-startup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

export function readDesktopStartupStatus(statusPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function formatDesktopStartupFailure(status) {
  const code = typeof status?.code === 'string' ? status.code : 'DEV_PROCESS_EXITED';
  const message = typeof status?.message === 'string'
    ? status.message
    : 'Desktop dev exited before window/auth/database startup completed.';
  const detail = status?.detail && typeof status.detail === 'object'
    ? Object.entries(status.detail)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ')
    : '';
  const processExit = status?.exitCode !== undefined || status?.signal
    ? ` exit=${status.exitCode ?? 'unknown'}${status.signal ? ` signal=${status.signal}` : ''}`
    : '';
  return `[${code}] ${message}${detail ? ` (${detail})` : ''}${processExit}`;
}

function writeDesktopStartupStatus(statusPath, status) {
  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statusPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Failed to write desktop startup status: ${error.message}`);
  }
}

export async function waitForDesktopStartup(statusPath, timeoutMs = startupReadyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readDesktopStartupStatus(statusPath);
    if (status?.state === 'ready') {
      console.log(`==> Desktop dev is ready (window + auth/local database, pid ${status.pid ?? 'unknown'}).`);
      fs.rmSync(statusPath, { force: true });
      return;
    }
    if (status?.state === 'failed') {
      fs.rmSync(statusPath, { force: true });
      throw new Error(
        `${formatDesktopStartupFailure(status)} Check the dev terminal, run \`pnpm desktop:whoami\`, and inspect apps/desktop/logs/.`,
      );
    }
    await sleep(pollIntervalMs);
  }
  // Keep a tombstone so a late Electron startup signal cannot recreate a stale
  // status file after this waiter has already reported timeout to its caller.
  writeDesktopStartupStatus(statusPath, { state: 'abandoned', at: Date.now() });
  throw new Error(
    `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s. Check the dev terminal and apps/desktop/logs/.`,
  );
}

/**
 * The kill-only phase controls existing processes but does not launch Desktop.
 * Skipping startup initialization keeps that phase from printing default
 * region/endpoint values that can contradict the following real startup.
 */
export function applyDesktopStartupConfigForPhase(options) {
  if (options.argv.includes('--kill-only')) return null;
  return applyDesktopDevStartupConfig(options);
}

async function main() {
  const argv = process.argv.slice(2);
  const killOnly = argv.includes('--kill-only');
  const waitReady = argv.includes('--wait-ready');
  const preserveRunning = argv.includes('--preserve-running');
  const replaceRunningArg = argv.find((arg) => arg.startsWith('--replace-running-root='));
  const replaceRunningRoot = replaceRunningArg
    ? path.resolve(replaceRunningArg.slice('--replace-running-root='.length))
    : null;
  // --local 切换到本地模式(连 localhost:3333);缺省走 remote(连 xdt-api)。
  const mode = argv.includes('--local') ? 'local' : 'remote';
  const startupConfig = applyDesktopStartupConfigForPhase({ argv, mode });
  const selectedRegion = startupConfig?.region ?? resolveDesktopDevRegion(argv, process.env);
  const isolatedArg = argv.find((a) => a === '--isolated' || a.startsWith('--isolated='));
  if (preserveRunning && killOnly) {
    throw new Error('--preserve-running cannot be combined with the internal --kill-only stage');
  }
  if (replaceRunningRoot && !preserveRunning) {
    throw new Error('--replace-running-root requires --preserve-running');
  }
  if (replaceRunningArg && !replaceRunningArg.slice('--replace-running-root='.length)) {
    throw new Error('--replace-running-root requires an absolute registered worktree path');
  }
  if (replaceRunningRoot) {
    const registeredRoots = repositoryWorktreePaths().map((entry) => path.resolve(entry));
    if (!registeredRoots.includes(replaceRunningRoot)) {
      throw new Error(`--replace-running-root is not a registered repository worktree: ${replaceRunningRoot}`);
    }
    if (replaceRunningRoot === rootDir) {
      throw new Error('--replace-running-root cannot target the worktree that is starting the replacement');
    }
  }
  if (preserveRunning && mode === 'local') {
    throw new Error(
      '--preserve-running only supports remote mode: sharing remote login storage with a local auth server could invalidate the persisted credential',
    );
  }
  if (preserveRunning && hasIsolationIntent(argv, process.env)) {
    throw new Error(
      '--preserve-running reuses the current Cindy login via shared userData and cannot be combined with --isolated or XDT_ISOLATED=1',
    );
  }
  if (startupConfig) {
    console.log(`==> Desktop region: ${startupConfig.region}`);
  }
  // --passive: 定时任务被动模式 —— 本实例不参与自动触发(交给同机 primary,
  // 典型场景多个 dev preview 与 release/primary 共享数据时 preview 让位)。
  // 实现方式是置 XDT_SCHEDULER_PASSIVE=1,经 devEnvPrefix 白名单透传进新开的
  // 系统终端 / 直接 spawn 的 dev 进程。
  if (startupConfig && (argv.includes('--passive') || preserveRunning)) {
    process.env.XDT_SCHEDULER_PASSIVE = '1';
    console.log(
      preserveRunning
        ? '==> Preserve-running preview: existing Cindy processes stay alive; this instance shares login/data and will not auto-fire schedules.'
        : '==> Scheduler passive mode: this instance will not auto-fire schedules.',
    );
  }
  // --endpoints-cdn: dev 不读仓内 config/endpoint.json,改走与 packaged 相同的
  // 线上 CDN 端点清单拉取链路(测线上清单)。实现方式是置 XDT_ENDPOINTS_CDN=1,
  // 经 devEnvPrefix 白名单透传,主进程 devCliFlags/clientEndpointsService 消费。
  // 注意 local 模式的 endpoint.local.json 生成不在本脚本——dev(local)脚本链里的
  // apps/desktop/scripts/dev-local-env.mjs 统一负责(human 直跑与 restart 同路径)。
  if (startupConfig?.endpointsCdn) {
    console.log(`==> Endpoints via CDN: dev will fetch the ${startupConfig.region} online endpoint manifest.`);
  } else if (startupConfig && mode === 'remote' && startupConfig.endpointManifestFile) {
    console.log(`==> Endpoint manifest: ${startupConfig.endpointManifestFile}`);
  }
  // --isolated[=<名字>]: dev 使用独立的 userData 目录(数据库/登录态/会话全部与
  // 正式版隔离,首次要重新登录 Cindy 账号)。不带名字 = 当前区域默认沙箱;
  // 带名字 = 在区域沙箱名后追加 `-<名字>`,每个名字一条,可同时多开。
  // 实现:置 XDT_USER_DATA_DIR(主进程入口只在非 packaged 时应用,见
  // apps/desktop/src/main/index.ts),经 devEnvPrefix 白名单透传给 dev 进程。
  // 已手动设了 XDT_USER_DATA_DIR 时尊重用户的值,不覆盖。
  // 同时置 XDT_ISOLATED=1(开关)+ XDT_ISOLATED_NAME(名字,可选)把隔离意图带进
  // 主进程——开关与名字分离,名叫 "1" 的沙箱不会撞开关标记值(codex review P2)。
  // 主进程据此派生独立 deviceId(dev-[<名字>-]<机器指纹>,机器指纹只有主进程能取)
  // ——服务端登录凭证按 (user, device) 一对一存,不派生的话沙箱登录会覆盖正式版
  // 的续期凭证,同机互踢。
  if (startupConfig && isolatedArg) {
    let isolationName = '';
    if (isolatedArg.includes('=')) {
      isolationName = isolatedArg.slice('--isolated='.length);
      // 名字白名单与主进程 devCliFlags 一致:目录跨平台安全 + deviceId 总长可控。
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(isolationName)) {
        console.error(`==> Invalid --isolated name: "${isolationName}"`);
        console.error('    Allowed: letters / digits / _ / -, max 32 chars. e.g. --isolated=feature-a');
        process.exit(1);
      }
    }
    process.env.XDT_ISOLATED = '1';
    if (isolationName) process.env.XDT_ISOLATED_NAME = isolationName;
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = defaultIsolatedUserDataDir(isolationName, selectedRegion);
      // 可信纪元信号:仅当目录由本脚本按 -dev2 纪元派生时携带,主进程据此允许
      // 显式 env 覆写命中纪元判定。用户手动设 XDT_USER_DATA_DIR(上面的分支不
      // 进入)或旧 checkout 启动都不带该信号 → 观察模式,防旧代码对同一显式
      // 路径以默认身份打开造成双身份互写(#912 review P1)。
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
    }
  }
  // --isolated-auth: 沙箱凭证隔离 —— 不与本机 ~/.codex 共享 auth 硬链(已共享的
  // 解除本沙箱一端),沙箱内的 OAuth 登录/登出不再触碰正式实例与本机 CLI 的凭证。
  // 隔离沙箱里测登录流程时必用:共享硬链下沙箱登录会改写共用凭证文件,把正式版
  // 一起退登(2026-08-13 实测)。实现:置 XDT_ISOLATED_AUTH=1,经 devEnvPrefix
  // 白名单透传,maker-host auth-adapters 消费(仅非 packaged 生效)。
  if (startupConfig && argv.includes('--isolated-auth')) {
    if (!isolatedArg) {
      console.error('==> --isolated-auth requires --isolated: 共享 userData 的实例不该单独隔离凭证');
      process.exit(1);
    }
    process.env.XDT_ISOLATED_AUTH = '1';
    console.log('==> Isolated auth: this sandbox will NOT share codex OAuth credentials with ~/.codex.');
  }
  if (startupConfig) ensureDesktopEnv();

  const devAncestor = findDevAncestor();
  if (devAncestor && !preserveRunning) {
    console.error('==> Detected this script is running inside an Cindy desktop dev process tree:');
    console.error(`    ancestor pid ${devAncestor.pid}: ${devAncestor.command.slice(0, 180)}`);
    console.error('==> Refusing to restart from within. Killing the ancestor would terminate this');
    console.error('    script mid-flight and leave ports / file locks held by the dying process,');
    console.error('    causing the new electron-forge to fail with ELIFECYCLE.');
    console.error('==> Ask the user to restart from the terminal where they originally launched');
    console.error(`    \`pnpm ${devScriptForMode(mode)}\` (Ctrl+C then re-run), or from any external shell`);
    console.error('    not spawned by the desktop dev tree.');
    process.exit(1);
  }
  if (devAncestor && preserveRunning) {
    if (replaceRunningRoot && commandContainsPath(devAncestor.command, replaceRunningRoot)) {
      throw new Error(
        `Refusing to replace ${replaceRunningRoot}: the current command is hosted by that dev process tree`,
      );
    }
    console.log(
      `==> Current session is hosted by Cindy desktop dev pid ${devAncestor.pid}; preserving that process tree.`,
    );
  }

  // userData 冲突门:目标 userData 已被其他 checkout 的 dev 实例占用时中止。
  // 杀掉别人(旧全灭行为)会顶掉用户并行调试中的沙箱;共用同一份 userData 并行
  // 又会撞 SQLite / 登录态。两难之下唯一安全解是停下来让用户决定:换一个
  // --isolated 名字,或用户自己停掉那个实例。preserve-running 不进此门 ——
  // 它的语义就是共享 userData 的被动预览。检测是尽力而为:靠 helper 进程命令行
  // 上的 --user-data-dir,对方实例刚启动还没起 helper 时可能漏检。
  const targetUserDataDir = resolveRestartTargetUserDataDir({
    envUserDataDir: process.env.XDT_USER_DATA_DIR,
    isolatedArg,
    isolatedEnv: process.env.XDT_ISOLATED,
    isolatedName: process.env.XDT_ISOLATED_NAME,
    selectedRegion,
  });
  if (
    hasIsolationIntent(argv, process.env)
    && isOfficialProductionUserDataDir(targetUserDataDir)
  ) {
    throw new Error(
      `--isolated cannot use the official Cindy profile (${targetUserDataDir}). ` +
        'Omit XDT_USER_DATA_DIR, or point it at a sandbox directory.',
    );
  }
  if (startupConfig && hasIsolationIntent(argv, process.env)) {
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = targetUserDataDir;
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
    }
    fs.mkdirSync(process.env.XDT_USER_DATA_DIR, { recursive: true });
    const isolationName = isolatedArg
      ? parseIsolationName(isolatedArg)
      : (process.env.XDT_ISOLATED_NAME || '');
    console.log(`==> Isolated dev user data${isolationName ? ` (sandbox "${isolationName}")` : ''}: ${process.env.XDT_USER_DATA_DIR}`);
  }
  if (!preserveRunning) {
    const conflicts = listDesktopDevProcesses().filter(
      (proc) => !commandContainsPath(proc.command, rootDir)
        && commandUsesUserDataDir(proc.command, targetUserDataDir),
    );
    if (conflicts.length > 0) {
      console.error(`==> Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`);
      for (const proc of conflicts) {
        console.error(`    pid ${proc.pid}: ${proc.command.slice(0, 180)}`);
      }
      console.error('==> Refusing to stop processes outside this checkout. Pick a different sandbox');
      console.error('    name (--isolated=<name>), or stop that instance yourself and re-run.');
      process.exit(1);
    }
  } else {
    const compatibility = inspectSharedUserDataRegion(
      targetUserDataDir,
      selectedRegion,
      listDesktopDevProcesses(),
    );
    if (!compatibility.compatible) {
      throw new Error(
        `--preserve-running cannot safely share ${targetUserDataDir}: ${compatibility.reason}. ` +
          'Restart the existing instance with the same region, or use an isolated sandbox.',
      );
    }
  }

  const allTargets = listDesktopDevProcesses();
  // kill 作用域 = 当前 checkout。其他 worktree / 命名沙箱的实例一律保留。
  const ownScope = partitionDesktopDevProcesses(allTargets, rootDir);
  const targets = replaceRunningRoot
    ? allTargets.filter((proc) => commandContainsPath(proc.command, replaceRunningRoot))
    : ownScope.targets;
  const darwinTerminalTtys = darwinTerminalTtysForProcesses(targets);

  if (!preserveRunning && !replaceRunningRoot && ownScope.preserved.length > 0) {
    console.log(
      `==> Preserving ${ownScope.preserved.length} Cindy desktop dev process(es) from other checkouts; this restart only touches ${rootDir}.`,
    );
  }

  if (preserveRunning && !replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length} existing Cindy desktop dev process(es); the preview will start alongside them in passive mode.`,
    );
  } else if (replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length - targets.length} other Cindy desktop dev process(es); replacing only ${replaceRunningRoot}.`,
    );
    if (targets.length === 0) {
      console.log('==> No running desktop dev processes were found for the requested replacement root.');
    } else {
      console.log(`==> Stopping ${targets.length} desktop dev process(es) from the requested replacement root...`);
      for (const target of targets) {
        console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
        killProcess(target.pid);
      }

      const matchesReplacementRoot = (proc) => commandContainsPath(proc.command, replaceRunningRoot);
      const remainingForRoot = await waitForDesktopDevProcessesToExit(
        gracefulTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingForRoot.length > 0) {
        console.log(`==> Force stopping ${remainingForRoot.length} stubborn process(es) from the replacement root...`);
        for (const target of remainingForRoot) {
          console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
          forceKillProcess(target.pid);
        }
      }

      const remainingAfterForce = await waitForDesktopDevProcessesToExit(
        forceTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingAfterForce.length > 0) {
        console.error(`==> Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`);
        for (const target of remainingAfterForce) {
          console.error(`    still running ${target.pid}: ${target.command.slice(0, 180)}`);
        }
        process.exit(1);
      }

      closeDarwinTerminalTtys(darwinTerminalTtys);
    }
  } else if (targets.length === 0) {
    console.log('==> No existing Cindy desktop dev processes found for this checkout.');
  } else {
    console.log(`==> Stopping ${targets.length} existing Cindy desktop dev process(es) from this checkout...`);
    for (const target of targets) {
      console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
      killProcess(target.pid);
    }

    // 等待/强杀同样限定在本 checkout —— 不带过滤器会把其他 checkout 仍在跑的
    // 实例当成"顽固进程"逐个 SIGKILL 掉。
    const matchesOwnRoot = (proc) => commandContainsPath(proc.command, rootDir);
    const remainingAfterTerm = await waitForDesktopDevProcessesToExit(gracefulTimeoutMs, matchesOwnRoot);
    if (remainingAfterTerm.length > 0) {
      console.log(`==> Force stopping ${remainingAfterTerm.length} stubborn Cindy desktop dev process(es)...`);
      for (const target of remainingAfterTerm) {
        console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
        forceKillProcess(target.pid);
      }
    }

    const remainingAfterForce = await waitForDesktopDevProcessesToExit(forceTimeoutMs, matchesOwnRoot);
    if (remainingAfterForce.length > 0) {
      console.error(`==> Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`);
      for (const target of remainingAfterForce) {
        console.error(`    still running ${target.pid}: ${target.command.slice(0, 180)}`);
      }
      process.exit(1);
    }

    closeDarwinTerminalTtys(darwinTerminalTtys);
  }

  if (killOnly) return;

  if (!preserveRunning) clearDesktopDevCaches(rootDir);

  let startupStatusPath = null;
  if (waitReady) {
    startupStatusPath = createStartupStatusPath();
    writeDesktopStartupStatus(startupStatusPath, { state: 'pending', at: Date.now() });
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = startupStatusPath;
  }
  startDesktopDev(mode);
  if (startupStatusPath) await waitForDesktopStartup(startupStatusPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
