import { resolveRemoteText } from '@cindy/device-link';
import { isAccessRevokedRemoteError as isAccessRevokedError } from '@cindy/maker-shared/device-link-contract';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { listRemoteCollection, normalizeRemoteCollectionItems } from '@/device-link/remoteResources';
import { readCompanionTask } from './companionTaskReads';
import { isTeammateTask, parseTaskCompanion, type TaskTeammate } from './teammateTaskSource';
import type { RemoteSession } from './types';

/** Released hosts expose these read APIs even when sessions:list omits bot lanes.
 * Caller supplies its account/query fence; no process-global results or per-row reads. */
export async function readTeammateTasks(input: {
  invoke: RemoteInvoke; deviceId: string; deviceName: string; scope: string;
  sessions: readonly RemoteSession[]; previous?: readonly RemoteSession[];
  status: string; limit: number; current(): boolean;
  /** Publish the ordinary snapshot before optional history/roster reads finish. */
  publishInitial?(sessions: RemoteSession[]): void;
}): Promise<RemoteSession[]> {
  const { invoke, deviceId, current, status, limit } = input;
  const matches = (s: RemoteSession) => s.status !== 'deleted' && (status === 'all' || s.status === status || !!s.pinnedAt);
  const rows = new Map(input.sessions.map(row => [row.id, row]));
  const previous = new Map((input.previous ?? []).filter(row => row.deviceLinkDeviceId === deviceId).map(row => [row.id, row]));
  if (!current()) return [];
  if (input.publishInitial) {
    const initial = new Map<string, RemoteSession>();
    for (const row of rows.values()) if (row.source !== 'bot' || isTeammateTask(row)) {
      initial.set(row.id, { ...row, taskTeammate: row.taskTeammate ?? previous.get(row.id)?.taskTeammate });
    }
    for (const row of previous.values()) if (!initial.has(row.id) && isTeammateTask(row) && matches(row)) initial.set(row.id, row);
    input.publishInitial([...initial.values()]);
  }
  // Independent from roster support: old hosts' history carries the exact lane owner.
  try {
    const links = new Map<string, NonNullable<RemoteSession['companion']>>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (!current()) return [];
      const reply = await invoke<{ ok: boolean; sessions: Array<RemoteSession>; hasMore?: boolean; nextCursor?: string }>(
        deviceId, 'local-db:history:query', [{ tool: 'list_sessions', args: {
          source: 'bot', time_field: 'activity', limit: 200, ...(cursor ? { cursor } : {}),
        } }]);
      if (!current()) return [];
      if (!reply?.ok || !Array.isArray(reply.sessions)) throw new Error('Invalid task history');
      for (const row of reply.sessions) {
        const companion = parseTaskCompanion(row.companion);
        if (typeof row.id === 'string' && isTeammateTask({ ...row, companion }) && matches(row)) links.set(row.id, companion!);
      }
      if (!reply.hasMore || links.size >= limit) break;
      if (!reply.nextCursor || cursors.has(reply.nextCursor)) throw new Error('Invalid task history cursor');
      cursor = reply.nextCursor;
      cursors.add(cursor);
    } while (current());
    const ids = [...links.keys()].slice(0, limit);
    // Existing reader batches eight requests, with serial fallback only for old hosts.
    const values = await Promise.all(ids.map(id => rows.get(id) ?? readCompanionTask(input.scope, deviceId, id, invoke, current)));
    if (!current()) return [];
    values.forEach((value, index) => {
      const row = value as RemoteSession | null;
      if (row && row.id === ids[index] && row.source === 'bot' && matches(row)) rows.set(row.id, { ...row, companion: links.get(row.id)! });
    });
  } catch (error) {
    if (isAccessRevokedError(error)) throw error;
    // Optional/temporarily unavailable history must not remove last known lanes.
    for (const row of previous.values()) if (isTeammateTask(row) && matches(row) && !rows.has(row.id)) rows.set(row.id, row);
  }
  const creators = new Map<string, TaskTeammate>();
  const owners = new Map<string, TaskTeammate>();
  const checked = new Set<string>();
  let rosterRead = false;
  try {
    if (!current()) return [];
    const response = await listRemoteCollection(invoke, { deviceId, deviceName: input.deviceName }, 'teammates');
    if (!current()) return [];
    if (response.collectionId !== 'teammates' || !Array.isArray(response.items)) throw new Error('Invalid teammates');
    const items = normalizeRemoteCollectionItems(response, 'teammates').filter(item => item.ref.kind === 'bot');
    rosterRead = true;
    for (const item of items) {
      const bot: TaskTeammate = { id: item.ref.id, name: resolveRemoteText(item.display.title), avatar: item.display.avatar };
      owners.set(bot.id, bot);
      const session = item.links?.find(link => link.rel === 'conversation' && link.target.kind === 'session')?.target;
      if (session?.kind !== 'session') continue;
      if (!current()) return [];
      try {
        const reply = await invoke<{ ok: boolean; delegations: Array<{ requestingBotId: string; childSessionId: string }> }>(
          deviceId, 'maker:bot-delegations:list', [session.sessionId]);
        if (!current()) return [];
        if (!reply?.ok || !Array.isArray(reply.delegations)) continue;
        checked.add(bot.id);
        for (const task of reply.delegations) if (task.requestingBotId === bot.id && typeof task.childSessionId === 'string') creators.set(task.childSessionId, bot);
      } catch (error) { if (isAccessRevokedError(error)) throw error; }
    }
  } catch (error) { if (isAccessRevokedError(error)) throw error; }
  if (!current()) return [];
  return [...rows.values()].filter(row => row.source !== 'bot' || isTeammateTask(row)).map(row => {
    const old = previous.get(row.id)?.taskTeammate;
    const ownerId = isTeammateTask(row) ? row.companion!.id : undefined;
    const found = ownerId ? owners.get(ownerId) : creators.get(row.id);
    // Successful absence clears attribution; transient failure retains it on the same host.
    const retained = old && (!rosterRead || (owners.has(old.id) && !checked.has(old.id))) ? old : undefined;
    return { ...row, taskTeammate: found ?? retained ?? null };
  });
}
