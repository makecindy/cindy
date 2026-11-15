import { botGroupRuntimeFailureCode } from './botGroupRuntimeFailure.js';
import type { ChatAssistantSessionRecord } from './chatServerWorkspaces.js';
import type { GroupProjectFolders, GroupProjectRoom, GroupWorkFolder } from './groupProjectFolder.js';

/**
 * The group's Cindy on this computer (bot-group-chat.md §9): one ordinary visible task per
 * conversation (main group or Thread), titled with the group's name, in the group's project folder
 * (`groupProjectFolder.ts`), which is there at once even while its repository is still being fetched. Requests the owner makes to Cindy in the group arrive in it as ordinary
 * messages, so anything that blocks (a permission, a sign-in, a question) is handled right there.
 *
 * The task follows the project folder: once the folder appears or changes, the next request opens
 * a new task there and the old one stays as it is. A task that was deleted or archived is replaced too.
 */
export interface GroupAssistantTask {
  sessionId: string;
  /** The group's newest message already delivered into the task, per conversation (`main` or a Thread's root ID). */
  delivered: Record<string, string>;
  /** The group's repository is not in the task's folder yet, and why (`preparing`: being cloned now). */
  pending?: GroupWorkFolder['pending'];
}

/** Keep the legacy room key for the main group. Threads never inherit its mixed history. */
function taskKey(roomId: string, threadRootId?: string): string {
  return threadRootId ? `${roomId}:thread:${threadRootId}` : roomId;
}

export function createGroupAssistantTasks(deps: {
  current: () => boolean;
  store: () => { read(): Record<string, ChatAssistantSessionRecord>; save(value: Record<string, ChatAssistantSessionRecord>): void };
  folders: Pick<GroupProjectFolders, 'forWork'>;
  /** The given task when it is still usable, else a new ordinary task in `projectDir` (null: under 「对话」). */
  ensureSession?: (input: { sessionId?: string; title: string; projectDir: string | null }) =>
    Promise<{ ok: true; sessionId: string } | { ok: false; errorCode: string; message: string }>;
}) {
  // One lookup per conversation at a time, so two requests arriving together share the same task.
  const lookups = new Map<string, Promise<GroupAssistantTask>>();

  async function find(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean, threadRootId?: string): Promise<GroupAssistantTask> {
    if (!deps.ensureSession) throw new Error('MEMBER_UNAVAILABLE');
    // The requester is at this computer: a background fetch of the repository may open Cindy's GitHub sign-in.
    const folder = await deps.folders.forWork(room, { signIn: true, isCurrent: () => deps.current() && isCurrent() });
    const key = taskKey(room.id, threadRootId);
    const saved = deps.store().read()[key];
    const ensured = await deps.ensureSession({ ...(saved?.projectDir === folder.dir ? { sessionId: saved.sessionId } : {}),
      title: room.name, projectDir: folder.dir });
    if (!ensured.ok) throw new Error(botGroupRuntimeFailureCode({ code: ensured.errorCode, message: ensured.message }));
    if (!deps.current()) throw new Error('OWNER_CHANGED');
    const all = deps.store().read();
    const record = all[key]?.sessionId === ensured.sessionId ? all[key]! : { sessionId: ensured.sessionId, projectDir: folder.dir };
    all[key] = record;
    deps.store().save(all);
    return { sessionId: record.sessionId, delivered: record.deliveredSeq ?? {}, ...(folder.pending ? { pending: folder.pending } : {}) };
  }

  return {
    /** The group's task for a request made now. `isCurrent`: the request is still wanted. */
    forRequest(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean, threadRootId?: string): Promise<GroupAssistantTask> {
      const key = taskKey(room.id, threadRootId);
      const lookup = (lookups.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => find(room, isCurrent, threadRootId));
      lookups.set(key, lookup);
      void lookup.catch(() => undefined).finally(() => { if (lookups.get(key) === lookup) lookups.delete(key); });
      return lookup;
    },
    /** The task has the conversation's messages up to `seq`; the next request carries only newer ones. */
    noteDelivered(roomId: string, sessionId: string, scope: string, seq: string) {
      if (!deps.current()) return;
      const all = deps.store().read();
      const key = taskKey(roomId, scope === 'main' ? undefined : scope);
      const record = all[key];
      if (record?.sessionId !== sessionId) return;
      const delivered = { ...record.deliveredSeq };
      if (delivered[scope] !== undefined && BigInt(delivered[scope]!) >= BigInt(seq)) return;
      delivered[scope] = seq;
      all[key] = { ...record, deliveredSeq: delivered };
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
