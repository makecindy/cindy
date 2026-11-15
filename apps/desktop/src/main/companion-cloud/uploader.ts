/**
 * Home-only upload of a companion's profile, memories and own skills as Chat Server
 * preferences of the companion actor (cloud-companions.md §2). Only changed values
 * are written; values that disappeared locally become `null` tombstones.
 */
import { createHash } from 'node:crypto';
import type { LocalBotSkillFile } from '../maker-ipc/botSkillFiles.js';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';
import { STORE_KEY_MAX_LENGTH, readPreference, readPreferences, storedValueHash, type CompanionStore } from './store.js';

export const COMPANION_PROFILE_KEY = 'companion.profile.v1';
export const COMPANION_MEMORY_PREFIX = 'companion.memory.v1:';
export const COMPANION_SKILL_PREFIX = 'companion.skill.v1:';
/** Which room files hold what sits beside a skill's SKILL.md (skillFiles.ts). */
export const COMPANION_SKILL_FILES_PREFIX = 'companion.skill-files.v1:';
/** Teammates no longer keep todos. Still owned, so this computer clears its old rows in the cloud. */
export const COMPANION_TODO_PREFIX = 'companion.todo.v1:';
/**
 * One V1 routine definition per key. Teammates' scheduled work is now their project's automations:
 * nothing is uploaded under it any more, but it stays owned so this computer clears its old rows in
 * the cloud. Rows from a computer still on V1 are still applied on arrival (host.ts).
 */
export const COMPANION_ROUTINE_PREFIX = 'companion.routine.v1:';
/** Workbench folders (with the computer each is on) and portable judgments. */
export const COMPANION_WORKBENCH_KEY = 'companion.workbench.v1';
/** Capability setup that means the same on any computer (capabilities.ts); never the permission level. */
export const COMPANION_CAPABILITIES_KEY = 'companion.capabilities.v1';
/**
 * A V2 teammate's project rules: its `AGENTS.md`, `{ content }` (project.ts). The project's files
 * stay on the main computer; only the rules travel. Older computers do not know the key.
 */
export const COMPANION_PROJECT_RULES_KEY = 'companion.project-rules.v1';
/**
 * One automation of a V2 teammate's project per key (`<configId>` of its `schedules.json`):
 * `{ config, paused, originDeviceId? }` (project.ts). Older computers do not know the prefix.
 */
export const COMPANION_AUTOMATION_PREFIX = 'companion.automation.v1:';
/**
 * The unfinished V1 work its upgrade wrote into the project (`CARRYOVER.md`, `{ content }`): its
 * rules point to it, so it travels with them. Older computers do not know the key.
 */
export const COMPANION_PROJECT_CARRYOVER_KEY = 'companion.project-carryover.v1';
const OWNED_PREFIXES = [COMPANION_PROFILE_KEY, COMPANION_MEMORY_PREFIX, COMPANION_SKILL_PREFIX, COMPANION_SKILL_FILES_PREFIX,
  COMPANION_TODO_PREFIX, COMPANION_ROUTINE_PREFIX, COMPANION_WORKBENCH_KEY, COMPANION_CAPABILITIES_KEY,
  COMPANION_PROJECT_RULES_KEY, COMPANION_AUTOMATION_PREFIX, COMPANION_PROJECT_CARRYOVER_KEY];
const MAX_KEY_LENGTH = 160;
export const COMPANION_VALUE_MAX_BYTES = 60 * 1024;
/** A value over the size limit was not uploaded (thrown only when every value is required). */
export const COMPANION_VALUE_TOO_LARGE = 'COMPANION_VALUE_TOO_LARGE';
/** Companion store answers that do not change on a retry. */
const STORE_REFUSALS = new Set(['MEDIA_STORAGE_UNAVAILABLE', 'VALUE_TOO_LARGE', 'COMPANION_STORE_QUOTA', 'UNSUPPORTED_TYPE']);

/**
 * One value to upload. `unread` marks a key prefix that could not be read this cycle (e.g. the
 * workbench): its server values stay as they are and nothing under it is
 * tombstoned; a hand-over, which needs everything, fails instead.
 */
export interface CompanionPreferenceValue {
  key: string;
  value: unknown;
  unread?: boolean;
  /** A skill's files as listed here; skillFiles.ts turns them into the value before upload. */
  localFiles?: LocalBotSkillFile[];
}
/** A required part of the companion could not be read: the hand-over waits for the next try. */
export const COMPANION_READ_INCOMPLETE = 'COMPANION_READ_INCOMPLETE';

const PROFILE_FIELDS = ['name', 'description', 'soul', 'systemPrompt', 'user'] as const;
export type CompanionProfileSnapshot = Record<(typeof PROFILE_FIELDS)[number], string>;

/** The complete profile the home uploads (host.readCompanionValues); anything less is not a snapshot. */
export function isCompanionProfileSnapshot(value: unknown): value is CompanionProfileSnapshot {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && PROFILE_FIELDS.every(field => typeof (value as Record<string, unknown>)[field] === 'string');
}

/** Stable JSON (sorted object keys): the server's JSONB does not preserve key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const TOMBSTONE_HASH = sha256('null');
export const valueHash = (value: unknown) => sha256(canonicalJson(value));
/** First-upgrade bursts are spread over cycles. */
export const COMPANION_UPLOAD_WRITES_PER_CYCLE = 30;

export class CompanionLostHomeError extends Error {
  constructor() { super('NOT_HOME'); }
}

export function createCompanionUploader(deps: {
  api: CompanionApi;
  state: CompanionCloudState;
  readValues: (botId: string, actorId: string) => Promise<CompanionPreferenceValue[]>;
  /** Re-read the server: is this computer still the home? Asked before overwriting a conflicting value. */
  confirmHome?: (botId: string, actorId: string) => Promise<boolean>;
  /** The home moved away while uploading: re-read actors so this copy is demoted. */
  onLostHome?: () => void;
  log?: CompanionLog;
  maxValueBytes?: number;
  /** Values too large for the preferences go to the companion store when the server offers it (store.ts). */
  store?: CompanionStore;
}) {
  const maxBytes = deps.maxValueBytes ?? COMPANION_VALUE_MAX_BYTES;
  const owned = (key: string) => OWNED_PREFIXES.some(prefix => key === prefix || (prefix.endsWith(':') && key.startsWith(prefix)));
  type Row = { key: string; value: unknown; revision: number };
  const readRows = (actorId: string): Promise<Row[]> => readPreferences(deps.api, actorId);
  /** Values the store refused for good (`${actorId}\n${key}` → hash): not asked again until they change. */
  const refused = new Map<string, string>();

  async function write(actorId: string, key: string, value: unknown, json: string, expectedRevision: number) {
    const operationId = `cpref:${sha256(`${key}\n${expectedRevision}\n${json}`).slice(0, 48)}`;
    const result = await deps.api<{ revision?: number }>('/preferences', 'POST', { operationId, key, expectedRevision, value }, actorId);
    return typeof result?.revision === 'number' ? result.revision : expectedRevision + 1;
  }

  /** Read the server's revisions once, so a lost state file never conflicts forever. Keeps which keys were ours. */
  async function seed(botId: string, actorId: string) {
    const rows = await readRows(actorId);
    deps.state.update(botId, actorId, entry => {
      for (const row of rows) {
        if (!owned(row.key) || typeof row.revision !== 'number') continue;
        const known = entry.prefs[row.key];
        // A key this device holds keeps the value it holds (e.g. what a take-over just restored):
        // a newer server value written meanwhile (the old home's late upload) is not an edit here,
        // and must not be overwritten unless this device really changes the key.
        entry.prefs[row.key] = known?.local
          ? { ...known, revision: row.revision }
          : { hash: valueHash(row.value), revision: row.revision };
      }
      entry.prefsSeeded = true;
    });
  }

  /** Someone else wrote this key: only the home may overwrite it, and only once. */
  async function resolveConflict(botId: string, actorId: string, key: string, value: unknown, json: string, hash: string, fallbackRevision: number) {
    if (deps.confirmHome && !(await deps.confirmHome(botId, actorId))) {
      deps.onLostHome?.();
      throw new CompanionLostHomeError();
    }
    const server = (await readRows(actorId)).find(row => row.key === key);
    if (server && valueHash(server.value) === hash) return server.revision;
    return write(actorId, key, value, json, server?.revision ?? fallbackRevision);
  }

  async function writePreference(botId: string, actorId: string, key: string, value: unknown, json: string, hash: string) {
    const prior = deps.state.bot(botId)?.prefs[key];
    let revision: number;
    try {
      revision = await write(actorId, key, value, json, prior?.revision ?? 0);
    } catch (error) {
      const conflict = chatRejection(error, 409, 'REVISION_CONFLICT');
      if (!conflict || typeof conflict.revision !== 'number') throw error;
      revision = await resolveConflict(botId, actorId, key, value, json, hash, conflict.revision);
    }
    deps.state.update(botId, actorId, entry => { entry.prefs[key] = { hash, revision, local: true }; });
  }

  /** Store revisions once per state file, like `seed`; keys this device holds stay its own. */
  async function seedStore(botId: string, actorId: string, store: CompanionStore) {
    const server = await store.revisions(actorId);
    // A live store value under a key whose current value this computer holds in the preferences
    // is this computer's to clear only if that preference row is newer than the value (written
    // over an older row); a later value (the previous home's late upload) stays until edited here.
    const superseded = new Set<string>();
    const kept = new Map<string, number>();
    const before = deps.state.bot(botId);
    for (const [key, row] of server) {
      const pref = before?.prefs[key];
      if (!owned(key) || row.hash === TOMBSTONE_HASH || before?.stored?.[key]?.local || !pref?.local) continue;
      let current = await store.entry(actorId, key) as { prefRevision?: number; blob?: unknown } | undefined;
      // A large value keeps its ordering revision inside the bucket file.
      if (current?.blob) current = await store.valueOf(actorId, key);
      if (!current) continue;
      if (current.prefRevision === undefined) continue;
      if (pref.revision > current.prefRevision) superseded.add(key);
      else kept.set(key, current.prefRevision);
    }
    deps.state.update(botId, actorId, entry => {
      const stored = entry.stored ?? {};
      for (const [key, row] of server) {
        if (!owned(key)) continue;
        const known = stored[key];
        stored[key] = known?.local ? { ...known, revision: row.revision }
          : { hash: row.hash, revision: row.revision, ...(superseded.has(key) ? { local: true } : {}),
            ...(kept.has(key) ? { prefRevision: kept.get(key) } : {}) };
      }
      entry.stored = stored;
      entry.storeSeeded = true;
    });
  }

  async function resolveStoreConflict(botId: string, actorId: string, store: CompanionStore, key: string, value: unknown, hash: string) {
    if (deps.confirmHome && !(await deps.confirmHome(botId, actorId))) {
      deps.onLostHome?.();
      throw new CompanionLostHomeError();
    }
    const prefRevision = deps.state.bot(botId)?.prefs[key]?.revision ?? 0;
    const server = await store.entry(actorId, key);
    // The same value counts only if its store copy also supersedes the current preference row.
    const same = !server.deleted && (server.blob ? server.hash === store.blobHash(value, prefRevision)
      : valueHash(server.value) === hash && ((server as { prefRevision?: number }).prefRevision ?? 0) >= prefRevision);
    if (same || (server.deleted && value === null)) return server.revision;
    // Clearing an old copy is not an edit: a value written meanwhile over this computer's
    // preference row (the previous home's late upload) stays.
    const serverPrefRevision = (server as { prefRevision?: number }).prefRevision;
    if (value === null && !server.deleted && (server.blob || (serverPrefRevision !== undefined && serverPrefRevision >= prefRevision))) {
      deps.state.update(botId, actorId, entry => { entry.stored = { ...entry.stored, [key]: { hash: server.hash, revision: server.revision, ...(serverPrefRevision !== undefined ? { prefRevision: serverPrefRevision } : {}) } }; });
      return null;
    }
    return store.write(actorId, key, value, server.revision, prefRevision);
  }

  /**
   * Upload what changed; returns the number of writes made (bounded by `budget`). With
   * `requireAll` (before a hand-over) an oversized value fails the sync instead of being skipped.
   * `preferencesOnly`: the reader cannot read the companion store (an older Cindy taking over), so
   * a value the preferences cannot hold counts as not uploaded.
   */
  async function syncBot(botId: string, actorId: string, budget = Number.POSITIVE_INFINITY,
    options: { requireAll?: boolean; preferencesOnly?: boolean } = {}): Promise<number> {
    const read = await deps.readValues(botId, actorId);
    const unread = read.filter(entry => entry.unread).map(entry => entry.key);
    if (unread.length && options.requireAll) throw new Error(COMPANION_READ_INCOMPLETE);
    const values = read.filter(entry => !entry.unread);
    if (deps.state.bot(botId)?.actorId !== actorId || !deps.state.bot(botId)?.prefsSeeded) await seed(botId, actorId);
    const desired = new Map<string, unknown>();
    for (const { key, value } of values) desired.set(key, value);
    // Only keys this device itself had are tombstoned; never what merely exists on the server,
    // nor anything under a part that could not be read this time.
    // A hand-over must not trust a pause from an earlier switch-off: the server may be back, and a
    // store copy left uncleared there would win over the preferences on the receiving computer.
    if (options.requireAll) deps.store?.retryNow();
    let store = deps.store?.active() ? deps.store : undefined;
    // Values only the store holds count as uploaded only if the store answers now: a store
    // switched off since the last pass must fail a complete sync, not pass it unchanged.
    const storeOnly = Object.entries(deps.state.bot(botId)?.stored ?? {}).find(([, entry]) => entry.local && entry.hash !== TOMBSTONE_HASH);
    if (options.requireAll && store && storeOnly) {
      try { await store.entry(actorId, storeOnly[0]); } catch (error) {
        if (store.active()) throw error;
        store = undefined;
      }
    }
    if (store && !deps.state.bot(botId)?.storeSeeded) {
      try { await seedStore(botId, actorId, store); } catch (error) {
        // Switched off on the server: the preferences alone, as before.
        if (store.active()) throw error;
        store = undefined;
      }
    }
    // Store keys count too, whether or not the store is available: a deletion of a value this
    // computer kept there also goes into the preferences (below), which is all a reader without
    // the store sees, so a store tombstone without a preference tombstone still needs one.
    const known = deps.state.bot(botId);
    for (const [key, entry] of Object.entries(known?.prefs ?? {})) {
      if (unread.some(prefix => key.startsWith(prefix))) continue;
      if (!desired.has(key) && entry.local && entry.hash !== TOMBSTONE_HASH) desired.set(key, null);
    }
    for (const [key, entry] of Object.entries(known?.stored ?? {})) {
      if (unread.some(prefix => key.startsWith(prefix))) continue;
      if (!desired.has(key) && entry.local && (entry.hash !== TOMBSTONE_HASH || known?.prefs[key]?.hash !== TOMBSTONE_HASH)) desired.set(key, null);
    }
    let writes = 0;
    let skipped = 0;
    for (const [key, value] of desired) {
      const json = canonicalJson(value);
      const inPreferences = key.length <= MAX_KEY_LENGTH && Buffer.byteLength(json) <= maxBytes;
      const hash = sha256(json);
      const storeUsable = !!store?.active() && key.length <= STORE_KEY_MAX_LENGTH && refused.get(`${actorId}\n${key}`) !== hash;
      // `preferencesOnly` only stops a value the reader could not see from counting as uploaded;
      // clearing the store copy of a value that shrank or was deleted must still happen.
      const inStore = storeUsable && (inPreferences || !options.preferencesOnly);
      if (!inPreferences && !inStore) {
        deps.log?.warn('Companion value too large to upload; skipped', { actorId, keyKind: key.split(':')[0], bytes: Buffer.byteLength(json) });
        skipped += 1;
        continue;
      }
      // Preferences stay complete for every value they can hold: older versions read only them.
      if (inPreferences) {
        const prior = deps.state.bot(botId)?.prefs[key];
        const storedHere = deps.state.bot(botId)?.stored?.[key];
        // A deleted value this computer kept in the store gets a tombstone here too, though the
        // preferences never had the key: a reader without the store (switched off) must see it.
        const storeDeletionPending = value === null && !!storedHere?.local;
        // Back from the store with the very value (or deletion) the preferences still hold: write
        // it again, so the preference row is newer than the store copy even while that copy cannot
        // be cleared.
        const storeCopyAhead = !!prior && !!storedHere?.local && storedHere.hash !== TOMBSTONE_HASH
          && storedHere.prefRevision !== undefined && prior.revision <= storedHere.prefRevision;
        if (prior ? prior.hash === hash && !storeCopyAhead : value === null && !storeDeletionPending) {
          if (prior && !prior.local && value !== null) deps.state.update(botId, actorId, entry => { entry.prefs[key] = { ...prior, local: true }; });
        } else {
          if (writes >= budget) break;
          writes += 1;
          await writePreference(botId, actorId, key, value, json, hash);
        }
      }
      if (!inStore || !store?.active()) continue;
      // The store holds only what the preferences cannot (so nothing is read twice); a value
      // that fits them again leaves it.
      const priorStored = deps.state.bot(botId)?.stored?.[key];
      // A preference revision another computer moved (a late upload) does not make an unchanged
      // value here an edit: only this computer's own preference writes call for a rewrite.
      const prefHere = deps.state.bot(botId)?.prefs[key];
      let prefRevision = prefHere?.local ? prefHere.revision : priorStored?.prefRevision ?? prefHere?.revision ?? 0;
      const storeValue = inPreferences ? null : value;
      let storeHash = inPreferences ? TOMBSTONE_HASH : storedValueHash(value, prefRevision);
      // Only a store copy this computer wrote or took over is cleared here: another computer's
      // later value stays until this computer actually edits the key.
      if (priorStored ? priorStored.hash === storeHash || (storeValue === null && !priorStored.local) : storeValue === null) {
        if (priorStored && !priorStored.local && storeValue !== null) deps.state.update(botId, actorId, entry => { entry.stored = { ...entry.stored, [key]: { ...priorStored, local: true } }; });
        continue;
      }
      if (writes >= budget) break;
      writes += 1;
      if (storeValue !== null) {
        // The preference row may have moved since the seed (a late upload of the previous home):
        // the store copy must supersede the row as it is now.
        const current = await readPreference(deps.api, actorId, key);
        if (current && current.revision > prefRevision) {
          prefRevision = current.revision;
          storeHash = storedValueHash(value, prefRevision);
          deps.state.update(botId, actorId, entry => {
            const known = entry.prefs[key];
            entry.prefs[key] = known ? { ...known, revision: current.revision } : { hash: valueHash(current.value), revision: current.revision };
          });
        }
      }
      let revision: number;
      try {
        revision = await store.write(actorId, key, storeValue, priorStored?.revision ?? 0, prefRevision);
      } catch (error) {
        // Switched off meanwhile, or a value the store can never take (no bucket, over its
        // limits): skipped as before, so a hand-over still refuses to leave it behind.
        if (!store.active() || STORE_REFUSALS.has(errorCode(error))) {
          // Nothing was written: a pass with only refused store writes counts as settled.
          writes -= 1;
          if (inPreferences) continue;
          if (store.active()) refused.set(`${actorId}\n${key}`, hash);
          deps.log?.warn('Companion value too large to upload; skipped', { actorId, keyKind: key.split(':')[0], bytes: Buffer.byteLength(json), code: errorCode(error) });
          skipped += 1;
          continue;
        }
        const conflict = chatRejection(error, 409, 'REVISION_CONFLICT');
        if (!conflict) throw error;
        const resolved = await resolveStoreConflict(botId, actorId, store, key, storeValue, inPreferences ? TOMBSTONE_HASH : hash);
        if (resolved === null) continue;
        revision = resolved;
      }
      deps.state.update(botId, actorId, entry => { entry.stored = { ...entry.stored, [key]: { hash: storeHash, revision, local: true, ...(storeValue !== null ? { prefRevision } : {}) } }; });
    }
    // A reader limited to the preferences would also miss a later store value another computer
    // wrote (it wins over this computer's preference row on restore): not complete for it either.
    if (options.requireAll && options.preferencesOnly && store?.active()) {
      for (const [key, entry] of Object.entries(deps.state.bot(botId)?.stored ?? {})) {
        // A preference written over the stored copy's revision already wins for every reader.
        const overtaken = entry.prefRevision !== undefined && (deps.state.bot(botId)?.prefs[key]?.revision ?? 0) > entry.prefRevision;
        if (!entry.local && !overtaken && entry.hash !== TOMBSTONE_HASH && owned(key) && !unread.some(prefix => key.startsWith(prefix))) skipped += 1;
      }
    }
    if (skipped > 0 && options.requireAll) throw new Error(COMPANION_VALUE_TOO_LARGE);
    return writes;
  }

  return {
    syncBot,
    /** Errors are logged per companion and retried next cycle. Returns true when the write budget ran out. */
    async syncAll(bots: Array<{ botId: string; actorId: string }>, limit = COMPANION_UPLOAD_WRITES_PER_CYCLE): Promise<boolean> {
      let remaining = limit;
      for (const { botId, actorId } of bots) {
        if (remaining <= 0) return true;
        try { remaining -= await syncBot(botId, actorId, remaining); }
        catch (error) { deps.log?.warn('Companion upload will retry', { actorId, code: errorCode(error) }); }
      }
      return remaining <= 0;
    },
  };
}
