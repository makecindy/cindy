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

/** Locale-independent UTF-16 ordering used anywhere sync output must converge. */
export function compareContactsSyncText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON-compatible serialization with recursively sorted object keys. */
export function stableContactsSyncJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableContactsSyncJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareContactsSyncText);
  return `{${keys
    .map(
      (key) => `${JSON.stringify(key)}:${stableContactsSyncJson(record[key])}`,
    )
    .join(",")}}`;
}

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
  // 同 stamp 理论上来自同一次写入；异常状态仍按规范化 JSON 值稳定裁决，
  // 不能让对象 key 的输入顺序影响跨设备赢家。
  return stableContactsSyncJson(a.value) >= stableContactsSyncJson(b.value)
    ? a
    : b;
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
    compareContactsSyncText(left.id, right.id),
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
    compareContactsSyncText(left.id, right.id),
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
    .sort((left, right) => compareContactsSyncText(left.nodeId, right.nodeId));
}

function mergeClocksForRedirects(
  state: ContactsSyncState,
): ContactsSyncClock[] {
  if (state.mergeClocks !== undefined) return state.mergeClocks;
  const clocks = new Map<string, number>();
  for (const evidence of [
    ...(state.merges ?? []),
    ...(state.deletions ?? []),
  ]) {
    const stamp = evidence.value.stamp;
    clocks.set(
      stamp.nodeId,
      Math.max(clocks.get(stamp.nodeId) ?? 0, stamp.counter),
    );
  }
  return [...clocks.entries()]
    .map(([nodeId, counter]) => ({ nodeId, counter }))
    .sort((left, right) => compareContactsSyncText(left.nodeId, right.nodeId));
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
    mergeClocks: mergeClocks(
      mergeClocksForRedirects(a),
      mergeClocksForRedirects(b),
    ),
    contacts: mergeContacts(a.contacts, b.contacts),
    identities: mergeById(a.identities, b.identities),
    events: mergeById(a.events, b.events),
    groups: mergeById(a.groups, b.groups),
    memberships: mergeById(a.memberships, b.memberships),
    relations: mergeById(a.relations, b.relations),
    merges: mergeById(a.merges ?? [], b.merges ?? []),
    deletions: mergeById(a.deletions ?? [], b.deletions ?? []),
  };
}

export function nextContactsSyncMergeStamp(
  state: ContactsSyncState,
  nodeId: string,
): { state: ContactsSyncState; stamp: ContactsSyncStamp } {
  let observedMax = 0;
  const existing = mergeClocksForRedirects(state);
  for (const clock of existing)
    observedMax = Math.max(observedMax, clock.counter);
  const counter = observedMax + 1;
  const mergeClocks = existing.filter((clock) => clock.nodeId !== nodeId);
  mergeClocks.push({ nodeId, counter });
  mergeClocks.sort((left, right) =>
    compareContactsSyncText(left.nodeId, right.nodeId),
  );
  return {
    state: { ...state, mergeClocks },
    stamp: { counter, nodeId },
  };
}

export function nextContactsSyncStamp(
  state: ContactsSyncState,
  nodeId: string,
): { state: ContactsSyncState; stamp: ContactsSyncStamp } {
  // 磁盘与远端状态进入仓库前都会验证 clocks 覆盖全部内容 stamp，因此本地编辑
  // 只需扫描至多 256 个设备时钟，不再随联系人总量线性变慢。
  let observedMax = 0;
  for (const clock of state.clocks) {
    observedMax = Math.max(observedMax, clock.counter);
  }
  const counter = observedMax + 1;
  const clocks = state.clocks.filter((clock) => clock.nodeId !== nodeId);
  clocks.push({ nodeId, counter });
  clocks.sort((left, right) =>
    compareContactsSyncText(left.nodeId, right.nodeId),
  );
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
  knownMergeClocks: ContactsSyncClock[] = [],
): ContactsSyncState {
  const known = new Map(
    knownClocks.map((clock) => [clock.nodeId, clock.counter]),
  );
  const knownMerges = new Map(
    knownMergeClocks.map((clock) => [clock.nodeId, clock.counter]),
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
  const mergeIsNew = (entity: ContactsSyncEntity<unknown>): boolean =>
    entity.value.stamp.counter >
    (knownMerges.get(entity.value.stamp.nodeId) ?? 0);
  const merges = (state.merges ?? []).filter(mergeIsNew);
  const deletions = (state.deletions ?? []).filter(mergeIsNew);
  const evidenceSourceIds = new Set([
    ...merges.map((merge) => merge.id),
    ...deletions.map((deletion) => deletion.id),
  ]);

  return {
    version: CONTACTS_SYNC_VERSION,
    clocks: state.clocks.map((clock) => ({ ...clock })),
    mergeClocks: mergeClocksForRedirects(state).map((clock) => ({ ...clock })),
    // 旧客户端可能已确认 source tombstone 的普通时钟，却吞掉未知 redirect；
    // redirect / 删除意图尚未确认时必须把 tombstone 一并重发，让升级后的接收端
    // 能原子迁移或删除本机锚点。
    contacts: state.contacts.filter(
      (contact) => contactIsNew(contact) || evidenceSourceIds.has(contact.id),
    ),
    identities: state.identities.filter(entityIsNew),
    events: state.events.filter(entityIsNew),
    groups: state.groups.filter(entityIsNew),
    memberships: state.memberships.filter(entityIsNew),
    relations: state.relations.filter(entityIsNew),
    merges,
    deletions,
  };
}
