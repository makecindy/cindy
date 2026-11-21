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
/** query 上限 — 防病态输入把 LIKE 臂与 MATCH 表达式一起放大 */
const MAX_QUERY_CHARS = 200;
const MAX_QUERY_TERMS = 8;
/**
 * LIKE 臂分数基准: 远大于 bm25 的量级, 合并后仍排在 MATCH 命中之后;
 * 基准减去质量分, 让 LIKE 臂内部也按相关度排序 (score 越小越相关)。
 */
const LIKE_SCORE_BASE = 1_000_000_000;
/**
 * LIKE 臂候选池上限: 命中行数超过时先按字段命中/覆盖词数粗排, 只取前 N 条做精确
 * 打分 — 避免上千条命中时把所有 body 拉回主进程。候选之外的高密度文档会被放弃;
 * 500 是在 bounded latency 与召回之间取的平衡。
 */
const LIKE_CANDIDATE_LIMIT = 500;
/** 命中窗口: 命中位置前 60 / 后 120 字符 */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;
const SNIPPET_MAX_LEN = 200;

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
   * 全文检索. 召回顺序是兼容优先的三层:
   *  1. query 经 escapeFtsQuery 收成 phrase 走 FTS5 MATCH (AND/OR/NOT 被吞,
   *     见 escapeFtsQuery 说明), bm25 排序, snippet() 高亮;
   *  2. 整串 LIKE — 与改动前同一召回口径, 中文子串(如「边界」在「边界索引
   *     配置说明」中) 由它捞回;
   *  3. 前两层都为空时, 才按空白拆词做 OR 召回 (「登录 失败」不再直接归零),
   *     按字段权重 + 覆盖词数 + 正文密度打分。
   * 前两层有任何命中时结果集与改动前一致, 只改排序与片段; OR 只在零命中时兜底。
   * MATCH 已满 limit 时为 LIKE-only 子串命中预留 1 个名额, 避免其被整 token 命中遮蔽。
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const parsed = parseQuery(query);
    if (parsed.terms.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    // top = bm25 最佳 limit 条 (完整列); seen 用轻量查询取全部 MATCH 命中
    // filename, 保证 fallback 里只剩 MATCH 永远命不中的 true LIKE-only
    const top = this.searchMatch(parsed.matchQuery, opts, limit);
    const seen = new Set(this.searchMatchFilenames(parsed.matchQuery, opts));
    const phraseHits = this.searchLike([parsed.matchQuery], opts).filter((h) => !seen.has(h.filename));
    if (top.length > 0 || phraseHits.length > 0) {
      if (limit > 1 && top.length >= limit && phraseHits.length > 0) {
        // MATCH 已满 limit: 预留 1 个名额给 LIKE-only 子串命中, 避免中文子串结果
        // 被整 token 命中完全遮蔽 (limit=1 时不预留, 保住唯一最佳 MATCH)
        return [...top.slice(0, limit - 1), phraseHits[0]];
      }
      return [...top, ...phraseHits].slice(0, limit);
    }
    // 短语零命中才拆词: 单词 query 拆了还是同一条, 不需要再扫一遍;
    // 但重复词(「缓存 缓存」)去重后只剩一个词, 与整串不同, 仍要走这条兜底。
    if (parsed.terms.length === 1 && parsed.terms[0] === parsed.matchQuery) return [];
    return this.searchLike(parsed.terms, opts).slice(0, limit);
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
   * LIKE 臂: 每个词各一组 (title/description/body) 条件, OR 召回 — 多词查询不再
   * 要求原文出现同一字面串 (「登录 失败」命中「登录…失败」)。
   * 大小写不敏感(LIKE 默认 ASCII 不敏感, CJK 逐字节精确)。
   *
   * SQL 先按字段命中 + 覆盖词数粗排, 只取前 LIKE_CANDIDATE_LIMIT 条候选, 再在
   * JS 里按正文密度/长度精确打分 — 不再把所有命中行的 body 拉回主进程。
   * 候选之外的高密度文档会被放弃; 同分时短正文优先, 作为密度的一个廉价近似。
   */
  private searchLike(terms: readonly string[], opts: SearchOptions): SearchHit[] {
    const clauses = terms.map(
      () => `(title LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')`,
    );
    const whereParams: unknown[] = terms.flatMap((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return [pattern, pattern, pattern];
    });
    // 粗排与最终权重同源(字段 12/6/6, 覆盖词数做乘数), 只少密度与长度归一。
    const coarseParts = terms.map(
      () =>
        `(CASE WHEN instr(title, ?) > 0 THEN 12 ELSE 0 END` +
        ` + CASE WHEN instr(description, ?) > 0 THEN 6 ELSE 0 END` +
        ` + CASE WHEN instr(body, ?) > 0 THEN 6 ELSE 0 END)`,
    );
    const matchedParts = terms.map(
      () =>
        `(CASE WHEN instr(title, ?) > 0 OR instr(description, ?) > 0 OR instr(body, ?) > 0` +
        ` THEN 1 ELSE 0 END)`,
    );
    const coarseParams: unknown[] = terms.flatMap((term) => [term, term, term]);
    const params: unknown[] = [...coarseParams, ...coarseParams, ...whereParams];
    let sql = `SELECT filename, type, title, description, body,
                      (${coarseParts.join(' + ')}) * (${matchedParts.join(' + ')}) AS coarse
               FROM ${TABLE}
               WHERE (${clauses.join(' OR ')})`;
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    // 候选池截断: 同分时正文短的优先 (密度高的文档更像精确命中)。
    sql += ` ORDER BY coarse DESC, length(body) ASC, filename ASC LIMIT ${LIKE_CANDIDATE_LIMIT}`;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        filename: string;
        type: string;
        title: string;
        description: string;
        body: string;
      }>;
      const lowered = terms.map((term) => term.toLowerCase());
      const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      type Row = (typeof rows)[number];
      type ScoredRow = { row: Row; score: number; bodyHitAt: number };
      return rows
        .map((r): ScoredRow | null => {
          const scored = scoreLikeHit(r, lowered);
          if (scored.score <= 0) return null;
          return { row: r, score: scored.score, bodyHitAt: scored.bodyHitAt };
        })
        .filter((hit): hit is ScoredRow => hit !== null)
        .sort((a, b) => b.score - a.score || a.row.filename.localeCompare(b.row.filename))
        .slice(0, limit)
        // 只为最终返回的少数命中构建片段, 不在上千条命中上跑正则标记
        .map((hit): SearchHit => ({
          filename: hit.row.filename,
          type: hit.row.type as MemoryType,
          title: hit.row.title,
          snippet: buildLikeSnippet(hit.row, terms, hit.bodyHitAt),
          // 越小越相关: 基准 - 质量分, 仍排在 MATCH 命中之后、LIKE 臂内部有序
          score: LIKE_SCORE_BASE - Math.round(hit.score * 1000),
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

/**
 * 把 query 收成 MATCH 用的原文与 LIKE 用的词表。
 * MATCH 仍是整句 phrase (精度优先); 只有 phrase 与整串 LIKE 都零命中时,
 * 才用词表做 OR 兜底。
 */
function parseQuery(query: string): { matchQuery: string; terms: string[] } {
  const matchQuery = query.trim().slice(0, MAX_QUERY_CHARS);
  const terms = [...new Set(matchQuery.split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TERMS);
  return { matchQuery, terms };
}

/**
 * LIKE 臂打分: title 12 / description 6 / body 6 (出现次数加成, 按正文长度开方归一),
 * 多词 OR 兜底再乘覆盖词数。分数只用于 LIKE 臂内部排序。
 */
function scoreLikeHit(
  r: { title: string; description: string; body: string },
  terms: readonly string[],
): { score: number; bodyHitAt: number } {
  const title = r.title.toLowerCase();
  const description = r.description.toLowerCase();
  const body = r.body.toLowerCase();
  let score = 0;
  let matched = 0;
  let bodyHitAt = -1;

  for (const term of terms) {
    let hit = false;
    if (title.includes(term)) {
      score += 12;
      hit = true;
    }
    if (description.includes(term)) {
      score += 6;
      hit = true;
    }
    const pos = body.indexOf(term);
    if (pos >= 0) {
      hit = true;
      const count = countOccurrences(body, term, 6);
      const density = 1 + Math.min(count - 1, 4) * 0.5;
      score += (density * 6) / Math.sqrt(Math.max(1, body.length / 1000));
      if (bodyHitAt < 0 || pos < bodyHitAt) bodyHitAt = pos;
    }
    if (hit) matched += 1;
  }
  if (matched === 0) return { score: 0, bodyHitAt: -1 };

  if (terms.length > 1) {
    // 命中更多查询词更相关: 覆盖词数做乘数, 避免「一个词落在标题」压过
    // 「两个词都在正文」(如「缓存 日志」两个词都在正文的文档应排在只有日志的文档前)
    score *= matched;
  }

  return { score, bodyHitAt };
}

/** 命中窗口片段: body 优先, 没有 body 命中时退回 description/title, 关键词打 <mark> */
function buildLikeSnippet(
  r: { title: string; description: string; body: string },
  terms: readonly string[],
  bodyHitAt: number,
): string {
  if (bodyHitAt >= 0) {
    const start = Math.max(0, bodyHitAt - SNIPPET_BEFORE);
    const end = Math.min(r.body.length, bodyHitAt + SNIPPET_AFTER);
    const head = start > 0 ? '…' : '';
    const tail = end < r.body.length ? '…' : '';
    const text = `${head}${r.body.slice(start, end).replace(/\s+/g, ' ').trim()}${tail}`;
    return markTerms(truncate(text, SNIPPET_MAX_LEN), terms);
  }
  const source = [r.description, r.title].find((f) => f && containsAnyTerm(f, terms)) ?? r.title;
  return markTerms(truncate(source, SNIPPET_MAX_LEN), terms);
}

/** 单次替换 + 长词优先, 避免「登录」与「登录失败」互相嵌套 <mark> */
function markTerms(text: string, terms: readonly string[]): string {
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  const re = new RegExp(ordered.map(escapeRegExp).join('|'), 'gi');
  return text.replace(re, (m) => `<mark>${m}</mark>`);
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  let count = 0;
  let from = 0;
  while (count < cap) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}

function containsAnyTerm(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}
