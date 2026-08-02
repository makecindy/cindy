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

function resolveExplicitMergeTarget(
  sourceId: string,
  redirects: ReadonlyMap<string, string>,
  liveContactIds: Set<string>,
): string | undefined {
  const seen = new Set<string>([sourceId]);
  let currentId = sourceId;
  while (redirects.has(currentId)) {
    const targetId = redirects.get(currentId)!;
    if (seen.has(targetId)) return undefined;
    seen.add(targetId);
    currentId = targetId;
  }
  return currentId !== sourceId && liveContactIds.has(currentId)
    ? currentId
    : undefined;
}

/**
 * 兼容显式 merge 证据上线前的状态：identity / event 的稳定 id 会随 store.merge
 * 从 source 原样迁到 target，可作为旧状态的明确证据；纯删除没有对应证据，
 * 必须 fail closed 丢弃锚点，不能按名字猜测。
 */
function resolveLegacyAnchorTargets(
  db: Database.Database,
  snapshot: ContactsDataSnapshot,
  orphanContactIds: Set<string>,
  liveContactIds: Set<string>,
): Map<string, string> {
  const remoteTargets = new Map<string, string>();
  for (const identity of snapshot.identities) {
    remoteTargets.set(`identity:${identity.id}`, identity.contactId);
  }
  for (const event of snapshot.events) {
    remoteTargets.set(`event:${event.id}`, event.contactId);
  }
  const localEvidence = db
    .prepare(
      `SELECT 'identity:' || id AS evidence_id, contact_id
         FROM contact_identities WHERE platform <> 'apple-contacts'
       UNION ALL
       SELECT 'event:' || id AS evidence_id, contact_id FROM contact_events`,
    )
    .all() as Array<{ evidence_id: string; contact_id: string }>;
  const candidates = new Map<string, Set<string>>();
  for (const row of localEvidence) {
    if (!orphanContactIds.has(row.contact_id)) continue;
    const targetId = remoteTargets.get(row.evidence_id);
    if (!targetId || !liveContactIds.has(targetId)) continue;
    const targets = candidates.get(row.contact_id) ?? new Set<string>();
    targets.add(targetId);
    candidates.set(row.contact_id, targets);
  }
  return new Map(
    [...candidates]
      .filter(([, targets]) => targets.size === 1)
      .map(([sourceId, targets]) => [sourceId, [...targets][0]!] as const),
  );
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
  mergeRedirects: ReadonlyMap<string, string> = new Map(),
  confirmedDeletions: ReadonlySet<string> = new Set(),
): void {
  // 同步快照替换主表前先保住本机系统通讯录锚点。远端快照即使来自旧版、
  // 仍带 apple-contacts，也不得写进来；本机锚保留在存活档案上，若 source
  // 被远端 merge 删除则优先沿显式 redirect 迁到最终 target，旧状态再用稳定
  // 子记录 id 兜底；纯删除没有证据时不猜测。
  const localSystemAnchors = db
    .prepare(
      `SELECT * FROM contact_identities
       WHERE platform = 'apple-contacts' ORDER BY created_at, id`,
    )
    .all() as IdentityRow[];
  const deletePendingAnchor = db.prepare(
    `DELETE FROM contacts_sync_pending_anchors WHERE source_contact_id = ?`,
  );
  for (const contactId of confirmedDeletions) deletePendingAnchor.run(contactId);
  const pendingSystemAnchors = db
    .prepare(
      `SELECT identity_id AS id, source_contact_id AS contact_id,
              'apple-contacts' AS platform, value, normalized_value, label, note, created_at
       FROM contacts_sync_pending_anchors ORDER BY created_at, identity_id`,
    )
    .all() as IdentityRow[];
  const anchorsById = new Map(
    pendingSystemAnchors.map((anchor) => [anchor.id, anchor]),
  );
  for (const anchor of localSystemAnchors) anchorsById.set(anchor.id, anchor);
  const allSystemAnchors = [...anchorsById.values()];
  const liveContactIds = new Set(snapshot.contacts.map((contact) => contact.id));
  const orphanContactIds = new Set(
    allSystemAnchors
      .map((anchor) => anchor.contact_id)
      .filter((contactId) => !liveContactIds.has(contactId)),
  );
  const migratedAnchorTargets = new Map<string, string>();
  const legacyOrphans = new Set<string>();
  for (const sourceId of orphanContactIds) {
    const explicitTarget = resolveExplicitMergeTarget(
      sourceId,
      mergeRedirects,
      liveContactIds,
    );
    if (explicitTarget) migratedAnchorTargets.set(sourceId, explicitTarget);
    else legacyOrphans.add(sourceId);
  }
  if (legacyOrphans.size > 0) {
    for (const [sourceId, targetId] of resolveLegacyAnchorTargets(
      db,
      snapshot,
      legacyOrphans,
      liveContactIds,
    )) {
      migratedAnchorTargets.set(sourceId, targetId);
    }
  }
  const stashPendingAnchor = db.prepare(
    `INSERT INTO contacts_sync_pending_anchors(
       identity_id, source_contact_id, value, normalized_value, label, note, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET
       source_contact_id = excluded.source_contact_id,
       value = excluded.value,
       normalized_value = excluded.normalized_value,
       label = excluded.label,
       note = excluded.note,
       created_at = excluded.created_at`,
  );
  for (const anchor of localSystemAnchors) {
    if (
      !liveContactIds.has(anchor.contact_id) &&
      !migratedAnchorTargets.has(anchor.contact_id) &&
      !confirmedDeletions.has(anchor.contact_id)
    ) {
      stashPendingAnchor.run(
        anchor.id,
        anchor.contact_id,
        anchor.value,
        anchor.normalized_value,
        anchor.label,
        anchor.note,
        anchor.created_at,
      );
    }
  }
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
  const directlyAnchoredContacts = new Set(
    allSystemAnchors
      .map((anchor) => anchor.contact_id)
      .filter((contactId) => liveContactIds.has(contactId)),
  );
  const migratedAnchors = new Set<string>();
  const restoredPendingAnchorIds: string[] = [];
  const pendingAnchorIds = new Set(pendingSystemAnchors.map((anchor) => anchor.id));
  for (const row of allSystemAnchors) {
    let targetContactId = row.contact_id;
    if (!liveContactIds.has(targetContactId)) {
      const migratedTarget = migratedAnchorTargets.get(targetContactId);
      if (!migratedTarget) continue;
      if (
        directlyAnchoredContacts.has(migratedTarget) ||
        migratedAnchors.has(migratedTarget)
      ) {
        // target 已有本机锚点（或同批已有 pending 胜出）时丢弃 loser；否则用户
        // 之后移除 target 锚点，残留 pending 会在下一次物化时把旧卡复活。
        if (pendingAnchorIds.has(row.id)) restoredPendingAnchorIds.push(row.id);
        continue;
      }
      targetContactId = migratedTarget;
      migratedAnchors.add(migratedTarget);
    }
    insertIdentity.run(
      row.id,
      targetContactId,
      row.platform,
      row.value,
      row.normalized_value,
      row.label,
      row.note,
      row.created_at,
    );
    if (pendingAnchorIds.has(row.id)) restoredPendingAnchorIds.push(row.id);
  }
  const removeRestoredPendingAnchor = db.prepare(
    `DELETE FROM contacts_sync_pending_anchors WHERE identity_id = ?`,
  );
  for (const identityId of restoredPendingAnchorIds) {
    removeRestoredPendingAnchor.run(identityId);
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
