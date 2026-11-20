/**
 * Buddy set (伙伴集) —— a purely presentational, user-named container for buddy
 * rows in the sidebar's Buddies section.
 *
 * This module is state and rules only: no storage, no React, no sessions, no
 * buddy profile writes. A buddy set is NOT a group chat (no conversation, no
 * members, no orchestration), NOT a project (it has no working directory and
 * holds no tasks), NOT a task tag (a buddy belongs to at most one set), and NOT
 * a permission group. Membership is a list of stable buddy roster keys; the
 * container only changes how the existing rows are displayed and navigated.
 *
 * The persisted record is an override only: it never contains a copy of the
 * default (empty) configuration, and unknown/corrupt input falls back to it
 * (docs/dev-rules/configuration-and-overrides.md §2).
 */

export const BUDDY_SETS_STATE_VERSION = 1 as const;

/** Bounds keep a local display preference from growing without limit. */
export const BUDDY_SET_LIMIT = 32;
export const BUDDY_SET_NAME_MAX_CHARS = 80;
export const BUDDY_SET_ID_MAX_CHARS = 256;
export const BUDDY_SET_MEMBER_LIMIT = 200;

export interface BuddySet {
  buddySetId: string;
  name: string;
  buddyIds: string[];
  /** Explicit fold; absent means expanded (the default is never persisted). */
  collapsed?: boolean;
}

export interface BuddySetsState {
  version: typeof BUDDY_SETS_STATE_VERSION;
  /** User-created containers, in display order. */
  sets: BuddySet[];
}

/** The default is derived, never stored. */
export function emptyBuddySets(): BuddySetsState {
  return { version: BUDDY_SETS_STATE_VERSION, sets: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length > 0 && id.length <= BUDDY_SET_ID_MAX_CHARS ? id : null;
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, BUDDY_SET_NAME_MAX_CHARS);
}

/**
 * Normalize any persisted/untrusted shape into a valid state.
 * Enforces the one-buddy-one-set invariant: the first set that claims a buddy
 * keeps it, and later duplicates are dropped. Never mutates the input.
 */
export function normalizeBuddySets(raw: unknown): BuddySetsState {
  if (!isRecord(raw) || raw.version !== BUDDY_SETS_STATE_VERSION || !Array.isArray(raw.sets)) {
    return emptyBuddySets();
  }
  const sets: BuddySet[] = [];
  const seenSetIds = new Set<string>();
  const claimedBuddies = new Set<string>();
  for (const item of raw.sets.slice(0, BUDDY_SET_LIMIT)) {
    if (!isRecord(item)) continue;
    const buddySetId = cleanId(item.buddySetId);
    const name = cleanName(item.name);
    if (!buddySetId || !name || seenSetIds.has(buddySetId)) continue;
    seenSetIds.add(buddySetId);
    const buddyIds: string[] = [];
    if (Array.isArray(item.buddyIds)) {
      for (const candidate of item.buddyIds.slice(0, BUDDY_SET_MEMBER_LIMIT)) {
        const buddyId = cleanId(candidate);
        if (!buddyId || claimedBuddies.has(buddyId)) continue;
        claimedBuddies.add(buddyId);
        buddyIds.push(buddyId);
      }
    }
    sets.push({
      buddySetId,
      name,
      buddyIds,
      ...(item.collapsed === true ? { collapsed: true as const } : {}),
    });
  }
  return { version: BUDDY_SETS_STATE_VERSION, sets };
}

/** Sparse serialization: only user-created containers are written. */
export function serializeBuddySets(state: BuddySetsState): string {
  const normalized = normalizeBuddySets(state);
  if (normalized.sets.length === 0) return '';
  return JSON.stringify({
    version: BUDDY_SETS_STATE_VERSION,
    sets: normalized.sets.map((set) => ({
      buddySetId: set.buddySetId,
      name: set.name,
      buddyIds: set.buddyIds,
      ...(set.collapsed === true ? { collapsed: true } : {}),
    })),
  });
}

/** An absent, empty or corrupt record reads back as the derived default. */
export function parseBuddySets(raw: string | null): BuddySetsState {
  if (!raw) return emptyBuddySets();
  try {
    return normalizeBuddySets(JSON.parse(raw));
  } catch {
    return emptyBuddySets();
  }
}

export function createBuddySet(state: BuddySetsState, id: string, name: string): BuddySetsState {
  const buddySetId = cleanId(id);
  const clean = cleanName(name);
  if (!buddySetId || !clean || state.sets.length >= BUDDY_SET_LIMIT) return state;
  if (state.sets.some((set) => set.buddySetId === buddySetId)) return state;
  return normalizeBuddySets({
    version: BUDDY_SETS_STATE_VERSION,
    sets: [...state.sets, { buddySetId, name: clean, buddyIds: [] }],
  });
}

export function renameBuddySet(state: BuddySetsState, id: string, name: string): BuddySetsState {
  const clean = cleanName(name);
  if (!clean) return state;
  let changed = false;
  const sets = state.sets.map((set) => {
    if (set.buddySetId !== id || set.name === clean) return set;
    changed = true;
    return { ...set, name: clean };
  });
  return changed ? { version: BUDDY_SETS_STATE_VERSION, sets } : state;
}

/** Removing a set returns its buddies to the flat roster: nothing else owns them. */
export function deleteBuddySet(state: BuddySetsState, id: string): BuddySetsState {
  const sets = state.sets.filter((set) => set.buddySetId !== id);
  return sets.length === state.sets.length
    ? state
    : { version: BUDDY_SETS_STATE_VERSION, sets };
}

/** A buddy belongs to at most one set: assignment removes it from every other one. */
export function assignBuddyToSet(
  state: BuddySetsState,
  buddyId: string,
  buddySetId: string,
): BuddySetsState {
  const clean = cleanId(buddyId);
  const target = state.sets.find((set) => set.buddySetId === buddySetId);
  if (!clean || !target) return state;
  // Refuse a full target instead of dropping the new member after removing it
  // from its previous set: the buddy must keep its original membership.
  if (!target.buddyIds.includes(clean) && target.buddyIds.length >= BUDDY_SET_MEMBER_LIMIT) return state;
  const sets = state.sets.map((set) => {
    const without = set.buddyIds.filter((id) => id !== clean);
    if (set.buddySetId !== buddySetId) {
      return without.length === set.buddyIds.length ? set : { ...set, buddyIds: without };
    }
    return { ...set, buddyIds: [...without, clean] };
  });
  return normalizeBuddySets({ version: BUDDY_SETS_STATE_VERSION, sets });
}

/**
 * Apply one set's membership form. Only the target set is edited: selected
 * buddies are claimed by it (and leave any other set, keeping one-buddy-one-set),
 * while unselected candidates are removed only from it — other sets keep their
 * members. Buddies not shown in the form (e.g. offline ones) stay in the target.
 * Returns the input state unchanged when the target set does not exist, so a
 * refused create (set limit reached) can never edit an existing set by mistake.
 */
export function reconcileBuddySetMembers(
  state: BuddySetsState,
  buddySetId: string,
  candidateIds: readonly string[],
  selectedIds: readonly string[],
): BuddySetsState {
  if (!state.sets.some((set) => set.buddySetId === buddySetId)) return state;
  const candidates = new Set(candidateIds.map(cleanId).filter((id): id is string => id !== null));
  const selected = new Set(
    selectedIds.map(cleanId).filter((id): id is string => id !== null && candidates.has(id)),
  );
  // Decide who actually fits before touching any set. Buddies beyond the target's
  // capacity keep their previous membership instead of vanishing from all sets.
  const target = state.sets.find((set) => set.buddySetId === buddySetId)!;
  const kept = target.buddyIds.filter((id) => !candidates.has(id));
  const admitted = [...candidates]
    .filter((id) => selected.has(id) && !kept.includes(id))
    .slice(0, Math.max(0, BUDDY_SET_MEMBER_LIMIT - kept.length));
  const claimed = new Set(admitted);
  const sets = state.sets.map((set) => {
    if (set.buddySetId !== buddySetId) {
      // Only buddies actually admitted to the target leave their previous set.
      return { ...set, buddyIds: set.buddyIds.filter((id) => !claimed.has(id)) };
    }
    return { ...set, buddyIds: [...kept, ...admitted] };
  });
  return normalizeBuddySets({ version: BUDDY_SETS_STATE_VERSION, sets });
}

/** Unassigning leaves the buddy in the flat roster. */
export function removeBuddyFromSet(state: BuddySetsState, buddyId: string): BuddySetsState {
  const clean = cleanId(buddyId);
  if (!clean) return state;
  let changed = false;
  const sets = state.sets.map((set) => {
    const buddyIds = set.buddyIds.filter((id) => id !== clean);
    if (buddyIds.length === set.buddyIds.length) return set;
    changed = true;
    return { ...set, buddyIds };
  });
  return changed ? { version: BUDDY_SETS_STATE_VERSION, sets } : state;
}

export function setBuddySetCollapsed(
  state: BuddySetsState,
  id: string,
  collapsed: boolean,
): BuddySetsState {
  let changed = false;
  const sets = state.sets.map((set) => {
    if (set.buddySetId !== id) return set;
    const next: BuddySet = collapsed ? { ...set, collapsed: true } : {
      buddySetId: set.buddySetId, name: set.name, buddyIds: set.buddyIds,
    };
    if (next.collapsed === set.collapsed) return set;
    changed = true;
    return next;
  });
  return changed ? { version: BUDDY_SETS_STATE_VERSION, sets } : state;
}

/** Only buddy private-chat rows can ever be collected. */
export type BuddyRosterKind = 'buddy' | 'group' | 'task' | 'device';

export interface BuddyRosterRow {
  /** Stable roster key of this row; not a Session id and not a display name. */
  id: string;
  kind: BuddyRosterKind;
}

export interface BuddyRosterPartition<T> {
  /** One entry per user-created set, in display order (empty sets are kept). */
  groups: Array<{ set: BuddySet; rows: T[] }>;
  /** Everything else: unassigned buddies plus all group/task/device rows. */
  flat: T[];
}

/**
 * Split a sidebar roster into set containers and the flat remainder.
 * Group chats, tasks and the Cindy device row are never collected, even if a
 * set's buddyIds happens to contain the same string: the `kind` guard is the
 * product rule, not a caller convention. Input rows are never mutated.
 */
export function partitionBuddyRoster<T extends BuddyRosterRow>(
  rows: readonly T[],
  state: BuddySetsState,
): BuddyRosterPartition<T> {
  const owner = new Map<string, string>();
  for (const set of state.sets) {
    for (const buddyId of set.buddyIds) {
      if (!owner.has(buddyId)) owner.set(buddyId, set.buddySetId);
    }
  }
  const bySet = new Map<string, T[]>();
  for (const set of state.sets) bySet.set(set.buddySetId, []);
  const flat: T[] = [];
  for (const row of rows) {
    if (row.kind !== 'buddy') {
      flat.push(row);
      continue;
    }
    const buddySetId = owner.get(row.id);
    const bucket = buddySetId ? bySet.get(buddySetId) : undefined;
    if (bucket) bucket.push(row);
    else flat.push(row);
  }
  return {
    groups: state.sets.map((set) => ({ set, rows: bySet.get(set.buddySetId) ?? [] })),
    flat,
  };
}

export function buddySetIdForBuddy(state: BuddySetsState, buddyId: string): string | null {
  for (const set of state.sets) {
    if (set.buddyIds.includes(buddyId)) return set.buddySetId;
  }
  return null;
}
