#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import {
  buildDesktopDevVerdictFromFailure,
  buildDesktopDevVerdictFromWhoami,
  desktopRestartArgvConflictMessage,
  normalizeDesktopRestartArgv,
  UI_MOCK_ARG,
  printDesktopDevVerdict,
  resolveIsolatedArg,
  restartContextFromArgv,
  SHARED_USERDATA_ARG,
} from './desktop-dev-verdict.mjs';
import { PROCESS_TABLE_MAX_BYTES, collectDesktopWhoamiReport } from './desktop-whoami.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const gracefulTimeoutMs = 3000;
const forceTimeoutMs = 5000;
const pollIntervalMs = 150;
const startupReadyTimeoutMs = 120_000;
const startupBuildTimeoutMs = 180_000;
export const ISOLATED_AUTH_LAUNCH_PROOF_FILE = '.isolated-auth-launch-proof.json';
const isolatedAuthLaunchProofTtlMs = 10 * 60_000;
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
    // 命令行无法安全区分「裸 root 后接参数」和「带空格的 sibling 路径」。
    // 空格当结束边界会误伤 sibling；不当结束会漏认裸路径。desktop-dev 命令行里
    // checkout 都以 /node_modules 或 /apps/desktop 出现，保守匹配足够。
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
 * 进程是否属于 ownRootDir 这份 checkout。Cindy 托管的 `.cindy-worktrees/<name>`
 * 嵌在主 checkout 目录里，只看路径前缀会把托管 worktree 的 dev 当成主 checkout
 * 自己的进程（主仓 restart 误杀并行实例、userData 冲突门漏检）。归属以命中的
 * 最深 checkout 为准：同时命中嵌套在 ownRootDir 下的其他 worktree 时不算自己的。
 */
export function commandBelongsToCheckout(command, ownRootDir, checkoutPaths = []) {
  if (!commandContainsPath(command, ownRootDir)) return false;
  const own = stripTrailingSlashes(normalize(ownRootDir));
  return !checkoutPaths.some((candidate) => {
    const normalized = stripTrailingSlashes(normalize(candidate));
    return normalized.startsWith(`${own}/`) && commandContainsPath(command, candidate);
  });
}

/**
 * 重启的 kill 作用域:只收当前 checkout(ownRootDir)自己的 dev 进程。其他
 * worktree / 命名沙箱一律保留 ——「重启」的语义是重启这份 checkout 的实例,
 * 不是清场(2026-07-30 约束:PI 沙箱启动器曾全灭掉并行的 tgbot-review 沙箱)。
 */
export function partitionDesktopDevProcesses(processes, ownRootDir, checkoutPaths = []) {
  const targets = [];
  const preserved = [];
  for (const proc of processes) {
    (commandBelongsToCheckout(proc.command, ownRootDir, checkoutPaths) ? targets : preserved).push(proc);
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

/**
 * `ps -eo …` 在装了上千个进程的机器上已经超过 spawnSync 默认的 1 MiB，溢出时
 * status 是 null、stdout 只剩半截。上限与 desktop-whoami 共用一个常量。
 */
function processScanError(code, detail) {
  return new Error(
    `[PROCESS_SCAN_FAILED] Could not read the process table (${code}): ${detail}. ` +
      'Refusing to guess which desktop dev processes belong to this checkout; fix the process listing and re-run.',
  );
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

/**
 * 读全量进程表。失败时抛错而不是返回空数组：scan 不到进程时「没找到本 checkout 的
 * dev 进程」和「真的有进程」看起来一模一样，kill 阶段会因此静默地不杀任何东西，旧实例
 * 残留后撞单实例锁。向上抛错 + 独立的 PROCESS_SCAN_FAILED verdict 才能让人看到原因。
 */
export function scanRestartProcessTable({ platform = process.platform, runCommand = run } = {}) {
  if (platform === 'win32') {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
    const result = runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      maxBuffer: PROCESS_TABLE_MAX_BYTES,
    });
    if (result.error || result.status !== 0) {
      throw processScanError(
        result.error?.code ?? `powershell.exe exit ${result.status}`,
        result.error?.message ?? 'powershell.exe did not return a process table',
      );
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
        pid: Number(item.ProcessId),
        ppid: Number(item.ParentProcessId) || 0,
        command: String(item.CommandLine ?? ''),
      }));
    } catch {
      throw processScanError('PROCESS_LIST_UNPARSABLE', 'powershell.exe output was not valid JSON');
    }
  }

  const result = runCommand('ps', ['-eo', 'pid=,ppid=,tty=,command='], {
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw processScanError(
      result.error?.code ?? `ps exit ${result.status}`,
      result.error?.message ?? 'ps did not return a process table',
    );
  }
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
// 用途：拦住"agent 跑在【当前 checkout】的 desktop dev 里还调 restart"这种自杀场景——
// kill 作用域虽已限本 checkout，但祖先就是这份 checkout 时仍会把本脚本一起收掉。
// 宿主是正式版或另一个 worktree 时不拦：杀不到那份祖先，隔离启动可以继续。
function findDevAncestor() {
  const processes = scanRestartProcessTable();
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
  // Durable PI Subagent runners intentionally outlive the Electron main
  // process. They use the bundled Electron executable with
  // ELECTRON_RUN_AS_NODE=1, so the executable path alone looks like a Desktop
  // dev process. Killing them alongside the app turns a normal dev restart
  // into an unexpected terminal failure instead of letting the next Desktop
  // instance reattach to the still-running durable job.
  if (
    command.includes('/runtime/pi-subagent-runs/')
    && command.includes('/runner.cjs')
  ) return false;

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
  const processes = scanRestartProcessTable();
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

// Terminal 的 `do script` 把命令当键盘输入送进新标签页的 tty;新窗口的 shell 还没接管
// 输入时 tty 处于 canonical 模式,单行超过 MAX_CANON(1024 字节)会被截断,整条命令
// 静默不执行(worktree 路径长、需清除的环境变量多时实测 ~1600 字节)。完整命令先写进
// 临时脚本,Terminal 只收一条短的 source 命令;脚本第一行删掉自身,不留残留文件。
export function writeDarwinTerminalLaunchScript(command, dir = os.tmpdir()) {
  const scriptPath = path.join(dir, `cindy-desktop-dev-${randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(scriptPath, `rm -f -- ${shellSingleQuote(scriptPath)}\n${command}\n`, {
    mode: 0o600,
  });
  return scriptPath;
}

export function darwinTerminalSourceCommand(scriptPath) {
  return `. ${shellSingleQuote(scriptPath)}`;
}

export function prepareDarwinTerminalLaunch(command, dir = os.tmpdir()) {
  const scriptPath = writeDarwinTerminalLaunchScript(command, dir);
  return {
    scriptPath,
    args: osascriptLaunchDarwinTerminalArgs(darwinTerminalSourceCommand(scriptPath)),
  };
}

// 足够覆盖启动全过程（实测一次冷启动约 0.6MB）；main/agent 日志另有按天轮转的文件。
export const DEV_TERMINAL_LOG_MAX_BYTES = 8 * 1024 * 1024;

export function desktopDevTerminalLogPath(root = rootDir) {
  return path.join(root, 'apps', 'desktop', 'logs', 'dev-terminal.log');
}

// Agent 没有 TTY 时 dev 跑在新开的 Terminal 标签页里，进程退出后标签页随之关闭，
// 失败原因就看不到了。script(1) 继续给子进程一个 pty（electron-forge 依赖 TTY），
// 输出经命名管道只把前 maxBytes 写进日志、其余丢弃：dev 会把 trace 级日志镜像到
// 终端，长期运行的实例不能让这份文件无限增长。每次启动覆盖，退出码与子进程一致。
// 返回一个 `{ ...; }` 命令组，可以整体接在 `cd … &&` 后面；envPrefix 只作用于 script。
export function darwinTerminalLoggedCommand(
  command,
  logPath,
  { envPrefix = '', maxBytes = DEV_TERMINAL_LOG_MAX_BYTES } = {},
) {
  const log = shellSingleQuote(logPath);
  const fifo = shellSingleQuote(`${logPath}.fifo`);
  return [
    `{ rm -f ${fifo}; mkfifo ${fifo} && { { head -c ${maxBytes} > ${log}; cat > /dev/null; } < ${fifo} & }; `,
    `${envPrefix}/usr/bin/script -q -F ${fifo} ${command}; `,
    `cindyDevExit=$?; rm -f ${fifo}; (exit $cindyDevExit); }`,
  ].join('');
}

export function readDesktopDevLogTail(logPath, maxLines = 40) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text
    // ANSI 转义、script(1) 写入的 ^D／退格等控制字符都去掉，只保留可读文本。
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split(/\r?\n/)
    .map((line) => line.split('\r').at(-1).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd())
    .filter((line) => line.trim() !== '');
  return lines.slice(-maxLines);
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

export function looksLikeCindyManagedUserDataDir(dir) {
  const base = path.basename(path.resolve(dir));
  return /^(Cindy|CindyGlobal|CindyDev)(?:-dev2(?:-[A-Za-z0-9_-]+)?)?$/i.test(base);
}

/** Named `--isolated=<name>` must not inherit another Cindy profile. Custom dirs stay. */
export function inheritedUserDataBlocksNamedIsolation(isolatedArg, envUserDataDir, derivedDir) {
  if (!envUserDataDir || !isolatedArg || !isolatedArg.includes('=')) return false;
  if (!looksLikeCindyManagedUserDataDir(envUserDataDir)) return false;
  return canonicalizeUserDataDir(envUserDataDir) !== canonicalizeUserDataDir(derivedDir);
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

function foldCaseOption(dir) {
  try {
    fs.statSync(dir);
    return { foldCase: volumeIsCaseInsensitive(dir) };
  } catch {
    return {};
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
  rootDir: targetRoot = rootDir,
}) {
  const resolvedIsolatedArg = resolveIsolatedArg(isolatedArg, targetRoot, foldCaseOption(targetRoot));
  const isolationName = sanitizeIsolationName(
    resolvedIsolatedArg ? parseIsolationName(resolvedIsolatedArg) : isolatedName,
  );
  const isolated = Boolean(resolvedIsolatedArg) || isolatedEnv === '1';
  return envUserDataDir
    || (isolated
      ? defaultIsolatedUserDataDir(isolationName, selectedRegion)
      : productionUserDataDir(selectedRegion));
}

/**
 * Credential cleanup/write access is more destructive than ordinary isolated
 * startup. Trust only the v2 sandbox selected by this restart invocation; an
 * ambient userData path must not gain that authority by spoofing the epoch.
 */
export function isTrustedIsolatedAuthUserDataDir({
  isolatedArg,
  userDataDir,
  userDataDirEpoch,
  userDataDerivedByRestart,
  selectedRegion,
}) {
  if (
    !isolatedArg
    || !userDataDir
    || userDataDirEpoch !== '1'
    || userDataDerivedByRestart !== true
  ) {
    return false;
  }
  const expectedDir = defaultIsolatedUserDataDir(
    parseIsolationName(isolatedArg),
    selectedRegion,
  );
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) return false;
  return canonicalizeUserDataDir(userDataDir) === canonicalizeUserDataDir(expectedDir);
}

function userDataDirEntryIsAliasOrUnverifiable(dir) {
  try {
    return fs.lstatSync(path.resolve(dir)).isSymbolicLink();
  } catch (error) {
    // A not-yet-created derived sandbox is valid at the early trust gate. Every other lstat
    // failure is ambiguous and must not authorize credential cleanup or OAuth writes.
    return error?.code !== 'ENOENT';
  }
}

/**
 * Mint a single-use proof only after this restart invocation derived and accepted the sandbox.
 * The nonce crosses Terminal/runner/Forge via env; the bound file is the second factor that an
 * inherited ambient env does not carry. Desktop consumes it from its actual app userData path.
 */
export function createIsolatedAuthLaunchProof({
  userDataDir,
  isolationName = '',
  now = Date.now(),
  nonce = randomBytes(32).toString('hex'),
}) {
  // Recheck at the write boundary: process cleanup between authorization and proof minting leaves
  // time for the derived directory to be swapped for a symlink / Windows junction.
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) {
    throw new Error('Refusing isolated-auth launch proof for a symlink or junction userData path');
  }
  const proofPath = path.join(userDataDir, ISOLATED_AUTH_LAUNCH_PROOF_FILE);
  const tempPath = `${proofPath}.${process.pid}.${nonce}.tmp`;
  const proof = {
    version: 1,
    nonce,
    userDataDir: canonicalizeUserDataDir(userDataDir),
    profileKind: 'isolated-sandbox',
    epoch: 1,
    isolationName,
    issuedAtMs: now,
    expiresAtMs: now + isolatedAuthLaunchProofTtlMs,
  };
  fs.rmSync(proofPath, { force: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, proofPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return nonce;
}

/**
 * Refuse when restarting would suicide this checkout's host, or when a shared
 * start is hosted by another checkout's desktop-dev (same official profile).
 * Isolated start from another checkout is safe: kill scope is ownRootDir.
 */
export function shouldRefuseHostedRestart(ancestor, {
  preserveRunning,
  ownRootDir,
  isolated = false,
  checkoutPaths = [],
}) {
  if (!ancestor || preserveRunning) return false;
  if (commandBelongsToCheckout(ancestor.command, ownRootDir, checkoutPaths)) return true;
  return isolated !== true;
}

export function hostedRestartRefusal(ancestor, { ownRootDir, checkoutPaths = [] }) {
  return commandBelongsToCheckout(ancestor.command, ownRootDir, checkoutPaths)
    ? {
      code: 'HOSTED_RESTART_REFUSED',
      message: "Refusing to restart from within this checkout's desktop dev process tree.",
    }
    : {
      code: 'HOSTED_SHARED_REFUSED',
      message: 'Cannot share official userData while hosted by another checkout desktop dev.',
    };
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

/**
 * 启动器转发给 dev 进程的全部环境变量(含未设值项)。devEnvPrefix 只转发有值的项;
 * macOS 走长驻的 Terminal.app 时,未设值项还必须由 darwinStaleDevEnvUnset 显式清掉 ——
 * 否则 Terminal 进程里残留的更早一次启动的值(XDT_ISOLATED / XDT_USER_DATA_DIR /
 * XDT_USER_DATA_DIR_EPOCH 等)会被 dev 进程继承,`--shared` / `--preserve-running`
 * 预览悄悄落进别的 worktree 的沙箱,甚至用错钥匙串身份打开 profile。
 * 不变量:Terminal 命令里这些变量的取值 == 本次启动器的取值。
 */
function devEnvEntries(env) {
  return [
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
    // --mock 的 UI 模拟数据开关(main/index.ts 只在隔离沙箱里认)。
    ['XDT_UI_MOCK', env.XDT_UI_MOCK],
    // Cindy Make 测试窗口标记必须穿过 restart → dev-env → Forge，
    // 否则测试进程会退化成普通开发窗口（数据虽隔离，关闭／前台行为却不再是测试版）。
    ['XDT_CINDY_MAKE_TEST', env.XDT_CINDY_MAKE_TEST],
    // 沙箱凭证隔离(--isolated-auth):不与 ~/.codex 共享 auth 硬链,auth-adapters 消费。
    ['XDT_ISOLATED_AUTH', env.XDT_ISOLATED_AUTH],
    ['XDT_ALLOW_DEV_OAUTH_WRITE', env.XDT_ALLOW_DEV_OAUTH_WRITE],
    ['XDT_ISOLATED_AUTH_PROOF', env.XDT_ISOLATED_AUTH_PROOF],
    // CDP 端口覆写(bootstrap-electron 消费): 并行多开沙箱时给后起实例换端口。
    ['XDT_CDP_PORT', env.XDT_CDP_PORT],
    // A long-lived Terminal can retain a previous smoke run's environment.
    // Override its value even when this invocation did not request the smoke.
    ['CINDY_CUA_SMOKE', ['1', 'cursor-goal'].includes(env.CINDY_CUA_SMOKE) ? env.CINDY_CUA_SMOKE : '0'],
    // 一次性 Grok wire 归因探针(dev-only;正常环境不设置,不产生额外日志)。
    ['XDT_WIRE_DIAGNOSTICS', env.XDT_WIRE_DIAGNOSTICS],
    // 一次性 Grok strict tool spike(dev-only;必须与 wire probe 一起显式开启)。
    ['XDT_WIRE_DIAGNOSTICS_STRICT', env.XDT_WIRE_DIAGNOSTICS_STRICT],
    ['CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY', env.CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY],
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
  ];
}

/** macOS Terminal 命令前缀:清掉本次未设值、但可能残留在 Terminal 进程里的转发变量。 */
export function darwinStaleDevEnvUnset(env = process.env) {
  const keys = devEnvEntries(env)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return keys.length > 0 ? `unset ${[...new Set(keys)].join(' ')}; ` : '';
}

export function devEnvPrefix(env = process.env, platform = process.platform) {
  const envEntries = devEnvEntries(env).filter(([, value]) => value);

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
    if (result.status !== 0) {
      throw new Error(`Failed to open cmd window (exit ${result.status ?? 1})`);
    }
    console.log(`==> Opened desktop ${mode} dev in a new cmd window.`);
    return;
  }

  if (process.platform === 'darwin') {
    const logPath = desktopDevTerminalLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.rmSync(logPath, { force: true });
    fs.rmSync(`${logPath}.fifo`, { force: true });
    const command = `${darwinEnvPrefix()}${darwinStaleDevEnvUnset()}cd ${shellSingleQuote(rootDir)} && ${darwinTerminalLoggedCommand(packageManagerCommand(mode), logPath, { envPrefix: devEnvPrefix() })}; exitCode=$?; exit $exitCode`;
    const { scriptPath, args } = prepareDarwinTerminalLaunch(command);
    // osascript 在 do script 之前失败（自动化权限被拒、脚本错误）时临时脚本不会被 source，
    // 首行自删不会发生；按失败退出尽力删除，避免留下含开发环境变量的文件。
    const removeScript = () => {
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        // 尽力清理，失败不影响启动结果判断。
      }
    };
    const child = spawn('osascript', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', removeScript);
    child.on('exit', (code) => {
      if (code !== 0) removeScript();
    });
    child.unref();
    if (child.pid === undefined) {
      removeScript();
      throw new Error('Failed to open Terminal.app');
    }
    console.log(`==> Opened desktop ${mode} dev in a new Terminal window.`);
    console.log(`==> Dev terminal output is also written to ${logPath}`);
    return logPath;
  }

  console.warn('==> Non-interactive terminal detected, but no system terminal launcher is configured for this platform.');
  console.warn('==> Falling back to current process; this may fail if electron-forge requires a TTY.');
  return null;
}

function startDesktopDev(mode) {
  console.log(`==> Starting desktop ${mode} dev...`);

  if (!hasInteractiveTty() && (process.platform === 'win32' || process.platform === 'darwin')) {
    return launchInSystemTerminal(mode) ?? null;
  }

  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs'), mode], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    // --wait-ready owns the process exit so it can print DESKTOP_DEV_VERDICT.
    if (process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE) return;
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  return null;
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

function attachStartupFailure(error, status) {
  error.startupStatus = status ?? null;
  return error;
}

export async function waitForDesktopStartup(statusPath, {
  startedAtMs = Date.now(),
  buildTimeoutMs = startupBuildTimeoutMs,
  readyTimeoutMs = startupReadyTimeoutMs,
  expectedRootDir = rootDir,
} = {}) {
  const buildDeadline = startedAtMs + buildTimeoutMs;
  let readyDeadline = null;
  while (true) {
    const status = readDesktopStartupStatus(statusPath);
    const now = Date.now();
    const instance = status?.instance;
    // The private per-launch status file is the generation boundary. Only a
    // matching, newly registered main process may start the second budget.
    const validInstance = instance && Number.isSafeInteger(status.pid) && status.pid > 0
      && instance.pid === status.pid && typeof instance.instanceId === 'string'
      && instance.instanceId.length > 0 && typeof instance.rootDir === 'string'
      && path.resolve(instance.rootDir) === path.resolve(expectedRootDir)
      && Number.isFinite(instance.startedAtMs)
      && instance.startedAtMs >= startedAtMs && instance.startedAtMs <= now;
    if (readyDeadline === null && validInstance && instance.startedAtMs <= buildDeadline) {
      // The ready budget anchors to registration completion, not process start,
      // so a concurrent migration's lock wait does not consume it. Legacy
      // records without a finite registeredAtMs fall back to startedAtMs.
      const registrationAtMs =
        Number.isFinite(instance.registeredAtMs) && instance.registeredAtMs >= instance.startedAtMs
          ? instance.registeredAtMs
          : instance.startedAtMs;
      readyDeadline = registrationAtMs + readyTimeoutMs;
      console.log('DESKTOP_DEV_STEP=waiting-ready');
      console.log(`==> Desktop main registered; waiting up to ${Math.round(readyTimeoutMs / 1000)}s from registration for window + auth/local database.`);
    }
    if (now >= (readyDeadline ?? buildDeadline)) break;
    // Legacy ready-only writers remain usable, but malformed/foreign records
    // cannot finish this launch. Repeated registration never extends a budget.
    if (status?.state === 'ready' && (!instance || validInstance)) {
      console.log(`==> Desktop dev is ready (window + auth/local database, pid ${status.pid ?? 'unknown'}).`);
      fs.rmSync(statusPath, { force: true });
      return status;
    }
    if (status?.state === 'failed') {
      fs.rmSync(statusPath, { force: true });
      throw attachStartupFailure(
        new Error(
          `${formatDesktopStartupFailure(status)} Check the dev terminal, run \`pnpm desktop:whoami\`, and inspect apps/desktop/logs/.`,
        ),
        status,
      );
    }
    await sleep(pollIntervalMs);
  }
  // Keep a tombstone so a late Electron startup signal cannot recreate a stale
  // status file after this waiter has already reported timeout to its caller.
  const phase = readyDeadline === null ? 'build' : 'ready';
  const timeoutMs = phase === 'build' ? buildTimeoutMs : readyTimeoutMs;
  const message = phase === 'build'
    ? `Desktop dev did not finish build/main-process bootstrap within ${Math.round(timeoutMs / 1000)}s.`
    : `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s after main-process registration.`;
  writeDesktopStartupStatus(statusPath, { state: 'abandoned', phase, at: Date.now() });
  throw attachStartupFailure(
    new Error(
      `${message} Check the dev terminal and apps/desktop/logs/.`,
    ),
    {
      state: 'failed',
      code: 'STARTUP_TIMEOUT',
      message,
      detail: { phase, buildTimeoutMs, readyTimeoutMs },
    },
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

export function clearInheritedIsolatedAuthAuthorization(env = process.env) {
  delete env.XDT_ISOLATED_AUTH;
  delete env.XDT_ALLOW_DEV_OAUTH_WRITE;
  delete env.XDT_ISOLATED_AUTH_PROOF;
}

async function main() {
  // These capabilities are granted below only for this invocation's accepted --isolated-auth.
  clearInheritedIsolatedAuthAuthorization();
  let argv = normalizeDesktopRestartArgv(process.argv.slice(2), process.env);
  const sharedArgvConflict = desktopRestartArgvConflictMessage(argv, process.env);
  if (sharedArgvConflict) throw new Error(sharedArgvConflict);
  // --mock: dev main seeds the shared UI mock tasks into this isolated sandbox
  // (docs/dev-rules/ui-mock-data.md). Only the flag turns it on, never a stale shell env.
  if (argv.includes(UI_MOCK_ARG)) process.env.XDT_UI_MOCK = '1';
  else delete process.env.XDT_UI_MOCK;
  const rawIsolatedArg = argv.find((arg) => arg === '--isolated' || arg.startsWith('--isolated='));
  const isolatedArg = resolveIsolatedArg(rawIsolatedArg, rootDir, foldCaseOption(rootDir));
  if (rawIsolatedArg && isolatedArg && isolatedArg !== rawIsolatedArg) {
    argv = argv.map((arg) => (arg === rawIsolatedArg ? isolatedArg : arg));
    console.log(`==> Isolated sandbox from worktree: ${parseIsolationName(isolatedArg)}`);
  }
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
  let userDataDerivedByRestart = false;
  let isolatedAuthAuthorizedByRestart = false;
  if (isolatedArg && isolatedArg.includes('=')) {
    const derivedDir = defaultIsolatedUserDataDir(parseIsolationName(isolatedArg), selectedRegion);
    if (inheritedUserDataBlocksNamedIsolation(isolatedArg, process.env.XDT_USER_DATA_DIR, derivedDir)) {
      delete process.env.XDT_USER_DATA_DIR;
      delete process.env.XDT_USER_DATA_DIR_EPOCH;
      delete process.env.XDT_DEVICE_ID_OVERRIDE;
      delete process.env.XDT_ISOLATED_NAME;
      console.log(`==> Ignoring inherited Cindy profile so --isolated=${parseIsolationName(isolatedArg)} can use its own sandbox.`);
    }
  }
  const isolationName = isolatedArg ? parseIsolationName(isolatedArg) : '';
  const verdictContext = {
    rootDir,
    isolated: Boolean(isolatedArg) || process.env.XDT_ISOLATED === '1',
    sandbox: isolationName || undefined,
    local: mode === 'local',
    region: selectedRegion,
  };
  const exitWithFailure = (code, message, details = []) => {
    for (const line of details) console.error(line);
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(new Error(message), {
      ...verdictContext,
      code,
    }));
    process.exit(1);
  };
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
  if (startupConfig && argv.includes(SHARED_USERDATA_ARG)) {
    console.log('==> Shared userData mode: dev keeps the legacy shared profile behavior instead of an isolated sandbox.');
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
    if (isolationName && !/^[A-Za-z0-9_-]{1,32}$/.test(isolationName)) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        `Invalid --isolated name: "${isolationName}"`,
        [
          `==> Invalid --isolated name: "${isolationName}"`,
          '    Allowed: letters / digits / _ / -, max 32 chars. e.g. --isolated=feature-a',
        ],
      );
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
      userDataDerivedByRestart = true;
    }
  }
  // --isolated-auth: 沙箱凭证隔离 —— 启动时清掉本沙箱旧 auth(共享硬链与独立孤岛
  // 都处理),再显式允许沙箱自己的 OAuth 写入；正式实例与本机 CLI 凭证不受影响。
  // 隔离沙箱里测登录流程时必用:共享硬链下沙箱登录会改写共用凭证文件,把正式版
  // 一起退登(2026-08-13 实测)。实现:置 XDT_ISOLATED_AUTH=1,经 devEnvPrefix
  // 白名单透传,maker-host auth-adapters 消费(仅非 packaged 生效)。
  if (startupConfig && argv.includes('--isolated-auth')) {
    if (!isolatedArg) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        '--isolated-auth requires --isolated: shared userData must not isolate credentials alone',
        ['==> --isolated-auth requires --isolated: 共享 userData 的实例不该单独隔离凭证'],
      );
    }
    if (!isTrustedIsolatedAuthUserDataDir({
      isolatedArg,
      userDataDir: process.env.XDT_USER_DATA_DIR,
      userDataDirEpoch: process.env.XDT_USER_DATA_DIR_EPOCH,
      userDataDerivedByRestart,
      selectedRegion,
    })) {
      exitWithFailure(
        'STARTUP_FAILED',
        '--isolated-auth requires a userData sandbox derived by this restart invocation',
        [
          '==> Refusing --isolated-auth for an inherited or explicit XDT_USER_DATA_DIR.',
          '    Unset XDT_USER_DATA_DIR and retry with --isolated-auth --isolated[=<name>].',
        ],
      );
    }
    process.env.XDT_ISOLATED_AUTH = '1';
    process.env.XDT_ALLOW_DEV_OAUTH_WRITE = '1';
    isolatedAuthAuthorizedByRestart = true;
    console.log('==> Isolated auth: this sandbox will NOT share codex OAuth credentials with ~/.codex.');
  }
  if (startupConfig) ensureDesktopEnv();

  const checkoutPaths = repositoryWorktreePaths();
  const belongsToThisCheckout = (proc) => commandBelongsToCheckout(proc.command, rootDir, checkoutPaths);
  const devAncestor = findDevAncestor();
  if (shouldRefuseHostedRestart(devAncestor, {
    preserveRunning,
    ownRootDir: rootDir,
    isolated: hasIsolationIntent(argv, process.env),
    checkoutPaths,
  })) {
    const refusal = hostedRestartRefusal(devAncestor, { ownRootDir: rootDir, checkoutPaths });
    exitWithFailure(
      refusal.code,
      refusal.message,
      [
        `==> ${refusal.message}`,
        `    ancestor pid ${devAncestor.pid}: ${devAncestor.command.slice(0, 180)}`,
        refusal.code === 'HOSTED_RESTART_REFUSED'
          ? '==> Ask the user to restart from the official Cindy app, another worktree, or an external terminal.'
          : '==> Use --isolated=@worktree, or --preserve-running if you explicitly want shared login.',
      ],
    );
  }
  if (devAncestor && !preserveRunning && isolatedArg) {
    console.log(
      `==> Hosted by another checkout's desktop dev pid ${devAncestor.pid}; this isolated restart will not stop that host.`,
    );
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
      (proc) => !belongsToThisCheckout(proc)
        && commandUsesUserDataDir(proc.command, targetUserDataDir),
    );
    if (conflicts.length > 0) {
      exitWithFailure(
        'USERDATA_IN_USE',
        `Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
        [
          `==> Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
          ...conflicts.map((proc) => `    pid ${proc.pid}: ${proc.command.slice(0, 180)}`),
          '==> Refusing to stop processes outside this checkout. Pick a different sandbox',
          '    name (--isolated=<name>), or stop that instance yourself and re-run.',
        ],
      );
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
  const ownScope = partitionDesktopDevProcesses(allTargets, rootDir, checkoutPaths);
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
        exitWithFailure(
          'STARTUP_FAILED',
          `Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
          [
            `==> Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
            ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
          ],
        );
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
    const matchesOwnRoot = belongsToThisCheckout;
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
      exitWithFailure(
        'STARTUP_FAILED',
        `Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
        [
          `==> Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
          ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
        ],
      );
    }

    closeDarwinTerminalTtys(darwinTerminalTtys);
  }

  if (killOnly) return;

  if (!preserveRunning) clearDesktopDevCaches(rootDir);

  let startupStatusPath = null;
  let startupRequestedAt = null;
  if (waitReady) {
    startupStatusPath = createStartupStatusPath();
    startupRequestedAt = Date.now();
    writeDesktopStartupStatus(startupStatusPath, { state: 'pending', at: startupRequestedAt });
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = startupStatusPath;
  }
  if (isolatedAuthAuthorizedByRestart) {
    process.env.XDT_ISOLATED_AUTH_PROOF = createIsolatedAuthLaunchProof({
      userDataDir: process.env.XDT_USER_DATA_DIR,
      isolationName: process.env.XDT_ISOLATED_NAME || '',
    });
  }
  const terminalLogPath = startDesktopDev(mode);
  // 所有非 ready 的结论（启动失败、超时、ready 后进程退出导致的 WHOAMI_MISMATCH）
  // 都先打印终端日志末尾，并在 verdict 里带上 log=。
  const printFailedVerdict = (verdict) => {
    const logTail = terminalLogPath ? readDesktopDevLogTail(terminalLogPath) : [];
    if (logTail.length > 0) {
      console.error(`==> Last ${logTail.length} lines of ${terminalLogPath}:`);
      for (const line of logTail) console.error(`    ${line}`);
    }
    printDesktopDevVerdict(terminalLogPath ? { ...verdict, log: terminalLogPath } : verdict);
  };
  if (startupStatusPath) {
    try {
      await waitForDesktopStartup(startupStatusPath, { startedAtMs: startupRequestedAt });
      const report = collectDesktopWhoamiReport({
        rootDir,
        userDataDir: process.env.XDT_USER_DATA_DIR,
      });
      const verdict = buildDesktopDevVerdictFromWhoami(report, verdictContext);
      if (verdict.state !== 'ready') {
        printFailedVerdict(verdict);
        process.exit(1);
      }
      printDesktopDevVerdict(verdict);
    } catch (error) {
      printFailedVerdict(buildDesktopDevVerdictFromFailure(error, verdictContext));
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(error, {
      rootDir,
      ...restartContextFromArgv(process.argv.slice(2)),
    }));
    console.error(error);
    process.exit(1);
  });
}
