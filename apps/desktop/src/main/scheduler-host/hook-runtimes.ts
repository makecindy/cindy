/**
 * hook 运行时探测:检查用户机器上是否有可用的真实 Node。
 *
 * 生成器据此选择 `node` / `xdt-node` 命令形态;执行器还会再次解析解释器,
 * 因为保存后的 PATH 可能变化,插件和手写的裸 `node` 命令也绕过生成器。
 * PATH 失效时继续发现常见版本管理器安装;候选必须实际执行 `--version` 成功。
 * 找不到真实运行时时,xdt-node 明确 fail-closed(见 pre-run-hook),不使用
 * 正式包已关闭的 Electron RunAsNode。
 *
 * 结果按进程生命周期 + TTL 缓存,让"用户刚装完或修复 node"无需重启也能
 * 在几分钟后被感知。调用方取消或本轮预算耗尽不会写成全局不可用缓存。
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;

let cached: { value: boolean; at: number } | null = null;

export interface ProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already exited */
      }
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
      child = spawn(command, args ?? [], { shell: args === undefined, windowsHide: true, stdio: 'ignore' });
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
  /** 以下依赖仅供单元测试隔离用户目录与真实进程。 */
  env?: NodeJS.ProcessEnv;
  home?: string;
  probeExecutable?: (executable: string, options?: ProbeOptions) => Promise<boolean>;
  readVersions?: (directory: string) => string[];
}

let cachedInterpreter: { value: string | null; at: number } | null = null;

interface VersionRoot {
  directory: string;
  executable: string;
}

function versionManagerCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  readVersions: (directory: string) => string[],
): string[] {
  const current: string[] = [];
  const roots: VersionRoot[] = [];
  const executable = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  const nvmHome = env.NVM_HOME ?? (process.platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'nvm') : undefined);
  const nvmDir = env.NVM_DIR ?? (process.platform !== 'win32' ? path.join(home, '.nvm') : undefined);
  if (process.platform === 'win32') {
    if (env.NVM_SYMLINK) current.push(path.join(env.NVM_SYMLINK, executable));
    if (nvmHome) {
      current.push(path.join(nvmHome, 'nodejs', executable));
      roots.push({ directory: path.join(nvmHome, 'installs'), executable });
      roots.push({ directory: nvmHome, executable });
    }
  } else if (nvmDir) {
    roots.push({ directory: path.join(nvmDir, 'versions', 'node'), executable });
  }
  const fnmDir = env.FNM_DIR ?? (process.platform === 'win32'
    ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'fnm')
    : path.join(home, '.local', 'share', 'fnm'));
  roots.push({ directory: path.join(fnmDir, 'node-versions'), executable: path.join('installation', executable) });
  const voltaHome = env.VOLTA_HOME ?? path.join(home, '.volta');
  roots.push({ directory: path.join(voltaHome, 'tools', 'image', 'node'), executable });
  if (process.platform !== 'win32') {
    roots.push({ directory: path.join(env.ASDF_DATA_DIR ?? path.join(home, '.asdf'), 'installs', 'nodejs'), executable });
    roots.push({ directory: path.join(env.MISE_DATA_DIR ?? path.join(home, '.local', 'share', 'mise'), 'installs', 'node'), executable });
  }

  const candidates = [...current];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = readVersions(root.directory);
    } catch {
      continue;
    }
    versions = versions
      .filter(version => /^v?\d/.test(version))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .slice(0, 2);
    for (const version of versions) candidates.push(path.join(root.directory, version, root.executable));
  }
  return [...new Set(candidates)].slice(0, 16);
}

function quoteNodeExecutable(executable: string): string {
  return process.platform === 'win32' ? `"${executable}"` : `'${executable.replace(/'/g, `'\\''`)}'`;
}

/**
 * 返回可替换命令首 token 的 Node 解释器。PATH 失效时，继续发现常见版本管理器
 * 已安装的运行时；候选必须实际 `--version` 成功才可使用。结果带同一 TTL 缓存，
 * 避免每次定时触发都扫描目录或重复探测。
 */
export async function resolveSystemNodeInterpreter(
  options: SystemNodeInterpreterOptions = {},
): Promise<string | null> {
  if (options.signal?.aborted) return null;
  const now = Date.now();
  if (!options.forceProbe && cachedInterpreter && now - cachedInterpreter.at < CACHE_TTL_MS) {
    return cachedInterpreter.value;
  }
  const deadline = options.timeoutMs === undefined ? undefined : now + Math.max(0, options.timeoutMs);
  const remaining = (): number | undefined => deadline === undefined ? undefined : deadline - Date.now();
  if (options.signal?.aborted || (remaining() ?? 1) <= 0) return null;
  let value: string | null = null;
  const pathAvailable = await probeCommand('node --version', undefined, {
    signal: options.signal, timeoutMs: remaining(),
  });
  if (options.signal?.aborted || (remaining() ?? 1) <= 0) return null;
  if (pathAvailable) {
    value = 'node';
  } else {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const probe = options.probeExecutable ?? ((executable: string, probeOptions?: ProbeOptions) =>
      probeCommand(executable, ['--version'], probeOptions));
    const readVersions = options.readVersions ?? readdirSync;
    const candidates = versionManagerCandidates(env, home, readVersions);
    // 最多 4 个并发探测,既保持优先级,也把 PATH 失效后的最坏等待限制在约 12 秒。
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = candidates.slice(offset, offset + 4);
      const results = await Promise.all(batch.map(async executable => {
        try {
          return await probe(executable, { signal: options.signal, timeoutMs: remaining() });
        } catch {
          return false;
        }
      }));
      if (options.signal?.aborted || (remaining() ?? 1) <= 0) return null;
      const available = results.findIndex(Boolean);
      if (available >= 0) {
        value = quoteNodeExecutable(batch[available]);
        break;
      }
    }
  }
  cachedInterpreter = { value, at: Date.now() };
  return value;
}

/** 测试辅助:清缓存。 */
export function __resetHookRuntimeCacheForTest(): void {
  cached = null;
  cachedInterpreter = null;
}
