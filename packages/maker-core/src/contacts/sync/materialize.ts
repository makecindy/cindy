/**
 * 把合并后的 CRDT 状态物化为 SQLite 可接受的逻辑快照。
 *
 * 跨设备并发可能撞上数据库唯一约束（同一身份、同名分组、同一关系边）。
 * 这里按写入 stamp、再按稳定 id 选唯一赢家；未胜出的状态仍保留在 CRDT 中，
 * 不会被下一次本地捕获误记成删除，后续可以接入“待确认冲突”界面。
 */

import { compareContactsSyncStamp, compareContactsSyncText } from "./merge.js";
import { collectContactsIdentityConflicts } from "./conflicts.js";
import {
  type ContactsDataSnapshot,
  type ContactsSnapshotContact,
  type ContactsSnapshotEvent,
  type ContactsSnapshotGroup,
  type ContactsSnapshotIdentity,
  type ContactsSnapshotMembership,
  type ContactsSnapshotRelation,
  type ContactsSyncConflictMembership,
  type ContactsSyncEntity,
  type ContactsSyncState,
} from "./types.js";

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareContactsSyncText(a.id, b.id);
}

function liveEntities<T>(
  records: Array<ContactsSyncEntity<T>>,
): Array<ContactsSyncEntity<T>> {
  return records.filter((record) => !record.deleted);
}

/**
 * 分组成员使用 (groupId, contactId) 复合键，移出后再加入会复用同一个 id。
 * 因此它与 UUID 实体不同：新增 stamp 晚于删除 stamp 时允许重新出现。
 */
function liveReusableEntities<T>(
  records: Array<ContactsSyncEntity<T>>,
): Array<ContactsSyncEntity<T>> {
  return records.filter(
    (record) =>
      !record.deleted ||
      compareContactsSyncStamp(record.value.stamp, record.deleted) > 0,
  );
}

function preferNewest<T>(
  records: Array<ContactsSyncEntity<T>>,
): Array<ContactsSyncEntity<T>> {
  return [...records].sort((a, b) => {
    const stampOrder = compareContactsSyncStamp(b.value.stamp, a.value.stamp);
    return stampOrder !== 0 ? stampOrder : compareContactsSyncText(a.id, b.id);
  });
}

function uniqueBy<T>(
  records: Array<ContactsSyncEntity<T>>,
  keyOf: (value: T) => string,
): Array<ContactsSyncEntity<T>> {
  const seen = new Set<string>();
  const winners: Array<ContactsSyncEntity<T>> = [];
  for (const record of preferNewest(records)) {
    const key = keyOf(record.value.value);
    if (seen.has(key)) continue;
    seen.add(key);
    winners.push(record);
  }
  return winners;
}

export function materializeContactsSyncState(
  state: ContactsSyncState,
): ContactsDataSnapshot {
  const contacts = state.contacts
    .filter((record) => !record.deleted)
    .map<ContactsSnapshotContact>((record) => ({
      id: record.id,
      kind: record.kind.value,
      displayName: record.displayName.value,
      aliases: record.aliases.value,
      summary: record.summary.value,
      narrative: record.narrative.value,
      agentNotes: record.agentNotes.value,
      status: record.status.value,
      source: record.source.value,
      createdAt: record.createdAt.value,
      updatedAt: record.updatedAt.value,
    }))
    .sort(byId);
  const contactsById = new Map(
    contacts.map((contact) => [contact.id, contact]),
  );
  const acknowledgementsByContactId = new Map<
    string,
    Map<string, ContactsSyncConflictMembership>
  >();
  for (const contact of state.contacts) {
    const acknowledgements = contact.status.acknowledgedConflicts;
    if (!acknowledgements || acknowledgements.length === 0) continue;
    const byConflictKey = new Map<string, ContactsSyncConflictMembership>();
    for (const acknowledgement of acknowledgements) {
      byConflictKey.set(
        `${acknowledgement.platform}\u0000${acknowledgement.normalizedValue}`,
        acknowledgement,
      );
    }
    acknowledgementsByContactId.set(contact.id, byConflictKey);
  }
  const contactIds = new Set(contacts.map((contact) => contact.id));

  // contact_groups.name 的 UNIQUE 与 ContactsGroupsRepo 都是精确字符串语义；
  // A / a 可以合法共存，同步层不能自行收紧成大小写不敏感而吞掉其中一组。
  const groups = uniqueBy(liveEntities(state.groups), (value) => value.name)
    .map<ContactsSnapshotGroup>((record) => ({
      id: record.id,
      ...record.value.value,
    }))
    .sort(byId);
  const groupIds = new Set(groups.map((group) => group.id));

  const identityCandidates = liveEntities(state.identities).filter((record) =>
    contactIds.has(record.value.value.contactId),
  );
  const conflicts = collectContactsIdentityConflicts(state);
  const identities = uniqueBy(
    identityCandidates,
    (value) => `${value.platform}\u0000${value.normalizedValue}`,
  )
    .map<ContactsSnapshotIdentity>((record) => ({
      id: record.id,
      ...record.value.value,
    }))
    .sort(byId);

  // 同一身份被并发分给不同联系人时，SQLite 只能物化一个确定性赢家；把所有
  // 相关档案标成待确认，避免另一边被隐藏后用户完全不知道发生过冲突。
  // Lamport stamp 只提供确定性全序，不能证明确认写入见过某个离线成员。
  // 只有确认记录的成员指纹与当前冲突完全一致，才保留 confirmed。
  for (const conflict of conflicts) {
    const conflictKey = `${conflict.platform}\u0000${conflict.normalizedValue}`;
    for (const contactId of conflict.owners) {
      const contact = contactsById.get(contactId);
      if (!contact) continue;
      const acknowledgement = acknowledgementsByContactId
        .get(contactId)
        ?.get(conflictKey);
      if (
        contact.status === "confirmed" &&
        acknowledgement?.membershipHash === conflict.membershipHash
      ) {
        continue;
      }
      contact.status = "pending";
    }
  }

  const events = liveEntities(state.events)
    .filter((record) => contactIds.has(record.value.value.contactId))
    .map<ContactsSnapshotEvent>((record) => ({
      id: record.id,
      ...record.value.value,
    }))
    .sort(byId);

  const memberships = liveReusableEntities(state.memberships)
    .filter(
      (record) =>
        contactIds.has(record.value.value.contactId) &&
        groupIds.has(record.value.value.groupId),
    )
    .map<ContactsSnapshotMembership>((record) => ({
      id: record.id,
      ...record.value.value,
    }))
    .sort(byId);

  const relations = uniqueBy(
    liveEntities(state.relations).filter(
      (record) =>
        record.value.value.fromId !== record.value.value.toId &&
        contactIds.has(record.value.value.fromId) &&
        contactIds.has(record.value.value.toId),
    ),
    (value) => `${value.fromId}\u0000${value.toId}\u0000${value.relation}`,
  )
    .map<ContactsSnapshotRelation>((record) => ({
      id: record.id,
      ...record.value.value,
    }))
    .sort(byId);

  return { contacts, identities, events, groups, memberships, relations };
}
