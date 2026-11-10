/**
 * sqlite-vec 扩展加载器。
 *
 * 职责：
 *   - 按 platform-arch 拼出 vec0.dylib / vec0.dll 路径
 *   - dev:  __dirname 上跳两级找 native/sqlite-vec/（和 drizzle 路径约定一致）
 *   - prod: process.resourcesPath/app.asar.unpacked/native/sqlite-vec/
 *   - 成功加载后跑 vec_version() 拿版本号并缓存结果
 *   - 文件缺失 / load 失败 → 返 loaded:false，不 fatal，app 仍能启动
 *
 * 注意：loadExtension 在 better-sqlite3 v12.x 中默认已启用（构造器内调用了
 * sqlite3_db_config(SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1)），无需额外操作。
 */

import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import { createLogger } from '../logger';

const log = createLogger('localDb/sqliteVec');

export interface SqliteVecLoadResult {
  loaded: boolean;
  version?: string;
  error?: string;
  expectedPath?: string;
}

/** module-level state: 最近一次加载结果 */
let _lastResult: SqliteVecLoadResult | null = null;

function platformDir(): string {
  return `${process.platform}-${process.arch}`;
}

function libFilename(): string {
  if (process.platform === 'win32') return 'vec0.dll';
  if (process.platform === 'linux') return 'vec0.so';
  return 'vec0.dylib';
}

/**
 * 解析 vec0 扩展库绝对路径（Desktop 默认布局）。
 *
 * dev:  __dirname = <repo>/apps/desktop/.vite/build → ../../native/sqlite-vec/
 * prod: process.resourcesPath/app.asar.unpacked/native/sqlite-vec/
 */
export function resolveDesktopSqliteVecExtPath(isPackaged: boolean): string {
  const relPath = path.join('native', 'sqlite-vec', platformDir(), libFilename());
  if (isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', relPath);
  }
  return path.resolve(__dirname, '..', '..', relPath);
}

let configuredExtPath: string | null = null;

/**
 * Install the host's sqlite-vec location once at startup. Desktop passes its
 * packaged/dev layout; the Node host passes the checkout or install path.
 */
export function configureSqliteVecExtPath(extPath: string): void {
  configuredExtPath = extPath;
}

/**
 * 解析 vec0 扩展库绝对路径。
 *
 * dev:  __dirname = <repo>/apps/desktop/.vite/build → ../../native/sqlite-vec/
 * prod: process.resourcesPath/app.asar.unpacked/native/sqlite-vec/
 */
export function resolveSqliteVecExtPath(): string {
  if (!configuredExtPath) {
    throw new Error(
      'sqlite-vec extension path is not configured; call configureSqliteVecExtPath() during startup',
    );
  }
  return configuredExtPath;
}

/**
 * 加载 sqlite-vec 扩展到指定 db 连接。
 *
 * 调用时机由连接生命周期决定：ensureReady 在 migration 前加载，worker
 * takeover 会为新连接重新加载。
 * 失败不 fatal，调用方记录日志后 continue。
 */
export function loadSqliteVec(db: Database.Database): SqliteVecLoadResult {
  const extPath = resolveSqliteVecExtPath();

  if (!fs.existsSync(extPath)) {
    const result: SqliteVecLoadResult = {
      loaded: false,
      error: `sqlite-vec binary not found at expected path`,
      expectedPath: extPath,
    };
    _lastResult = result;
    return result;
  }

  try {
    db.loadExtension(extPath);
    const row = db.prepare('SELECT vec_version() as v').get() as { v: string } | undefined;
    const version = row?.v ?? 'unknown';
    const result: SqliteVecLoadResult = { loaded: true, version };
    _lastResult = result;
    return result;
  } catch (err) {
    const result: SqliteVecLoadResult = {
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
      expectedPath: extPath,
    };
    _lastResult = result;
    log.error(
      JSON.stringify({
        event: 'localDb.sqliteVec.loadError',
        extPath,
        error: result.error,
      }),
    );
    return result;
  }
}

/** 返回最近一次加载结果（null = 从未调用过 loadSqliteVec）。 */
export function getSqliteVecState(): SqliteVecLoadResult | null {
  return _lastResult;
}

/** 快速判断 sqlite-vec 当前是否可用。 */
export function isSqliteVecAvailable(): boolean {
  return _lastResult?.loaded === true;
}

/** 返回已加载的版本号，未加载时返回 undefined。 */
export function getSqliteVecVersion(): string | undefined {
  return _lastResult?.loaded ? _lastResult.version : undefined;
}

/** closeDb 时重置 state（切账号 / 退出时调用）。 */
export function resetSqliteVecState(): void {
  _lastResult = null;
}
