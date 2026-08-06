/**
 * MemoryFts — 给 MakerMemory 分片挂 SQLite FTS5 全文检索 (Hermes 风格)。
 *
 * 设计取舍:
 *  - 用 standalone FTS5 (所有列存表内, 含 body) 而非 contentless / external content。
 *    理由: memory 量级小 (per-workdir 几十到一两百条), 空间开销可忽略;
 *    standalone 直接支持 snippet() 高亮, 不用维护内容→FTS 同步关系。
 *  - tokenize='porter unicode61' — porter stemming + unicode61 分词。⚠️ unicode61
 *    把**连续 CJK 文本当一个 token** ("数据分析链路"是单 token), 中文子串无法被
 *    phrase MATCH 命中; 因此 search 用 **MATCH + LIKE 兜底** 保证 CJK 召回
 *    (模式对齐 contacts/fts.ts)。不换 trigram: 它对 <3 字符查询(如"边界")返回空,
 *    且要重建存量 fts.db 表。
 *  - upsert = DELETE + INSERT (FTS5 没有 ON CONFLICT 子句)。
 *  - 不在 maker-core 加 better-sqlite3 runtime dep — 用 type-only import, 实例由 host
 *    (desktop) 注入, 跟 zero-electron-deps 边界一致。
 *
 * 失败原则:
 *  FTS5 同步失败不阻塞主流程 (调用方 storage.write 已经成功落盘) — 调用方 catch 后只 log,
 *  下次 rebuild 时检测到不一致重建。文件是 source of truth, FTS5 是派生索引。
 */

import type Database from 'better-sqlite3';

import {
  MemoryError,
  type MemoryRecord,
  type MemoryType,
  type SearchHit,
  type SearchOptions,
} from './types.js';

const TABLE = 'memory_fts';
const SNIPPET_TOKEN_RADIUS = 8; // snippet() 命中前后各取 N tokens
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** LIKE 兜底没有 snippet() 高亮, 用 body 前 N 字符顶替 (防 UI 展示超长原文) */
const SNIPPET_FALLBACK_LEN = 160;

export class MemoryFts {
  constructor(private readonly db: Database.Database) {}

  /** 创建 memory_fts 虚拟表 (idempotent). manager 启动时调一次。 */
  init(): void {
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(
         filename UNINDEXED,
         type UNINDEXED,
         title,
         description,
         body,
         tokenize='porter unicode61'
       );`,
    );
  }

  /** 写入或更新一条记录 (按 filename 去重) */
  upsert(record: MemoryRecord): void {
    const tx = this.db.transaction((rec: MemoryRecord) => {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE filename = ?`).run(rec.filename);
      this.db.prepare(
        `INSERT INTO ${TABLE}(filename, type, title, description, body) VALUES (?, ?, ?, ?, ?)`,
      ).run(rec.filename, rec.frontmatter.type, rec.frontmatter.title, rec.frontmatter.description, rec.body);
    });
    try {
      tx(record);
    } catch (e) {
      throw new MemoryError('io-error', `fts upsert failed: ${(e as Error).message}`);
    }
  }

  /** 按 filename 删除. 不存在 no-op (跟 fs delete 失败语义解耦) */
  delete(filename: string): void {
    try {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE filename = ?`).run(filename);
    } catch (e) {
      throw new MemoryError('io-error', `fts delete failed: ${(e as Error).message}`);
    }
  }

  /**
   * 全文检索. query 经 escapeFtsQuery 转义为 phrase 后走 FTS5 MATCH
   * (AND/OR/NOT 等高级语法会被转义吞掉, 见 escapeFtsQuery 说明)。
   * 返回按 bm25 排序 (越小越相关) 的命中, 含 snippet() 高亮片段。
   *
   * CJK 兜底: unicode61 把连续 CJK 文本当一个 token, MATCH 只能覆盖整 token 命中;
   * 中文子串(如「边界」在「边界索引配置说明」中) 只有 LIKE 扫描捞得到 —
   * 始终合并 LIKE 兜底结果并按 filename 去重; MATCH 已满 limit 时为 LIKE-only
   * 子串命中预留 1 个名额, 避免其被整 token 命中完全遮蔽。
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!query || query.trim().length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    // top = bm25 最佳 limit 条 (完整列); seen 用轻量查询取全部 MATCH 命中
    // filename, 保证 fallback 里只剩 MATCH 永远命不中的 true LIKE-only
    const top = this.searchMatch(query, opts, limit);
    const seen = new Set(this.searchMatchFilenames(query, opts));
    const fallback = this.searchLike(query, opts).filter((h) => !seen.has(h.filename));
    if (limit > 1 && top.length >= limit && fallback.length > 0) {
      // MATCH 已满 limit: 预留 1 个名额给 LIKE-only 子串命中, 避免中文子串结果
      // 被整 token 命中完全遮蔽 (limit=1 时不预留, 保住唯一最佳 MATCH)
      return [...top.slice(0, limit - 1), fallback[0]];
    }
    return [...top, ...fallback].slice(0, limit);
  }

  /** FTS5 MATCH 路径; query 语法错静默返空(让 LIKE 兜底接管) */
  private searchMatch(query: string, opts: SearchOptions, limit: number): SearchHit[] {
    const escapedQuery = escapeFtsQuery(query);

    let sql = `SELECT filename, type, title,
                      snippet(${TABLE}, -1, '<mark>', '</mark>', '…', ${SNIPPET_TOKEN_RADIUS}) AS snippet,
                      bm25(${TABLE}) AS score
               FROM ${TABLE}
               WHERE ${TABLE} MATCH ?`;
    const params: unknown[] = [escapedQuery];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY score LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        filename: string;
        type: string;
        title: string;
        snippet: string;
        score: number;
      }>;
      return rows.map((r) => ({
        filename: r.filename,
        type: r.type as MemoryType,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
      }));
    } catch (e) {
      // FTS5 query 语法错 (用户传了非法 token) 直接返空, 不抛 — 让 LLM 改写 query 重试。
      const msg = (e as Error).message;
      // 只吞明确的 MATCH 语法错误; 其他 FTS5 运行时错误 (snippet/bm25/索引损坏) 抛 io-error
      // 避免真实故障被静默吞掉、search 退化到 LIKE-only 而难以定位 (Copilot review 反馈)
      if (msg.includes('syntax error') || msg.includes('malformed MATCH expression')) return [];
      throw new MemoryError('io-error', `fts search failed: ${msg}`);
    }
  }

  /**
   * 轻量查询: 只取全部 MATCH 命中的 filename (不计算 snippet/bm25) —
   * 用于构建 seen 集合, 让 LIKE 兜底只剩 true LIKE-only 候选。
   */
  private searchMatchFilenames(query: string, opts: SearchOptions): string[] {
    const escapedQuery = escapeFtsQuery(query);
    let sql = `SELECT filename FROM ${TABLE} WHERE ${TABLE} MATCH ?`;
    const params: unknown[] = [escapedQuery];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{ filename: string }>;
      return rows.map((r) => r.filename);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('syntax error') || msg.includes('malformed MATCH expression')) return [];
      throw new MemoryError('io-error', `fts match-filenames failed: ${msg}`);
    }
  }

  /**
   * LIKE 子串兜底: 大小写不敏感(LIKE 默认 ASCII 不敏感, CJK 逐字节精确), 无 bm25/snippet。
   * 不做 SQL LIMIT — 由调用方去重后再截断: 否则 LIKE-only 命中排在 MATCH 双命中行
   * 之后时会被先截掉, 预留名额失效 (memory 量级小, 全扫可接受)。
   */
  private searchLike(query: string, opts: SearchOptions): SearchHit[] {
    const pattern = `%${escapeLikePattern(query.trim())}%`;
    let sql = `SELECT filename, type, title, description, body
               FROM ${TABLE}
               WHERE (title LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')`;
    const params: unknown[] = [pattern, pattern, pattern];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY filename`;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        filename: string;
        type: string;
        title: string;
        description: string;
        body: string;
      }>;
      return rows.map((r) => ({
        filename: r.filename,
        type: r.type as MemoryType,
        title: r.title,
        // snippet 优先取实际命中的字段 (title/description/body), 保证与命中原因相关
        snippet: truncate(hitField(r, query) ?? r.title, SNIPPET_FALLBACK_LEN),
        // LIKE 兜底无 bm25: 用大值表示"未排名", 排在所有 MATCH 命中之后 (score 越小越相关)
        score: Number.MAX_SAFE_INTEGER,
      }));
    } catch (e) {
      throw new MemoryError('io-error', `fts like-fallback failed: ${(e as Error).message}`);
    }
  }

  /**
   * 全量重建. 在事务内 DELETE + 重新 INSERT 所有 records。
   * 调用时机: storage 跟 fts 检测到不一致 (count 对不上) / 启动 sanity check / 手动触发。
   */
  rebuild(records: readonly MemoryRecord[]): void {
    const tx = this.db.transaction((recs: readonly MemoryRecord[]) => {
      this.db.exec(`DELETE FROM ${TABLE}`);
      const stmt = this.db.prepare(
        `INSERT INTO ${TABLE}(filename, type, title, description, body) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of recs) {
        stmt.run(r.filename, r.frontmatter.type, r.frontmatter.title, r.frontmatter.description, r.body);
      }
    });
    try {
      tx(records);
    } catch (e) {
      throw new MemoryError('io-error', `fts rebuild failed: ${(e as Error).message}`);
    }
  }

  /** 当前 FTS 表里的行数 — 用于 sanity check (跟 storage.list().length 对比) */
  count(): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number };
      return row.c;
    } catch {
      return -1; // 表不存在 / 损坏
    }
  }
}

/**
 * FTS5 query 转义 — 用户输入的特殊字符 (双引号/括号/列名前缀) 会被解析成语法 token,
 * 保险起见把整个 query 包成 phrase ("...") 走精确匹配, 同时把内部双引号 escape。
 *
 * 这样的副作用: AND/OR/NOT 这些 LLM 想用的 advanced query 也被吞了 — 短期可接受,
 * 后续如果 LLM 表达需求强, 可以加 "raw mode" 选项绕过。
 */
function escapeFtsQuery(q: string): string {
  return `"${q.trim().replace(/"/g, '""')}"`;
}

/**
 * LIKE 通配符转义. % _ 是 LIKE 语法字符, 用户 query 里出现时按字面匹配;
 * 转义符用 '!' (避开反斜杠, 省去 SQL/TS 双重转义的坑)。
 */
function escapeLikePattern(q: string): string {
  return q.replace(/[!%_]/g, (c) => `!${c}`);
}

/** LIKE 命中字段优先: title/description/body 中第一个包含 query 子串的字段 (ASCII 大小写不敏感) */
function hitField(r: { title: string; description: string; body: string }, query: string): string | undefined {
  const ql = query.trim().toLowerCase();
  return [r.title, r.description, r.body].find((f) => f && f.toLowerCase().includes(ql));
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}
