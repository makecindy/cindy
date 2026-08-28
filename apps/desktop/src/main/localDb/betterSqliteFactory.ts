import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createLogger, maskPath } from '../logger';

const log = createLogger('localDb/betterSqliteFactory');

export const BETTER_SQLITE_NATIVE_BINDING_ENV = 'XDT_BETTER_SQLITE3_NATIVE_BINDING';
const BETTER_SQLITE_NATIVE_MODULE = 'better-sqlite3';

/** WAL 模式下与主库同处一目录、同样承载已提交数据的伴随文件后缀。 */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

type ProcessVersionsLike = {
  electron?: string;
  node: string;
};

type ResolveNativeBindingOptions = {
  arch?: string;
  isPackaged?: boolean;
  moduleVersion?: string;
  platform?: string;
  roots?: string[];
};

type EnvLike = Partial<Record<string, string | undefined>>;

export function getElectronNativeBindingPath(
  root: string,
  electronVersion: string,
  platform: string,
  arch: string,
  moduleVersion: string,
): string {
  return path.join(
    root,
    'node_modules',
    '.xdt-electron-native',
    `electron-${electronVersion}-${platform}-${arch}-${BETTER_SQLITE_NATIVE_MODULE}-${moduleVersion}`,
    'node_modules',
    BETTER_SQLITE_NATIVE_MODULE,
    'build',
    'Release',
    'better_sqlite3.node',
  );
}

export function resolveBetterSqliteNativeBinding(
  env: EnvLike = runtimeProcessEnv(),
  versions: ProcessVersionsLike = process.versions,
  options: ResolveNativeBindingOptions = {},
): string | undefined {
  if (!versions.electron) return undefined;

  const explicitBinding = env[BETTER_SQLITE_NATIVE_BINDING_ENV]?.trim();
  if (explicitBinding) return explicitBinding;
  if (options.isPackaged ?? isPackagedElectronRuntime(versions)) return undefined;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  for (const root of options.roots ?? getDefaultNativeBindingRoots()) {
    const moduleVersion = options.moduleVersion ?? readBetterSqlitePackageVersion(root);
    if (!moduleVersion) continue;
    const candidate = getElectronNativeBindingPath(root, versions.electron, platform, arch, moduleVersion);
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Vite replaces the literal `process.env` expression in preload-target bundles
 * with a build-time object. Utility processes still need their fork-time env,
 * especially the Electron-native better-sqlite3 binding selected by Main.
 */
function runtimeProcessEnv(): EnvLike {
  const runtimeProcess = Reflect.get(globalThis, 'process') as
    | { env?: EnvLike }
    | undefined;
  return runtimeProcess?.env ?? {};
}

// createRequire 绑定到本 bundle 文件位置 —— 与主进程静态 `import Database from 'better-sqlite3'`
// 同一解析上下文,所以这里 resolve 出来的路径在 dev / packaged 都指向真正被加载的那份
// better-sqlite3 (packaged 下是 app.asar.unpacked/node_modules/better-sqlite3/...)。
const moduleEntryRequire = createRequire(import.meta.url);

/**
 * 解析 better-sqlite3 入口 JS 的绝对路径,用于跨 worker_threads 传递。
 *
 * 背景：真实 db worker 是单独的 `.vite/build/dbWorker.js`，紧急回滚时也可能
 * 显式启用 inline worker。两条路径都不应该依赖裸 `require('better-sqlite3')`
 * 自行猜解析根；packaged 下模块实际在 app.asar.unpacked/node_modules。
 *
 * 解法: 在主进程 (解析正常) 把绝对路径算好传给 worker, worker 改 require(绝对路径)。
 * 绝对路径绕开 worker 的 bare-specifier 解析, better-sqlite3 自身的 .node 加载仍按
 * 它自己的 __dirname 解析, 与主进程加载行为一致。失败返回 undefined, worker 回退裸
 * require (dev 下仍可解析)。
 */
export function resolveBetterSqliteModuleEntry(): string | undefined {
  try {
    return moduleEntryRequire.resolve(BETTER_SQLITE_NATIVE_MODULE);
  } catch {
    return undefined;
  }
}

export function createBetterSqliteDatabase(
  filename: string | Buffer,
  options: Database.Options = {},
): Database.Database {
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const finalOptions = nativeBinding && !options.nativeBinding
    ? { ...options, nativeBinding }
    : options;
  // 安全加固:本地 SQLite 库承载全量聊天 / 会话数据,收紧文件权限到仅属主可读写,
  // 避免多用户机器上同机其它用户按 umask 读到明文。
  //
  // 先在打开**之前**收紧已存在的库文件:损坏库会让 `new Database` 抛错,调用方
  // (ensureReady)可能在损坏 / 无备份分支提前返回,若只在打开成功后 chmod,那条
  // 早退路径会把一个 0644 的旧库原样留在盘上被同机他人读到。restrictDbFilePermissions
  // 对不存在的文件 ENOENT 静默跳过,故全新安装(文件尚未创建)时此次调用是 no-op。
  restrictDbFilePermissions(filename);
  const db = new Database(filename, finalOptions);
  // 打开成功后再收紧一次:覆盖本次刚创建的新库,以及 WAL pragma 之前 / 之后 SQLite
  // 创建的 -wal / -shm 伴随文件(继承主库 0600)。
  restrictDbFilePermissions(filename);
  return db;
}

/**
 * best-effort 把 DB 文件及其 WAL 伴随文件(`-wal` / `-shm`)权限收紧到 `0o600`
 * (仅属主可读写),消除同机他人明文读取本地聊天 / 会话数据的攻击面。
 *
 * 约束:
 * - 仅对真实落盘的字符串路径生效;`:memory:` / 空串 / Buffer 直接跳过。
 * - Windows(NTFS)不用 POSIX mode 位,`chmod` 近似 no-op,直接跳过 win32。
 * - 全程 best-effort:任何失败只 warn 不抛(权限被回收 / 文件被并发删除等),
 *   绝不阻断建库主流程。sidecar 尚未创建(ENOENT)属常态,静默跳过不打日志。
 */
export function restrictDbFilePermissions(filename: string | Buffer): void {
  if (process.platform === 'win32') return;
  if (typeof filename !== 'string') return;
  if (filename === '' || filename === ':memory:' || filename.startsWith('file::memory:')) return;

  const targets = [filename, ...DB_SIDECAR_SUFFIXES.map((suffix) => `${filename}${suffix}`)];
  for (const target of targets) {
    try {
      fs.chmodSync(target, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn('[localDb] chmod 0600 failed', maskPath(target), err);
    }
  }
}

function getDefaultNativeBindingRoots(): string[] {
  const roots: string[] = [];
  const cwd = process.cwd();
  addRoot(roots, cwd);

  let current = cwd;
  for (let depth = 0; depth < 5; depth++) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      addRoot(roots, current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

function addRoot(roots: string[], root: string): void {
  const resolved = path.resolve(root);
  if (!roots.includes(resolved)) roots.push(resolved);
}

function readBetterSqlitePackageVersion(root: string): string | null {
  try {
    const pkgPath = path.join(root, 'node_modules', BETTER_SQLITE_NATIVE_MODULE, 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function isPackagedElectronRuntime(versions: ProcessVersionsLike): boolean {
  if (!versions.electron) return false;
  const electronProcess = process as NodeJS.Process & {
    defaultApp?: boolean;
    resourcesPath?: string;
  };
  if (electronProcess.defaultApp) return false;
  const resourcesPath = electronProcess.resourcesPath;
  if (!resourcesPath) return false;
  return !resourcesPath.replaceAll('\\', '/').includes('/node_modules/electron/');
}
