/**
 * 把 SQLite 在两次观察之间的差异写进 CRDT 状态。
 *
 * previous 是上次由同步层确认过的本地投影，而不是直接拿远端状态反推。这样
 * 因唯一约束被确定性隐藏的远端冲突行不会被误判成“本机删除”。
 */

import {
  compareContactsSyncText,
  nextContactsSyncStamp,
  stableContactsSyncJson,
} from "./merge.js";
import {
  type ContactsDataSnapshot,
  type ContactsSnapshotContact,
  type ContactsSyncContact,
  type ContactsSyncEntity,
  type ContactsSyncStamp,
  type ContactsSyncState,
  type ContactsStampedValue,
} from "./types.js";

function equal(a: unknown, b: unknown): boolean {
  return stableContactsSyncJson(a) === stableContactsSyncJson(b);
}

function stamped<T>(
  value: T,
  stamp: ContactsSyncStamp,
): ContactsStampedValue<T> {
  return { value, stamp };
}

function createContact(
  row: ContactsSnapshotContact,
  stamp: ContactsSyncStamp,
): ContactsSyncContact {
  return {
    id: row.id,
    kind: stamped(row.kind, stamp),
    displayName: stamped(row.displayName, stamp),
    aliases: stamped(row.aliases, stamp),
    summary: stamped(row.summary, stamp),
    narrative: stamped(row.narrative, stamp),
    agentNotes: stamped(row.agentNotes, stamp),
    status: stamped(row.status, stamp),
    source: stamped(row.source, stamp),
    createdAt: stamped(row.createdAt, stamp),
    updatedAt: stamped(row.updatedAt, stamp),
  };
}

function updateContact(
  existing: ContactsSyncContact,
  previous: ContactsSnapshotContact,
  current: ContactsSnapshotContact,
  stamp: ContactsSyncStamp,
): ContactsSyncContact {
  const next = { ...existing };
  if (previous.kind !== current.kind) next.kind = stamped(current.kind, stamp);
  if (previous.displayName !== current.displayName)
    next.displayName = stamped(current.displayName, stamp);
  if (!equal(previous.aliases, current.aliases))
    next.aliases = stamped(current.aliases, stamp);
  if (previous.summary !== current.summary)
    next.summary = stamped(current.summary, stamp);
  if (previous.narrative !== current.narrative)
    next.narrative = stamped(current.narrative, stamp);
  if (previous.agentNotes !== current.agentNotes)
    next.agentNotes = stamped(current.agentNotes, stamp);
  if (previous.status !== current.status)
    next.status = stamped(current.status, stamp);
  if (previous.source !== current.source)
    next.source = stamped(current.source, stamp);
  if (previous.createdAt !== current.createdAt)
    next.createdAt = stamped(current.createdAt, stamp);
  if (previous.updatedAt !== current.updatedAt)
    next.updatedAt = stamped(current.updatedAt, stamp);
  return next;
}

function captureContacts(
  state: ContactsSyncContact[],
  previous: ContactsSnapshotContact[],
  current: ContactsSnapshotContact[],
  stamp: ContactsSyncStamp,
): ContactsSyncContact[] {
  const records = new Map(state.map((record) => [record.id, record]));
  const before = new Map(previous.map((row) => [row.id, row]));
  const after = new Map(current.map((row) => [row.id, row]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldRow = before.get(id);
    const newRow = after.get(id);
    const existing = records.get(id);
    if (newRow && !oldRow) {
      if (!existing) records.set(id, createContact(newRow, stamp));
      continue;
    }
    if (newRow && oldRow) {
      records.set(
        id,
        existing
          ? updateContact(existing, oldRow, newRow, stamp)
          : createContact(newRow, stamp),
      );
      continue;
    }
    if (oldRow && existing && !existing.deleted) {
      records.set(id, { ...existing, deleted: stamp });
    }
  }
  return [...records.values()].sort((a, b) =>
    compareContactsSyncText(a.id, b.id),
  );
}

type RowWithId = { id: string };

function valueWithoutId<T extends RowWithId>(row: T): Omit<T, "id"> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "id"),
  ) as Omit<T, "id">;
}

function captureEntities<T extends RowWithId>(
  state: Array<ContactsSyncEntity<Omit<T, "id">>>,
  previous: T[],
  current: T[],
  stamp: ContactsSyncStamp,
  options: { reusableId?: boolean } = {},
): Array<ContactsSyncEntity<Omit<T, "id">>> {
  const records = new Map(state.map((record) => [record.id, record]));
  const before = new Map(previous.map((row) => [row.id, row]));
  const after = new Map(current.map((row) => [row.id, row]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldRow = before.get(id);
    const newRow = after.get(id);
    const existing = records.get(id);
    if (newRow && (!oldRow || !equal(oldRow, newRow))) {
      records.set(id, {
        id,
        value: stamped(valueWithoutId(newRow), stamp),
        ...(existing?.deleted ? { deleted: existing.deleted } : {}),
      });
      continue;
    }
    if (
      oldRow &&
      !newRow &&
      existing &&
      (!existing.deleted || options.reusableId)
    ) {
      records.set(id, { ...existing, deleted: stamp });
    }
  }
  return [...records.values()].sort((a, b) =>
    compareContactsSyncText(a.id, b.id),
  );
}

export function captureContactsSnapshot(
  state: ContactsSyncState,
  previous: ContactsDataSnapshot,
  current: ContactsDataSnapshot,
  nodeId: string,
): { state: ContactsSyncState; changed: boolean } {
  if (equal(previous, current)) return { state, changed: false };
  const next = nextContactsSyncStamp(state, nodeId);
  return {
    changed: true,
    state: {
      ...next.state,
      contacts: captureContacts(
        state.contacts,
        previous.contacts,
        current.contacts,
        next.stamp,
      ),
      identities: captureEntities(
        state.identities,
        previous.identities,
        current.identities,
        next.stamp,
      ),
      events: captureEntities(
        state.events,
        previous.events,
        current.events,
        next.stamp,
      ),
      groups: captureEntities(
        state.groups,
        previous.groups,
        current.groups,
        next.stamp,
      ),
      memberships: captureEntities(
        state.memberships,
        previous.memberships,
        current.memberships,
        next.stamp,
        { reusableId: true },
      ),
      relations: captureEntities(
        state.relations,
        previous.relations,
        current.relations,
        next.stamp,
      ),
    },
  };
}
