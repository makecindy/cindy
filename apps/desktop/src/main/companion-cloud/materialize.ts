/**
 * Build or update the local companion from its cloud copy (cloud-companions.md §3.1 step 2-3):
 * profile, memories and own skills from the companion's preferences, then the room's whole
 * conversation as local history, then a deterministic context rebuild. Nothing old is replayed.
 * Every local write is fenced by the owner that started it. The copy stays demoted (does not
 * run, upload or mirror) until everything is restored; a partial restore throws and the
 * automatic take-over retries it.
 */
import type { CompanionMirrorCursor, CompanionMirrorRow } from './mirror.js';
import { COMPANION_HISTORY_CLIENT_PREFIX } from './mirror.js';
import { parseCompanionCapabilities, type CompanionArrivalNotice, type CompanionCapabilitiesValue } from './capabilities.js';
import { directRoomSourceId } from './directRoom.js';
import { readAllRoomMessages } from './room.js';
import type { CompanionCloudState } from './state.js';
import { errorCode, isTransientAttachmentFailure, type CompanionApi, type CompanionLog } from './types.js';
import {
  COMPANION_CAPABILITIES_KEY, COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_ROUTINE_PREFIX, COMPANION_SKILL_PREFIX, COMPANION_TODO_PREFIX,
  COMPANION_WORKBENCH_KEY, TOMBSTONE_HASH, isCompanionProfileSnapshot, valueHash,
} from './uploader.js';

export interface CompanionLocalProfile { status: string; displayName: string; description: string }

/** The owner that started the operation; every host write checks it and aborts on change. */
export interface CompanionWriteFence {
  assertCurrent: () => void;
  signal?: AbortSignal;
}

/** Local profile, Bot Home and Session operations, all through the existing services. */
export interface CompanionMaterializeHost {
  readProfile: (botId: string) => Promise<CompanionLocalProfile | null>;
  /**
   * The cloud avatar is restored when its bytes are still available. A temporary download failure
   * rejects; a permanent one stores the default avatar together with durable local-only provenance.
   */
  createProfile: (input: {
    id: string; name: string; description: string; identitySource: string; userContextSource: string; avatar: string | null;
    /** The preset the companion was made from (the cloud profile's `templateId`). */
    templateId?: string;
  }, fence: CompanionWriteFence) => Promise<void>;
  /**
   * Also makes the profile active again. Undefined fields stay unchanged; a restored cloud avatar
   * replaces the local one. A permanent download failure persists the default with local-only provenance.
   */
  updateProfile: (input: {
    id: string; name: string; description?: string; identitySource?: string; userContextSource?: string; avatar: string | null;
    templateId?: string;
  }, fence: CompanionWriteFence) => Promise<void>;
  /**
   * Apply the companion's portable capability setup (capabilities.ts): references stay even when
   * this computer lacks them, a model chain that is not usable here falls back to the default.
   * Returns what could not be kept, for the one-line notice.
   */
  applyCapabilities?: (botId: string, value: CompanionCapabilitiesValue, fence: CompanionWriteFence) => Promise<CompanionArrivalNotice[]>;
  writeSystemPrompt: (botId: string, text: string, fence: CompanionWriteFence) => Promise<void>;
  /** Copy the companion's Home (identity, prompt, user file, memories, skills) aside; returns where. */
  backupHome?: (botId: string, fence: CompanionWriteFence) => Promise<string | null>;
  readMemory: (botId: string, filename: string) => Promise<string | null>;
  restoreMemory: (botId: string, filename: string, raw: string, fence: CompanionWriteFence) => Promise<void>;
  removeMemory: (botId: string, filename: string, fence: CompanionWriteFence) => Promise<void>;
  readSkill: (botId: string, slug: string) => Promise<string | null>;
  saveSkill: (botId: string, slug: string, content: string, enabled: boolean, fence: CompanionWriteFence) => Promise<void>;
  removeSkill: (botId: string, slug: string, fence: CompanionWriteFence) => Promise<void>;
  /** The companion's todos from the cloud replace the same ids here; `remove` ids are deleted. */
  applyTodos?: (botId: string, items: unknown[], remove: string[], fence: CompanionWriteFence) => Promise<void>;
  /** Its routines from the cloud are created or updated with their ids; `remove` ids are deleted. */
  applyRoutines?: (botId: string, routines: unknown[], remove: string[], fence: CompanionWriteFence) => Promise<void>;
  /**
   * Its workbench folders and portable judgments join this computer's, or with `replace` take their
   * place (`null`: the companion has none).
   */
  applyWorkbench?: (botId: string, value: unknown, fence: CompanionWriteFence, options?: { replace?: boolean }) => Promise<void>;
  ensureCanonicalSession: (botId: string, fence: CompanionWriteFence) => Promise<string>;
  /**
   * Local rows created at or after `fromMs`, including rewound and deleted ones (`removed`):
   * dedupe against mirrored, delivered and deliberately removed messages.
   */
  localMessageTimes: (sessionId: string, fromMs: number) => Promise<Array<{ role: string; createdAt: number; clientId: string; removed?: boolean }>>;
  insertHistory: (sessionId: string, row: {
    clientId: string; role: 'user' | 'assistant'; text: string; createdAt: number;
    /** Files of the message, already downloaded to this computer. */
    attachments?: CompanionHistoryAttachment[];
  }, fence: CompanionWriteFence) => Promise<void>;
  /** Rebuild the native context from DB history like a companion restart; never interrupts a turn. */
  rebuildContext: (sessionId: string, fence: CompanionWriteFence) => Promise<'rebuilt' | 'busy'>;
  /** Newest first; `excludeClientIdPrefix` leaves out rows whose client id starts with it. */
  latestRows: (sessionId: string, limit: number, options?: { excludeClientIdPrefix?: string }) => Promise<CompanionMirrorRow[]>;
}

/** A room file brought to this computer: images in the media store, other files by path. */
export interface CompanionHistoryAttachment {
  name: string; category: string; mimeType: string; size: number; url: string | null; path: string | null;
}

/** Download one of the room's files to this computer. */
export type CompanionRoomDownload = (roomId: string, mediaId: string) => Promise<CompanionHistoryAttachment>;

export interface CompanionMaterializeActor { id: string; externalId: string; name: string; avatar: string | null }

export interface CompanionMaterializeResult {
  created: boolean;
  inserted: number;
  rebuild: 'rebuilt' | 'skipped';
  /** Where an existing, never-synced local copy was saved before being overwritten. */
  backup?: string | null;
  /** What of the old setup this computer could not keep (the permission level never travels). */
  notices: CompanionArrivalNotice[];
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const noFence: CompanionWriteFence = { assertCurrent: () => undefined };

export async function materializeCompanion(input: {
  api: CompanionApi;
  state: CompanionCloudState;
  host: CompanionMaterializeHost;
  actor: CompanionMaterializeActor;
  roomId: () => Promise<string>;
  fence?: CompanionWriteFence;
  log?: CompanionLog;
  /** Publish the demotion (send guard, routines, lists) before the first local write. */
  onDemoted?: () => void;
  /** Brings the room's files along with the history; without it only their names come. */
  download?: CompanionRoomDownload;
}): Promise<CompanionMaterializeResult> {
  const { api, state, host, actor, log } = input;
  const fence = input.fence ?? noFence;
  /** Check the owner before and after each local step. */
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    fence.assertCurrent();
    const value = await run();
    fence.assertCurrent();
    return value;
  };
  const botId = actor.externalId;
  const rows = await step(() => api<Array<{ key: string; value: unknown; revision: number }>>('/preferences', 'GET', undefined, actor.id));
  const prefs = new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row]));
  const profileValue = prefs.get(COMPANION_PROFILE_KEY)?.value;
  const profile = isCompanionProfileSnapshot(profileValue) ? profileValue : null;
  const known = state.bot(botId);
  const knownPrefs = known?.actorId === actor.id ? known.prefs : {};

  const local = await step(() => host.readProfile(botId));
  if (local?.status === 'deleting') throw new Error('PROFILE_DELETING');
  // Not runnable here until the take-over completes: a half-restored copy must never run or
  // upload its stale files over the cloud values.
  fence.assertCurrent();
  state.update(botId, actor.id, entry => { entry.demoted = true; });
  input.onDemoted?.();
  // Without the home's profile snapshot this copy's own (or empty) profile would be published as
  // the companion's identity: wait (demoted, retried) until the home has uploaded one.
  if (!profile) throw new Error('PROFILE_SNAPSHOT_MISSING');
  // An existing local copy is saved before the cloud copy replaces (or deletes) its files.
  let backup: string | null | undefined;
  if (local && !(known?.actorId === actor.id && known.backedUp) && host.backupHome) {
    backup = await step(() => host.backupHome!(botId, fence));
    if (backup) log?.info?.('Companion local copy backed up before take-over', { actorId: actor.id, backup });
    // Once is enough: a take-over that fails later (e.g. avatar unavailable) retries without a new copy.
    state.update(botId, actor.id, entry => { entry.backedUp = true; });
  }
  const name = text(profile?.name)?.trim() || actor.name || local?.displayName || '伙伴';
  const templateId = text(record(profile)?.templateId);
  if (!local) {
    await step(() => host.createProfile({ id: botId, name, description: text(profile?.description) ?? '',
      identitySource: text(profile?.soul) ?? '', userContextSource: text(profile?.user) ?? '', avatar: actor.avatar,
      ...(templateId ? { templateId } : {}) }, fence));
    // From here the copy exists, so a retry no longer sees it as new: remember the permission reset now.
    state.update(botId, actor.id, entry => { entry.arrivalNotices = [...new Set([...(entry.arrivalNotices ?? []), 'permissions' as const])]; });
  } else {
    await step(() => host.updateProfile({ id: botId, name, description: text(profile?.description),
      identitySource: text(profile?.soul), userContextSource: text(profile?.user), avatar: actor.avatar,
      ...(templateId ? { templateId } : {}) }, fence));
  }
  const systemPrompt = text(profile?.systemPrompt);
  if (systemPrompt !== undefined) await step(() => host.writeSystemPrompt(botId, systemPrompt, fence));

  // Keys whose value this device now has locally; only these may be tombstoned later.
  const applied = new Map<string, { hash: string; revision: number }>();
  const profileRow = prefs.get(COMPANION_PROFILE_KEY);
  if (profileRow && profile) applied.set(COMPANION_PROFILE_KEY, { hash: valueHash(profileRow.value), revision: profileRow.revision });
  let failures = 0;
  const apply = async (kind: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) {
      if (errorCode(error) === 'OWNER_CHANGED') throw error;
      failures += 1;
      log?.warn('Companion content could not be restored', { actorId: actor.id, kind, code: errorCode(error) });
    }
  };
  // The cloud copy wins: a tombstone deletes the local file (the copy was backed up above), so
  // the uploader can never bring deleted content back.
  for (const [key, row] of prefs) {
    const value = row.value;
    if (key.startsWith(COMPANION_MEMORY_PREFIX)) {
      const filename = key.slice(COMPANION_MEMORY_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('memory', async () => {
        const current = await host.readMemory(botId, filename);
        if (value === null) {
          if (current !== null) await step(() => host.removeMemory(botId, filename, fence));
          applied.set(key, { hash: TOMBSTONE_HASH, revision: row.revision });
          return;
        }
        if (content === undefined) return;
        if (content !== current) await step(() => host.restoreMemory(botId, filename, content, fence));
        applied.set(key, { hash: valueHash(value), revision: row.revision });
      });
    } else if (key.startsWith(COMPANION_SKILL_PREFIX)) {
      const slug = key.slice(COMPANION_SKILL_PREFIX.length);
      const content = text(record(value)?.content);
      await apply('skill', async () => {
        const current = await host.readSkill(botId, slug);
        if (value === null) {
          if (current !== null) await step(() => host.removeSkill(botId, slug, fence));
          applied.set(key, { hash: TOMBSTONE_HASH, revision: row.revision });
          return;
        }
        if (content === undefined) return;
        // Always written: also sets the cloud's enabled state, even when the body is unchanged.
        await step(() => host.saveSkill(botId, slug, content, record(value)?.enabled !== false, fence));
        applied.set(key, { hash: valueHash(value), revision: row.revision });
      });
    }
  }

  // Capability setup (references, memory switch, model preference). A new copy gets this computer's
  // default permission level; an existing copy keeps its own. A cloud value from an older home is
  // simply absent: the copy keeps what it has.
  // (Notices a failed earlier try of this take-over already recorded stay until the owner clears them.)
  const notices: CompanionArrivalNotice[] = known?.actorId === actor.id ? [...(known.arrivalNotices ?? [])] : [];
  if (!local && !notices.includes('permissions')) notices.push('permissions');
  const capabilitiesRow = prefs.get(COMPANION_CAPABILITIES_KEY);
  const capabilities = capabilitiesRow ? parseCompanionCapabilities(capabilitiesRow.value) : null;
  if (capabilitiesRow && capabilities && host.applyCapabilities) {
    await apply('capabilities', async () => {
      for (const notice of await step(() => host.applyCapabilities!(botId, capabilities, fence))) {
        if (!notices.includes(notice)) notices.push(notice);
      }
      applied.set(COMPANION_CAPABILITIES_KEY, { hash: valueHash(capabilitiesRow.value), revision: capabilitiesRow.revision });
    });
  }

  // Todos, routines and the workbench move with the companion: applied in one batch each (the
  // cloud wins; a routine tombstone removes it here). A todo is deleted by marking it (the mark
  // travels as a value); its tombstone only means it left the travelling window (closed long ago),
  // so this computer keeps its own copy.
  const batches = [
    { prefix: COMPANION_TODO_PREFIX, kind: 'todo', run: host.applyTodos, removes: false },
    { prefix: COMPANION_ROUTINE_PREFIX, kind: 'routine', run: host.applyRoutines, removes: true },
  ] as const;
  for (const batch of batches) {
    const rows = [...prefs].filter(([key]) => key.startsWith(batch.prefix));
    if (!rows.length || !batch.run) continue;
    await apply(batch.kind, async () => {
      const values = rows.flatMap(([, row]) => (row.value === null ? [] : [row.value]));
      const removed = batch.removes ? rows.flatMap(([key, row]) => (row.value === null ? [key.slice(batch.prefix.length)] : [])) : [];
      await step(() => batch.run!(botId, values, removed, fence));
      for (const [key, row] of rows) applied.set(key, { hash: row.value === null ? TOMBSTONE_HASH : valueHash(row.value), revision: row.revision });
    });
  }
  // A workbench this computer synced before is the cloud's from back then: the cloud replaces it, so
  // a folder or judgment removed meanwhile (or all of them) stays removed. One that never synced
  // (an old copy of its own) joins, and goes up with the rest.
  const workbench = prefs.get(COMPANION_WORKBENCH_KEY);
  const replaceWorkbench = !!knownPrefs[COMPANION_WORKBENCH_KEY];
  if (workbench && host.applyWorkbench && (workbench.value !== null || replaceWorkbench)) {
    await apply('workbench', async () => {
      await step(() => host.applyWorkbench!(botId, workbench.value, fence, { replace: replaceWorkbench }));
      applied.set(COMPANION_WORKBENCH_KEY, { hash: workbench.value === null ? TOMBSTONE_HASH : valueHash(workbench.value), revision: workbench.revision });
    });
  }

  if (failures > 0) {
    // Keep what was restored (so the retry does not back the copy up again) and stay demoted.
    state.update(botId, actor.id, entry => {
      for (const [key, value] of applied) entry.prefs[key] = { ...value, local: true };
      // The copy now exists: the retry no longer sees it as new, so remember what it could not keep.
      if (notices.length) entry.arrivalNotices = notices;
    });
    throw new Error('RESTORE_INCOMPLETE');
  }

  const sessionId = await step(() => host.ensureCanonicalSession(botId, fence));
  const roomId = await step(() => input.roomId());
  const inserted = await importCloudHistory({ api, host, sessionId, botActorId: actor.id, roomId, fence,
    ...(input.download ? { download: input.download } : {}), ...(log ? { log } : {}) });
  // Keep the mirror coherent: everything up to now is already in the room. Imported history
  // (possibly stamped by a peer's clock) never sets the cursor.
  const [latest] = await host.latestRows(sessionId, 1, { excludeClientIdPrefix: COMPANION_HISTORY_CLIENT_PREFIX });
  const cursor: CompanionMirrorCursor = latest ? { createdAt: latest.createdAt, id: latest.id } : { createdAt: 0, id: '' };
  const keepCursor = known?.actorId === actor.id && known.mirror?.sessionId === sessionId
    && (known.mirror.createdAt > cursor.createdAt || (known.mirror.createdAt === cursor.createdAt && known.mirror.id >= cursor.id));
  const needsRebuild = inserted > 0 || known?.pendingRebuild === true;
  fence.assertCurrent();
  state.update(botId, actor.id, entry => {
    // Revisions may have moved on while another computer was the home.
    entry.prefsSeeded = false;
    for (const [key, value] of applied) entry.prefs[key] = { ...value, local: true };
    if (!keepCursor) entry.mirror = { sessionId, ...cursor };
    if (needsRebuild) entry.pendingRebuild = true;
    if (notices.length) entry.arrivalNotices = notices; else delete entry.arrivalNotices;
  });
  // Rebuild while still demoted: a failure, or a turn still running (`busy`), leaves the copy
  // demoted and the automatic take-over retries until the rebuild completes.
  const rebuild = needsRebuild ? await rebuildPending({ state, host, botId, actorId: actor.id, sessionId, fence }) : 'skipped';
  if (rebuild === 'busy') throw new Error('CONTEXT_REBUILD_PENDING');
  fence.assertCurrent();
  state.update(botId, actor.id, entry => {
    delete entry.demoted;
    // The next take-over (after this copy hands the companion away again) backs it up anew.
    delete entry.backedUp;

  });
  return { created: !local, inserted, rebuild, notices, ...(backup !== undefined ? { backup } : {}) };
}

/** Insert the room's whole conversation that is not already local, in message-time order. */
export async function importCloudHistory(input: {
  api: CompanionApi;
  host: Pick<CompanionMaterializeHost, 'localMessageTimes' | 'insertHistory'>;
  sessionId: string;
  botActorId: string;
  roomId: string;
  fence?: CompanionWriteFence;
  download?: CompanionRoomDownload;
  log?: CompanionLog;
}): Promise<number> {
  const fence = input.fence ?? noFence;
  const messages = await readAllRoomMessages(input.api, input.roomId, input.botActorId, { complete: true });
  if (!messages.length) return 0;
  // Rows already imported, and delivered direct-room messages, name their room message in the
  // client id: exact. Rows mirrored from this Session keep their local timestamp; the server
  // does not return import source ids, so (role, createdAt) identifies only those. Rewound or
  // deleted rows count too: what the owner removed here does not come back.
  const local = await input.host.localMessageTimes(input.sessionId, messages[0]!.createdAt);
  const known = new Set(local.flatMap(row => (row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX)
    ? row.clientId.slice(COMPANION_HISTORY_CLIENT_PREFIX.length) : directRoomSourceId(row.clientId)) ?? []));
  const present = new Set(local.flatMap(row => row.clientId.startsWith(COMPANION_HISTORY_CLIENT_PREFIX) ? []
    : row.removed ? [`user:${row.createdAt}`, `assistant:${row.createdAt}`] : [`${row.role}:${row.createdAt}`]));
  let inserted = 0;
  for (const message of messages) {
    if (known.has(message.id) || present.has(`${message.role}:${message.createdAt}`)) continue;
    fence.assertCurrent();
    // Files come along when they can be fetched; a file that cannot keeps its name in the text.
    const attachments: CompanionHistoryAttachment[] = [];
    const missing: string[] = [];
    for (const file of message.attachments ?? []) {
      try {
        if (!input.download) throw new Error('DOWNLOAD_UNAVAILABLE');
        attachments.push(await input.download(input.roomId, file.mediaId));
      } catch (error) {
        // A file that may still come fails the take-over (retried); this message is not inserted yet.
        if (isTransientAttachmentFailure(error)) throw error;
        missing.push(file.name);
        input.log?.warn('Companion history attachment not brought over', { code: errorCode(error) });
      }
      fence.assertCurrent();
    }
    const text = [message.text, ...missing.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n');
    await input.host.insertHistory(input.sessionId, { clientId: `${COMPANION_HISTORY_CLIENT_PREFIX}${message.id}`,
      role: message.role, text, createdAt: message.createdAt, ...(attachments.length ? { attachments } : {}) }, fence);
    inserted += 1;
  }
  fence.assertCurrent();
  return inserted;
}

/** Rebuild now when idle; otherwise keep the flag for the next sync cycle. */
export async function rebuildPending(input: {
  state: CompanionCloudState;
  host: Pick<CompanionMaterializeHost, 'rebuildContext'>;
  botId: string;
  actorId: string;
  sessionId: string;
  fence?: CompanionWriteFence;
}): Promise<'rebuilt' | 'busy'> {
  const fence = input.fence ?? noFence;
  fence.assertCurrent();
  const outcome = await input.host.rebuildContext(input.sessionId, fence);
  fence.assertCurrent();
  if (outcome === 'rebuilt') input.state.update(input.botId, input.actorId, entry => { delete entry.pendingRebuild; });
  return outcome;
}
