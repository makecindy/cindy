/**
 * libraryDbWorker.ts — 插件 Library SQLite 的专属 worker 入口。
 * ---------------------------------------------------------------------------
 * 与 dbWorker 同款装配:better-sqlite3 经**绝对路径 require**(packaged app 的
 * asar.unpacked 解析,bare require 会解析错),构造器在 worker 侧实例化,
 * 执行体是 libraryDbCore(与单测共用同一份逻辑,无双份漂移)。
 * 一个 worker 服务一个插件:恶意慢查询只能饿死自己,宿主可 terminate
 * (WAL 保证 terminate 不损坏库)。
 */

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

import {
  createLibraryDbCore,
  type LibraryDbResult,
  type SqliteDatabaseConstructor,
} from './libraryDbCore.js';

interface LibraryDbWorkerStartup {
  betterSqliteModulePath?: string;
}

const workerPort = parentPort;
if (!workerPort) throw new Error('library db worker must be spawned via worker_threads');
const activePort = workerPort;

const startup = (workerData ?? {}) as LibraryDbWorkerStartup;
const moduleRequire = createRequire(import.meta.url);

function loadDatabaseConstructor(modulePath: string | undefined): SqliteDatabaseConstructor {
  const mod = moduleRequire(modulePath || 'better-sqlite3') as
    | SqliteDatabaseConstructor
    | { default?: SqliteDatabaseConstructor };
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  throw new Error('better-sqlite3 module did not export a Database constructor');
}

const core = createLibraryDbCore({
  DatabaseCtor: loadDatabaseConstructor(startup.betterSqliteModulePath),
  onLog: () => {
    /* worker 侧静默;错误经 RPC 结果回传,不落日志(不含用户内容) */
  },
});

interface WorkerRequest {
  id: number;
  op: 'open' | 'close' | 'closeAll' | 'exec' | 'batch' | 'migrate' | 'backup' | 'check' | 'userVersion';
  dbPath?: string;
  sql?: string;
  params?: unknown;
  statements?: Array<{ sql: string; params?: unknown }>;
  targetVersion?: number;
  steps?: Array<{ toVersion: number; sql: string[] }>;
  destAbs?: string;
}

activePort.on('message', async (req: WorkerRequest) => {
  let result: LibraryDbResult<Record<string, unknown>>;
  try {
    switch (req.op) {
      case 'open':
        result = await core.openDatabase(req.dbPath ?? '');
        break;
      case 'close':
        result = { ok: true, closed: core.closeDatabase(req.dbPath ?? '') };
        break;
      case 'closeAll':
        core.closeAll();
        result = { ok: true, closedAll: true };
        break;
      case 'exec':
        result = core.execStatement(req.dbPath ?? '', req.sql ?? '', req.params);
        break;
      case 'batch':
        result = core.batch(req.dbPath ?? '', req.statements ?? []);
        break;
      case 'migrate':
        result = core.migrate(req.dbPath ?? '', req.targetVersion ?? 0, req.steps ?? []);
        break;
      case 'backup':
        result = await core.backupDatabase(req.dbPath ?? '', req.destAbs ?? '');
        break;
      case 'check':
        result = core.checkDatabase(req.dbPath ?? '');
        break;
      case 'userVersion':
        result = { ok: true, version: core.readUserVersion(req.dbPath ?? '') };
        break;
      default:
        result = { ok: false, code: 'DB_ERROR', message: `未知 op:${String(req.op)}` };
    }
  } catch (err) {
    result = { ok: false, code: 'DB_ERROR', message: err instanceof Error ? err.message : String(err) };
  }
  activePort.postMessage({ id: req.id, result });
});
