/**
 * 通讯录同步状态的纯函数合并。
 *
 * 合并必须保持幂等、交换、结合。设备链路可以丢帧、重复或乱序，只要任意持有
 * 新状态的设备之后再次在线，N 台设备就会最终收敛。
 */

import {
  CONTACTS_SYNC_VERSION,
  createEmptyContactsSyncState,
  type ContactsStampedValue,
  type ContactsSyncClock,
  type ContactsSyncContact,
  type ContactsSyncEntity,
  type ContactsSyncStamp,
  type ContactsSyncState,
} from "./types.js";

export function compareContactsSyncStamp(
  a: ContactsSyncStamp,
  b: ContactsSyncStamp,
): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function maxStamp(
  a: ContactsSyncStamp | undefined,
  b: ContactsSyncStamp | undefined,
): ContactsSyncStamp | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareContactsSyncStamp(a, b) >= 0 ? a : b;
}

function mergeStamped<T>(
  a: ContactsStampedValue<T>,
  b: ContactsStampedValue<T>,
): ContactsStampedValue<T> {
  const order = compareContactsSyncStamp(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;
  // 同 stamp 理论上来自同一次写入；异常状态仍按 JSON 值稳定裁决。
  return JSON.stringify(a.value) >= JSON.stringify(b.value) ? a : b;
}

function mergeContact(
  a: ContactsSyncContact,
  b: ContactsSyncContact,
): ContactsSyncContact {
  return {
    id: a.id,
    kind: mergeStamped(a.kind, b.kind),
    displayName: mergeStamped(a.displayName, b.displayName),
    aliases: mergeStamped(a.aliases, b.aliases),
    summary: mergeStamped(a.summary, b.summary),
    narrative: mergeStamped(a.narrative, b.narrative),
    agentNotes: mergeStamped(a.agentNotes, b.agentNotes),
    status: mergeStamped(a.status, b.status),
    source: mergeStamped(a.source, b.source),
    createdAt: mergeStamped(a.createdAt, b.createdAt),
    updatedAt: mergeStamped(a.updatedAt, b.updatedAt),
    ...(maxStamp(a.deleted, b.deleted)
      ? { deleted: maxStamp(a.deleted, b.deleted)! }
      : {}),
  };
}

function mergeById<T>(
  a: Array<ContactsSyncEntity<T>>,
  b: Array<ContactsSyncEntity<T>>,
): Array<ContactsSyncEntity<T>> {
  const merged = new Map<string, ContactsSyncEntity<T>>();
  for (const record of [...a, ...b]) {
    const existing = merged.get(record.id);
    if (!existing) {
      merged.set(record.id, record);
      continue;
    }
    const deleted = maxStamp(existing.deleted, record.deleted);
    merged.set(record.id, {
      id: record.id,
      value: mergeStamped(existing.value, record.value),
      ...(deleted ? { deleted } : {}),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function mergeContacts(
  a: ContactsSyncContact[],
  b: ContactsSyncContact[],
): ContactsSyncContact[] {
  const merged = new Map<string, ContactsSyncContact>();
  for (const contact of [...a, ...b]) {
    const existing = merged.get(contact.id);
    merged.set(
      contact.id,
      existing ? mergeContact(existing, contact) : contact,
    );
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function mergeClocks(
  a: ContactsSyncClock[],
  b: ContactsSyncClock[],
): ContactsSyncClock[] {
  const clocks = new Map<string, number>();
  for (const clock of [...a, ...b]) {
    clocks.set(
      clock.nodeId,
      Math.max(clocks.get(clock.nodeId) ?? 0, clock.counter),
    );
  }
  return [...clocks.entries()]
    .map(([nodeId, counter]) => ({ nodeId, counter }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function mergeContactsSyncStates(
  a: ContactsSyncState,
  b: ContactsSyncState,
): ContactsSyncState {
  if (
    a.version !== CONTACTS_SYNC_VERSION ||
    b.version !== CONTACTS_SYNC_VERSION
  ) {
    if (a.version === CONTACTS_SYNC_VERSION) return a;
    if (b.version === CONTACTS_SYNC_VERSION) return b;
    return createEmptyContactsSyncState();
  }
  return {
    version: CONTACTS_SYNC_VERSION,
    clocks: mergeClocks(a.clocks, b.clocks),
    contacts: mergeContacts(a.contacts, b.contacts),
    identities: mergeById(a.identities, b.identities),
    events: mergeById(a.events, b.events),
    groups: mergeById(a.groups, b.groups),
    memberships: mergeById(a.memberships, b.memberships),
    relations: mergeById(a.relations, b.relations),
  };
}

export function nextContactsSyncStamp(
  state: ContactsSyncState,
  nodeId: string,
): { state: ContactsSyncState; stamp: ContactsSyncStamp } {
  const counters = state.clocks.map((clock) => clock.counter);
  const observe = (stamp: ContactsSyncStamp | undefined): void => {
    if (stamp) counters.push(stamp.counter);
  };
  for (const contact of state.contacts) {
    observe(contact.kind.stamp);
    observe(contact.displayName.stamp);
    observe(contact.aliases.stamp);
    observe(contact.summary.stamp);
    observe(contact.narrative.stamp);
    observe(contact.agentNotes.stamp);
    observe(contact.status.stamp);
    observe(contact.source.stamp);
    observe(contact.createdAt.stamp);
    observe(contact.updatedAt.stamp);
    observe(contact.deleted);
  }
  for (const records of [
    state.identities,
    state.events,
    state.groups,
    state.memberships,
    state.relations,
  ]) {
    for (const record of records) {
      observe(record.value.stamp);
      observe(record.deleted);
    }
  }
  // 不信任远端 clocks 完整覆盖所有 stamp；直接观察内容，避免畸形帧把本机时钟压低。
  const counter = Math.max(0, ...counters) + 1;
  const clocks = state.clocks.filter((clock) => clock.nodeId !== nodeId);
  clocks.push({ nodeId, counter });
  clocks.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return {
    state: { ...state, clocks },
    stamp: { counter, nodeId },
  };
}

/**
 * 根据对端已经观察到的各节点 counter 生成记录级增量。
 *
 * 联系人按字段打 stamp，但 wire 上仍发送完整联系人记录；只要任一字段是新的就
 * 纳入增量，接收端继续按字段 merge。这样不会为了一个 summary 修改重发整库，
 * 同时保持增量本身仍是合法 ContactsSyncState，可复用同一套校验与合并。
 */
export function createContactsSyncDelta(
  state: ContactsSyncState,
  knownClocks: ContactsSyncClock[],
): ContactsSyncState {
  const known = new Map(
    knownClocks.map((clock) => [clock.nodeId, clock.counter]),
  );
  const isNew = (stamp: ContactsSyncStamp | undefined): boolean =>
    Boolean(stamp && stamp.counter > (known.get(stamp.nodeId) ?? 0));
  const contactIsNew = (contact: ContactsSyncContact): boolean =>
    isNew(contact.kind.stamp) ||
    isNew(contact.displayName.stamp) ||
    isNew(contact.aliases.stamp) ||
    isNew(contact.summary.stamp) ||
    isNew(contact.narrative.stamp) ||
    isNew(contact.agentNotes.stamp) ||
    isNew(contact.status.stamp) ||
    isNew(contact.source.stamp) ||
    isNew(contact.createdAt.stamp) ||
    isNew(contact.updatedAt.stamp) ||
    isNew(contact.deleted);
  const entityIsNew = <T>(entity: ContactsSyncEntity<T>): boolean =>
    isNew(entity.value.stamp) || isNew(entity.deleted);

  return {
    version: CONTACTS_SYNC_VERSION,
    clocks: state.clocks.map((clock) => ({ ...clock })),
    contacts: state.contacts.filter(contactIsNew),
    identities: state.identities.filter(entityIsNew),
    events: state.events.filter(entityIsNew),
    groups: state.groups.filter(entityIsNew),
    memberships: state.memberships.filter(entityIsNew),
    relations: state.relations.filter(entityIsNew),
  };
}
