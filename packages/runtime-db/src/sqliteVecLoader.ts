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


import type { DbLogger } from './logging.js';



export interface SqliteVecLoadResult {
  loaded: boolean;
  version?: string;
  error?: string;
  expectedPath?: string;
}


export function createSqliteVecLoader(resolveExtensionPath: () => string, log: DbLogger) {
/** module-level state: 最近一次加载结果 */
let _lastResult: SqliteVecLoadResult | null = null;





/**
 * 解析 vec0 扩展库绝对路径。
 *
 * dev:  __dirname = <repo>/apps/desktop/.vite/build → ../../native/sqlite-vec/
 * prod: process.resourcesPath/app.asar.unpacked/native/sqlite-vec/
 */
function resolveSqliteVecExtPath(): string { return resolveExtensionPath(); }

/**
 * 加载 sqlite-vec 扩展到指定 db 连接。
 *
 * 调用时机由连接生命周期决定：ensureReady 在 migration 前加载，worker
 * takeover 会为新连接重新加载。
 * 失败不 fatal，调用方记录日志后 continue。
 */
function loadSqliteVec(db: Database.Database): SqliteVecLoadResult {
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
function getSqliteVecState(): SqliteVecLoadResult | null {
  return _lastResult;
}

/** 快速判断 sqlite-vec 当前是否可用。 */
function isSqliteVecAvailable(): boolean {
  return _lastResult?.loaded === true;
}

/** 返回已加载的版本号，未加载时返回 undefined。 */
function getSqliteVecVersion(): string | undefined {
  return _lastResult?.loaded ? _lastResult.version : undefined;
}

/** closeDb 时重置 state（切账号 / 退出时调用）。 */
function resetSqliteVecState(): void {
  _lastResult = null;
}

return { resolveSqliteVecExtPath, loadSqliteVec, getSqliteVecState, isSqliteVecAvailable, getSqliteVecVersion, resetSqliteVecState };
}
