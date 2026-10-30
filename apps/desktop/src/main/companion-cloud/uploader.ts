/**
 * Home-only upload of a companion's profile, memories and own skills as Chat Server
 * preferences of the companion actor (cloud-companions.md §2). Only changed values
 * are written; values that disappeared locally become `null` tombstones.
 */
import { createHash } from 'node:crypto';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';

export const COMPANION_PROFILE_KEY = 'companion.profile.v1';
export const COMPANION_MEMORY_PREFIX = 'companion.memory.v1:';
export const COMPANION_SKILL_PREFIX = 'companion.skill.v1:';
/** One open (or recently closed) todo per key; the whole file would not fit one value. */
export const COMPANION_TODO_PREFIX = 'companion.todo.v1:';
/** One routine definition per key (run history stays on the computer it ran on). */
export const COMPANION_ROUTINE_PREFIX = 'companion.routine.v1:';
/** Workbench folders (with the computer each is on) and portable judgments. */
export const COMPANION_WORKBENCH_KEY = 'companion.workbench.v1';
/** Capability setup that means the same on any computer (capabilities.ts); never the permission level. */
export const COMPANION_CAPABILITIES_KEY = 'companion.capabilities.v1';
const OWNED_PREFIXES = [COMPANION_PROFILE_KEY, COMPANION_MEMORY_PREFIX, COMPANION_SKILL_PREFIX,
  COMPANION_TODO_PREFIX, COMPANION_ROUTINE_PREFIX, COMPANION_WORKBENCH_KEY, COMPANION_CAPABILITIES_KEY];
const MAX_KEY_LENGTH = 160;
export const COMPANION_VALUE_MAX_BYTES = 60 * 1024;
/** A value over the size limit was not uploaded (thrown only when every value is required). */
export const COMPANION_VALUE_TOO_LARGE = 'COMPANION_VALUE_TOO_LARGE';

/**
 * One value to upload. `unread` marks a key prefix that could not be read this cycle (e.g. the
 * routine engine is not ready): its server values stay as they are and nothing under it is
 * tombstoned; a hand-over, which needs everything, fails instead.
 */
export interface CompanionPreferenceValue { key: string; value: unknown; unread?: boolean }
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
  readValues: (botId: string) => Promise<CompanionPreferenceValue[]>;
  /** Re-read the server: is this computer still the home? Asked before overwriting a conflicting value. */
  confirmHome?: (botId: string, actorId: string) => Promise<boolean>;
  /** The home moved away while uploading: re-read actors so this copy is demoted. */
  onLostHome?: () => void;
  log?: CompanionLog;
  maxValueBytes?: number;
}) {
  const maxBytes = deps.maxValueBytes ?? COMPANION_VALUE_MAX_BYTES;
  const owned = (key: string) => OWNED_PREFIXES.some(prefix => key === prefix || (prefix.endsWith(':') && key.startsWith(prefix)));
  type Row = { key: string; value: unknown; revision: number };
  const readRows = async (actorId: string) => {
    const rows = await deps.api<Row[]>('/preferences', 'GET', undefined, actorId);
    return Array.isArray(rows) ? rows : [];
  };

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

  /**
   * Upload what changed; returns the number of writes made (bounded by `budget`). With
   * `requireAll` (before a hand-over) an oversized value fails the sync instead of being skipped.
   */
  async function syncBot(botId: string, actorId: string, budget = Number.POSITIVE_INFINITY,
    options: { requireAll?: boolean } = {}): Promise<number> {
    const read = await deps.readValues(botId);
    const unread = read.filter(entry => entry.unread).map(entry => entry.key);
    if (unread.length && options.requireAll) throw new Error(COMPANION_READ_INCOMPLETE);
    const values = read.filter(entry => !entry.unread);
    if (deps.state.bot(botId)?.actorId !== actorId || !deps.state.bot(botId)?.prefsSeeded) await seed(botId, actorId);
    const desired = new Map<string, unknown>();
    for (const { key, value } of values) desired.set(key, value);
    // Only keys this device itself had are tombstoned; never what merely exists on the server,
    // nor anything under a part that could not be read this time.
    for (const [key, entry] of Object.entries(deps.state.bot(botId)?.prefs ?? {})) {
      if (unread.some(prefix => key.startsWith(prefix))) continue;
      if (!desired.has(key) && entry.local && entry.hash !== TOMBSTONE_HASH) desired.set(key, null);
    }
    let writes = 0;
    let skipped = 0;
    for (const [key, value] of desired) {
      const json = canonicalJson(value);
      if (key.length > MAX_KEY_LENGTH || Buffer.byteLength(json) > maxBytes) {
        deps.log?.warn('Companion value too large to upload; skipped', { actorId, keyKind: key.split(':')[0], bytes: Buffer.byteLength(json) });
        skipped += 1;
        continue;
      }
      const hash = sha256(json);
      const prior = deps.state.bot(botId)?.prefs[key];
      if (prior ? prior.hash === hash : value === null) {
        if (prior && !prior.local && value !== null) deps.state.update(botId, actorId, entry => { entry.prefs[key] = { ...prior, local: true }; });
        continue;
      }
      if (writes >= budget) break;
      writes += 1;
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
