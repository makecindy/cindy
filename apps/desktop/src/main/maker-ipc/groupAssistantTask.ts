import { botGroupRuntimeFailureCode } from './botGroupRuntimeFailure.js';
import type { ChatAssistantSessionRecord } from './chatServerWorkspaces.js';
import type { GroupProjectFolders, GroupProjectRoom, GroupWorkFolder } from './groupProjectFolder.js';

/**
 * The group's Cindy on this computer (bot-group-chat.md §9): one ordinary visible task per group,
 * titled with the group's name, under the group's project folder when this computer has it and
 * under 「对话」 otherwise. Requests the owner makes to Cindy in the group arrive in it as ordinary
 * messages, so anything that blocks (a permission, a sign-in, a question) is handled right there.
 *
 * The task follows the project folder: once the folder appears or changes, the next request opens
 * a new task there and the old one stays as it is. A task that was deleted or archived is replaced too.
 */
export interface GroupAssistantTask {
  sessionId: string;
  /** The group's newest message already delivered into the task, per conversation (`main` or a Thread's root ID). */
  delivered: Record<string, string>;
  /** Why the group's repository is not on this computer yet; the task is under 「对话」 meanwhile. */
  pending?: GroupWorkFolder['pending'];
}

/** Threads whose delivered position a task remembers, besides the main group. */
const THREADS_KEPT = 20;

export function createGroupAssistantTasks(deps: {
  current: () => boolean;
  store: () => { read(): Record<string, ChatAssistantSessionRecord>; save(value: Record<string, ChatAssistantSessionRecord>): void };
  folders: Pick<GroupProjectFolders, 'forWork'>;
  /** The given task when it is still usable, else a new ordinary task in `projectDir` (null: under 「对话」). */
  ensureSession?: (input: { sessionId?: string; title: string; projectDir: string | null }) =>
    Promise<{ ok: true; sessionId: string } | { ok: false; errorCode: string; message: string }>;
}) {
  // One lookup per group at a time, so two requests arriving together share the same task.
  const lookups = new Map<string, Promise<GroupAssistantTask>>();

  async function find(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean): Promise<GroupAssistantTask> {
    if (!deps.ensureSession) throw new Error('MEMBER_UNAVAILABLE');
    // The requester is at this computer: Cindy may open its GitHub sign-in to fetch the repository.
    const folder = await deps.folders.forWork(room, { signIn: true, isCurrent: () => deps.current() && isCurrent() });
    const saved = deps.store().read()[room.id];
    const ensured = await deps.ensureSession({ ...(saved?.projectDir === folder.dir ? { sessionId: saved.sessionId } : {}),
      title: room.name, projectDir: folder.dir });
    if (!ensured.ok) throw new Error(botGroupRuntimeFailureCode({ code: ensured.errorCode, message: ensured.message }));
    if (!deps.current()) throw new Error('OWNER_CHANGED');
    const all = deps.store().read();
    const record = all[room.id]?.sessionId === ensured.sessionId ? all[room.id]! : { sessionId: ensured.sessionId, projectDir: folder.dir };
    all[room.id] = record;
    deps.store().save(all);
    return { sessionId: record.sessionId, delivered: record.deliveredSeq ?? {}, ...(folder.pending ? { pending: folder.pending } : {}) };
  }

  return {
    /** The group's task for a request made now. `isCurrent`: the request is still wanted. */
    forRequest(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean): Promise<GroupAssistantTask> {
      const lookup = (lookups.get(room.id) ?? Promise.resolve()).catch(() => undefined).then(() => find(room, isCurrent));
      lookups.set(room.id, lookup);
      void lookup.catch(() => undefined).finally(() => { if (lookups.get(room.id) === lookup) lookups.delete(room.id); });
      return lookup;
    },
    /** The task has the conversation's messages up to `seq`; the next request carries only newer ones. */
    noteDelivered(roomId: string, sessionId: string, scope: string, seq: string) {
      if (!deps.current()) return;
      const all = deps.store().read();
      const record = all[roomId];
      if (record?.sessionId !== sessionId) return;
      const delivered = { ...record.deliveredSeq };
      if (delivered[scope] !== undefined && BigInt(delivered[scope]!) >= BigInt(seq)) return;
      // Re-inserted last: the main group and the latest Threads stay, an older Thread starts over.
      delete delivered[scope];
      delivered[scope] = seq;
      const threads = Object.keys(delivered).filter(key => key !== 'main');
      for (const key of threads.slice(0, Math.max(0, threads.length - THREADS_KEPT))) delete delivered[key];
      all[roomId] = { ...record, deliveredSeq: delivered };
      deps.store().save(all);
    },
  };
}

/**
 * A group request as its task shows it: the requester's words, the host's note when there is one,
 * then the group's messages under their heading. All of it is visible; there is no hidden envelope.
 */
export function formatGroupRequest(parts: { words: string; note?: string; heading: string; background: string[] }): string {
  return [parts.words, ...(parts.note ? [parts.note] : []),
    ...(parts.background.length ? [`${parts.heading}\n${parts.background.join('\n')}`] : [])].join('\n\n');
}
