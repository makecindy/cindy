/** 深度校验来自设备链路或磁盘的同步状态，拒绝畸形/超量数据进入 SQLite。 */

import {
  DEFAULT_CONTACTS_CONFIG,
  MAX_NORMALIZED_IDENTITY_VALUE_LEN,
  isContactKind,
  isContactSource,
  isContactStatus,
} from "../types.js";
import {
  CONTACTS_SYNC_VERSION,
  membershipSyncId,
  type ContactsDataSnapshot,
  type ContactsStampedValue,
  type ContactsSyncConflictMembership,
  type ContactsSyncEntity,
  type ContactsSyncStamp,
  type ContactsSyncState,
} from "./types.js";

export const CONTACTS_SYNC_MAX_ROWS_PER_TABLE = 100_000;
const MAX_ID_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(
  value: unknown,
  max: number,
  allowEmpty = true,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.length > 0)
  );
}

function isUtf8String(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

/**
 * 这些 SQLite 文本列的本地写入契约没有长度上限；同步层只能校验类型，不能
 * 自行收紧合法域。传输层仍以整包解压上限约束来自设备的数据总量。
 */
function isUnboundedLocalText(value: unknown): value is string {
  return typeof value === "string";
}

function isId(value: unknown): value is string {
  return isString(value, MAX_ID_LENGTH, false) && !value.includes("\u0000");
}

function isStamp(value: unknown): value is ContactsSyncStamp {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.counter) &&
    (value.counter as number) > 0 &&
    isString(value.nodeId, 128, false) &&
    /^[A-Za-z0-9._:-]+$/.test(value.nodeId as string)
  );
}

function isStamped<T>(
  value: unknown,
  validate: (candidate: unknown) => candidate is T,
): value is ContactsStampedValue<T> {
  return isRecord(value) && isStamp(value.stamp) && validate(value.value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= DEFAULT_CONTACTS_CONFIG.maxAliases &&
    value.every((entry) =>
      isString(entry, DEFAULT_CONTACTS_CONFIG.maxDisplayNameLen, false),
    )
  );
}

function isEntityArray<T>(
  value: unknown,
  validate: (candidate: unknown) => candidate is T,
  validateId: (candidate: unknown) => candidate is string = isId,
): value is Array<ContactsSyncEntity<T>> {
  if (!Array.isArray(value) || value.length > CONTACTS_SYNC_MAX_ROWS_PER_TABLE)
    return false;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !validateId(candidate.id) ||
      ids.has(candidate.id)
    )
      return false;
    if (!isStamped(candidate.value, validate)) return false;
    if (candidate.deleted !== undefined && !isStamp(candidate.deleted))
      return false;
    ids.add(candidate.id);
  }
  return true;
}

function isContact(value: unknown): boolean {
  if (!isRecord(value) || !isId(value.id)) return false;
  if (!isStamped(value.kind, (v): v is "person" | "org" => isContactKind(v)))
    return false;
  if (
    !isStamped(value.displayName, (v): v is string =>
      isString(v, DEFAULT_CONTACTS_CONFIG.maxDisplayNameLen, false),
    )
  )
    return false;
  if (!isStamped(value.aliases, isStringArray)) return false;
  if (
    !isStamped(value.summary, (v): v is string =>
      isString(v, DEFAULT_CONTACTS_CONFIG.maxSummaryLen),
    )
  )
    return false;
  if (
    !isStamped(value.narrative, (v): v is string =>
      isUtf8String(v, DEFAULT_CONTACTS_CONFIG.maxNarrativeBytes),
    )
  )
    return false;
  if (
    !isStamped(value.agentNotes, (v): v is string =>
      isString(v, DEFAULT_CONTACTS_CONFIG.maxAgentNotesLen),
    )
  )
    return false;
  if (!isStatus(value.status)) return false;
  if (
    !isStamped(value.source, (v): v is "manual" | "agent" | "import" =>
      isContactSource(v),
    )
  )
    return false;
  if (!isStamped(value.createdAt, (v): v is string => isString(v, 64, false)))
    return false;
  if (!isStamped(value.updatedAt, (v): v is string => isString(v, 64, false)))
    return false;
  return value.deleted === undefined || isStamp(value.deleted);
}

function isConflictMembership(
  value: unknown,
): value is ContactsSyncConflictMembership {
  return (
    isRecord(value) &&
    isString(value.platform, 32, false) &&
    /^[a-z0-9_-]+$/.test(value.platform as string) &&
    isString(value.normalizedValue, MAX_NORMALIZED_IDENTITY_VALUE_LEN, false) &&
    isString(value.membershipHash, 64, false) &&
    /^[a-f0-9]{64}$/.test(value.membershipHash as string)
  );
}

function isStatus(value: unknown): boolean {
  if (
    !isStamped(value, (candidate): candidate is "confirmed" | "pending" =>
      isContactStatus(candidate),
    )
  ) {
    return false;
  }
  if (!isRecord(value) || value.acknowledgedConflicts === undefined)
    return true;
  if (
    !Array.isArray(value.acknowledgedConflicts) ||
    value.acknowledgedConflicts.length > CONTACTS_SYNC_MAX_ROWS_PER_TABLE
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const membership of value.acknowledgedConflicts) {
    if (!isConflictMembership(membership)) return false;
    const key = `${membership.platform}\u0000${membership.normalizedValue}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isIdentity(value: unknown): value is {
  contactId: string;
  platform: string;
  value: string;
  normalizedValue: string;
  label: string;
  note: string;
  createdAt: string;
} {
  if (!isRecord(value) || !isId(value.contactId)) return false;
  return (
    isString(value.platform, 32, false) &&
    /^[a-z0-9_-]+$/.test(value.platform) &&
    isString(value.value, DEFAULT_CONTACTS_CONFIG.maxIdentityValueLen, false) &&
    isString(value.normalizedValue, MAX_NORMALIZED_IDENTITY_VALUE_LEN, false) &&
    isUnboundedLocalText(value.label) &&
    isUnboundedLocalText(value.note) &&
    isString(value.createdAt, 64, false)
  );
}

function isEvent(value: unknown): value is {
  contactId: string;
  date: string;
  text: string;
  source: string;
  createdAt: string;
} {
  if (!isRecord(value) || !isId(value.contactId)) return false;
  return (
    isString(value.date, 32, false) &&
    isString(value.text, DEFAULT_CONTACTS_CONFIG.maxEventTextLen, false) &&
    isUnboundedLocalText(value.source) &&
    isString(value.createdAt, 64, false)
  );
}

function isGroup(value: unknown): value is {
  name: string;
  description: string;
  createdAt: string;
} {
  return (
    isRecord(value) &&
    isString(value.name, DEFAULT_CONTACTS_CONFIG.maxGroupNameLen, false) &&
    isUnboundedLocalText(value.description) &&
    isString(value.createdAt, 64, false)
  );
}

function isMembership(
  value: unknown,
): value is { groupId: string; contactId: string } {
  return isRecord(value) && isId(value.groupId) && isId(value.contactId);
}

function isMembershipId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 2 &&
    value.length <= MAX_ID_LENGTH * 2 + 1
  );
}

function isRelation(value: unknown): value is {
  fromId: string;
  toId: string;
  relation: string;
  note: string;
  createdAt: string;
} {
  return (
    isRecord(value) &&
    isId(value.fromId) &&
    isId(value.toId) &&
    isString(value.relation, DEFAULT_CONTACTS_CONFIG.maxRelationLen, false) &&
    isUnboundedLocalText(value.note) &&
    isString(value.createdAt, 64, false)
  );
}

function isSnapshotContact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isContactKind(value.kind) &&
    isString(
      value.displayName,
      DEFAULT_CONTACTS_CONFIG.maxDisplayNameLen,
      false,
    ) &&
    isStringArray(value.aliases) &&
    isString(value.summary, DEFAULT_CONTACTS_CONFIG.maxSummaryLen) &&
    isUtf8String(value.narrative, DEFAULT_CONTACTS_CONFIG.maxNarrativeBytes) &&
    isString(value.agentNotes, DEFAULT_CONTACTS_CONFIG.maxAgentNotesLen) &&
    isContactStatus(value.status) &&
    isContactSource(value.source) &&
    isString(value.createdAt, 64, false) &&
    isString(value.updatedAt, 64, false)
  );
}

function isSnapshotArray(
  value: unknown,
  validate: (candidate: unknown) => boolean,
  validateId: (candidate: unknown) => candidate is string = isId,
): value is Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value) || value.length > CONTACTS_SYNC_MAX_ROWS_PER_TABLE)
    return false;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !validateId(candidate.id) ||
      ids.has(candidate.id) ||
      !validate(candidate)
    ) {
      return false;
    }
    ids.add(candidate.id);
  }
  return true;
}

/**
 * projection_json 会作为下一次本地差异捕获的可信基线；必须完整 fail-closed。
 * 只校验 id 会把损坏行误判成“本机删除”，进而向 CRDT 写入永久 tombstone。
 */
export function isValidContactsDataSnapshot(
  value: unknown,
): value is ContactsDataSnapshot {
  if (!isRecord(value)) return false;
  if (
    !isSnapshotArray(value.contacts, isSnapshotContact) ||
    !isSnapshotArray(
      value.identities,
      (candidate) => isRecord(candidate) && isIdentity(candidate),
    ) ||
    !isSnapshotArray(
      value.events,
      (candidate) => isRecord(candidate) && isEvent(candidate),
    ) ||
    !isSnapshotArray(
      value.groups,
      (candidate) => isRecord(candidate) && isGroup(candidate),
    ) ||
    !isSnapshotArray(
      value.memberships,
      (candidate) =>
        isRecord(candidate) &&
        isMembership(candidate) &&
        (candidate as unknown as { id: string }).id ===
          membershipSyncId(candidate.groupId, candidate.contactId),
      isMembershipId,
    ) ||
    !isSnapshotArray(
      value.relations,
      (candidate) => isRecord(candidate) && isRelation(candidate),
    )
  ) {
    return false;
  }

  const snapshot = value as unknown as ContactsDataSnapshot;
  const contactIds = new Set(snapshot.contacts.map((contact) => contact.id));
  const groupIds = new Set(snapshot.groups.map((group) => group.id));
  const uniqueGroups = new Set<string>();
  for (const group of snapshot.groups) {
    if (uniqueGroups.has(group.name)) return false;
    uniqueGroups.add(group.name);
  }

  const uniqueIdentities = new Set<string>();
  for (const identity of snapshot.identities) {
    if (!contactIds.has(identity.contactId)) return false;
    const key = `${identity.platform}\u0000${identity.normalizedValue}`;
    if (uniqueIdentities.has(key)) return false;
    uniqueIdentities.add(key);
  }
  if (snapshot.events.some((event) => !contactIds.has(event.contactId)))
    return false;
  if (
    snapshot.memberships.some(
      (membership) =>
        !contactIds.has(membership.contactId) ||
        !groupIds.has(membership.groupId),
    )
  ) {
    return false;
  }

  const uniqueRelations = new Set<string>();
  for (const relation of snapshot.relations) {
    if (
      relation.fromId === relation.toId ||
      !contactIds.has(relation.fromId) ||
      !contactIds.has(relation.toId)
    ) {
      return false;
    }
    const key = `${relation.fromId}\u0000${relation.toId}\u0000${relation.relation}`;
    if (uniqueRelations.has(key)) return false;
    uniqueRelations.add(key);
  }
  return true;
}

export function isValidContactsSyncState(
  value: unknown,
): value is ContactsSyncState {
  if (!isRecord(value) || value.version !== CONTACTS_SYNC_VERSION) return false;
  if (!Array.isArray(value.clocks) || value.clocks.length > 256) return false;
  const clockNodes = new Set<string>();
  for (const clock of value.clocks) {
    if (
      !isRecord(clock) ||
      !isStamp({ counter: clock.counter, nodeId: clock.nodeId })
    )
      return false;
    if (clockNodes.has(clock.nodeId as string)) return false;
    clockNodes.add(clock.nodeId as string);
  }
  if (
    !Array.isArray(value.contacts) ||
    value.contacts.length > CONTACTS_SYNC_MAX_ROWS_PER_TABLE
  )
    return false;
  const contactIds = new Set<string>();
  let acknowledgedConflictCount = 0;
  for (const contact of value.contacts) {
    if (!isContact(contact) || contactIds.has((contact as { id: string }).id))
      return false;
    acknowledgedConflictCount +=
      (contact as { status: { acknowledgedConflicts?: unknown[] } }).status
        .acknowledgedConflicts?.length ?? 0;
    if (acknowledgedConflictCount > CONTACTS_SYNC_MAX_ROWS_PER_TABLE)
      return false;
    contactIds.add((contact as { id: string }).id);
  }
  if (!isEntityArray(value.identities, isIdentity)) return false;
  if (!isEntityArray(value.events, isEvent)) return false;
  if (!isEntityArray(value.groups, isGroup)) return false;
  if (!isEntityArray(value.memberships, isMembership, isMembershipId))
    return false;
  for (const membership of value.memberships) {
    const entry = membership as ContactsSyncEntity<{
      groupId: string;
      contactId: string;
    }>;
    if (
      entry.id !==
      membershipSyncId(entry.value.value.groupId, entry.value.value.contactId)
    )
      return false;
  }
  if (!isEntityArray(value.relations, isRelation)) return false;
  return clocksCoverEveryStamp(value as unknown as ContactsSyncState);
}

function clocksCoverEveryStamp(state: ContactsSyncState): boolean {
  const clocks = new Map(
    state.clocks.map((clock) => [clock.nodeId, clock.counter]),
  );
  const covered = (stamp: ContactsSyncStamp | undefined): boolean =>
    !stamp || (clocks.get(stamp.nodeId) ?? 0) >= stamp.counter;
  for (const contact of state.contacts) {
    if (
      !covered(contact.kind.stamp) ||
      !covered(contact.displayName.stamp) ||
      !covered(contact.aliases.stamp) ||
      !covered(contact.summary.stamp) ||
      !covered(contact.narrative.stamp) ||
      !covered(contact.agentNotes.stamp) ||
      !covered(contact.status.stamp) ||
      !covered(contact.source.stamp) ||
      !covered(contact.createdAt.stamp) ||
      !covered(contact.updatedAt.stamp) ||
      !covered(contact.deleted)
    ) {
      return false;
    }
  }
  for (const records of [
    state.identities,
    state.events,
    state.groups,
    state.memberships,
    state.relations,
  ]) {
    for (const record of records) {
      if (!covered(record.value.stamp) || !covered(record.deleted)) {
        return false;
      }
    }
  }
  return true;
}
