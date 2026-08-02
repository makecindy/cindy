/**
 * SQLite 主表与同步逻辑快照之间的确定性转换。
 *
 * FTS 不进入快照；写回后由 store 从主表全量重建。所有数组按稳定主键排序，
 * 既让 diff 可预测，也让不同设备序列化同一状态时得到相同结果。
 */

import type Database from "better-sqlite3";

import { parseAliases, type ContactRow, type IdentityRow } from "../rows.js";
import { compareContactsSyncText } from "./merge.js";
import {
  membershipSyncId,
  type ContactsDataSnapshot,
  type ContactsSnapshotContact,
  type ContactsSnapshotEvent,
  type ContactsSnapshotGroup,
  type ContactsSnapshotIdentity,
  type ContactsSnapshotMembership,
  type ContactsSnapshotRelation,
} from "./types.js";

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareContactsSyncText(a.id, b.id);
}

export function readContactsSnapshot(
  db: Database.Database,
): ContactsDataSnapshot {
  const contacts = (db.prepare(`SELECT * FROM contacts`).all() as ContactRow[])
    .map<ContactsSnapshotContact>((row) => ({
      id: row.id,
      kind: row.kind as ContactsSnapshotContact["kind"],
      displayName: row.display_name,
      aliases: parseAliases(row.aliases),
      summary: row.summary,
      narrative: row.narrative,
      agentNotes: row.agent_notes,
      status: row.status as ContactsSnapshotContact["status"],
      source: row.source as ContactsSnapshotContact["source"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .sort(byId);

  // apple-contacts 是本机 Contacts.app 的对象 id，同一人的 id 在另一台 Mac
  // 完全不同。它只作本机回写锚点，进入设备同步会让另一台机器拿死 id 更新，
  // 甚至在多台设备间反复覆盖锚点。因此同步投影明确排除它。
  const identities = (
    db
      .prepare(`SELECT * FROM contact_identities WHERE platform <> 'apple-contacts'`)
      .all() as IdentityRow[]
  )
    .map<ContactsSnapshotIdentity>((row) => ({
      id: row.id,
      contactId: row.contact_id,
      platform: row.platform,
      value: row.value,
      normalizedValue: row.normalized_value,
      label: row.label,
      note: row.note,
      createdAt: row.created_at,
    }))
    .sort(byId);

  const events = (
    db.prepare(`SELECT * FROM contact_events`).all() as Array<{
      id: string;
      contact_id: string;
      date: string;
      text: string;
      source: string;
      created_at: string;
    }>
  )
    .map<ContactsSnapshotEvent>((row) => ({
      id: row.id,
      contactId: row.contact_id,
      date: row.date,
      text: row.text,
      source: row.source,
      createdAt: row.created_at,
    }))
    .sort(byId);

  const groups = (
    db.prepare(`SELECT * FROM contact_groups`).all() as Array<{
      id: string;
      name: string;
      description: string;
      created_at: string;
    }>
  )
    .map<ContactsSnapshotGroup>((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
    }))
    .sort(byId);

  const memberships = (
    db.prepare(`SELECT * FROM contact_group_members`).all() as Array<{
      group_id: string;
      contact_id: string;
    }>
  )
    .map<ContactsSnapshotMembership>((row) => ({
      id: membershipSyncId(row.group_id, row.contact_id),
      groupId: row.group_id,
      contactId: row.contact_id,
    }))
    .sort(byId);

  const relations = (
    db.prepare(`SELECT * FROM contact_relations`).all() as Array<{
      id: string;
      from_id: string;
      to_id: string;
      relation: string;
      note: string;
      created_at: string;
    }>
  )
    .map<ContactsSnapshotRelation>((row) => ({
      id: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      relation: row.relation,
      note: row.note,
      createdAt: row.created_at,
    }))
    .sort(byId);

  return { contacts, identities, events, groups, memberships, relations };
}

/**
 * 用逻辑快照替换通讯录主表。调用者必须放在事务中，并在成功后重建 FTS。
 */
export function writeContactsSnapshot(
  db: Database.Database,
  snapshot: ContactsDataSnapshot,
): void {
  // 同步快照替换主表前先保住本机系统通讯录锚点。远端快照即使来自旧版、
  // 仍带 apple-contacts，也不得写进来；本机锚只在对应 contact 仍存在时恢复。
  const localSystemAnchors = db
    .prepare(`SELECT * FROM contact_identities WHERE platform = 'apple-contacts'`)
    .all() as IdentityRow[];
  db.exec(`DELETE FROM contacts; DELETE FROM contact_groups;`);

  const insertContact = db.prepare(
    `INSERT INTO contacts(
       id, kind, display_name, aliases, summary, narrative, agent_notes,
       status, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of snapshot.contacts) {
    insertContact.run(
      row.id,
      row.kind,
      row.displayName,
      JSON.stringify(row.aliases),
      row.summary,
      row.narrative,
      row.agentNotes,
      row.status,
      row.source,
      row.createdAt,
      row.updatedAt,
    );
  }

  const insertGroup = db.prepare(
    `INSERT INTO contact_groups(id, name, description, created_at) VALUES (?, ?, ?, ?)`,
  );
  for (const row of snapshot.groups) {
    insertGroup.run(row.id, row.name, row.description, row.createdAt);
  }

  const insertIdentity = db.prepare(
    `INSERT INTO contact_identities(
       id, contact_id, platform, value, normalized_value, label, note, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of snapshot.identities) {
    if (row.platform === 'apple-contacts') continue;
    insertIdentity.run(
      row.id,
      row.contactId,
      row.platform,
      row.value,
      row.normalizedValue,
      row.label,
      row.note,
      row.createdAt,
    );
  }
  const liveContactIds = new Set(snapshot.contacts.map((contact) => contact.id));
  for (const row of localSystemAnchors) {
    if (!liveContactIds.has(row.contact_id)) continue;
    insertIdentity.run(
      row.id,
      row.contact_id,
      row.platform,
      row.value,
      row.normalized_value,
      row.label,
      row.note,
      row.created_at,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO contact_events(id, contact_id, date, text, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of snapshot.events) {
    insertEvent.run(
      row.id,
      row.contactId,
      row.date,
      row.text,
      row.source,
      row.createdAt,
    );
  }

  const insertMembership = db.prepare(
    `INSERT INTO contact_group_members(group_id, contact_id) VALUES (?, ?)`,
  );
  for (const row of snapshot.memberships) {
    insertMembership.run(row.groupId, row.contactId);
  }

  const insertRelation = db.prepare(
    `INSERT INTO contact_relations(id, from_id, to_id, relation, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of snapshot.relations) {
    insertRelation.run(
      row.id,
      row.fromId,
      row.toId,
      row.relation,
      row.note,
      row.createdAt,
    );
  }
}
