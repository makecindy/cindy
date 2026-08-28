/**
 * librarySlot.ts — library 持久作品库的协议分派层(2026-08-20)。
 * ---------------------------------------------------------------------------
 * 与 fsSlot 平级,信任边界同源:
 *   - ghostId 一律 webContents 反查(IPC 层),槽内 getGhost 再核资格
 *     (manifest 声明 'library' + 启用态);
 *   - ownerId 插件接触不到:根目录解析走 LibraryBindingStore(默认根 =
 *     ownerScopedUserDataPath('libraries', id);自定义根按 binding 漂移判定),
 *     会话绑定 ownerScopeKey,每请求比对——切换后旧会话作废重解,
 *     在途写入不会跨 owner 落盘;
 *   - 所有路径只是**相对键**(validateLibraryRelPath),宿主解析;dbPath 同纪律;
 *   - db.migrate 前自动在线备份进 .cindy-library/backups/(宿主命名空间,
 *     插件路径语法写不进);
 *   - 结果统一 GhostPipeLibraryResult(结构化 errorCode,对沙箱永不 reject)。
 *
 * 依赖注入(规则 14):binding/vault/sql 工厂、owner scope 捕获、worker 路径
 * 全部经 deps,单测拿 tmpdir + 进程内 core 直测,零 Electron。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  GHOST_LIBRARY_OPS,
  type GhostPipeLibraryResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { LibraryVault, validateLibraryRelPath, DEFAULT_LIBRARY_LIMITS, type LibraryVaultDeps } from './libraryVault.js';
import { LibraryBindingStore, type LibraryLocationResolution } from './libraryBinding.js';
import { LibrarySqlService, type LibrarySqlServiceDeps } from './librarySqlService.js';
import type { LibraryDbResult } from './libraryDbCore.js';

/** 单插件的库会话(vault + sql 绑定到同一根与 owner scope)。 */
interface GhostLibrarySession {
  vault: LibraryVault;
  sql: LibrarySqlService;
  /** 会话创建时捕获的 owner scope key;每请求比对,变了就整会话作废。 */
  ownerScopeKey: string | null;
  locationKind: 'default' | 'custom';
  /** 自定义位置漂移(binding-moved/disk-missing):全部操作 unavailable。 */
  drift: 'binding-moved' | 'disk-missing' | null;
}

export interface GhostLibrarySlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 自定义位置 binding 存储(owner-scoped;生产注入)。 */
  bindingStore: LibraryBindingStore;
  /** 系统默认库根(生产 = ownerScopedUserDataPath('libraries', ghostId))。 */
  getDefaultRoot(ghostId: string): string;
  /** owner scope key(生产 = activeOwnerScopeKey;null = 无 owner 上下文)。 */
  captureOwnerScope(): string | null;
  /** vault 工厂(测试可换内存实现;默认真 LibraryVault)。 */
  createVault(deps: LibraryVaultDeps): LibraryVault;
  /** sql 服务工厂(测试注入进程内 core;默认真 worker 服务)。 */
  createSqlService(deps: LibrarySqlServiceDeps): LibrarySqlService;
  getDiskFreeBytes?(root: string): Promise<number | null>;
  workerScriptPath(): string;
  betterSqliteModulePath(): string;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const fail = (errorCode: string, message: string): GhostPipeLibraryResult => ({ ok: false, errorCode, message });

export class GhostLibrarySlot {
  private readonly sessions = new Map<string, GhostLibrarySession>();
  /** 迁移进行中的插件:全部写操作只读化(切换与 grace 前不再有写入落旧根)。 */
  private readonly relocating = new Set<string>();

  constructor(private readonly deps: GhostLibrarySlotDeps) {}

  /** 迁移期只读闸(设置页迁移在 copying 前置位、结束后清除)。 */
  setRelocating(ghostId: string, on: boolean): void {
    if (on) this.relocating.add(ghostId);
    else this.relocating.delete(ghostId);
  }

  /** 处理一条 library-request(ghost-pipe:send 的 invoke 返回值即本结果)。 */
  async handleLibraryRequest(ghostId: string, payload: unknown): Promise<GhostPipeLibraryResult> {
    try {
      return await this.dispatch(ghostId, payload);
    } catch (err) {
      this.deps.log?.warn('ghost library-request unexpected failure', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail('INTERNAL', 'Library 操作失败(主机内部错误)');
    }
  }

  private async dispatch(ghostId: string, payload: unknown): Promise<GhostPipeLibraryResult> {
    if (!this.checkEligibility(ghostId)) {
      return fail('NOT_DECLARED', '插件未装入、已停用或未声明 "library" 能力');
    }
    const req = (payload ?? {}) as Record<string, unknown>;
    const op = req.op as string;
    if (!GHOST_LIBRARY_OPS.includes(op as never)) {
      return fail('PATH_INVALID', `op 必须是 ${GHOST_LIBRARY_OPS.join(' / ')}`);
    }
    // 迁移期只读:写类操作在 copying 全程拒绝(读与状态查询照常)。
    if (this.relocating.has(ghostId)) {
      const writeOps: ReadonlySet<string> = new Set([
        'write', 'writeBegin', 'writeChunk', 'writeCommit', 'writeAbort',
        'mkdir', 'delete', 'rename',
        'db.open', 'db.exec', 'db.batch', 'db.migrate', 'db.backup',
      ]);
      if (writeOps.has(op)) {
        return fail('LIBRARY_READONLY', 'Library 正在迁移到新位置,写入已暂停;请稍后重试');
      }
    }

    // 会话获取/作废:owner scope 变了(切换在途或已切),旧会话的根与连接
    // 一并作废——绝不把上个 owner 的库当成本 owner 的库继续用。
    const scopeKey = this.deps.captureOwnerScope();
    const session = await this.getOrCreateSession(ghostId, scopeKey);
    return this.runOp(ghostId, session, op, req);
  }

  private async getOrCreateSession(ghostId: string, scopeKey: string | null): Promise<GhostLibrarySession> {
    let session = this.sessions.get(ghostId);
    if (session && session.ownerScopeKey !== scopeKey) {
      await this.teardownSession(ghostId);
      session = undefined;
    }
    if (!session) {
      const resolution = await this.deps.bindingStore.resolveLibraryRoot(ghostId);
      session = this.createSession(ghostId, resolution, scopeKey);
      this.sessions.set(ghostId, session);
      // 会话建立即自动 open(幂等):消除"write 前忘 open"的脚枪;显式 open
      // 操作仍有效,仅回状态。
      if (session.drift === null) {
        await session.vault.open();
        // 重装自愈:能走到这里 = 插件已装入且启用,清掉卸载时留的 orphaned
        // 标记(best-effort,失败不影响使用)。
        if (session.vault.getMeta()?.orphaned) {
          await session.vault.clearOrphaned().catch(() => {});
        }
      }
    }
    return session;
  }

  /**
   * 面板投影(cindy-ghost://<id>/library/<relPath>)的宿主侧解析:返回已存在
   * 普通文件的绝对路径,或 null(折叠 404)。经 binding 现解 + vault 路径纪律,
   * 与 read 同源校验——面板与电子脑看到同一个库。
   */
  /** 资格审:装入 + 启用 + 声明 library 能力(dispatch 与面板投影共用)。 */
  private checkEligibility(ghostId: string): boolean {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost) return false;
    if (ghost.enabled === false) return false;
    return ghost.manifest.library === true;
  }

  /**
   * 面板投影(cindy-ghost://<id>/library/<relPath>)的宿主侧解析:返回已存在
   * 普通文件的绝对路径,或 null(折叠 404)。资格审与 dispatch 同源——插件
   * 停用或更新后移除能力时投影一并熄灭(review:面板路由不复查授权)。
   */
  async resolvePanelFilePath(ghostId: string, relPath: string): Promise<string | null> {
    try {
      if (!this.checkEligibility(ghostId)) return null;
      const session = await this.getOrCreateSession(ghostId, this.deps.captureOwnerScope());
      if (session.drift !== null) return null;
      return await session.vault.resolveExistingFile(relPath);
    } catch {
      return null;
    }
  }

  private createSession(
    ghostId: string,
    resolution: LibraryLocationResolution,
    scopeKey: string | null,
  ): GhostLibrarySession {
    const drift = 'drift' in resolution && resolution.root === null ? resolution.drift : null;
    const root = resolution.kind === 'custom' && resolution.root !== null
      ? resolution.root
      : this.deps.getDefaultRoot(ghostId);
    const vault = this.deps.createVault({
      rootDir: () => root,
      ghostId,
      getDiskFreeBytes: this.deps.getDiskFreeBytes,
      locationKind: resolution.kind,
      log: this.deps.log,
    });
    const sql = this.deps.createSqlService({
      workerScriptPath: this.deps.workerScriptPath,
      betterSqliteModulePath: this.deps.betterSqliteModulePath,
      log: this.deps.log,
    });
    return { vault, sql, ownerScopeKey: scopeKey, locationKind: resolution.kind, drift };
  }

  private async teardownSession(ghostId: string): Promise<void> {
    const session = this.sessions.get(ghostId);
    if (!session) return;
    this.sessions.delete(ghostId);
    await session.sql.dispose().catch(() => {});
    await session.vault.invalidate().catch(() => {});
  }

  /** 停用/卸载/owner 切换收口:作废全部会话(commit 5 的生命周期接线点)。 */
  async disposeGhost(ghostId: string): Promise<void> {
    await this.teardownSession(ghostId);
  }

  async disposeAll(): Promise<void> {
    for (const id of Array.from(this.sessions.keys())) {
      await this.teardownSession(id);
    }
  }

  /** dbPath 相对键 → 库内绝对路径;经 vault 收敛校验(库内 symlink 指根外拒)。 */
  private async resolveDbPath(session: GhostLibrarySession, dbPath: unknown): Promise<{ abs: string } | GhostPipeLibraryResult> {
    const reason = validateLibraryRelPath(dbPath);
    if (reason) return fail('PATH_INVALID', `dbPath 非法:${reason}`);
    const abs = await session.vault.resolveDbTarget(dbPath as string);
    if (abs === null) return fail('PATH_INVALID', 'dbPath 越界或目标不可用作数据库');
    return { abs };
  }

  /** SQLite 写路径的磁盘保留水位(绕过 vault.write 的写也要受同一硬闸)。 */
  private async dbDiskGate(session: GhostLibrarySession): Promise<GhostPipeLibraryResult | null> {
    if (!this.deps.getDiskFreeBytes) return null;
    let free: number | null = null;
    try {
      free = await this.deps.getDiskFreeBytes(session.vault.getRootDir());
    } catch {
      return null;
    }
    if (free !== null && free < DEFAULT_LIBRARY_LIMITS.diskReserveBytes) {
      return fail('DISK_FULL', '磁盘剩余空间低于保留水位,数据库写入已暂停;请清理磁盘或迁移 Library');
    }
    return null;
  }

  /** core 结果 → 管道类型(按 op 定形;check 的 ok_check 归一为 healthy)。 */
  private dbResultToPipe(op: string, r: LibraryDbResult<Record<string, unknown>>): GhostPipeLibraryResult {
    if (!r.ok) return { ok: false, errorCode: r.code, message: r.message };
    const rest: Record<string, unknown> = { ...r };
    delete rest.ok;
    if (op === 'db.check') {
      return { ok: true, op: 'db.check', healthy: rest.ok_check === true, detail: String(rest.detail ?? '') };
    }
    return { ok: true, op, ...rest } as GhostPipeLibraryResult;
  }

  private async runOp(
    ghostId: string,
    session: GhostLibrarySession,
    op: string,
    req: Record<string, unknown>,
  ): Promise<GhostPipeLibraryResult> {
    // 漂移占位会话:open/status 如实报 unavailable+reason,其余操作全拒
    // (绝不当空库、绝不落默认根冒充)。
    if (session.drift !== null && op !== 'open' && op !== 'status') {
      return fail('LIBRARY_UNAVAILABLE', `Library 不可用(${session.drift});请在 Cindy 设置中重新确认存储位置`);
    }
    if (session.drift !== null) {
      return {
        ok: true as const, op: op as 'open' | 'status', state: 'unavailable' as const,
        reason: session.drift, usedBytes: 0, fileCount: 0, location: 'custom' as const,
      };
    }
    const vault = session.vault;
    switch (op) {
      case 'open': {
        const r = await vault.open();
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'open', state: r.state, reason: r.reason ?? undefined, usedBytes: r.usedBytes, fileCount: r.fileCount, location: session.locationKind };
      }
      case 'status': {
        const r = await vault.status();
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return {
          ok: true, op: 'status', state: r.state, reason: r.reason ?? undefined,
          usedBytes: r.usedBytes, fileCount: r.fileCount,
          diskFreeBytes: r.diskFreeBytes, softLimitBytes: r.softLimitBytes,
          softLimitExceeded: r.softLimitExceeded, location: r.location,
        };
      }
      case 'read': {
        const r = await vault.read({ path: req.path, encoding: req.encoding, offset: req.offset, length: req.length });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'read', path: r.path, content: r.content, encoding: r.encoding, bytes: r.bytes, sha256: r.sha256 };
      }
      case 'write': {
        const r = await vault.write({ path: req.path, content: req.content, encoding: req.encoding, ifNotExists: req.ifNotExists });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'write', path: r.path, bytes: r.bytes, sha256: r.sha256 };
      }
      case 'writeBegin': {
        const r = await vault.writeBegin({ path: req.path, totalBytes: req.totalBytes, sha256: req.sha256 });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'writeBegin', streamId: r.streamId };
      }
      case 'writeChunk': {
        const r = await vault.writeChunk({ streamId: req.streamId, seq: req.seq, content: req.content, encoding: req.encoding });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'writeChunk', accepted: r.accepted };
      }
      case 'writeCommit': {
        const r = await vault.writeCommit({ streamId: req.streamId });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'writeCommit', path: r.path, bytes: r.bytes, sha256: r.sha256 };
      }
      case 'writeAbort': {
        const r = await vault.writeAbort({ streamId: req.streamId });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'writeAbort', aborted: r.aborted };
      }
      case 'list': {
        const r = await vault.list({ path: req.path, recursive: req.recursive, cursor: req.cursor, limit: req.limit });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'list', entries: r.entries, hasMore: r.hasMore, nextCursor: r.nextCursor };
      }
      case 'stat': {
        const r = await vault.stat({ path: req.path });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'stat', path: r.path, kind: r.kind, bytes: r.bytes, mtime: r.mtime };
      }
      case 'mkdir': {
        const r = await vault.mkdir({ path: req.path });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'mkdir', path: r.path, existed: r.existed };
      }
      case 'delete': {
        const r = await vault.delete({ path: req.path, recursive: req.recursiveDelete });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'delete', path: r.path, existed: r.existed };
      }
      case 'rename': {
        const r = await vault.rename({ from: req.from, to: req.to, overwrite: req.overwrite });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, op: 'rename', from: r.from, to: r.to };
      }
      case 'db.open': {
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        // 父目录由宿主建好(better-sqlite3 只建文件不建目录)。
        await fs.promises.mkdir(path.dirname(resolved.abs), { recursive: true }).catch(() => {});
        const r = await session.sql.open(resolved.abs);
        return this.dbResultToPipe(op, r);
      }
      case 'db.exec': {
        const diskGate = await this.dbDiskGate(session);
        if (diskGate) return diskGate;
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        const r = await session.sql.exec(resolved.abs, req.sql as string, req.params);
        return this.dbResultToPipe(op, r);
      }
      case 'db.batch': {
        const diskGate = await this.dbDiskGate(session);
        if (diskGate) return diskGate;
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        const r = await session.sql.batch(resolved.abs, (req.statements as Array<{ sql: string; params?: unknown }>) ?? []);
        return this.dbResultToPipe(op, r);
      }
      case 'db.migrate': {
        const diskGate = await this.dbDiskGate(session);
        if (diskGate) return diskGate;
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        // 迁移前自动在线备份(宿主命名空间,插件路径语法写不进);备份失败
        // 是硬前置——报错中止,不带伤迁移。
        const backupDest = path.join(
          session.vault.getRootDir(), '.cindy-library', 'backups',
          `pre-migrate-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`,
        );
        await fs.promises.mkdir(path.dirname(backupDest), { recursive: true }).catch(() => {});
        const bak = await session.sql.backup(resolved.abs, backupDest);
        if (!bak.ok) return this.dbResultToPipe('db.backup', bak);
        const r = await session.sql.migrate(
          resolved.abs,
          Number(req.targetVersion ?? 0),
          (req.steps as Array<{ toVersion: number; sql: string[] }>) ?? [],
        );
        return this.dbResultToPipe(op, r);
      }
      case 'db.backup': {
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        const label = typeof req.label === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.label) ? req.label : 'manual';
        const dest = path.join(session.vault.getRootDir(), '.cindy-library', 'backups', `${label}-${Date.now()}.db`);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true }).catch(() => {});
        const r = await session.sql.backup(resolved.abs, dest);
        return this.dbResultToPipe(op, r);
      }
      case 'db.check': {
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        const r = await session.sql.check(resolved.abs);
        return this.dbResultToPipe(op, r);
      }
      case 'db.userVersion': {
        const resolved = await this.resolveDbPath(session, req.dbPath);
        if (!('abs' in resolved)) return resolved;
        const r = await session.sql.userVersion(resolved.abs);
        return this.dbResultToPipe(op, r);
      }
      default:
        return fail('PATH_INVALID', `未知 op:${op}`);
    }
  }
}
