import { botGroupRuntimeFailureCode } from './botGroupRuntimeFailure.js';
import { BOT_GROUP_ASSISTANT_NAME } from '../../shared/botGroupChat.js';
import { groupTaskName, type GroupTaskTopic } from './groupTaskNaming.js';
import type { GroupRepository } from '../../shared/botGroupChat.js';
import type { ChatAssistantSessionRecord } from './chatServerWorkspaces.js';
import type { GroupProjectFolders, GroupProjectRoom } from './groupProjectFolder.js';

/**
 * The group's Cindy on this computer (bot-group-chat.md §9): one ordinary visible task per
 * conversation (main group or Thread). The project is selected on
 * the executing device. Requests the owner makes to Cindy in the group arrive in it as ordinary
 * messages, so anything that blocks (a permission, a sign-in, a question) is handled right there.
 *
 * The task follows the project folder: once the folder appears or changes, the next request opens
 * a new task there and the old one stays as it is. A task that was deleted or archived is replaced too.
 */
export interface GroupAssistantTask {
  sessionId: string;
  topicName?: { initialTitle?: string; topic: GroupTaskTopic };
  /** The group's newest message already delivered into the task, per conversation (`main` or a Thread's root ID). */
  delivered: Record<string, string>;
}

/** Keep the legacy room key for the main group. Threads never inherit its mixed history. */
function taskKey(roomId: string, threadRootId?: string): string {
  return threadRootId ? `${roomId}:thread:${threadRootId}` : roomId;
}

export function createGroupAssistantTasks(deps: {
  current: () => boolean;
  store: () => { read(): Record<string, ChatAssistantSessionRecord>; save(value: Record<string, ChatAssistantSessionRecord>): void };
  folders: Pick<GroupProjectFolders, 'forWork' | 'registered'>;
  /** The given task when it is still usable, else a new ordinary task in `projectDir` (null: under 「对话」). */
  ensureSession?: (input: { sessionId?: string; title: string; projectDir: string | null }) =>
    Promise<{ ok: true; sessionId: string; created?: boolean } | { ok: false; errorCode: string; message: string }>;
}) {
  // One lookup per conversation at a time, so two requests arriving together share the same task.
  const lookups = new Map<string, Promise<GroupAssistantTask>>();

  async function find(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean, threadRootId?: string, request?: GroupRepository | null, subject?: string): Promise<GroupAssistantTask> {
    if (!deps.ensureSession) throw new Error('MEMBER_UNAVAILABLE');
    const key = taskKey(room.id, threadRootId);
    const saved = deps.store().read()[key];
    const folder = await deps.folders.forWork(room, { botId: 'cindy-default', request,
      isCurrent: () => deps.current() && isCurrent() });
    if (folder.continueConversation && saved?.resolved && saved.projectDir
      && await deps.folders.registered(saved.projectDir)) folder.dir = saved.projectDir;
    if (!isCurrent() || !deps.current()) throw new Error('OWNER_CHANGED');
    const name = groupTaskName(room.name, BOT_GROUP_ASSISTANT_NAME, threadRootId ? subject ?? '' : undefined);
    const ensured = await deps.ensureSession({ ...(saved?.projectDir === folder.dir ? { sessionId: saved.sessionId } : {}),
      title: name.title, projectDir: folder.dir });
    if (!ensured.ok) throw new Error(botGroupRuntimeFailureCode({ code: ensured.errorCode, message: ensured.message }));
    if (!deps.current()) throw new Error('OWNER_CHANGED');
    const all = deps.store().read();
    const record = all[key]?.sessionId === ensured.sessionId ? all[key]! : { sessionId: ensured.sessionId, resolved: true, projectDir: folder.dir };
    all[key] = record;
    deps.store().save(all);
    return { sessionId: record.sessionId, delivered: record.deliveredSeq ?? {},
      ...(name.topic ? { topicName: { initialTitle: ensured.created ? name.title : undefined, topic: name.topic } } : {}) };
  }

  return {
    /** The group's task for a request made now. `isCurrent`: the request is still wanted. */
    forRequest(room: GroupProjectRoom & { name: string }, isCurrent: () => boolean, threadRootId?: string, request?: GroupRepository | null, subject?: string): Promise<GroupAssistantTask> {
      const key = taskKey(room.id, threadRootId);
      const lookup = (lookups.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => find(room, isCurrent, threadRootId, request, subject));
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
