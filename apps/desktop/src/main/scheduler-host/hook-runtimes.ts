/**
 * hook 运行时探测:检查用户机器上是否有可用的真实 Node。
 *
 * 生成器据此选择 `node` / `xdt-node` 命令形态;执行器还会再次解析解释器,
 * 因为保存后的 PATH 可能变化,插件和手写的裸 `node` 命令也绕过生成器。
 * PATH 失效时继续发现常见版本管理器安装;候选必须实际执行 `--version` 成功。
 * 找不到真实运行时时,xdt-node 明确 fail-closed(见 pre-run-hook),不使用
 * 正式包已关闭的 Electron RunAsNode。
 *
 * 结果按执行目录存入有界 LRU + TTL 缓存,让"用户刚装完或修复 node"无需重启也能
 * 在几分钟后被感知。调用方取消或本轮预算耗尽不会写成不可用缓存。
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from './proc-util.js';

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;

let cached: { value: boolean; at: number } | null = null;

export interface ProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 与真实 hook 一致的工作目录;asdf / mise 的 PATH shim 会据此选择版本。 */
  cwd?: string;
}

/** 探测一条命令能否成功执行(exit 0)。PATH 用 shell，候选绝对路径直接 exec，语义一致。 */
function probeCommand(command: string, args?: string[], options: ProbeOptions = {}): Promise<boolean> {
  const timeoutMs = Math.min(PROBE_TIMEOUT_MS, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (options.signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    const kill = (): void => {
      if (child) killProcessTree(child.pid, child);
    };
    const onAbort = (): void => {
      kill();
      settle(false);
    };
    const timer = setTimeout(() => {
      kill();
      settle(false);
    }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(command, args ?? [], {
        shell: args === undefined,
        cwd: options.cwd,
        windowsHide: true,
        stdio: 'ignore',
        // POSIX 下让 PATH shim 与其后代自成进程组,取消和超时才能整树终止。
        detached: process.platform !== 'win32',
      });
    } catch {
      settle(false);
      return;
    }
    child.on('error', () => settle(false));
    child.on('close', (code) => settle(code === 0));
  });
}

/** 系统 node 是否可用(缓存 + TTL)。测试可传 forceProbe 绕过缓存。 */
export async function hasSystemNode(opts?: { forceProbe?: boolean }): Promise<boolean> {
  const now = Date.now();
  if (!opts?.forceProbe && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await probeCommand('node --version');
  cached = { value, at: now };
  return value;
}

export interface SystemNodeInterpreterOptions {
  forceProbe?: boolean;
  signal?: AbortSignal;
  /** 本轮发现流程的总剩余预算,不是每个候选各自的新预算。 */
  timeoutMs?: number;
  /** 真实 hook 的工作目录;缺省与执行器一样回落到用户目录。 */
  cwd?: string;
  /** 以下依赖仅供单元测试隔离用户目录与真实进程。 */
  env?: NodeJS.ProcessEnv;
  home?: string;
  probeExecutable?: (executable: string, options?: ProbeOptions) => Promise<boolean>;
  readVersions?: (directory: string) => string[] | Promise<string[]>;
  /** 目标平台与路径算法仅用于跨平台目录发现测试,不直接改写 process.platform。 */
  platform?: NodeJS.Platform;
  pathApi?: { join: (...parts: string[]) => string };
}

const INTERPRETER_CACHE_MAX_ENTRIES = 32;
const cachedInterpreters = new Map<string, { value: string | null; at: number }>();

interface InflightInterpreter {
  promise: Promise<string | null>;
  controller: AbortController;
  waiters: number;
  completed: boolean;
}

const inflightInterpreters = new Map<string, InflightInterpreter>();

function getCachedInterpreter(cwd: string, now: number): { value: string | null } | null {
  const entry = cachedInterpreters.get(cwd);
  if (!entry) return null;
  if (now - entry.at >= CACHE_TTL_MS) {
    cachedInterpreters.delete(cwd);
    return null;
  }
  // Map 迭代顺序即 LRU 顺序:命中后移到末尾。
  cachedInterpreters.delete(cwd);
  cachedInterpreters.set(cwd, entry);
  return { value: entry.value };
}

function setCachedInterpreter(cwd: string, value: string | null): void {
  const now = Date.now();
  for (const [key, entry] of cachedInterpreters) {
    if (now - entry.at >= CACHE_TTL_MS) cachedInterpreters.delete(key);
  }
  cachedInterpreters.delete(cwd);
  cachedInterpreters.set(cwd, { value, at: now });
  while (cachedInterpreters.size > INTERPRETER_CACHE_MAX_ENTRIES) {
    const oldest = cachedInterpreters.keys().next().value;
    if (oldest === undefined) break;
    cachedInterpreters.delete(oldest);
  }
}

/** fs 读目录本身不可取消;等待侧竞争 signal,迟到结果直接丢弃。 */
function awaitDirectoryVersions(
  readVersions: (directory: string) => string[] | Promise<string[]>,
  directory: string,
  signal: AbortSignal,
): Promise<string[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => readVersions(directory))
      .then((versions) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(signal.aborted ? null : versions);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
  });
}

interface VersionRoot {
  directory: string;
  executable: string;
}

async function versionManagerCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  readVersions: (directory: string) => string[] | Promise<string[]>,
  signal: AbortSignal,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string,
): Promise<string[]> {
  const current: string[] = [];
  const roots: VersionRoot[] = [];
  const executable = platform === 'win32' ? 'node.exe' : join('bin', 'node');
  const nvmHome = env.NVM_HOME ?? (platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'nvm') : undefined);
  const nvmDir = env.NVM_DIR ?? (platform !== 'win32' ? join(home, '.nvm') : undefined);
  if (platform === 'win32') {
    if (env.NVM_SYMLINK) current.push(join(env.NVM_SYMLINK, executable));
    if (nvmHome) {
      current.push(join(nvmHome, 'nodejs', executable));
      roots.push({ directory: join(nvmHome, 'installs'), executable });
      roots.push({ directory: nvmHome, executable });
    }
  } else if (nvmDir) {
    roots.push({ directory: join(nvmDir, 'versions', 'node'), executable });
  }
  const fnmDir = env.FNM_DIR ?? (platform === 'win32'
    ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'fnm')
    : platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'fnm')
      : join(home, '.local', 'share', 'fnm'));
  roots.push({ directory: join(fnmDir, 'node-versions'), executable: join('installation', executable) });
  const voltaHome = env.VOLTA_HOME ?? (platform === 'win32'
    ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Volta')
    : join(home, '.volta'));
  roots.push({ directory: join(voltaHome, 'tools', 'image', 'node'), executable });
  if (platform !== 'win32') {
    roots.push({ directory: join(env.ASDF_DATA_DIR ?? join(home, '.asdf'), 'installs', 'nodejs'), executable });
    roots.push({ directory: join(env.MISE_DATA_DIR ?? join(home, '.local', 'share', 'mise'), 'installs', 'node'), executable });
  }

  const candidates = [...current];
  for (const root of roots) {
    if (signal.aborted) return [];
    let versions: string[] | null;
    try {
      versions = await awaitDirectoryVersions(readVersions, root.directory, signal);
    } catch {
      continue;
    }
    if (versions === null) return [];
    versions = versions
      .filter(version => /^v?\d/.test(version))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .slice(0, 2);
    for (const version of versions) candidates.push(join(root.directory, version, root.executable));
  }
  return [...new Set(candidates)].slice(0, 16);
}

function quoteNodeExecutable(executable: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `"${executable}"` : `'${executable.replace(/'/g, `'\\''`)}'`;
}

/** 共享探测只监听共享 signal;每个调用者的独立 budget 在等待侧处理。 */
async function discoverSystemNodeInterpreter(
  cwd: string,
  options: SystemNodeInterpreterOptions,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null;
  const pathAvailable = await probeCommand('node --version', undefined, { signal, cwd });
  if (signal.aborted) return null;
  if (pathAvailable) return 'node';

  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const probe = options.probeExecutable ?? ((executable: string, probeOptions?: ProbeOptions) =>
    probeCommand(executable, ['--version'], probeOptions));
  const readVersions = options.readVersions ?? (async (directory: string) => readdir(directory));
  const candidates = await versionManagerCandidates(
    env, home, readVersions, signal, options.platform ?? process.platform, options.pathApi?.join ?? path.join,
  );
  if (signal.aborted) return null;
  // 最多 4 个并发探测;每个进程自身有 3 秒上限,调用者另有独立总预算。
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async executable => {
      try {
        return await probe(executable, { signal, cwd });
      } catch {
        return false;
      }
    }));
    if (signal.aborted) return null;
    const available = results.findIndex(Boolean);
    if (available >= 0) return quoteNodeExecutable(batch[available], options.platform ?? process.platform);
  }
  return null;
}

function createInflightInterpreter(
  cwd: string,
  options: SystemNodeInterpreterOptions,
): InflightInterpreter {
  const controller = new AbortController();
  const entry: InflightInterpreter = {
    promise: Promise.resolve(null),
    controller,
    waiters: 0,
    completed: false,
  };
  entry.promise = discoverSystemNodeInterpreter(cwd, options, controller.signal)
    .catch(() => null)
    .then((value) => {
      if (!controller.signal.aborted) setCachedInterpreter(cwd, value);
      return value;
    })
    .finally(() => {
      entry.completed = true;
      if (inflightInterpreters.get(cwd) === entry) inflightInterpreters.delete(cwd);
    });
  inflightInterpreters.set(cwd, entry);
  return entry;
}

/** 独立等待共享结果;只有最后一个等待者离开才会取消底层共享探测。 */
function waitForInterpreter(
  entry: InflightInterpreter,
  options: SystemNodeInterpreterOptions,
): Promise<string | null> {
  if (options.signal?.aborted || (options.timeoutMs !== undefined && options.timeoutMs <= 0)) {
    return Promise.resolve(null);
  }
  entry.waiters += 1;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCancel);
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.completed) entry.controller.abort();
      resolve(value);
    };
    const onCancel = (): void => finish(null);
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(onCancel, options.timeoutMs);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', onCancel, { once: true });
    entry.promise.then(finish);
  });
}

/**
 * 返回可替换命令首 token 的 Node 解释器。PATH 失效时，继续发现常见版本管理器
 * 已安装的运行时；候选必须实际 `--version` 成功才可使用。同一 cwd 合并在途探测，
 * 各调用者保留独立取消与预算;完成结果使用有界 LRU + TTL 缓存。
 */
export async function resolveSystemNodeInterpreter(
  options: SystemNodeInterpreterOptions = {},
): Promise<string | null> {
  if (options.signal?.aborted || (options.timeoutMs !== undefined && options.timeoutMs <= 0)) return null;
  const cwd = options.cwd?.trim() ? options.cwd : os.homedir();
  if (!options.forceProbe) {
    const cached = getCachedInterpreter(cwd, Date.now());
    if (cached) return cached.value;
  }
  let entry = inflightInterpreters.get(cwd);
  if (entry?.completed || entry?.controller.signal.aborted) {
    inflightInterpreters.delete(cwd);
    entry = undefined;
  }
  entry ??= createInflightInterpreter(cwd, options);
  return waitForInterpreter(entry, options);
}

/** 测试辅助:取消在途探测并清缓存。 */
export function __resetHookRuntimeCacheForTest(): void {
  for (const entry of inflightInterpreters.values()) entry.controller.abort();
  inflightInterpreters.clear();
  cached = null;
  cachedInterpreters.clear();
}
