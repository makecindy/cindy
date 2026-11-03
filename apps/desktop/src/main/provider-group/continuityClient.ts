import { isScopedPeer, PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';
import type { ProviderGroupRemotePick } from '../../shared/providerGroup.js';
import { parseGroupContinuityAck } from '../../shared/providerGroupContinuity.js';
import type { ProviderGroupRemoteClient, ProviderGroupRemoteInvoke } from './remoteClient.js';
import { pickProviderGroupMember } from './scheduler.js';

type Input = Parameters<ProviderGroupRemoteClient['pick']>[1];
type Pick = Extract<ProviderGroupRemotePick, { kind: 'member' }>;
interface Row { owner: string; provider: string; agent: string; model: string; pick: Pick;
  current(): boolean; wall: number; mono: number }

/** C can use only contexts previously acknowledged by both O and M, scoped to this model. */
export function createGroupContinuityClient(deps: {
  livePick: ProviderGroupRemoteClient['pick']; invoke: ProviderGroupRemoteInvoke;
  capture(owner: string, executor?: string): () => boolean;
  ownerMayRespond(owner: string): boolean;
  retryable(error: unknown): boolean;
  wall(): number; mono(): number;
}) {
  const rows = new Map<string, Row>();
  const cursors = new Map<string, string>();
  const fallbackQueues = new Map<string, { tail: Promise<void>; pending: number }>();
  const valid = (row: Row) => row.current() && deps.wall() < row.wall && deps.mono() < row.mono;
  const prune = () => { for (const [key, row] of rows) if (!valid(row)) rows.delete(key); };
  const invalidate = (owner: string, provider: string) => {
    for (const [key, row] of rows) if (row.owner === owner && row.provider === provider) rows.delete(key);
  };
  async function fallback(owner: string, input: Input, original: unknown): Promise<ProviderGroupRemotePick> {
    prune();
    const candidates = [...rows.values()].filter(row => row.owner === owner && row.provider === input.providerId
      && row.agent === input.agentKind && row.model === input.model && !input.exclude.includes(row.pick.member.key));
    if (!candidates.length || input.quotaRebalance) throw original;
    const live: Array<{ row: Row; running: number }> = [];
    const work = Promise.allSettled(candidates.map(async row => {
      const id = row.pick.continuity!.id, device = row.pick.member.agentDeviceId!;
      // Each queued pick samples M anew, including after a previous read timed out.
      // Load is task-relative: never reuse another task's in-flight inspection.
      const reply = await deps.invoke(device, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'continuity-inspect', id,
        ownerDeviceId: owner, sessionId: input.sessionId }], { preSend: () => { if (!valid(row)) throw new Error('Group routing context expired'); } });
      const ack = reply.ok ? parseGroupContinuityAck(reply.result, id) : null;
      if (ack?.running !== undefined && valid(row)) live.push({ row, running: ack.running });
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    const first = candidates[0].pick.continuity!;
    const cursor = JSON.stringify([owner, input.providerId, input.agentKind, input.model]);
    const excluded = new Set(input.exclude);
    while (true) {
      const key = pickProviderGroupMember(first.config.members.map(member => ({ ...member,
        usable: live.some(row => row.row.pick.member.key === member.key && valid(row.row)),
        running: live.find(row => row.row.pick.member.key === member.key)?.running ?? 0,
      })), first.config.strategy, { exclude: excluded, lastPicked: cursors.get(cursor) });
      if (!key) throw original;
      const selected = live.find(row => row.row.pick.member.key === key)!;
      const row = selected.row, id = row.pick.continuity!.id;
      try {
        let admitTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const request = deps.invoke(row.pick.member.agentDeviceId!, PROVIDER_GROUP_REMOTE_CHANNEL,
          [{ action: 'continuity-admit', id, ownerDeviceId: owner, sessionId: input.sessionId }], {
            preSend: () => { if (timedOut || !valid(row)) throw new Error('Group routing context expired'); },
          });
        const reply = await Promise.race([request, new Promise<never>((_resolve, reject) => {
          admitTimer = setTimeout(() => { timedOut = true; reject(new Error('Executor admission timed out')); }, 2_000);
        })]).finally(() => { if (admitTimer) clearTimeout(admitTimer); });
        if (!reply.ok || !parseGroupContinuityAck(reply.result, id) || !valid(row)) throw new Error('Executor admission failed');
        if (!cursors.has(cursor) && cursors.size >= 512) cursors.delete(cursors.keys().next().value!);
        cursors.set(cursor, key);
        return { kind: 'member', member: { ...row.pick.member }, label: row.pick.label };
      } catch {
        if (!first.config.autoSwitch) throw original;
        excluded.add(key);
      }
    }
  }
  async function queuedFallback(owner: string, input: Input, original: unknown, current: () => boolean) {
    // One group's read/select/admit is a transaction: M's acknowledged reservation
    // must be visible to the next pick. Different groups keep independent queues.
    const key = JSON.stringify([owner, input.providerId]);
    let queue = fallbackQueues.get(key);
    if (!queue) {
      if (fallbackQueues.size >= 512) throw original;
      queue = { tail: Promise.resolve(), pending: 0 }; fallbackQueues.set(key, queue);
    }
    if (queue.pending >= 128) throw original;
    queue.pending++;
    const result = queue.tail.then(() => {
      if (!current()) throw new Error('[ACCESS_REVOKED] Group owner scope changed while waiting');
      return fallback(owner, input, original);
    });
    queue.tail = result.then(() => undefined, () => undefined);
    const active = queue;
    void queue.tail.then(() => {
      active.pending--;
      if (active.pending === 0 && fallbackQueues.get(key) === active) fallbackQueues.delete(key);
    });
    return result;
  }
  return {
    async pick(owner: string, input: Input): Promise<ProviderGroupRemotePick> {
      if (isScopedPeer(owner) || owner.startsWith('share:')) return deps.livePick(owner, input);
      const current = deps.capture(owner);
      const wall = deps.wall(), mono = deps.mono();
      const remember = (pick: ProviderGroupRemotePick) => {
        if (!current()) throw new Error('[ACCESS_REVOKED] Group owner scope changed');
        prune();
        if (pick.kind !== 'member' || !pick.continuity) { invalidate(owner, input.providerId); return pick; }
        for (const [key, row] of rows) if (row.owner === owner && row.provider === input.providerId
          && JSON.stringify(row.pick.continuity?.config) !== JSON.stringify(pick.continuity.config)) rows.delete(key);
        if (rows.size >= 512) rows.delete(rows.keys().next().value!);
        const key = JSON.stringify([owner, input.providerId, input.agentKind, input.model, pick.member.key]);
        const peerCurrent = deps.capture(owner, pick.member.agentDeviceId!);
        rows.set(key, { owner, provider: input.providerId, agent: input.agentKind, model: input.model,
          pick: JSON.parse(JSON.stringify(pick)), current: () => current() && peerCurrent(),
          wall: wall + pick.continuity.remainingMs, mono: mono + pick.continuity.remainingMs });
        return pick;
      };
      if (!deps.ownerMayRespond(owner) && current()) {
        const offline = Object.assign(new Error('[NOT_CONNECTED] Group owner signaling is unavailable'), { code: 'NOT_CONNECTED' });
        prune();
        if ([...rows.values()].some(row => row.owner === owner && row.provider === input.providerId
          && row.agent === input.agentKind && row.model === input.model)) return queuedFallback(owner, input, offline, current);
      }
      try { return remember(await deps.livePick(owner, input)); }
      catch (error) {
        if (!current() || !deps.retryable(error)) { invalidate(owner, input.providerId); throw error; }
        return queuedFallback(owner, input, error, current);
      }
    },
  };
}
