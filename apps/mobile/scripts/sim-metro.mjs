// 模拟器 / Metro 端口归属与 git env 的共享判断,供 sim-start.mjs / sim-rebuild.mjs 复用,
// 避免两边各自重复一套(以及"一个脚本加了校验、另一个忘了"的不一致)。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path, { join } from 'node:path';
import { tmpdir } from 'node:os';

// 连接探测:连得上 = 有进程在监听。比 listen(127.0.0.1) 可靠 —— Metro 监听 *:port(可能带
// SO_REUSEADDR),用 listen 探测会误判成空闲。
export function portInUse(port) {
  return new Promise((res) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); res(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

// 监听该端口的第一个进程 pid(LISTEN)。
export function parseWindowsNetstatListener(output, port) {
  for (const line of String(output).split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP' || columns[3] !== 'LISTENING') continue;
    if (!columns[1]?.endsWith(`:${port}`)) continue;
    return columns[4] || null;
  }
  return null;
}

/**
 * One bounded socket snapshot for whoami; a failed probe is not an empty port.
 * @param {number[]} ports
 * @param {{ platform?: NodeJS.Platform, run?: (command: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string }} options
 */
export function inspectMetroListeners(ports, { platform = process.platform, run = execFileSync } = {}) {
  const pids = {};
  try {
    // Socket names do not need filesystem stat/readlink. -b avoids blocked mounts;
    // -w suppresses the expected filesystem warnings from that mode.
    const output = String(run(platform === 'win32' ? 'netstat' : 'lsof',
      platform === 'win32' ? ['-ano', '-p', 'tcp']
        : ['-b', '-w', '-nP', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpn'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' }));
    if (platform === 'win32') {
      for (const port of ports) {
        const pid = parseWindowsNetstatListener(output, port);
        if (pid) pids[port] = pid;
      }
    } else {
      let pid = null;
      for (const line of output.split(/\r?\n/)) {
        if (/^p\d+$/.test(line)) pid = line.slice(1);
        const match = line.match(/^n.*:(\d+)$/);
        const port = match ? Number(match[1]) : null;
        if (pid && ports.includes(port) && !pids[port]) pids[port] = pid;
      }
    }
    return { healthy: true, code: 'ready', pids };
  } catch (error) {
    // lsof exits 1 when the requested ports have no listeners.
    if (platform !== 'win32' && error.status === 1 && !error.signal && !error.code
      && !String(error.stderr ?? '').trim() && !String(error.stdout ?? '').trim()) {
      return { healthy: true, code: 'ready', pids };
    }
    return { healthy: false, code: error.code === 'ETIMEDOUT'
      ? 'METRO_LISTENERS_TIMEOUT' : 'METRO_LISTENERS_UNAVAILABLE', pids };
  }
}

export function listenerPid(port) {
  return inspectMetroListeners([port]).pids[port] ?? null;
}

const metroOwnerDir = join(tmpdir(), 'cindy-metro-owners');

/**
 * Hash the public bundle environment and local config inputs without persisting
 * their values in the owner file. The owner only needs to answer whether the
 * running Metro was started with the same inputs as the next invocation.
 */
export function metroEnvironmentFingerprint({ env = {}, files = {} } = {}) {
  const ordered = (value) => Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256')
    .update(JSON.stringify({ env: ordered(env), files: ordered(files) }))
    .digest('hex')
    .slice(0, 16);
}

function metroOwnerPath(port) {
  return join(metroOwnerDir, `port-${port}.json`);
}

export function writeMetroOwner(port, owner) {
  mkdirSync(metroOwnerDir, { recursive: true });
  writeFileSync(metroOwnerPath(port), `${JSON.stringify(owner)}\n`, 'utf8');
}

export function clearMetroOwner(port, pid) {
  const path = metroOwnerPath(port);
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.pid !== pid) return;
    unlinkSync(path);
  } catch {
    // A missing or malformed owner file is already fail-closed to callers.
  }
}

function readMetroOwner(port) {
  try {
    const file = metroOwnerPath(port);
    return { ...JSON.parse(readFileSync(file, 'utf8')), recordedAtMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @typedef {{ stage: string, code: string, pid?: number, timeoutMs?: number }} MetroProbeError */
/** @typedef {{ execFile?: (file: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string, onProbeError?: (error: MetroProbeError) => void }} MetroProcessProbeOptions */

// Preserve the old fail-closed return values while exposing bounded diagnostics
// to whoami. Never include command output or process environment in the receipt.
function reportProcessProbeError(error, stage, pid, options) {
  const timedOut = error?.code === 'ETIMEDOUT';
  options.onProbeError?.({ stage, code: timedOut ? 'METRO_PROCESS_TIMEOUT' : 'METRO_PROCESS_UNAVAILABLE',
    ...(pid != null ? { pid: Number(pid) } : {}), ...(timedOut ? { timeoutMs: 5000 } : {}) });
}

/**
 * Snapshot only process identity, avoiding command lines and environment data.
 * @param {(file: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string} [run]
 * @param {MetroProcessProbeOptions} [options]
 */
export function windowsProcessSnapshot(run = execFileSync, options = {}) {
  try {
    const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, @{Name='StartedAtMs';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const entries = JSON.parse(String(output));
    return (Array.isArray(entries) ? entries : [entries]).filter(Boolean).map((entry) => ({
      pid: entry.ProcessId,
      parentPid: entry.ParentProcessId,
      startedAtMs: entry.StartedAtMs,
    }));
  } catch (error) {
    reportProcessProbeError(error, 'process-snapshot', null, options);
    return [];
  }
}

function windowsOwnerOwnsListener(owner, listener, processes) {
  const launcherPid = owner?.launcherPid ?? owner?.pid;
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0
    || !Number.isSafeInteger(launcherPid) || launcherPid <= 0
    || !Number.isFinite(owner.recordedAtMs)) return false;

  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const launcher = byPid.get(launcherPid);
  // A process created after the owner file was written cannot be its launcher,
  // even if Windows has reused that PID. File time also covers existing owners.
  if (!launcher || !Number.isFinite(launcher.startedAtMs)
    || launcher.startedAtMs > owner.recordedAtMs) return false;

  let current = byPid.get(Number(listener));
  const seen = new Set();
  while (current && !seen.has(current.pid)) {
    if (!Number.isFinite(current.startedAtMs)) return false;
    if (current.pid === launcherPid) return true;
    seen.add(current.pid);
    const parent = byPid.get(current.parentPid);
    // Windows retains ParentProcessId after a parent exits. A newer process with
    // that PID is not the parent, so do not follow that link during takeover.
    if (!parent || !Number.isFinite(parent.startedAtMs)
      || parent.startedAtMs > current.startedAtMs) return false;
    current = parent;
  }
  return false;
}

/** Probe a Metro listener with a worktree/source identity on every host OS. */
/** @typedef {{ pid: string|number, launcherPid?: string|number, cwd: string|null, source: string|null, region?: string|null, loginScenario?: string, envFingerprint?: string|null }} MetroOwnership */
/** @returns {MetroOwnership|null} */
export function probeMetroOwnership(port, options = {}) {
  const pid = (options.listenerPid ?? listenerPid)(port);
  if (!pid) return null;
  if ((options.platform ?? process.platform) !== 'win32') {
    if (!(options.isMetroPid ?? isMetroPid)(pid, options)) return { pid, cwd: null, source: null };
    const cwd = cwdOfPid(pid, options);
    const source = gitSourceOfPid(pid, options);
    const owner = (options.readOwner ?? readMetroOwner)(port);
    const worktreeRoot = cwd ? path.resolve(cwd, '../..') : null;
    const ownerRoot = owner?.worktreeRoot ? path.resolve(owner.worktreeRoot) : null;
    return {
      pid,
      cwd,
      source,
      ...(ownerRoot && ownerRoot === worktreeRoot && owner?.source === source
        && owner && Object.hasOwn(owner, 'loginScenario')
        ? { loginScenario: owner.loginScenario }
        : {}),
      region: ownerRoot && ownerRoot === worktreeRoot && owner?.source === source
        ? owner.region ?? null : null,
      envFingerprint: ownerRoot && ownerRoot === worktreeRoot && owner?.source === source
        ? owner.envFingerprint ?? null
        : null,
    };
  }
  const owner = (options.readOwner ?? readMetroOwner)(port);
  if (!owner || !windowsOwnerOwnsListener(owner, pid,
    (options.processSnapshot ?? windowsProcessSnapshot)(options.execFile ?? execFileSync, options))) {
    return { pid, cwd: null, source: null };
  }
  return {
    pid,
    launcherPid: Number.isInteger(owner.launcherPid) ? owner.launcherPid : owner.pid,
    cwd: owner.worktreeRoot ? join(owner.worktreeRoot, 'apps/mobile') : null,
    source: owner.source ?? null,
    region: owner.region ?? null,
    ...(Object.hasOwn(owner, 'loginScenario') ? { loginScenario: owner.loginScenario } : {}),
    envFingerprint: owner.envFingerprint ?? null,
  };
}

// 进程工作目录(用 cwd 判 worktree,而非解析命令行 —— 命令行常是 `pnpm exec expo`、取不到
// worktree,且各 checkout 目录名不同)。macOS:lsof -a -p <pid> -d cwd -Fn。
/** @param {string | number} pid @param {MetroProcessProbeOptions} [options] */
export function cwdOfPid(pid, options = {}) {
  try {
    const out = (options.execFile ?? execFileSync)('lsof', ['-b', '-w', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch (error) {
    reportProcessProbeError(error, 'cwd', pid, options);
    return null;
  }
}

/** @param {string | number} pid @param {MetroProcessProbeOptions} [options] */
export function commandOfPid(pid, options = {}) {
  try {
    return (options.execFile ?? execFileSync)('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }).trim();
  } catch (error) {
    reportProcessProbeError(error, 'command', pid, options);
    return '';
  }
}

export function processGroupOfPid(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function processGroupMembers(groupId) {
  try {
    return execFileSync('ps', ['-g', String(groupId), '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: match[1], command: match[2], cwd: cwdOfPid(match[1]) };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** @param {string | number} pid @param {MetroProcessProbeOptions} [options] */
export function isMetroPid(pid, options = {}) {
  return /expo|metro/i.test(commandOfPid(pid, options));
}

function normalizeComparablePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
}

export function isDedicatedMetroProcessGroup(entries, expectedWorktree) {
  if (!entries.length) return false;
  const normalizedRoot = expectedWorktree ? normalizeComparablePath(expectedWorktree) : null;
  const allowedCwds = normalizedRoot
    ? new Set([normalizedRoot, `${normalizedRoot}/apps/mobile`])
    : null;

  return entries.every((entry) => {
    const command = typeof entry === 'string' ? entry : entry.command;
    const cwd = typeof entry === 'string' ? null : entry.cwd;
    if (!command || !/(?:^|\/)(?:node|pnpm|sh|zsh)(?:\s|$)/.test(command)) return false;
    if (!/(?:expo|metro|sim-start|mobile:sim:start)/i.test(command)) return false;
    if (normalizedRoot && (!cwd || !allowedCwds.has(normalizeComparablePath(cwd)))) return false;
    return true;
  });
}

/**
 * Stop one confirmed Metro process group for an explicit simulator handoff.
 * The caller must have already checked that the PID is a Cindy Metro listener.
 * Tests can inject process inspection and waiting to avoid touching real processes.
 */
export async function terminateMetro(pid, options = {}) {
  const run = options.execFile ?? execFileSync;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = options.platform ?? process.platform;
  const isAlive = options.isAlive ?? (() => (
    platform === 'win32' ? processAlive(pid) : Boolean(commandOfPid(pid))
  ));
  const signal = options.signal ?? 'TERM';
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollMs = options.pollMs ?? 100;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Metro 终止轮询间隔必须大于 0');

  if (platform === 'win32') {
    try {
      run('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      if (!isAlive()) return true;
      return false;
    }
    for (let waitedMs = 0; waitedMs < timeoutMs; waitedMs += pollMs) {
      if (!isAlive()) return true;
      await wait(pollMs);
    }
    return !isAlive();
  }

  const groupId = options.groupId !== undefined ? options.groupId : processGroupOfPid(pid);
  const currentGroupId = options.currentGroupId !== undefined
    ? options.currentGroupId
    : processGroupOfPid(process.pid);
  const groupEntries = groupId
    ? (options.groupEntries ?? processGroupMembers(groupId))
    : [];
  const canTerminateGroup = Boolean(
    groupId
    && currentGroupId
    && groupId !== currentGroupId
    && groupId !== '1'
    && isDedicatedMetroProcessGroup(groupEntries, options.worktreeRoot),
  );

  try {
    run('kill', canTerminateGroup
      ? [`-${signal}`, `-${groupId}`]
      : [`-${signal}`, String(pid)]);
  } catch {
    if (!isAlive()) return true;
    return false;
  }

  for (let waitedMs = 0; waitedMs < timeoutMs; waitedMs += pollMs) {
    if (!isAlive()) return true;
    await wait(pollMs);
  }
  return !isAlive();
}

/** Read the exact source token injected by sim:start from a running Metro. */
/** @param {string | number} pid @param {MetroProcessProbeOptions} [options] */
export function gitSourceOfPid(pid, options = {}) {
  try {
    const out = (options.execFile ?? execFileSync)('ps', ['-ww', '-E', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    const match = out.match(/EXPO_PUBLIC_XDT_GIT_SOURCE=(\S*)/);
    return match ? match[1] : null;
  } catch (error) {
    reportProcessProbeError(error, 'source', pid, options);
    return null;
  }
}

/**
 * Build a source identity that changes for commits and dirty worktree content.
 * This prevents a Metro started before an amend/reset/edit from posing as fresh.
 */
export function gitSourceIdentity(worktreeRoot, options = {}) {
  const run = options.execFile ?? execFileSync;
  const git = (args, extra = {}) => String(run('git', args, {
    cwd: worktreeRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...extra,
  })).trim();

  const branch = git(['branch', '--show-current']) || 'detached';
  const commit = git(['rev-parse', '--short=9', 'HEAD']) || 'unknown';
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status) return `${branch}@${commit}`;

  const hash = createHash('sha256');
  hash.update(status);
  hash.update(git(['diff', '--no-ext-diff', '--binary', 'HEAD', '--']));
  for (const entry of status.split('\0')) {
    if (!entry.startsWith('?? ')) continue;
    const relativePath = entry.slice(3);
    try {
      const absolutePath = join(worktreeRoot, relativePath);
      const stat = statSync(absolutePath);
      if (!stat.isFile()) continue;
      hash.update(relativePath);
      if (stat.size <= 10 * 1024 * 1024) hash.update(readFileSync(absolutePath));
      else hash.update(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      hash.update(relativePath);
    }
  }
  return `${branch}@${commit}+${hash.digest('hex').slice(0, 10)}`;
}

// 真正的路径边界判断:避免 /workspace/XDMaker 与 /workspace/XDMaker-old 这种字符串前缀误判。
export function isInside(root, child, paths = path) {
  const rel = paths.relative(root, child);
  return !paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`);
}
