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
    .prepare(`SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY created_at, rowid`)
    .all(contactId) as IdentityRow[];
  return rows.map(mapIdentity);
}

export function listEvents(db: Database.Database, contactId: string): ContactEvent[] {
  const rows = db
    .prepare(`SELECT * FROM contact_events WHERE contact_id = ? ORDER BY date DESC, created_at DESC, rowid`)
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
              r.created_at AS sort_key, r.rowid AS relation_order
       FROM contact_relations r JOIN contacts c ON c.id = r.to_id
       WHERE r.from_id = ?
       UNION ALL
       SELECT r.id, r.relation, r.note, 'in',
              c.id, c.display_name, c.kind, r.created_at, r.rowid
       FROM contact_relations r JOIN contacts c ON c.id = r.from_id
       WHERE r.to_id = ?
       ORDER BY sort_key, relation_order`,
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

function appendFtsText(partsByContact: Map<string, string[]>, contactId: string, text: string): void {
  const parts = partsByContact.get(contactId);
  if (parts) {
    parts.push(text);
  } else {
    partsByContact.set(contactId, [text]);
  }
}

/**
 * 集合查询版全量 FTS 投影。启动一致性检查与同步后全量重建会走这里，避免对每个
 * contact 重复查询 identities / events / relations；单联系人写路径仍用 buildFtsDoc。
 */
export function buildAllFtsDocs(db: Database.Database): ContactFtsDoc[] {
  const contacts = db.prepare(`SELECT * FROM contacts`).all() as ContactRow[];
  const identitiesByContact = new Map<string, string[]>();
  const eventsByContact = new Map<string, string[]>();
  const relationsByContact = new Map<string, string[]>();

  const identities = db
    .prepare(`SELECT contact_id, value, label FROM contact_identities ORDER BY contact_id, created_at, rowid`)
    .all() as Array<{ contact_id: string; value: string; label: string }>;
  for (const identity of identities) {
    appendFtsText(identitiesByContact, identity.contact_id, `${identity.value} ${identity.label}`.trim());
  }

  const events = db
    .prepare(
      `SELECT contact_id, date, text FROM contact_events ORDER BY contact_id, date DESC, created_at DESC, rowid`,
    )
    .all() as Array<{ contact_id: string; date: string; text: string }>;
  for (const event of events) {
    appendFtsText(eventsByContact, event.contact_id, `${event.date} ${event.text}`);
  }

  const relations = db
    .prepare(
      `SELECT r.from_id AS contact_id, r.rowid AS relation_order, r.relation, r.note,
              c.display_name AS other_name, r.created_at AS sort_key
       FROM contact_relations r JOIN contacts c ON c.id = r.to_id
       UNION ALL
       SELECT r.to_id, r.rowid, r.relation, r.note,
              c.display_name, r.created_at
       FROM contact_relations r JOIN contacts c ON c.id = r.from_id
       ORDER BY contact_id, sort_key, relation_order`,
    )
    .all() as Array<{
    contact_id: string;
    relation: string;
    note: string;
    other_name: string;
  }>;
  for (const relation of relations) {
    appendFtsText(
      relationsByContact,
      relation.contact_id,
      `${relation.relation} ${relation.other_name} ${relation.note}`.trim(),
    );
  }

  return contacts.map((row) => ({
    contactId: row.id,
    kind: row.kind as ContactFtsDoc['kind'],
    status: row.status as ContactFtsDoc['status'],
    name: row.display_name,
    aliases: parseAliases(row.aliases).join(' '),
    identities: identitiesByContact.get(row.id)?.join(' ') ?? '',
    summary: row.summary,
    narrative: row.narrative,
    events: eventsByContact.get(row.id)?.join('\n') ?? '',
    relations: relationsByContact.get(row.id)?.join('\n') ?? '',
  }));
}
