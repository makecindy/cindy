/**
 * librarySqlService.ts — 主进程侧的插件 Library SQLite RPC 服务。
 * ---------------------------------------------------------------------------
 * 每个声明 library 能力的插件一个 LibrarySqlService 实例(分派层装配):
 *   - 语句门在**发送前**执行(main 侧第一道,worker 内 core 复读第二道);
 *   - worker 经 worker_threads 拉起(脚本 = 构建产出的 libraryDbWorker.js,
 *     与 main 输出同目录;better-sqlite3 模块路径由调用方注入,解析方式与
 *     localDb 的 resolveBetterSqliteModuleEntry 一致);
 *   - 慢查询/恶意 CPU 只阻塞该 worker;dispose/terminate 不损坏库(WAL);
 *   - 单飞串行:worker 单线程天然按序处理,这里只维护请求 id → Promise 映射。
 *
 * 单测不拉真 worker:注入 createCore 直接进程内执行(与 worker 共用 core)。
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

import {
  createLibraryDbCore,
  gateSqlStatement,
  type LibraryDbResult,
  type SqliteDatabaseConstructor,
} from './libraryDbCore.js';

export interface LibrarySqlServiceDeps {
  /** worker 脚本路径(生产 = __dirname/libraryDbWorker.js;测试可注入)。 */
  workerScriptPath(): string;
  /** better-sqlite3 模块绝对路径(生产 = resolveBetterSqliteModuleEntry)。 */
  betterSqliteModulePath(): string;
  /** 进程内执行体(单测注入;缺省时拉真 worker)。 */
  createCore?: (DatabaseCtor: SqliteDatabaseConstructor) => ReturnType<typeof createLibraryDbCore>;
  /** 进程内构造器(仅当 createCore 提供时使用;测试直连 require 结果)。 */
  inProcessCtor?: SqliteDatabaseConstructor;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface WorkerReply {
  id: number;
  result: LibraryDbResult<Record<string, unknown>>;
}

/**
 * LibrarySqlService — 单插件的受控 SQLite 会话。
 * 调用方(槽层)负责生命周期:owner 切换/停用时 dispose;本类不自行回收。
 */
export class LibrarySqlService {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: LibraryDbResult<Record<string, unknown>>) => void }>();
  private disposed = false;
  /** 进程内模式(单测):直接驱动 core,不拉线程。 */
  private readonly core: ReturnType<typeof createLibraryDbCore> | null;

  constructor(private readonly deps: LibrarySqlServiceDeps) {
    this.core = deps.createCore && deps.inProcessCtor ? deps.createCore(deps.inProcessCtor) : null;
  }

  private ensureWorker(): Worker {
    if (this.core) throw new Error('in-process mode has no worker');
    if (!this.worker) {
      const worker = new Worker(this.deps.workerScriptPath(), {
        workerData: { betterSqliteModulePath: this.deps.betterSqliteModulePath() },
      });
      this.worker = worker;
      worker.on('message', (reply: WorkerReply) => {
        const entry = this.pending.get(reply.id);
        if (!entry) return;
        this.pending.delete(reply.id);
        entry.resolve(reply.result);
      });
      worker.on('error', (err: Error) => {
        this.deps.log?.warn('library db worker error', { error: err.message });
        this.failAllPending();
      });
      worker.on('exit', (code) => {
        if (!this.disposed) {
          this.deps.log?.warn('library db worker exited unexpectedly; will respawn on next call', { code });
        }
        // 清引用:下次 call 经 ensureWorker 重拉 worker——否则 postMessage
        // 打在已退出线程上,pending 永远挂起(review:worker 退出不恢复)。
        if (this.worker === worker) this.worker = null;
        this.failAllPending();
      });
    }
    return this.worker;
  }

  private failAllPending(): void {
    for (const [, entry] of this.pending) {
      entry.resolve({ ok: false, code: 'DB_ERROR', message: 'worker 已退出' });
    }
    this.pending.clear();
  }

  /** 发送前语句门(main 侧第一道):拒给插件回结构化 DB_STATEMENT_REJECTED。 */
  private preGate(sql: unknown): { ok: true; sql: string } | { ok: false; code: 'DB_STATEMENT_REJECTED'; message: string } {
    const gate = gateSqlStatement(sql);
    if (!gate.ok) return { ok: false, code: 'DB_STATEMENT_REJECTED', message: gate.reason };
    return { ok: true, sql: sql as string };
  }

  private async call(payload: Record<string, unknown>): Promise<LibraryDbResult<Record<string, unknown>>> {
    if (this.disposed) return { ok: false, code: 'DB_ERROR', message: '服务已 dispose' };
    if (this.core) {
      return this.callCore(payload);
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<LibraryDbResult<Record<string, unknown>>>((resolve) => {
      this.pending.set(id, { resolve });
      worker.postMessage({ id, ...payload });
    });
  }

  /** 进程内分发(与 worker 的 switch 同构;由单测覆盖)。 */
  private async callCore(payload: Record<string, unknown>): Promise<LibraryDbResult<Record<string, unknown>>> {
    const core = this.core!;
    switch (payload.op as string) {
      case 'open':
        return core.openDatabase(String(payload.dbPath ?? ''));
      case 'close':
        return { ok: true, closed: core.closeDatabase(String(payload.dbPath ?? '')) };
      case 'closeAll':
        core.closeAll();
        return { ok: true, closedAll: true };
      case 'exec':
        return core.execStatement(String(payload.dbPath ?? ''), String(payload.sql ?? ''), payload.params);
      case 'batch':
        return core.batch(String(payload.dbPath ?? ''), (payload.statements as Array<{ sql: string; params?: unknown }>) ?? []);
      case 'migrate':
        return core.migrate(
          String(payload.dbPath ?? ''),
          Number(payload.targetVersion ?? 0),
          (payload.steps as Array<{ toVersion: number; sql: string[] }>) ?? [],
        );
      case 'backup':
        return core.backupDatabase(String(payload.dbPath ?? ''), String(payload.destAbs ?? ''));
      case 'check':
        return core.checkDatabase(String(payload.dbPath ?? ''));
      case 'userVersion':
        return { ok: true, version: core.readUserVersion(String(payload.dbPath ?? '')) };
      default:
        return { ok: false, code: 'DB_ERROR', message: `未知 op:${String(payload.op)}` };
    }
  }

  async open(dbPath: string): Promise<LibraryDbResult<{ opened: true }>> {
    return this.call({ op: 'open', dbPath }) as Promise<LibraryDbResult<{ opened: true }>>;
  }

  async exec(dbPath: string, sql: string, params?: unknown): Promise<LibraryDbResult<Record<string, unknown>>> {
    const gate = this.preGate(sql);
    if (!gate.ok) return gate;
    return this.call({ op: 'exec', dbPath, sql, params });
  }

  async batch(dbPath: string, statements: Array<{ sql: string; params?: unknown }>): Promise<LibraryDbResult<Record<string, unknown>>> {
    for (const st of statements) {
      const gate = this.preGate(st?.sql);
      if (!gate.ok) return gate;
    }
    return this.call({ op: 'batch', dbPath, statements });
  }

  async migrate(
    dbPath: string,
    targetVersion: number,
    steps: Array<{ toVersion: number; sql: string[] }>,
  ): Promise<LibraryDbResult<Record<string, unknown>>> {
    for (const step of steps) {
      for (const sql of step?.sql ?? []) {
        const gate = this.preGate(sql);
        if (!gate.ok) return gate;
      }
    }
    return this.call({ op: 'migrate', dbPath, targetVersion, steps });
  }

  async backup(dbPath: string, destAbs: string): Promise<LibraryDbResult<Record<string, unknown>>> {
    return this.call({ op: 'backup', dbPath, destAbs });
  }

  async check(dbPath: string): Promise<LibraryDbResult<Record<string, unknown>>> {
    return this.call({ op: 'check', dbPath });
  }

  async userVersion(dbPath: string): Promise<LibraryDbResult<Record<string, unknown>>> {
    return this.call({ op: 'userVersion', dbPath });
  }

  async close(dbPath: string): Promise<void> {
    await this.call({ op: 'close', dbPath });
  }

  /** 生命周期收口:优雅关闭 worker(有 pending 时直接 terminate,不等慢查询)。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.core) {
      this.core.closeAll();
      return;
    }
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    if (this.pending.size === 0) {
      worker.postMessage({ id: this.nextId++, op: 'closeAll' });
      await worker.terminate().catch(() => {});
      return;
    }
    await worker.terminate().catch(() => {});
    this.failAllPending();
  }
}

/** 生产 worker 脚本路径(构建产物与 main 输出同目录;见 forge vite 配置)。 */
export function defaultLibraryDbWorkerPath(): string {
  return path.join(__dirname, 'libraryDbWorker.js');
}
