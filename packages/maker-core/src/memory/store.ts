/**
 * MakerMemoryStore — per-workdir 的统一 facade, 把 storage (fs) 和 fts (sqlite) 组合在一起。
 *
 * 职责:
 *  - 对外只暴露一组方法: read / write / delete / list / search / getIndex / consolidate
 *  - 内部协调 storage 跟 fts 的同步: write/delete/consolidate 时触发 fts.upsert/delete
 *  - fts 同步失败不阻塞主路径 — 文件已落盘就算成功, fts 错误只 log warn
 *  - 启动时一次性 sanity check: storage 跟 fts 的 record count 不一致 → 全量 rebuild
 *
 * 不管:
 *  - workdir → 目录的 sanitize (manager 层算好后传 dir + dbPath)
 *  - SQLite Database 实例的生命周期 (manager 持有 + close)
 *  - Agent 联动 / mode 切换 (manager 层)
 *
 * 跨 session 一致性:
 *  本类是 per-workdir 单例 (manager 实例池保证), 同一 workdir 内多 session 共享同一个 store,
 *  内存里没有缓存的脏状态; 文件系统级别多 session 写撞到 OS 锁是小概率, rebuild 兜底。
 */

import type Database from 'better-sqlite3';

import { MemoryFts } from './fts.js';
import { MemoryStorage, sanitizeWorkdir, buildFilename, parseFilename } from './storage.js';
import {
  DEFAULT_MEMORY_CONFIG,
  MemoryError,
  type MemoryConfig,
  type MemoryRecord,
  type SearchHit,
  type SearchOptions,
  type WriteOptions,
  type WriteResult,
} from './types.js';
import type { Logger } from '../interfaces/logger.js';

export interface MakerMemoryStoreDeps {
  /** 已就绪的目录绝对路径 (manager 算好) */
  storageDir: string;
  /** 调用方记录的 workdir 绝对路径 (写进 meta.json) */
  absWorkdir: string;
  /** SQLite 实例 (host 注入, manager 创建并持有 close) */
  db: Database.Database;
  logger: Logger;
  /** 配置覆盖, 缺省走 DEFAULT_MEMORY_CONFIG */
  config?: Partial<MemoryConfig>;
}

export interface ConsolidateOptions {
  /** 要合并的源文件列表 (会被 delete) */
  sources: string[];
  /** 新生成条目的 type/name/title/description/body */
  target: WriteOptions;
}

export interface ConsolidateResult {
  ok: true;
  /** 新文件名 */
  filename: string;
  /** 实际删除的源文件 (源不存在的会被跳过) */
  deletedSources: string[];
  /** 软警告: 删源后按最终磁盘状态重算 (可能与写入时点不同, 也可能出现/消失); 重算失败退回写入时点值 */
  warning?: WriteResult['warning'];
  /** 软警告数值明细, 与 warning 同生同灭 */
  warningDetail?: WriteResult['warningDetail'];
}

export class MakerMemoryStore {
  private readonly storage: MemoryStorage;
  private readonly fts: MemoryFts;
  private readonly logger: Logger;
  private initialized = false;

  constructor(private readonly deps: MakerMemoryStoreDeps) {
    const config = { ...DEFAULT_MEMORY_CONFIG, ...(deps.config ?? {}) };
    this.storage = new MemoryStorage(deps.storageDir, config);
    this.fts = new MemoryFts(deps.db);
    this.logger = deps.logger;
  }

  /** mkdir + meta.json + FTS 表创建 + sanity check (count 不一致 → rebuild). 幂等。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.storage.init(this.deps.absWorkdir);
    this.fts.init();
    await this.sanityCheck();
    this.initialized = true;
  }

  // ── 直通 storage 的方法 (read 类) ────────────────────────────────────────

  async list(): Promise<MemoryRecord[]> {
    await this.init();
    return this.storage.list();
  }

  async read(filename: string): Promise<MemoryRecord> {
    await this.init();
    return this.storage.read(filename);
  }

  async getIndex(): Promise<string> {
    await this.init();
    return this.storage.getIndex();
  }

  async getIndexSize(): Promise<number> {
    await this.init();
    return this.storage.getIndexSize();
  }

  // ── 写入类 (storage + fts 两侧同步) ─────────────────────────────────────

  async write(opts: WriteOptions): Promise<WriteResult> {
    await this.init();
    const result = await this.storage.write(opts);
    // FTS 同步 — 失败只 warn, 文件已落盘
    try {
      const rec = await this.storage.read(result.filename);
      this.fts.upsert(rec);
    } catch (e) {
      this.logger.warn('memory fts upsert failed (file written ok, will rebuild on next sanity)', {
        filename: result.filename,
        error: String(e),
      });
    }
    return result;
  }

  async delete(filename: string): Promise<void> {
    await this.init();
    await this.storage.delete(filename);
    try {
      this.fts.delete(filename);
    } catch (e) {
      this.logger.warn('memory fts delete failed (file already removed, will rebuild on next sanity)', {
        filename,
        error: String(e),
      });
    }
  }

  // ── 检索 ─────────────────────────────────────────────────────────────────

  async search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    await this.init();
    return this.fts.search(query, opts);
  }

  // ── 合并 (LLM 在 size warning 后调) ─────────────────────────────────────

  /**
   * 原子化合并: 写入新条目 → 删源 → 重建索引一次。
   * 任意源不存在时跳过 (不抛), 真删过的列表回 deletedSources。
   * 失败时尽力恢复: 若新条目写失败直接抛; 若删除中途失败已删的不回滚 (文件系统不支持)。
   */
  async consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult> {
    await this.init();
    // 防呆: 不允许把 target 写到正要被删的 source 里 (否则会自删)
    const targetFilename = buildFilename(opts.target.type, opts.target.name);
    const sourcesToDelete = opts.sources.filter((s) => s !== targetFilename);

    // 写新的 (撞名时走 update)
    const writeOpts: WriteOptions = { ...opts.target };
    const targetExists = await this.tryReadRaw(targetFilename);
    if (targetExists) {
      writeOpts.mode = 'update';
    } else {
      writeOpts.mode = 'create';
    }
    const writeRes = await this.storage.write(writeOpts);

    // 删源
    const deleted: string[] = [];
    for (const src of sourcesToDelete) {
      try {
        await this.storage.delete(src);
        deleted.push(src);
      } catch (e) {
        if (e instanceof MemoryError && e.code === 'not-found') continue;
        this.logger.warn('consolidate: failed to delete source (continuing)', {
          source: src,
          error: String(e),
        });
      }
    }

    // FTS 同步 (整体重建一次, 比逐个 upsert/delete 简单且更不容易出错)
    try {
      const all = await this.storage.list();
      this.fts.rebuild(all);
    } catch (e) {
      this.logger.warn('consolidate fts rebuild failed', { error: String(e) });
    }

    // 删源后索引已变小, 写入时点的软警告可能失真 — 以最终磁盘状态重算;
    // 重算失败时退回写入时点的值 (宁可保守报警, 不静默丢警告)
    let finalDetail = writeRes.warningDetail;
    try {
      finalDetail = await this.storage.assessWarning(writeRes.filename);
    } catch (e) {
      this.logger.warn('consolidate: reassess warning failed, using write-time detail', {
        error: String(e),
      });
    }

    return {
      ok: true,
      filename: writeRes.filename,
      deletedSources: deleted,
      ...(finalDetail ? { warning: finalDetail.kind, warningDetail: finalDetail } : {}),
    };
  }

  /** 清空当前 workdir 全部 memory (manager.resetWorkdir 调). 慎用 */
  async resetAll(): Promise<{ removedCount: number }> {
    await this.init();
    const all = await this.storage.list();
    for (const r of all) {
      try { await this.storage.delete(r.filename); } catch { /* swallow */ }
    }
    try { this.fts.rebuild([]); } catch { /* swallow */ }
    return { removedCount: all.length };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /** storage 跟 fts count 不一致 → 全量 rebuild fts */
  private async sanityCheck(): Promise<void> {
    const fileCount = (await this.storage.list()).length;
    const ftsCount = this.fts.count();
    if (ftsCount === -1 || ftsCount !== fileCount) {
      this.logger.info('memory fts inconsistent, rebuilding', { fileCount, ftsCount });
      const all = await this.storage.list();
      this.fts.rebuild(all);
    }
  }

  private async tryReadRaw(filename: string): Promise<boolean> {
    if (!parseFilename(filename)) return false;
    try {
      await this.storage.read(filename);
      return true;
    } catch {
      return false;
    }
  }
}

// 跟 storage helper 同步导出, 让 manager 不用各处 import
export { sanitizeWorkdir, buildFilename, parseFilename };
export { memoryScopeDirName } from './storage.js';
