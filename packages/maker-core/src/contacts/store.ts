/**
 * MakerContactsStore — 智能通讯录的统一 facade(全局单库, 非 per-workdir)。
 *
 * 职责:
 *  - 实体 CRUD / 身份映射 / 事件流 / resolve / search / merge / stats 主链路
 *  - 分组子仓(groups.ts)组合直通; 行映射与只读查询在 rows.ts
 *  - 关系表与 FTS 派生索引同步: 每次 mutation 后 reindex 该 contact(失败只 warn)
 *  - init 时 sanity check: 主表与 FTS count 不一致 → 全量 rebuild
 *
 * 不管:
 *  - db 文件路径与生命周期(manager 创建并持有 close)
 *  - 功能开关(host 设置层)与工具暴露(@cindy/mcps 层)
 *
 * 并发: better-sqlite3 同步 API + 单进程单实例(manager 池保证), 无跨进程写者。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { findSimilarContacts, loadNameSnapshot, scanDuplicatePairs, type NameSnapshot } from './dedupe.js';
import { ContactsFts } from './fts.js';
import { ContactsGroupsRepo } from './groups.js';
import {
  buildFtsDoc,
  listEvents,
  listGroupsOf,
  listIdentities,
  listRelations,
  mapEntity,
  mapIdentity,
  parseAliases,
  type ContactRow,
  type IdentityRow,
} from './rows.js';
import { initContactsSchema } from './schema.js';
import {
  ContactsError,
  DEFAULT_CONTACTS_CONFIG,
  isContactKind,
  isContactSource,
  isContactStatus,
  normalizeIdentityValue,
  normalizePlatform,
  type AddIdentityInput,
  type AddRelationInput,
  type AppendEventInput,
  type ContactEvent,
  type ContactIdentity,
  type ContactKind,
  type ContactProfile,
  type ContactSummary,
  type ContactsConfig,
  type ContactsSearchHit,
  type ContactsSearchOptions,
  type ContactRelation,
  type ContactsStats,
  type DuplicateCandidate,
  type DuplicatePair,
  type EnrichResult,
  type CreateContactInput,
  type ListContactsOptions,
  type MergeResult,
  type ResolveHit,
  type ResolveOptions,
  type UpdateContactInput,
} from './types.js';
import type { Logger } from '../interfaces/logger.js';

export interface MakerContactsStoreDeps {
  /** 已 open 的 SQLite 实例(manager 创建并持有 close) */
  db: Database.Database;
  logger: Logger;
  config?: Partial<ContactsConfig>;
}

export class MakerContactsStore {
  private readonly db: Database.Database;
  private readonly fts: ContactsFts;
  private readonly groupsRepo: ContactsGroupsRepo;
  private readonly logger: Logger;
  private readonly config: ContactsConfig;
  private initialized = false;

  constructor(deps: MakerContactsStoreDeps) {
    this.db = deps.db;
    this.fts = new ContactsFts(deps.db);
    this.logger = deps.logger;
    this.config = { ...DEFAULT_CONTACTS_CONFIG, ...(deps.config ?? {}) };
    this.groupsRepo = new ContactsGroupsRepo(deps.db, this.config);
  }

  /** schema 迁移 + FTS sanity check. 幂等 */
  init(): void {
    if (this.initialized) return;
    initContactsSchema(this.db);
    this.sanityCheck();
    this.renormalizePhoneKeys();
    this.initialized = true;
  }

  /**
   * 幂等兜底: 早期写入的 phone 身份匹配键未剥格式字符, 与现行电话规范化口径
   * 不一致会漏配。逐条比对重写; 撞 UNIQUE(同号不同格式已各占一行)时 OR IGNORE
   * 保留原行 — 该情形本就是待人工 merge 的重复档案, 不在 init 里替用户裁决。
   */
  private renormalizePhoneKeys(): void {
    try {
      const rows = this.db
        .prepare(`SELECT id, value, normalized_value FROM contact_identities WHERE platform = 'phone'`)
        .all() as Array<{ id: string; value: string; normalized_value: string }>;
      const upd = this.db.prepare(`UPDATE OR IGNORE contact_identities SET normalized_value = ? WHERE id = ?`);
      for (const r of rows) {
        const canonical = normalizeIdentityValue(r.value, 'phone');
        if (canonical && canonical !== r.normalized_value) upd.run(canonical, r.id);
      }
    } catch (e) {
      this.logger.warn('contacts: phone key renormalize skipped', { error: String(e) });
    }
  }

  // ── 实体 CRUD ────────────────────────────────────────────────────────────

  createContact(input: CreateContactInput): ContactProfile {
    this.init();
    this.validateContactFields(input);
    if (!isContactKind(input.kind)) throw new ContactsError('invalid-params', `invalid kind: ${input.kind}`);
    const status = input.status ?? 'confirmed';
    if (!isContactStatus(status)) throw new ContactsError('invalid-params', `invalid status: ${status}`);
    const source = input.source ?? 'manual';
    if (!isContactSource(source)) throw new ContactsError('invalid-params', `invalid source: ${source}`);

    // 身份先校验+查冲突, 再进事务(错误信息带占用者 id, 引导 merge);
    // 入参内部按 (platform, normalized) 去重 — 导入记录常出现同值重复列出,
    // 不去重会穿过 assertIdentityFree 后在事务内撞 UNIQUE 抛裸 SqliteError
    const identities: Array<{ platform: string; value: string; normalized: string; label: string; note: string }> = [];
    const seenIdentity = new Set<string>();
    for (const i of input.identities ?? []) {
      const platform = normalizePlatform(i.platform);
      const value = i.value.trim();
      const normalized = normalizeIdentityValue(i.value, platform);
      if (!normalized) throw new ContactsError('invalid-params', 'identity value must not be empty');
      if (value.length > this.config.maxIdentityValueLen) {
        throw new ContactsError('invalid-params', `identity value too long (> ${this.config.maxIdentityValueLen})`);
      }
      const key = `${platform}\n${normalized}`;
      if (seenIdentity.has(key)) continue;
      seenIdentity.add(key);
      identities.push({ platform, value, normalized, label: i.label?.trim() ?? '', note: i.note?.trim() ?? '' });
    }
    if (identities.length > this.config.maxIdentitiesPerContact) {
      throw new ContactsError('invalid-params', `too many identities (> ${this.config.maxIdentitiesPerContact})`);
    }
    for (const i of identities) {
      this.assertIdentityFree(i.platform, i.normalized);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO contacts(id, kind, display_name, aliases, summary, narrative, agent_notes, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          input.displayName.trim(),
          JSON.stringify(input.aliases ?? []),
          input.summary?.trim() ?? '',
          input.narrative ?? '',
          input.agentNotes?.trim() ?? '',
          status,
          source,
          now,
          now,
        );
      const stmt = this.db.prepare(
        `INSERT INTO contact_identities(id, contact_id, platform, value, normalized_value, label, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of identities) {
        stmt.run(randomUUID(), id, i.platform, i.value, i.normalized, i.label, i.note, now);
      }
    });
    tx();
    this.reindexSafe(id);
    return this.getContact(id);
  }

  updateContact(id: string, patch: UpdateContactInput): ContactProfile {
    this.init();
    const before = this.db.prepare(`SELECT display_name FROM contacts WHERE id = ?`).get(id) as
      | { display_name: string }
      | undefined;
    if (!before) throw new ContactsError('not-found', `contact not found: ${id}`);
    this.validateContactFields(patch);
    if (patch.status !== undefined && !isContactStatus(patch.status)) {
      throw new ContactsError('invalid-params', `invalid status: ${patch.status}`);
    }
    if (patch.kind !== undefined && !isContactKind(patch.kind)) {
      throw new ContactsError('invalid-params', `invalid kind: ${patch.kind}`);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.kind !== undefined) push('kind', patch.kind);
    if (patch.displayName !== undefined) push('display_name', patch.displayName.trim());
    if (patch.aliases !== undefined) push('aliases', JSON.stringify(patch.aliases));
    if (patch.summary !== undefined) push('summary', patch.summary.trim());
    if (patch.narrative !== undefined) push('narrative', patch.narrative);
    if (patch.agentNotes !== undefined) push('agent_notes', patch.agentNotes.trim());
    if (patch.status !== undefined) push('status', patch.status);
    if (sets.length > 0) {
      push('updated_at', new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      this.reindexSafe(id);
      // 关系对端的 FTS 文档烤入了本人的 displayName(见 buildFtsDoc relations 列),
      // 改名必须连带重索引全部对端, 否则"搜新名捞关联人"漏检、旧名残留脏命中
      if (patch.displayName !== undefined && patch.displayName.trim() !== before.display_name) {
        for (const otherId of this.relatedContactIds(id)) this.reindexSafe(otherId);
      }
    }
    return this.getContact(id);
  }

  getContact(id: string): ContactProfile {
    this.init();
    const row = this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as ContactRow | undefined;
    if (!row) throw new ContactsError('not-found', `contact not found: ${id}`);
    return {
      ...mapEntity(row),
      identities: listIdentities(this.db, id),
      events: listEvents(this.db, id),
      groups: listGroupsOf(this.db, id),
      relations: listRelations(this.db, id),
    };
  }

  deleteContact(id: string): void {
    this.init();
    this.requireContact(id);
    // 对端 FTS 文档含本人名字, 删前收集受影响对端(删后关系行已级联消失查不到)
    const affected = this.relatedContactIds(id);
    // ON DELETE CASCADE 带走 identities/events/group members/relations
    this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(id);
    try {
      this.fts.delete(id);
    } catch (e) {
      this.logger.warn('contacts fts delete failed (row removed, rebuild will heal)', { id, error: String(e) });
    }
    for (const otherId of affected) this.reindexSafe(otherId);
  }

  listContacts(opts: ListContactsOptions = {}): ContactSummary[] {
    this.init();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) {
      where.push('c.kind = ?');
      params.push(opts.kind);
    }
    if (opts.status) {
      where.push('c.status = ?');
      params.push(opts.status);
    }
    if (opts.groupId) {
      where.push('c.id IN (SELECT contact_id FROM contact_group_members WHERE group_id = ?)');
      params.push(opts.groupId);
    }
    const sql = `SELECT c.*, (SELECT COUNT(*) FROM contact_identities i WHERE i.contact_id = c.id) AS identity_count
                 FROM contacts c
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY c.updated_at DESC
                 LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as Array<ContactRow & { identity_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as ContactSummary['kind'],
      displayName: r.display_name,
      aliases: parseAliases(r.aliases),
      summary: r.summary,
      status: r.status as ContactSummary['status'],
      source: r.source as ContactSummary['source'],
      identityCount: r.identity_count,
      updatedAt: r.updated_at,
    }));
  }

  // ── resolve / search ─────────────────────────────────────────────────────

  /**
   * 身份反查: 精确身份命中 → 名字/别名精确命中 → FTS 兜底, 三级递降。
   * matchType 告诉调用方命中路径(置信度从高到低), 同级内多命中都返回。
   */
  resolve(value: string, opts: ResolveOptions = {}): ResolveHit[] {
    this.init();
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const normalized = normalizeIdentityValue(value);
    if (!normalized) return [];

    // 1) 身份精确命中。电话匹配键剥了格式字符 — 无 platform 时把通用键与
    // 电话规范键都当候选(查询串带没带括号/横线都命中); 指定 platform 时
    // 用该平台口径的单键
    let idRows: IdentityRow[];
    if (opts.platform) {
      const platform = normalizePlatform(opts.platform);
      idRows = this.db
        .prepare(`SELECT * FROM contact_identities WHERE normalized_value = ? AND platform = ? LIMIT ?`)
        .all(normalizeIdentityValue(value, platform), platform, limit) as IdentityRow[];
    } else {
      const keys = [...new Set([normalized, normalizeIdentityValue(value, 'phone')])];
      idRows = this.db
        .prepare(
          `SELECT * FROM contact_identities WHERE normalized_value IN (${keys.map(() => '?').join(', ')}) LIMIT ?`,
        )
        .all(...keys, limit) as IdentityRow[];
    }
    if (idRows.length > 0) {
      return idRows.map((r) => ({
        matchType: 'identity' as const,
        identity: mapIdentity(r),
        profile: this.getContact(r.contact_id),
      }));
    }

    // platform 是消歧参数(如"查 github handle may 的那个人"): 指定后只认该平台的
    // 身份精确命中 — 名字/FTS 兜底会把恰好同名、但不持有该平台身份的人当命中
    // 返回, 调用方按 platform 消歧却拿到错人, 比查无此人更糟
    if (opts.platform) return [];

    // 2) 显示名/别名精确命中(大小写不敏感; alias 存 JSON, 用 EXISTS + json_each)
    const nameRows = this.findIdsByExactName(normalized, limit);
    if (nameRows.length > 0) {
      return nameRows.map((r) => ({ matchType: 'name' as const, profile: this.getContact(r.id) }));
    }

    // 3) FTS 兜底 — 单条幽灵行(fts.delete 曾失败留下的 stale 命中)跳过, 不让整个 resolve 崩掉
    const hits: ResolveHit[] = [];
    for (const h of this.fts.search(value, { limit })) {
      try {
        hits.push({ matchType: 'fts' as const, profile: this.getContact(h.contactId) });
      } catch {
        this.logger.warn('contacts resolve: stale fts hit skipped (rebuild will heal)', { contactId: h.contactId });
      }
    }
    return hits;
  }

  /**
   * 显示名/别名精确命中(resolve tier-2 语义, 不走身份/FTS)。导入 org 归并这类
   * "名字即键"的场景用 — identity 优先的 resolve 会被恰好同值的无关身份(如某人
   * 的 handle 撞公司名)在 tier-1 短路, 名字层的真命中永远到不了。
   */
  findByExactName(value: string, opts: { kind?: ContactKind; limit?: number } = {}): ContactProfile[] {
    this.init();
    const normalized = normalizeIdentityValue(value);
    if (!normalized) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    return this.findIdsByExactName(normalized, limit, opts.kind).map((r) => this.getContact(r.id));
  }

  /** tier-2 名字精确匹配的共享 SQL(resolve 与 findByExactName 共用, 口径保持一致) */
  private findIdsByExactName(normalized: string, limit: number, kind?: ContactKind): Array<{ id: string }> {
    let sql = `SELECT id FROM contacts
         WHERE (lower(display_name) = ?
            OR EXISTS (SELECT 1 FROM json_each(contacts.aliases) WHERE lower(json_each.value) = ?))`;
    const params: unknown[] = [normalized, normalized];
    if (kind) {
      sql += ` AND kind = ?`;
      params.push(kind);
    }
    return this.db.prepare(`${sql} LIMIT ?`).all(...params, limit) as Array<{ id: string }>;
  }

  search(query: string, opts?: ContactsSearchOptions): ContactsSearchHit[] {
    this.init();
    return this.fts.search(query, opts);
  }

  // ── 身份映射 ─────────────────────────────────────────────────────────────

  addIdentity(contactId: string, input: AddIdentityInput): ContactIdentity {
    this.init();
    this.requireContact(contactId);
    const platform = normalizePlatform(input.platform);
    const value = input.value.trim();
    const normalized = normalizeIdentityValue(value, platform);
    if (!normalized) throw new ContactsError('invalid-params', 'identity value must not be empty');
    if (value.length > this.config.maxIdentityValueLen) {
      throw new ContactsError('invalid-params', `identity value too long (> ${this.config.maxIdentityValueLen})`);
    }
    this.assertIdentityFree(platform, normalized, contactId);
    const count = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM contact_identities WHERE contact_id = ?`).get(contactId) as {
        c: number;
      }
    ).c;
    if (count >= this.config.maxIdentitiesPerContact) {
      throw new ContactsError('invalid-params', `identity limit reached (${this.config.maxIdentitiesPerContact})`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO contact_identities(id, contact_id, platform, value, normalized_value, label, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, contactId, platform, value, normalized, input.label?.trim() ?? '', input.note?.trim() ?? '', now);
    this.touch(contactId);
    this.reindexSafe(contactId);
    return {
      id,
      contactId,
      platform,
      value,
      normalizedValue: normalized,
      label: input.label?.trim() ?? '',
      note: input.note?.trim() ?? '',
      createdAt: now,
    };
  }

  removeIdentity(identityId: string): void {
    this.init();
    const row = this.db.prepare(`SELECT contact_id FROM contact_identities WHERE id = ?`).get(identityId) as
      | { contact_id: string }
      | undefined;
    if (!row) throw new ContactsError('not-found', `identity not found: ${identityId}`);
    this.db.prepare(`DELETE FROM contact_identities WHERE id = ?`).run(identityId);
    this.touch(row.contact_id);
    this.reindexSafe(row.contact_id);
  }

  // ── 事件流 ───────────────────────────────────────────────────────────────

  appendEvent(contactId: string, input: AppendEventInput): ContactEvent {
    this.init();
    this.requireContact(contactId);
    const date = input.date.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(date)) {
      throw new ContactsError('invalid-params', `event date must be YYYY-MM-DD or YYYY-MM, got: ${input.date}`);
    }
    const text = input.text.trim();
    if (!text) throw new ContactsError('invalid-params', 'event text must not be empty');
    if (text.length > this.config.maxEventTextLen) {
      throw new ContactsError('invalid-params', `event text too long (> ${this.config.maxEventTextLen})`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO contact_events(id, contact_id, date, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, contactId, date, text, input.source?.trim() ?? '', now);
    this.touch(contactId);
    this.reindexSafe(contactId);
    return { id, contactId, date, text, source: input.source?.trim() ?? '', createdAt: now };
  }

  deleteEvent(eventId: string): void {
    this.init();
    const row = this.db.prepare(`SELECT contact_id FROM contact_events WHERE id = ?`).get(eventId) as
      | { contact_id: string }
      | undefined;
    if (!row) throw new ContactsError('not-found', `event not found: ${eventId}`);
    this.db.prepare(`DELETE FROM contact_events WHERE id = ?`).run(eventId);
    this.reindexSafe(row.contact_id);
  }

  // ── 关系边 ───────────────────────────────────────────────────────────────

  /** 建立有向关系 from --relation--> to。同 (from,to,relation) 重复抛 already-exists */
  addRelation(fromId: string, input: AddRelationInput): ContactRelation {
    this.init();
    this.requireContact(fromId);
    this.requireContact(input.toId);
    if (fromId === input.toId) throw new ContactsError('invalid-params', 'cannot relate a contact to itself');
    const relation = input.relation.trim();
    if (!relation || relation.length > this.config.maxRelationLen) {
      throw new ContactsError('invalid-params', `relation must be 1..${this.config.maxRelationLen} chars`);
    }
    const dup = this.db
      .prepare(`SELECT id FROM contact_relations WHERE from_id = ? AND to_id = ? AND relation = ?`)
      .get(fromId, input.toId, relation);
    if (dup) throw new ContactsError('already-exists', `relation already exists: ${relation}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO contact_relations(id, from_id, to_id, relation, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fromId, input.toId, relation, input.note?.trim() ?? '', now);
    // 关系文本进双方的 FTS 文档(对端以 in 方向可见)
    this.reindexSafe(fromId);
    this.reindexSafe(input.toId);
    return { id, fromId, toId: input.toId, relation, note: input.note?.trim() ?? '', createdAt: now };
  }

  removeRelation(relationId: string): void {
    this.init();
    const row = this.db.prepare(`SELECT from_id, to_id FROM contact_relations WHERE id = ?`).get(relationId) as
      | { from_id: string; to_id: string }
      | undefined;
    if (!row) throw new ContactsError('not-found', `relation not found: ${relationId}`);
    this.db.prepare(`DELETE FROM contact_relations WHERE id = ?`).run(relationId);
    this.reindexSafe(row.from_id);
    this.reindexSafe(row.to_id);
  }

  // ── 同人识别 / 富集(去重的确定性入口) ───────────────────────────────────

  /**
   * 疑似同人候选: identity 精确撞(=同人) 优先, 名字面相似(疑似)其次。
   * snapshot 由批量导入传入(批内共享+增量追加, 避免每条记录全表扫), 单次调用不用传。
   */
  findSimilar(input: CreateContactInput, snapshot?: NameSnapshot): DuplicateCandidate[] {
    this.init();
    return findSimilarContacts(this.db, input, snapshot);
  }

  /** 全库名字面快照(import 管道批内缓存用, 见 dedupe.loadNameSnapshot) */
  createNameSnapshot(): NameSnapshot {
    this.init();
    return loadNameSnapshot(this.db);
  }

  /** 全库疑似重复对扫描(维护工具消费) */
  findDuplicatePairs(limit?: number): DuplicatePair[] {
    this.init();
    return scanDuplicatePairs(this.db, limit);
  }

  /**
   * 把"新采集到的一份档案"并入已有档案(identity 撞档时的自动归并路径):
   * 别名并集(含新显示名)、空字段填充、叙事追加(带标注)、身份逐条尝试添加
   * (归属它人的跳过并记录)。status 保持原值(pending 的裁决权在用户)。
   */
  enrichContact(id: string, input: CreateContactInput): EnrichResult {
    this.init();
    const existing = this.getContact(id);
    this.validateContactFields(input);

    // 身份先全量预检(normalize 非法 / 值超长的挑出来记 invalid), 再动库 —
    // 否则字段已 UPDATE 落库后身份循环中途抛错, 留下半套写入还被上游记成 skipped
    const validIdentities: NonNullable<CreateContactInput['identities']> = [];
    const skippedIdentities: EnrichResult['skippedIdentities'] = [];
    for (const i of input.identities ?? []) {
      try {
        normalizePlatform(i.platform);
        if (!normalizeIdentityValue(i.value, i.platform)) throw new ContactsError('invalid-params', 'empty identity value');
        if (i.value.trim().length > this.config.maxIdentityValueLen) {
          throw new ContactsError('invalid-params', 'identity value too long');
        }
        validIdentities.push(i);
      } catch {
        skippedIdentities.push({ platform: String(i.platform), value: String(i.value), reason: 'invalid' });
      }
    }

    // 别名并集: 新显示名(若与现名不同)+ 新别名, 去重且不超上限
    const aliasSet = new Set(existing.aliases.map((a) => a.toLowerCase()));
    const addedAliases: string[] = [];
    for (const cand of [input.displayName, ...(input.aliases ?? [])]) {
      const trimmed = cand.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase() === existing.displayName.toLowerCase()) continue;
      if (aliasSet.has(trimmed.toLowerCase())) continue;
      if (existing.aliases.length + addedAliases.length >= this.config.maxAliases) break;
      aliasSet.add(trimmed.toLowerCase());
      addedAliases.push(trimmed);
    }

    const filledFields: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (addedAliases.length > 0) push('aliases', JSON.stringify([...existing.aliases, ...addedAliases]));
    if (!existing.summary && input.summary?.trim()) {
      push('summary', input.summary.trim());
      filledFields.push('summary');
    }
    if (!existing.agentNotes && input.agentNotes?.trim()) {
      push('agent_notes', input.agentNotes.trim());
      filledFields.push('agentNotes');
    }
    let narrativeAppended = false;
    const newNarrative = input.narrative?.trim() ?? '';
    if (newNarrative && !existing.narrative) {
      push('narrative', newNarrative);
      filledFields.push('narrative');
    } else if (newNarrative && !existing.narrative.includes(newNarrative)) {
      const combined = `${existing.narrative}\n\n<!-- agent enrich ${new Date().toISOString().slice(0, 10)} -->\n${newNarrative}`;
      if (Buffer.byteLength(combined, 'utf8') <= this.config.maxNarrativeBytes) {
        push('narrative', combined);
        narrativeAppended = true;
      }
    }
    if (sets.length > 0) {
      push('updated_at', new Date().toISOString());
      params.push(id);
      this.db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    // 身份逐条尝试: 无主 → 加入; 已在本人 → 跳过; 归属它人 → 跳过并记录;
    // 数量到上限(invalid-params) → 跳过 — enrich 语义是尽力并入, 单条不打断整体
    let addedIdentities = 0;
    for (const i of validIdentities) {
      try {
        this.addIdentity(id, {
          platform: i.platform,
          value: i.value,
          ...(i.label !== undefined ? { label: i.label } : {}),
          ...(i.note !== undefined ? { note: i.note } : {}),
        });
        addedIdentities += 1;
      } catch (e) {
        if (e instanceof ContactsError && e.code === 'already-exists') {
          skippedIdentities.push({ platform: i.platform, value: i.value, reason: 'already-exists' });
        } else if (e instanceof ContactsError && e.code === 'identity-conflict') {
          skippedIdentities.push({
            platform: i.platform,
            value: i.value,
            reason: 'conflict-other',
            ...(e.conflictContactId ? { conflictContactId: e.conflictContactId } : {}),
          });
        } else if (e instanceof ContactsError && e.code === 'invalid-params') {
          skippedIdentities.push({ platform: i.platform, value: i.value, reason: 'invalid' });
        } else {
          throw e;
        }
      }
    }

    this.touch(id);
    this.reindexSafe(id);
    return { ok: true, contactId: id, addedAliases, addedIdentities, skippedIdentities, filledFields, narrativeAppended };
  }

  // ── 合并(重复档案治理) ───────────────────────────────────────────────────

  /**
   * 把 sourceId 并入 targetId 后删除 source:
   * 身份/事件/分组成员整体迁移, 别名取并集, 叙事拼接(带分隔注记), source 档案删除。
   * 全程单事务; FTS 事务外同步。
   */
  merge(targetId: string, sourceId: string): MergeResult {
    this.init();
    if (targetId === sourceId) throw new ContactsError('invalid-params', 'cannot merge a contact into itself');
    const target = this.getContact(targetId);
    const source = this.getContact(sourceId);

    const now = new Date().toISOString();
    // 别名并集大小写不敏感去重(与 enrich 口径一致), 不含 target 显示名
    const aliasSeen = new Set([target.displayName.toLowerCase()]);
    const mergedAliases: string[] = [];
    for (const a of [...target.aliases, source.displayName, ...source.aliases]) {
      const key = a.trim().toLowerCase();
      if (!key || aliasSeen.has(key)) continue;
      aliasSeen.add(key);
      mergedAliases.push(a.trim());
      if (mergedAliases.length >= this.config.maxAliases) break;
    }
    // 叙事拼接按 maxNarrativeBytes 兜底(与 enrichContact 追加同口径): 不校验会把
    // 超限行值直接落库, 之后所有 enrich 追加都因 combined 超限静默跳过且无从解释。
    // 超限时保留 target 全文、从尾部截断拼接结果, 并在返回值标注 truncated。
    let mergedNarrative = source.narrative
      ? `${target.narrative}${target.narrative ? '\n\n' : ''}<!-- merged from "${source.displayName}" -->\n${source.narrative}`
      : target.narrative;
    let narrativeTruncated = false;
    while (
      Buffer.byteLength(mergedNarrative, 'utf8') > this.config.maxNarrativeBytes &&
      mergedNarrative.length > target.narrative.length
    ) {
      narrativeTruncated = true;
      // 每次砍 256 个 code unit 直到达标(≤64 轮), 下界钉在 target 原文长度 —
      // target 落库时已过校验必然合规, source 段才是被牺牲的部分; 按 code unit
      // 切而非字节切, 避免劈开多字节字符
      mergedNarrative = mergedNarrative.slice(0, Math.max(target.narrative.length, mergedNarrative.length - 256));
    }
    // summary/agentNotes 沿用 enrich 的 fill-if-empty 语义 — agentNotes 是处置
    // 指令("勿群发"类), 随 source 删除静默蒸发有实际风险
    const mergedSummary = target.summary || source.summary;
    const mergedAgentNotes = target.agentNotes || source.agentNotes;
    // source 的关系对端 FTS 文档烤着 source 的名字, 迁移/清理后要重索引
    const affected = this.relatedContactIds(sourceId).filter((cid) => cid !== targetId);

    const tx = this.db.transaction(() => {
      // 分组成员先迁(PK 冲突用 OR IGNORE, 残留行随 source 级联删除), 再迁身份/事件
      this.db
        .prepare(`UPDATE OR IGNORE contact_group_members SET contact_id = ? WHERE contact_id = ?`)
        .run(targetId, sourceId);
      this.db.prepare(`UPDATE contact_identities SET contact_id = ? WHERE contact_id = ?`).run(targetId, sourceId);
      this.db.prepare(`UPDATE contact_events SET contact_id = ? WHERE contact_id = ?`).run(targetId, sourceId);
      // 关系边迁移: (from,to,relation) 撞唯一约束的用 OR IGNORE(残留随 source 级联删);
      // source↔target 之间的关系迁移后变自环, 显式清掉
      this.db
        .prepare(`UPDATE OR IGNORE contact_relations SET from_id = ? WHERE from_id = ?`)
        .run(targetId, sourceId);
      this.db.prepare(`UPDATE OR IGNORE contact_relations SET to_id = ? WHERE to_id = ?`).run(targetId, sourceId);
      this.db.prepare(`DELETE FROM contact_relations WHERE from_id = to_id`).run();
      this.db
        .prepare(`UPDATE contacts SET aliases = ?, summary = ?, agent_notes = ?, narrative = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(mergedAliases), mergedSummary, mergedAgentNotes, mergedNarrative, now, targetId);
      this.db.prepare(`DELETE FROM contacts WHERE id = ?`).run(sourceId);
    });
    tx();

    try {
      this.fts.delete(sourceId);
    } catch (e) {
      this.logger.warn('merge: fts delete of source failed', { sourceId, error: String(e) });
    }
    this.reindexSafe(targetId);
    for (const otherId of affected) this.reindexSafe(otherId);
    return {
      ok: true,
      targetId,
      mergedId: sourceId,
      movedIdentities: source.identities.length,
      movedEvents: source.events.length,
      ...(narrativeTruncated ? { narrativeTruncated: true } : {}),
    };
  }

  // ── 分组(直通 groups 子仓) ───────────────────────────────────────────────

  createGroup(name: string, description = '') {
    this.init();
    return this.groupsRepo.createGroup(name, description);
  }

  updateGroup(id: string, patch: { name?: string; description?: string }) {
    this.init();
    return this.groupsRepo.updateGroup(id, patch);
  }

  deleteGroup(id: string): void {
    this.init();
    this.groupsRepo.deleteGroup(id);
  }

  listGroups() {
    this.init();
    return this.groupsRepo.listGroups();
  }

  addToGroup(groupId: string, contactIds: string[]): void {
    this.init();
    this.groupsRepo.addToGroup(groupId, contactIds);
  }

  removeFromGroup(groupId: string, contactIds: string[]): void {
    this.init();
    this.groupsRepo.removeFromGroup(groupId, contactIds);
  }

  // ── 统计 / 重置 ──────────────────────────────────────────────────────────

  stats(): ContactsStats {
    this.init();
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      people: count(`SELECT COUNT(*) AS c FROM contacts WHERE kind = 'person'`),
      orgs: count(`SELECT COUNT(*) AS c FROM contacts WHERE kind = 'org'`),
      pending: count(`SELECT COUNT(*) AS c FROM contacts WHERE status = 'pending'`),
      groups: count(`SELECT COUNT(*) AS c FROM contact_groups`),
    };
  }

  /** 清空整个通讯录(UI 二次确认后调). 慎用 */
  resetAll(): { removedCount: number } {
    this.init();
    const c = (this.db.prepare(`SELECT COUNT(*) AS c FROM contacts`).get() as { c: number }).c;
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM contacts; DELETE FROM contact_groups;`);
    });
    tx();
    try {
      this.fts.rebuild([]);
    } catch {
      /* rebuild on next sanity */
    }
    return { removedCount: c };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private requireContact(id: string): void {
    const row = this.db.prepare(`SELECT id FROM contacts WHERE id = ?`).get(id);
    if (!row) throw new ContactsError('not-found', `contact not found: ${id}`);
  }

  /** (platform, normalized) 被其他 contact 占用时抛 identity-conflict(带占用者 id) */
  private assertIdentityFree(platform: string, normalized: string, selfContactId?: string): void {
    const row = this.db
      .prepare(`SELECT contact_id FROM contact_identities WHERE platform = ? AND normalized_value = ?`)
      .get(platform, normalized) as { contact_id: string } | undefined;
    if (!row) return;
    if (row.contact_id !== selfContactId) {
      throw new ContactsError(
        'identity-conflict',
        `identity ${platform}:${normalized} already belongs to contact ${row.contact_id}`,
        row.contact_id,
      );
    }
    throw new ContactsError('already-exists', `identity ${platform}:${normalized} already on this contact`);
  }

  private validateContactFields(input: Partial<CreateContactInput | UpdateContactInput>): void {
    const c = this.config;
    if (input.displayName !== undefined) {
      const n = input.displayName.trim();
      if (!n || n.length > c.maxDisplayNameLen) {
        throw new ContactsError('invalid-params', `displayName must be 1..${c.maxDisplayNameLen} chars`);
      }
    }
    if (input.aliases !== undefined) {
      if (input.aliases.length > c.maxAliases) {
        throw new ContactsError('invalid-params', `too many aliases (> ${c.maxAliases})`);
      }
      for (const a of input.aliases) {
        if (!a.trim() || a.length > c.maxDisplayNameLen) {
          throw new ContactsError('invalid-params', 'alias must be non-empty and within length limit');
        }
      }
    }
    if (input.summary !== undefined && input.summary.length > c.maxSummaryLen) {
      throw new ContactsError('invalid-params', `summary too long (> ${c.maxSummaryLen})`);
    }
    if (input.narrative !== undefined && Buffer.byteLength(input.narrative, 'utf8') > c.maxNarrativeBytes) {
      throw new ContactsError('invalid-params', `narrative too large (> ${c.maxNarrativeBytes} bytes)`);
    }
    if (input.agentNotes !== undefined && input.agentNotes.length > c.maxAgentNotesLen) {
      throw new ContactsError('invalid-params', `agentNotes too long (> ${c.maxAgentNotesLen})`);
    }
  }

  /** 与该 contact 有关系边的全部对端 id(改名/删除/合并后对端 FTS 需重索引) */
  private relatedContactIds(contactId: string): string[] {
    const rows = this.db
      .prepare(`SELECT from_id, to_id FROM contact_relations WHERE from_id = ? OR to_id = ?`)
      .all(contactId, contactId) as Array<{ from_id: string; to_id: string }>;
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.from_id === contactId ? r.to_id : r.from_id);
    }
    ids.delete(contactId);
    return [...ids];
  }

  private touch(contactId: string): void {
    this.db.prepare(`UPDATE contacts SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), contactId);
  }

  /** 拍平一个 contact 的全部可检索文本, 重建其 FTS 行. 失败只 warn(rebuild 自愈) */
  private reindexSafe(contactId: string): void {
    try {
      const doc = buildFtsDoc(this.db, contactId);
      if (doc) this.fts.reindex(doc);
    } catch (e) {
      this.logger.warn('contacts fts reindex failed (will heal on next rebuild)', {
        contactId,
        error: String(e),
      });
    }
  }

  /** 主表与 FTS count 不一致 → 全量 rebuild */
  private sanityCheck(): void {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM contacts`).get() as { c: number }).c;
    const ftsCount = this.fts.count();
    if (ftsCount === -1 || ftsCount !== total) {
      this.logger.info('contacts fts inconsistent, rebuilding', { total, ftsCount });
      const ids = this.db.prepare(`SELECT id FROM contacts`).all() as Array<{ id: string }>;
      const docs = ids
        .map((r) => buildFtsDoc(this.db, r.id))
        .filter((d): d is NonNullable<typeof d> => d !== null);
      this.fts.rebuild(docs);
    }
  }
}
