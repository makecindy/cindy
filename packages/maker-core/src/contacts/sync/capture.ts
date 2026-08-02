/**
 * 把 SQLite 在两次观察之间的差异写进 CRDT 状态。
 *
 * previous 是上次由同步层确认过的本地投影，而不是直接拿远端状态反推。这样
 * 因唯一约束被确定性隐藏的远端冲突行不会被误判成“本机删除”。
 */

import {
  compareContactsSyncText,
  nextContactsSyncMergeStamp,
  nextContactsSyncStamp,
  stableContactsSyncJson,
} from "./merge.js";
import {
  type ContactsDataSnapshot,
  type ContactsSnapshotContact,
  type ContactsSyncContact,
  type ContactsSyncDeletionValue,
  type ContactsSyncEntity,
  type ContactsSyncMergeValue,
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

function captureMergeRedirects(
  state: Array<ContactsSyncEntity<ContactsSyncMergeValue>>,
  redirects: Array<{ sourceId: string; targetId: string }>,
  stamp: ContactsSyncStamp,
): Array<ContactsSyncEntity<ContactsSyncMergeValue>> {
  const records = new Map(state.map((record) => [record.id, record]));
  for (const { sourceId, targetId } of redirects) {
    const existing = records.get(sourceId);
    if (existing?.value.value.targetId === targetId) continue;
    records.set(sourceId, {
      id: sourceId,
      value: stamped({ targetId }, stamp),
    });
  }
  return [...records.values()].sort((a, b) =>
    compareContactsSyncText(a.id, b.id),
  );
}

function captureDeletionIntents(
  state: Array<ContactsSyncEntity<ContactsSyncDeletionValue>>,
  contactIds: string[],
  stamp: ContactsSyncStamp,
): Array<ContactsSyncEntity<ContactsSyncDeletionValue>> {
  const records = new Map(state.map((record) => [record.id, record]));
  for (const contactId of contactIds) {
    if (records.has(contactId)) continue;
    records.set(contactId, {
      id: contactId,
      value: stamped({ contactId }, stamp),
    });
  }
  return [...records.values()].sort((a, b) =>
    compareContactsSyncText(a.id, b.id),
  );
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
  mergeRedirects: Array<{ sourceId: string; targetId: string }> = [],
  deletionIntents: string[] = [],
): { state: ContactsSyncState; changed: boolean } {
  const snapshotChanged = !equal(previous, current);
  const mergeChanges = mergeRedirects.filter(({ sourceId, targetId }) =>
    (state.merges ?? []).every(
      (merge) =>
        merge.id !== sourceId || merge.value.value.targetId !== targetId,
    ),
  );
  const deletionChanges = deletionIntents.filter((contactId) =>
    (state.deletions ?? []).every((deletion) => deletion.id !== contactId),
  );
  if (
    !snapshotChanged &&
    mergeChanges.length === 0 &&
    deletionChanges.length === 0
  ) {
    return { state, changed: false };
  }

  let nextState = state;
  let dataStamp: ContactsSyncStamp | undefined;
  if (snapshotChanged) {
    const next = nextContactsSyncStamp(nextState, nodeId);
    nextState = next.state;
    dataStamp = next.stamp;
  }
  let mergeStamp: ContactsSyncStamp | undefined;
  if (mergeChanges.length > 0 || deletionChanges.length > 0) {
    const next = nextContactsSyncMergeStamp(nextState, nodeId);
    nextState = next.state;
    mergeStamp = next.stamp;
  }

  return {
    changed: true,
    state: {
      ...nextState,
      contacts: dataStamp
        ? captureContacts(
            state.contacts,
            previous.contacts,
            current.contacts,
            dataStamp,
          )
        : state.contacts,
      identities: dataStamp
        ? captureEntities(
            state.identities,
            previous.identities,
            current.identities,
            dataStamp,
          )
        : state.identities,
      events: dataStamp
        ? captureEntities(
            state.events,
            previous.events,
            current.events,
            dataStamp,
          )
        : state.events,
      groups: dataStamp
        ? captureEntities(
            state.groups,
            previous.groups,
            current.groups,
            dataStamp,
          )
        : state.groups,
      memberships: dataStamp
        ? captureEntities(
            state.memberships,
            previous.memberships,
            current.memberships,
            dataStamp,
            { reusableId: true },
          )
        : state.memberships,
      relations: dataStamp
        ? captureEntities(
            state.relations,
            previous.relations,
            current.relations,
            dataStamp,
          )
        : state.relations,
      merges: mergeStamp
        ? captureMergeRedirects(state.merges ?? [], mergeChanges, mergeStamp)
        : (state.merges ?? []),
      deletions: mergeStamp
        ? captureDeletionIntents(
            state.deletions ?? [],
            deletionChanges,
            mergeStamp,
          )
        : (state.deletions ?? []),
    },
  };
}
