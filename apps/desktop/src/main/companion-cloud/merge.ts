/**
 * Merging the copies of Cindy that grew on separate computers into one companion
 * (cloud-companions.md, 2026-10-16 裁决 2). Runs on the kept Cindy's home: the other copies'
 * memories, own skills, todos, routines, workbench and conversation join it; their profile does
 * not (the kept one is the user's chosen base). Nothing is overwritten silently: a memory or skill
 * that exists on both sides with different content is kept as a second, renamed entry. The merged
 * copies are retired in the cloud only once everything, the kept task's history included, is in;
 * their own data stays there and on their computers. Every step is idempotent, so a failed merge
 * (sources still active) is simply run again.
 */
import { createHash } from 'node:crypto';
import { inferBotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import type { CompanionHistoryAttachment, CompanionMaterializeHost, CompanionWriteFence } from './materialize.js';
import type { CompanionMediaUpload, CompanionMirrorAttachment } from './mirror.js';
import { readAllRoomMessages, readRoomPage } from './room.js';
import { isTransientAttachmentFailure, type CompanionApi, type CompanionLog } from './types.js';
import {
  COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_ROUTINE_PREFIX, COMPANION_SKILL_PREFIX, COMPANION_TODO_PREFIX,
  COMPANION_WORKBENCH_KEY,
} from './uploader.js';

export interface CompanionMergeActor {
  id: string; externalId: string; name: string; homeDeviceId?: string | null;
  /** Where it came from (its computer's name), for naming a second copy of a same-name memory or skill. */
  label?: string;
}

export interface CompanionMergeSummary {
  merged: number;
  messages: number;
  memories: number;
  skills: number;
  /** Memories and skills that existed on both sides with different content, kept under these names. */
  renamed: string[];
}

type PrefRow = { key: string; value: unknown; revision: number };

/** Copies of Cindy: made from the Cindy preset, or the provisioned default Cindy. Never by name. */
export function isCindyCompanion(externalId: string, profile: unknown): boolean {
  if (externalId === 'cindy-default') return true;
  const value = profile && typeof profile === 'object' ? profile as { templateId?: unknown; soul?: unknown } : {};
  if (value.templateId === 'cindy') return true;
  return typeof value.soul === 'string' && inferBotTemplatePresetId(value.soul) === 'cindy';
}

const BATCH = 50;
const BATCH_BYTES = 200_000;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** `name.md` → `name-<suffix>.md` (then `-2`, `-3`…); skills are slugs without an extension. */
export function renamedEntry(name: string, suffix: string, attempt = 1): string {
  const dot = name.lastIndexOf('.');
  const safe = (suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'merged')
    + (attempt > 1 ? `-${attempt}` : '');
  return dot > 0 ? `${name.slice(0, dot)}-${safe}${name.slice(dot)}` : `${name}-${safe}`;
}

const RENAME_ATTEMPTS = 50;

/**
 * Where a source entry goes in the kept companion: its own name when free, else the first renamed
 * name that is free or already holds the same content (a rerun); null when it is already there.
 */
async function mergeTarget(name: string, suffix: string, content: string, read: (name: string) => Promise<string | null>): Promise<string | null> {
  const current = await read(name);
  if (current === null) return name;
  if (current === content) return null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    const target = renamedEntry(name, suffix, attempt);
    const existing = await read(target);
    if (existing === content) return null;
    if (existing === null) return target;
  }
  throw new Error('MERGE_NAME_EXHAUSTED');
}

/**
 * Every todo and routine joining another companion gets an id of its own, stable per (kept
 * companion, source, original id): copies of Cindy can hold the same id (a todo made from the same
 * old workbench entry, a routine the source still owns here), and nothing merged may replace
 * another. A rerun derives the same ids, so it replaces only what it brought before.
 */
function mergedEntryHash(keepBotId: string, sourceActorId: string, id: string): string {
  return createHash('sha256').update(`${keepBotId}\n${sourceActorId}\n${id}`).digest('hex').slice(0, 40);
}
export function mergedRoutineId(keepBotId: string, sourceActorId: string, routineId: string): string {
  return `m${mergedEntryHash(keepBotId, sourceActorId, routineId)}`;
}
export function mergedTodoId(keepBotId: string, sourceActorId: string, todoId: string): string {
  return `todo:m-${mergedEntryHash(keepBotId, sourceActorId, todoId)}`;
}

export async function mergeCompanionsInto(input: {
  api: CompanionApi;
  host: Pick<CompanionMaterializeHost, 'readMemory' | 'restoreMemory' | 'readSkill' | 'saveSkill' | 'applyTodos' | 'applyRoutines' | 'applyWorkbench'>;
  keep: CompanionMergeActor;
  from: CompanionMergeActor[];
  humanActorId: string;
  /** Room of a companion (deterministic per companion actor). */
  roomOf: (actor: CompanionMergeActor) => Promise<string>;
  media?: { upload: CompanionMediaUpload; download: (roomId: string, mediaId: string) => Promise<CompanionHistoryAttachment> };
  /** After the conversation is in the kept room: bring it into the kept companion's own task. */
  importHistory: () => Promise<void>;
  /** Right before retiring: each copy's home sends anything it produced meanwhile (throws when it cannot). */
  beforeRetire?: () => Promise<void>;
  fence: CompanionWriteFence;
  log?: CompanionLog;
}): Promise<CompanionMergeSummary> {
  const { api, host, keep, fence } = input;
  const summary: CompanionMergeSummary = { merged: 0, messages: 0, memories: 0, skills: 0, renamed: [] };
  const keepRoom = await input.roomOf(keep);
  // What each copy had in the cloud when the merge read it: anything newer at the end was missed.
  const seen = new Map<string, string>();
  for (const source of input.from) {
    fence.assertCurrent();
    seen.set(source.id, await cloudMark(api, source, input.roomOf));
    const rows = await api<PrefRow[]>('/preferences', 'GET', undefined, source.id);
    const prefs = (Array.isArray(rows) ? rows : []).filter(row => row.value !== null);
    const suffix = source.label || (source.name && source.name !== keep.name ? source.name : source.externalId.slice(-8));

    for (const row of prefs.filter(candidate => candidate.key.startsWith(COMPANION_MEMORY_PREFIX))) {
      const filename = row.key.slice(COMPANION_MEMORY_PREFIX.length);
      const content = text(record(row.value)?.content);
      if (content === undefined) continue;
      // A second run finds the (renamed) copy already there.
      const target = await mergeTarget(filename, suffix, content, name => host.readMemory(keep.externalId, name));
      if (target === null) continue;
      if (target !== filename) summary.renamed.push(target);
      fence.assertCurrent();
      await host.restoreMemory(keep.externalId, target, content, fence);
      summary.memories += 1;
    }

    for (const row of prefs.filter(candidate => candidate.key.startsWith(COMPANION_SKILL_PREFIX))) {
      const slug = row.key.slice(COMPANION_SKILL_PREFIX.length);
      const content = text(record(row.value)?.content);
      if (content === undefined) continue;
      const target = await mergeTarget(slug, suffix, content, name => host.readSkill(keep.externalId, name));
      if (target === null) continue;
      if (target !== slug) summary.renamed.push(target);
      fence.assertCurrent();
      await host.saveSkill(keep.externalId, target, content, record(row.value)?.enabled !== false, fence);
      summary.skills += 1;
    }

    // Todos and routines get ids of their own in the kept companion (the store also gives a
    // same-key todo its own key).
    const todos = prefs.filter(row => row.key.startsWith(COMPANION_TODO_PREFIX)).map(row => row.value).flatMap(value => {
      const todo = record(value);
      return todo && typeof todo.id === 'string' ? [{ ...todo, id: mergedTodoId(keep.externalId, source.id, todo.id) }] : [];
    });
    if (todos.length && host.applyTodos) await host.applyTodos(keep.externalId, todos, [], fence);
    const routines = prefs.filter(row => row.key.startsWith(COMPANION_ROUTINE_PREFIX)).map(row => row.value).flatMap(value => {
      const routine = record(value);
      return routine && typeof routine.id === 'string' ? [{ ...routine, id: mergedRoutineId(keep.externalId, source.id, routine.id) }] : [];
    });
    if (routines.length && host.applyRoutines) await host.applyRoutines(keep.externalId, routines, [], fence);
    const workbench = prefs.find(row => row.key === COMPANION_WORKBENCH_KEY);
    if (workbench && host.applyWorkbench) await host.applyWorkbench(keep.externalId, workbench.value, fence);

    summary.messages += await mergeConversation({ ...input, source, keepRoom });
  }
  await input.importHistory();
  // A copy that kept working during the merge (a new turn, a memory saved) has more in the cloud
  // than was read: stop with every copy active; running the merge again brings the rest.
  await input.beforeRetire?.();
  for (const source of input.from) {
    fence.assertCurrent();
    if (await cloudMark(api, source, input.roomOf) !== seen.get(source.id)) throw new Error('COMPANION_STILL_CHANGING');
  }
  // Only now are the merged copies no longer companions: other computers hide and stop their copy.
  // Until here a failure leaves every source active, so the merge can run again.
  for (const source of input.from) {
    fence.assertCurrent();
    await api(`/actors/${source.id}`, 'PATCH', { disabled: true });
    summary.merged += 1;
  }
  return summary;
}

/** The source's conversation into the kept room, by message time, keeping each message's time. */
async function mergeConversation(input: {
  api: CompanionApi;
  keep: CompanionMergeActor;
  source: CompanionMergeActor;
  keepRoom: string;
  humanActorId: string;
  roomOf: (actor: CompanionMergeActor) => Promise<string>;
  media?: { upload: CompanionMediaUpload; download: (roomId: string, mediaId: string) => Promise<CompanionHistoryAttachment> };
  fence: CompanionWriteFence;
  log?: CompanionLog;
}): Promise<number> {
  const sourceRoom = await input.roomOf(input.source);
  const messages = await readAllRoomMessages(input.api, sourceRoom, input.source.id, { complete: true });
  const prepared: Array<{ sourceId: string; authorId: string; createdAt: string; content: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    const authorId = message.role === 'assistant' ? input.keep.id : input.humanActorId;
    const sourceId = `merge:${input.source.id}:${message.id}`;
    // Room files belong to their room: bring each over (download, upload again); a file that
    // cannot come keeps its name in the text.
    const media: Array<{ type: string; mediaId?: string; caption?: string }> = [];
    const missing: string[] = [];
    for (const file of message.attachments ?? []) {
      try {
        if (!input.media) throw new Error('MEDIA_UNAVAILABLE');
        const local = await input.media.download(sourceRoom, file.mediaId);
        const attachment: CompanionMirrorAttachment = { id: file.mediaId, name: local.name, category: local.url ? 'image' : 'file',
          mimeType: local.mimeType, size: local.size, url: local.url, path: local.path };
        media.push(...await input.media.upload(input.keepRoom, sourceId, [attachment], authorId));
      } catch (error) {
        // A file that may still come fails the merge (every copy stays active, so it can run again).
        if (isTransientAttachmentFailure(error)) throw error;
        missing.push(file.name);
        input.log?.warn('Merged attachment kept as its name', { code: error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN' });
      }
      input.fence.assertCurrent();
    }
    const body = [message.text, ...missing.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n');
    prepared.push({ sourceId, authorId, createdAt: new Date(message.createdAt).toISOString(),
      content: [...(body ? [{ type: 'text', text: body }] : []), ...media] });
  }
  let imported = 0;
  let start = 0;
  while (start < prepared.length) {
    // Same limits as the mirror: at most 50 messages and about 200 KB per request.
    let end = start; let bytes = 0;
    while (end < prepared.length && end - start < BATCH) {
      const size = Buffer.byteLength(JSON.stringify(prepared[end]));
      if (end > start && bytes + size > BATCH_BYTES) break;
      bytes += size; end += 1;
    }
    const batch = prepared.slice(start, end);
    input.fence.assertCurrent();
    await input.api(`/conversations/${input.keepRoom}/import`, 'POST', {
      operationId: `companion-merge:${createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 48)}`, messages: batch });
    imported += batch.length;
    start = end;
  }
  return imported;
}

/**
 * What a copy has in the cloud: every preference with its revision (revisions count per key, so a
 * new, changed or removed one changes the list) and the newest room message (room order). Any
 * difference means it added something.
 */
async function cloudMark(api: CompanionApi, actor: CompanionMergeActor, roomOf: (actor: CompanionMergeActor) => Promise<string>): Promise<string> {
  const rows = await api<PrefRow[]>('/preferences', 'GET', undefined, actor.id);
  const prefs = (Array.isArray(rows) ? rows : []).map(row => `${row.key}\u0000${row.revision}`).sort();
  const page = await readRoomPage(api, await roomOf(actor));
  const seq = page.reduce((max, message) => (BigInt(message.seq) > max ? BigInt(message.seq) : max), 0n);
  return createHash('sha256').update(JSON.stringify([prefs, String(seq)])).digest('hex');
}

/** The profile snapshot of a companion actor, for telling the copies of Cindy apart. */
export async function readProfileSnapshot(api: CompanionApi, actorId: string): Promise<unknown> {
  const rows = await api<PrefRow[]>('/preferences', 'GET', undefined, actorId);
  return (Array.isArray(rows) ? rows : []).find(row => row.key === COMPANION_PROFILE_KEY)?.value ?? null;
}
