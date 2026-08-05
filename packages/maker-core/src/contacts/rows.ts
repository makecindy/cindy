/**
 * contacts 行映射与只读查询 helper — store / groups 共用的 row → 领域对象转换,
 * 以及拍平 FTS 文档的组装。无状态纯函数, 全部以 db 为首参。
 */

import type Database from 'better-sqlite3';

import type { ContactFtsDoc } from './fts.js';
import type {
  ContactEntity,
  ContactEvent,
  ContactGroup,
  ContactIdentity,
  ContactKind,
  RelatedContactRef,
} from './types.js';

export interface ContactRow {
  id: string;
  kind: string;
  display_name: string;
  aliases: string;
  summary: string;
  narrative: string;
  agent_notes: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface IdentityRow {
  id: string;
  contact_id: string;
  platform: string;
  value: string;
  normalized_value: string;
  label: string;
  note: string;
  created_at: string;
}

export function parseAliases(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function mapIdentity(r: IdentityRow): ContactIdentity {
  return {
    id: r.id,
    contactId: r.contact_id,
    platform: r.platform,
    value: r.value,
    normalizedValue: r.normalized_value,
    label: r.label,
    note: r.note,
    createdAt: r.created_at,
  };
}

export function mapEntity(row: ContactRow): ContactEntity {
  return {
    id: row.id,
    kind: row.kind as ContactEntity['kind'],
    displayName: row.display_name,
    aliases: parseAliases(row.aliases),
    summary: row.summary,
    narrative: row.narrative,
    agentNotes: row.agent_notes,
    status: row.status as ContactEntity['status'],
    source: row.source as ContactEntity['source'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listIdentities(db: Database.Database, contactId: string): ContactIdentity[] {
  const rows = db
    .prepare(`SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY created_at`)
    .all(contactId) as IdentityRow[];
  return rows.map(mapIdentity);
}

export function listEvents(db: Database.Database, contactId: string): ContactEvent[] {
  const rows = db
    .prepare(`SELECT * FROM contact_events WHERE contact_id = ? ORDER BY date DESC, created_at DESC`)
    .all(contactId) as Array<{
    id: string;
    contact_id: string;
    date: string;
    text: string;
    source: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    date: r.date,
    text: r.text,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export function listGroupsOf(db: Database.Database, contactId: string): ContactGroup[] {
  const rows = db
    .prepare(
      `SELECT g.* FROM contact_groups g
       JOIN contact_group_members m ON m.group_id = g.id
       WHERE m.contact_id = ? ORDER BY g.name`,
    )
    .all(contactId) as Array<{ id: string; name: string; description: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at }));
}

/** 双向关联: 本人指向的(out) + 指向本人的(in), 各带对端名称与 kind */
export function listRelations(db: Database.Database, contactId: string): RelatedContactRef[] {
  const rows = db
    .prepare(
      `SELECT r.id AS relation_id, r.relation, r.note, 'out' AS direction,
              c.id AS other_id, c.display_name AS other_name, c.kind AS other_kind,
              r.created_at AS sort_key
       FROM contact_relations r JOIN contacts c ON c.id = r.to_id
       WHERE r.from_id = ?
       UNION ALL
       SELECT r.id, r.relation, r.note, 'in',
              c.id, c.display_name, c.kind, r.created_at
       FROM contact_relations r JOIN contacts c ON c.id = r.from_id
       WHERE r.to_id = ?
       ORDER BY sort_key`,
    )
    .all(contactId, contactId) as Array<{
    relation_id: string;
    relation: string;
    note: string;
    direction: 'out' | 'in';
    other_id: string;
    other_name: string;
    other_kind: string;
  }>;
  return rows.map((r) => ({
    relationId: r.relation_id,
    contactId: r.other_id,
    displayName: r.other_name,
    kind: r.other_kind as ContactKind,
    relation: r.relation,
    note: r.note,
    direction: r.direction,
  }));
}

/** 拍平一个 contact 的全部可检索文本为 FTS 文档; contact 不存在返回 null */
export function buildFtsDoc(db: Database.Database, contactId: string): ContactFtsDoc | null {
  const row = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId) as ContactRow | undefined;
  if (!row) return null;
  const identities = listIdentities(db, contactId)
    .map((i) => `${i.value} ${i.label}`.trim())
    .join(' ');
  const events = listEvents(db, contactId)
    .map((e) => `${e.date} ${e.text}`)
    .join('\n');
  const relations = listRelations(db, contactId)
    .map((r) => `${r.relation} ${r.displayName} ${r.note}`.trim())
    .join('\n');
  return {
    contactId: row.id,
    kind: row.kind as ContactFtsDoc['kind'],
    status: row.status as ContactFtsDoc['status'],
    name: row.display_name,
    aliases: parseAliases(row.aliases).join(' '),
    identities,
    summary: row.summary,
    narrative: row.narrative,
    events,
    relations,
  };
}
