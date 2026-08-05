/**
 * ContactsFts — contacts 的 FTS5 派生索引维护与检索(模式对齐 memory/fts.ts)。
 *
 * 索引粒度: 每个 contact 一行, 把姓名/别名/全部身份值/简介/叙事/事件文本拍平进列。
 * 写路径由 store 在每次 mutation 后调 reindexContact(单行 delete+insert);
 * count 与主表不一致时由 store 的 sanity check 触发 rebuild。
 *
 * 失败原则: 主表(contacts 等关系表)才是 source of truth, FTS 同步失败不阻塞主流程 —
 * 调用方 catch 后 log warn, 下次 rebuild 自愈。
 */

import type Database from 'better-sqlite3';

import {
  ContactsError,
  type ContactKind,
  type ContactStatus,
  type ContactsSearchHit,
  type ContactsSearchOptions,
} from './types.js';

const TABLE = 'contacts_fts';
const SNIPPET_TOKEN_RADIUS = 8;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** 拍平后的一行索引文档(store 组装) */
export interface ContactFtsDoc {
  contactId: string;
  kind: ContactKind;
  status: ContactStatus;
  name: string;
  aliases: string;
  identities: string;
  summary: string;
  narrative: string;
  events: string;
  /** 关联文本(双向, "relation 对端名 note" 拼接) — 搜组织名可捞到成员 */
  relations: string;
}

export class ContactsFts {
  constructor(private readonly db: Database.Database) {}

  /** 单 contact 重建索引行(delete + insert, FTS5 无 ON CONFLICT) */
  reindex(doc: ContactFtsDoc): void {
    const tx = this.db.transaction((d: ContactFtsDoc) => {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE contact_id = ?`).run(d.contactId);
      this.db
        .prepare(
          `INSERT INTO ${TABLE}(contact_id, kind, status, name, aliases, identities, summary, narrative, events, relations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(d.contactId, d.kind, d.status, d.name, d.aliases, d.identities, d.summary, d.narrative, d.events, d.relations);
    });
    try {
      tx(doc);
    } catch (e) {
      throw new ContactsError('io-error', `fts reindex failed: ${(e as Error).message}`);
    }
  }

  /** 按 contactId 删除索引行. 不存在 no-op */
  delete(contactId: string): void {
    try {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE contact_id = ?`).run(contactId);
    } catch (e) {
      throw new ContactsError('io-error', `fts delete failed: ${(e as Error).message}`);
    }
  }

  /**
   * 全文检索: 先走 FTS5 MATCH(bm25 排序 + snippet 高亮), 零命中时回落 LIKE 子串扫描。
   *
   * 为什么要 LIKE 兜底: unicode61 tokenizer 把**连续 CJK 文本当一个 token**
   * ("通讯录设计方案"是单 token), phrase MATCH "设计方案" 无法命中其子串 —
   * 中文为主的通讯录里"按公司/项目关键词找人"会大面积漏检。契合量级
   * (per-user 通讯录几百到几千行)下 LIKE 全扫成本可忽略, 换确定性召回。
   */
  search(query: string, opts: ContactsSearchOptions = {}): ContactsSearchHit[] {
    if (!query || query.trim().length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const matched = this.searchMatch(query, opts, limit);
    if (matched.length >= limit) return matched;
    // MATCH 只覆盖整 token 命中; CJK 子串(「通讯录设计方案」含「设计方案」)只有
    // LIKE 扫描捞得到 — 部分命中时同样要合并兜底结果并按 contactId 去重,
    // 否则子串命中行被整 token 命中行遮蔽(MATCH 命中≥1 就提前返回的旧行为)
    const seen = new Set(matched.map((h) => h.contactId));
    const fallback = this.searchLike(query, opts, limit).filter((h) => !seen.has(h.contactId));
    return [...matched, ...fallback].slice(0, limit);
  }

  /** FTS5 MATCH 路径; query 语法错静默返空(让调用方回落/改写) */
  private searchMatch(query: string, opts: ContactsSearchOptions, limit: number): ContactsSearchHit[] {
    const escaped = escapeFtsQuery(query);

    let sql = `SELECT contact_id, kind, status,
                      snippet(${TABLE}, -1, '<mark>', '</mark>', '…', ${SNIPPET_TOKEN_RADIUS}) AS snip,
                      bm25(${TABLE}) AS score,
                      name, summary
               FROM ${TABLE}
               WHERE ${TABLE} MATCH ?`;
    const params: unknown[] = [escaped];
    if (opts.kind) {
      sql += ` AND kind = ?`;
      params.push(opts.kind);
    }
    if (opts.status) {
      sql += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.groupId) {
      sql += ` AND EXISTS (SELECT 1 FROM contact_group_members m WHERE m.group_id = ? AND m.contact_id = ${TABLE}.contact_id)`;
      params.push(opts.groupId);
    }
    sql += ` ORDER BY score LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        contact_id: string;
        kind: string;
        status: string;
        snip: string;
        score: number;
        name: string;
        summary: string;
      }>;
      return rows.map((r) => ({
        contactId: r.contact_id,
        kind: r.kind as ContactKind,
        displayName: r.name,
        summary: r.summary,
        status: r.status as ContactStatus,
        snippet: r.snip,
        score: r.score,
      }));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('fts5') || msg.includes('syntax error')) return [];
      throw new ContactsError('io-error', `fts search failed: ${msg}`);
    }
  }

  /** LIKE 子串兜底: 大小写不敏感(LIKE 默认 ASCII 不敏感, CJK 逐字节精确), 无 bm25/snippet */
  private searchLike(query: string, opts: ContactsSearchOptions, limit: number): ContactsSearchHit[] {
    const pattern = `%${escapeLikePattern(query.trim())}%`;
    let sql = `SELECT contact_id, kind, status, name, summary
               FROM ${TABLE}
               WHERE (name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR identities LIKE ? ESCAPE '\\'
                      OR summary LIKE ? ESCAPE '\\' OR narrative LIKE ? ESCAPE '\\' OR events LIKE ? ESCAPE '\\'
                      OR relations LIKE ? ESCAPE '\\')`;
    const params: unknown[] = [pattern, pattern, pattern, pattern, pattern, pattern, pattern];
    if (opts.kind) {
      sql += ` AND kind = ?`;
      params.push(opts.kind);
    }
    if (opts.status) {
      sql += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.groupId) {
      sql += ` AND EXISTS (SELECT 1 FROM contact_group_members m WHERE m.group_id = ? AND m.contact_id = ${TABLE}.contact_id)`;
      params.push(opts.groupId);
    }
    sql += ` LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        contact_id: string;
        kind: string;
        status: string;
        name: string;
        summary: string;
      }>;
      return rows.map((r) => ({
        contactId: r.contact_id,
        kind: r.kind as ContactKind,
        displayName: r.name,
        summary: r.summary,
        status: r.status as ContactStatus,
        snippet: r.summary || r.name,
        score: 0,
      }));
    } catch (e) {
      throw new ContactsError('io-error', `fts like-fallback failed: ${(e as Error).message}`);
    }
  }

  /** 全量重建(事务内 DELETE + 批量 INSERT) */
  rebuild(docs: readonly ContactFtsDoc[]): void {
    const tx = this.db.transaction((all: readonly ContactFtsDoc[]) => {
      this.db.exec(`DELETE FROM ${TABLE}`);
      const stmt = this.db.prepare(
        `INSERT INTO ${TABLE}(contact_id, kind, status, name, aliases, identities, summary, narrative, events, relations)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of all) {
        stmt.run(d.contactId, d.kind, d.status, d.name, d.aliases, d.identities, d.summary, d.narrative, d.events, d.relations);
      }
    });
    try {
      tx(docs);
    } catch (e) {
      throw new ContactsError('io-error', `fts rebuild failed: ${(e as Error).message}`);
    }
  }

  /** FTS 行数 — 与主表 count 对比做 sanity check */
  count(): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number };
      return row.c;
    } catch {
      return -1;
    }
  }
}

/** 与 memory/fts.ts 同策略: 整体包 phrase, 内部双引号 escape, 防语法注入 */
function escapeFtsQuery(q: string): string {
  return `"${q.trim().replace(/"/g, '""')}"`;
}

/** LIKE 通配符转义(% _ \), 配合 ESCAPE '\\' 使用 */
function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
