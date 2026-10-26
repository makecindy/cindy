import { archivedGroupRestore, type ArchivedGroupRequest, type CurrentGroupResult } from '@cindy/mcps/group-management';
import { chatGroupRolePermissions } from '@cindy/maker-shared/botGroupPresentation';

type Recovery = (botId: string, request: ArchivedGroupRequest, validate: () => Promise<void>) => Promise<CurrentGroupResult>;
let recovery: { execute: Recovery; refresh?: () => void } | undefined;

/** Account-scoped Chat Server lifecycle, not an execution grant or persisted lane. */
export function registerArchivedGroupRecovery(handler: Recovery, refresh?: () => void): () => void {
  const registration = { execute: handler, refresh };
  recovery = registration;
  return () => { if (recovery === registration) recovery = undefined; };
}

interface Room { id: string; name: string; kind?: string; archived: boolean; revision: number; dissolved_at?: string | null }
interface Member { id: string; kind: string; ownerActorId: string; state: string; role: string }

export function createArchivedGroupRecovery(deps: {
  actor(botId: string): Promise<{ actorId: string; ownerId: string } | undefined>;
  rooms(): Promise<Room[]>;
  snapshot(groupId: string): Promise<{ room: Room; members: Member[] }>;
  restore(groupId: string, actorId: string, payload: { operationId: string; expectedRevision: number; archived: false }): Promise<unknown>;
  changed(groupId: string): void;
  assertCurrent(): void;
}): Recovery {
  let tail: Promise<unknown> = Promise.resolve();
  const attempts = new Map<string, { fingerprint: string; result: CurrentGroupResult }>();
  const uncertain = new Map<string, { botId: string; groupId: string }>();
  const blocked = new Set<string>();
  const perform: Recovery = async (botId, request, validate) => {
    try {
      const check = async () => { await validate(); deps.assertCurrent(); };
      await check();
      const actor = await deps.actor(botId);
      if (!actor) throw new Error('GROUP_ROLE_REQUIRED');
      const snapshot = async (groupId: string) => {
        const state = await deps.snapshot(groupId);
        await check();
        const member = state.members.find(m => m.id === actor.actorId && m.kind === 'bot' && m.ownerActorId === actor.ownerId && m.state === 'joined');
        if (state.room.kind !== 'group' || state.room.dissolved_at || !member || !chatGroupRolePermissions(member.role).manager
          || !state.members.some(m => m.id === actor.ownerId && m.kind === 'human' && m.state === 'joined')) throw new Error('GROUP_ROLE_REQUIRED');
        return state.room;
      };
      if (request.type === 'list-archived') {
        const rooms = await deps.rooms();
        const ids = new Set(rooms.filter(r => r.archived && r.kind === 'group').map(r => r.id));
        for (const pending of uncertain.values()) if (pending.botId === botId) ids.add(pending.groupId);
        const groups: Array<{ id: string; name: string; revision: number; archived: boolean }> = [];
        const reconciled: string[] = [];
        for (const id of ids) {
          try {
            const room = await snapshot(id);
            groups.push({ id: room.id, name: room.name, revision: room.revision, archived: room.archived });
            reconciled.push(`${botId}:${id}`);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'GROUP_ROLE_REQUIRED') throw error;
          }
        }
        await check();
        for (const key of reconciled) blocked.delete(key);
        return { ok: true, groups, scope: 'own-teammate-archived-groups' };
      }
      const input = archivedGroupRestore.parse(request.mutation);
      const { groupId, operationId, expectedRevision } = input;
      const room = await snapshot(groupId);
      const fingerprint = JSON.stringify([botId, input]);
      const previous = attempts.get(operationId);
      if (previous && previous.fingerprint !== fingerprint) throw new Error('OPERATION_CONFLICT');
      if (blocked.has(`${botId}:${groupId}`)) throw new Error('GROUP_RESULT_UNKNOWN');
      if (previous?.result.ok) return previous.result;
      if (!previous && (!room.archived || room.revision !== expectedRevision)) throw new Error('REVISION_CONFLICT');
      await check();
      try {
        const receipt = await deps.restore(groupId, actor.actorId, { operationId, archived: false, expectedRevision });
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('CHAT_RESPONSE_INVALID');
        const result: CurrentGroupResult = { ok: true, operationId, groupId, receipt };
        attempts.set(operationId, { fingerprint, result });
        uncertain.delete(operationId);
        deps.changed(groupId);
        return result;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (typeof status === 'number' && status < 500 && status !== 408) throw error;
        const result: CurrentGroupResult = { ok: false, errorCode: 'GROUP_RESULT_UNKNOWN', message: 'Read get_archived_groups to reconcile the result before an identical retry.' };
        attempts.set(operationId, { fingerprint, result });
        uncertain.set(operationId, { botId, groupId });
        blocked.add(`${botId}:${groupId}`);
        return result;
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const errorCode = /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'GROUP_RECOVERY_FAILED';
      return { ok: false, errorCode, message: `Archived group recovery refused (${errorCode}).` };
    }
  };
  return (botId, request, validate) => {
    const pending = tail.then(() => perform(botId, request, validate));
    tail = pending.catch(() => undefined);
    return pending;
  };
}

interface Caller { botId: string; source: string; role: string; status: string; botStatus: string; archivedAt: number | null; remoteHostId: string | null }
interface Input { key: string; boundary: string; ownerInput: boolean; permission?: { planModeEnabled?: boolean; isCurrent?: () => boolean } | null }

/** Recovery requires a fresh owner-private-chat request. A stopped group lane,
 * scheduler, worker, or message from another bot cannot revive its old grant. */
export async function executeArchivedGroupTool(sessionId: string, request: ArchivedGroupRequest, deps: {
  caller(sessionId: string): Promise<Caller | null>;
  input(sessionId: string): Input;
}): Promise<CurrentGroupResult> {
  // Settle the lazy account/endpoint wrapper before capturing a grant. This
  // may dispose the old registration and install the current account's one.
  recovery?.refresh?.();
  const handler = recovery;
  const input = deps.input(sessionId);
  let botId: string | undefined;
  const validate = async () => {
    const fresh = deps.input(sessionId);
    if (recovery !== handler || !handler || !input.ownerInput || !fresh.ownerInput
      || fresh.key !== input.key || fresh.boundary !== input.boundary || input.permission?.isCurrent?.() !== true
      || (request.type === 'restore-archived' && input.permission.planModeEnabled !== false)) throw new Error('GROUP_AUTHORIZATION_REQUIRED');
    const caller = await deps.caller(sessionId);
    if (!caller || caller.source !== 'bot' || !['canonical', 'thread'].includes(caller.role)
      || caller.status !== 'active' || caller.botStatus !== 'active' || caller.archivedAt !== null || caller.remoteHostId
      || (botId !== undefined && botId !== caller.botId)) throw new Error('GROUP_AUTHORIZATION_REQUIRED');
    botId = caller.botId;
    const latest = deps.input(sessionId);
    if (latest.key !== input.key || latest.boundary !== input.boundary || !latest.ownerInput
      || input.permission?.isCurrent?.() !== true || recovery !== handler) throw new Error('GROUP_AUTHORIZATION_REQUIRED');
  };
  try {
    await validate();
    return await handler!.execute(botId!, request, validate);
  } catch {
    return { ok: false, errorCode: 'GROUP_AUTHORIZATION_REQUIRED', message: 'Archived group recovery requires a current request from your owner in your private Bot Chat.' };
  }
}
