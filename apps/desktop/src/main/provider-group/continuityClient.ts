import { isProviderAccessDeniedError, isScopedPeer, PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';
import type { ProviderGroupConfig, ProviderGroupRemotePick } from '../../shared/providerGroup.js';
import { parseGroupContinuityAck } from '../../shared/providerGroupContinuity.js';
import { ProviderGroupLocalCapacityError } from './localCapacity.js';
import type { ProviderGroupRemoteClient, ProviderGroupRemoteInvoke } from './remoteClient.js';
import { pickProviderGroupMember } from './scheduler.js';

type Input = Parameters<ProviderGroupRemoteClient['pick']>[1];
type Pick = Extract<ProviderGroupRemotePick, { kind: 'member' }>;
interface Row { key: string; scope: string; epoch: number; owner: string; provider: string; agent: string; model: string; pick: Pick;
  current(): boolean; wall: number; mono: number }

/** C can use only contexts previously acknowledged by both O and M, scoped to this model. */
export function createGroupContinuityClient(deps: {
  livePick: ProviderGroupRemoteClient['pick']; invoke: ProviderGroupRemoteInvoke;
  capture(owner: string, executor?: string): () => boolean;
  /** Account/endpoint/current/link-close only; live online picks must not depend on the offline metadata registry. */
  onlineCapture?(owner: string): () => boolean;
  /** Local account/endpoint scope; a new generation must not inherit the old one's in-flight picks. */
  scopeKey?(): string;
  ownerMayRespond(owner: string): boolean;
  retryable(error: unknown): boolean;
  wall(): number; mono(): number;
}) {
  const scopeKey = deps.scopeKey ?? (() => 'default');
  const rows = new Map<string, Row>();
  const cursors = new Map<string, string>();
  const fallbackQueues = new Map<string, { tail: Promise<void>; pending: number }>();
  const sessionFlights = new Map<string, { promise: Promise<ProviderGroupRemotePick>; current(): boolean;
    scope: string; owner: string; provider: string }>();
  const scopeEpochs = new Map<string, number>();
  let scopeSequence = 0;
  const epochKey = (scope: string, owner: string, provider: string) => JSON.stringify([scope, owner, provider]);
  const epochFor = (scope: string, owner: string, provider: string): number => {
    const key = epochKey(scope, owner, provider), existing = scopeEpochs.get(key);
    if (existing !== undefined) return existing;
    if (scopeEpochs.size >= 512 && !recycleOneScope()) throw new ProviderGroupLocalCapacityError();
    const epoch = ++scopeSequence;
    scopeEpochs.set(key, epoch);
    return epoch;
  };
  const peekEpoch = (scope: string, owner: string, provider: string): number | undefined =>
    scopeEpochs.get(epochKey(scope, owner, provider));
  const advanceEpoch = (scope: string, owner: string, provider: string): number => {
    const key = epochKey(scope, owner, provider);
    // Only an existing, referenced scope can be advanced. An unrelated forget must
    // not allocate a table entry or evict a healthy neighbour.
    if (!scopeEpochs.has(key)) return 0;
    const epoch = ++scopeSequence;
    scopeEpochs.set(key, epoch);
    return epoch;
  };
  /** Only the three messages emitted by fastPolicyRuntime are member-scoped Fast failures. */
  const FAST_POLICY_FAILURES = [
    'Subscription Fast policy executor is unreachable',
    'Subscription Fast policy has not been confirmed',
    'Update this computer to enforce the subscription Fast policy',
  ];
  const fastPolicyFailure = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const row = error as { code?: unknown };
    const code = typeof row.code === 'string' && row.code !== 'IPC_ERROR'
      ? row.code : /^\[([A-Z_]+)\]/.exec(error.message)?.[1];
    return (code === 'REMOTE_AGENT_UNAVAILABLE' || code === 'REMOTE_AGENT_PEER_TOO_OLD')
      && FAST_POLICY_FAILURES.some(message => error.message.includes(message));
  };
  // A removed/replaced row must not keep admitting from an already captured reference.
  const valid = (row: Row) => rows.get(row.key) === row && row.scope === scopeKey()
    && peekEpoch(row.scope, row.owner, row.provider) === row.epoch && row.current()
    && deps.wall() < row.wall && deps.mono() < row.mono;
  const prune = () => { for (const [key, row] of rows) if (!valid(row)) rows.delete(key); };
  const forget = (row: Row) => { for (const [key, current] of rows) if (current === row) rows.delete(key); };
  const recycleOneScope = (): boolean => {
    prune();
    const referenced = new Set<string>();
    for (const row of rows.values()) referenced.add(epochKey(row.scope, row.owner, row.provider));
    for (const flight of sessionFlights.values()) referenced.add(epochKey(flight.scope, flight.owner, flight.provider));
    for (const key of scopeEpochs.keys()) {
      if (!referenced.has(key)) { scopeEpochs.delete(key); return true; }
    }
    return false;
  };
  const deleteRows = (scope: string, owner: string, provider: string) => {
    for (const [key, row] of rows) if (row.scope === scope && row.owner === owner && row.provider === provider) rows.delete(key);
  };
  /** Only the current generation may invalidate its own rows; an old refusal never clears a newer generation. */
  const invalidateScoped = (scope: string, owner: string, provider: string, epoch: number) => {
    if (peekEpoch(scope, owner, provider) !== epoch) return;
    advanceEpoch(scope, owner, provider);
    deleteRows(scope, owner, provider);
  };
  async function fallback(owner: string, input: Input, original: unknown, localScope: string): Promise<ProviderGroupRemotePick> {
    prune();
    const candidates = [...rows.values()].filter(row => row.scope === localScope && row.owner === owner && row.provider === input.providerId
      && row.agent === input.agentKind && row.model === input.model && !input.exclude.includes(row.pick.member.key));
    if (!candidates.length || input.quotaRebalance) throw original;
    const live: Array<{ row: Row; running: number }> = [];
    const work = Promise.allSettled(candidates.map(async row => {
      const id = row.pick.continuity!.id, device = row.pick.member.agentDeviceId!;
      // Each queued pick samples M anew, including after a previous read timed out.
      // Load is task-relative: never reuse another task's in-flight inspection.
      let reply: Awaited<ReturnType<ProviderGroupRemoteInvoke>>;
      try {
        reply = await deps.invoke(device, PROVIDER_GROUP_REMOTE_CHANNEL, [{ action: 'continuity-inspect', id,
          ownerDeviceId: owner, sessionId: input.sessionId }], { preSend: () => { if (!valid(row)) throw new Error('Group routing context expired'); } });
      } catch (error) {
        // A local executor (the selected member is this computer) throws
        // instead of returning an IPC result; treat the same refusal the same way.
        if (isProviderAccessDeniedError(error)) forget(row);
        return;
      }
      if (!reply.ok) {
        // An explicit refusal invalidates this target immediately. A timeout is different:
        // keep the bounded context so a later pick can retry the same executor.
        if (isProviderAccessDeniedError(reply.error)) forget(row);
        return;
      }
      const ack = parseGroupContinuityAck(reply.result, id);
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
        void request.then(reply => {
          if (!reply.ok && isProviderAccessDeniedError(reply.error)) forget(row);
        }, error => { if (isProviderAccessDeniedError(error)) forget(row); });
        const reply = await Promise.race([request, new Promise<never>((_resolve, reject) => {
          admitTimer = setTimeout(() => { timedOut = true; reject(new Error('Executor admission timed out')); }, 2_000);
        })]).finally(() => { if (admitTimer) clearTimeout(admitTimer); });
        if (!reply.ok) {
          if (isProviderAccessDeniedError(reply.error)) forget(row);
          throw new Error('Executor admission failed');
        }
        if (!parseGroupContinuityAck(reply.result, id) || !valid(row)) {
          if (!valid(row)) forget(row);
          throw new Error('Executor admission failed');
        }
        if (!cursors.has(cursor) && cursors.size >= 512) cursors.delete(cursors.keys().next().value!);
        cursors.set(cursor, key);
        return { kind: 'member', member: { ...row.pick.member }, label: row.pick.label };
      } catch (error) {
        // The local handler reports refusal by rejecting rather than returning
        // ok:false; do not keep a route which the executor already retired.
        if (isProviderAccessDeniedError(error)) forget(row);
        if (!first.config.autoSwitch) throw original;
        excluded.add(key);
      }
    }
  }
  async function serializedFallback(owner: string, input: Input, original: unknown, current: () => boolean,
    localScope: string) {
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
      return fallback(owner, input, original, localScope);
    });
    queue.tail = result.then(() => undefined, () => undefined);
    const active = queue;
    void queue.tail.then(() => {
      active.pending--;
      if (active.pending === 0 && fallbackQueues.get(key) === active) fallbackQueues.delete(key);
    });
    return result;
  }
  async function pickOnce(owner: string, input: Input, current: () => boolean, localScope: string,
    scopeEpoch: number): Promise<ProviderGroupRemotePick> {
    const allowOffline = input.allowOffline === true;
    const wall = deps.wall(), mono = deps.mono();
    const remember = (pick: ProviderGroupRemotePick) => {
      if (!current()) throw new Error('[ACCESS_REVOKED] Group owner scope changed');
      prune();
      // A member without a continuity context only proves that this member is not
      // usable offline (local/share/legacy, or preparation missed). It does not
      // invalidate contexts which other members already acknowledged with O: a
      // routine selection must not erase their remaining window.
      if (pick.kind !== 'member') { invalidateScoped(localScope, owner, input.providerId, scopeEpoch); return pick; }
      if (!pick.continuity) return pick;
      for (const [key, row] of rows) if (row.scope === localScope && row.owner === owner && row.provider === input.providerId
        && JSON.stringify(row.pick.continuity?.config) !== JSON.stringify(pick.continuity.config)) rows.delete(key);
      const key = JSON.stringify([localScope, owner, input.providerId, input.agentKind, input.model, pick.member.key]);
      const peerCurrent = deps.capture(owner, pick.member.agentDeviceId!);
      // At the metadata target cap an online pick can still be authoritative, but it
      // must not create an offline routing row that cannot be safely retained.
      if (!peerCurrent()) return pick;
      // Only a genuinely new positive row may reclaim the bounded slot. Updating an
      // existing key or failing to retain an uncapturable pick must not evict a
      // still-valid neighbour.
      if (!rows.has(key) && rows.size >= 512) rows.delete(rows.keys().next().value!);
      rows.set(key, { key, scope: localScope, epoch: scopeEpoch, owner, provider: input.providerId,
        agent: input.agentKind, model: input.model,
        pick: JSON.parse(JSON.stringify(pick)), current: () => current() && peerCurrent(),
        wall: wall + pick.continuity.remainingMs, mono: mono + pick.continuity.remainingMs });
      return pick;
    };
    if (!deps.ownerMayRespond(owner) && current()) {
      const offline = Object.assign(new Error('[NOT_CONNECTED] Group owner signaling is unavailable'), { code: 'NOT_CONNECTED' });
      prune();
      if ([...rows.values()].some(row => row.scope === localScope && row.owner === owner && row.provider === input.providerId
        && row.agent === input.agentKind && row.model === input.model) && allowOffline) {
        return serializedFallback(owner, input, offline, current, localScope);
      }
    }
    try { return remember(await deps.livePick(owner, input)); }
    catch (error) {
      if (!current()) {
        invalidateScoped(localScope, owner, input.providerId, scopeEpoch);
        throw error;
      }
      if (!deps.retryable(error)) {
        // Fast binding errors are produced for the selected member (its send/caps/ack);
        // another prepared member may still have an acknowledged context. The executor
        // enforces its current policy again at admission. Keep owner-level refusals broad.
        if (!fastPolicyFailure(error)) invalidateScoped(localScope, owner, input.providerId, scopeEpoch);
        throw error;
      }
      // Existing tasks keep their group owner's authority: only a new-task
      // assignment may use contexts prepared by an earlier pick.
      if (!allowOffline) throw error;
      return serializedFallback(owner, input, error, current, localScope);
    }
  }
  return {
    /** A live directory read that confirms this group is gone retires every route it prepared. */
    forgetGroup(owner: string, provider: string): void {
      if (isScopedPeer(owner)) return;
      const localScope = scopeKey();
      // Unknown owners have no table entry to advance; cleaning orphan rows is
      // enough and must not allocate/evict under pressure.
      if (peekEpoch(localScope, owner, provider) === undefined) {
        deleteRows(localScope, owner, provider);
        return;
      }
      advanceEpoch(localScope, owner, provider);
      deleteRows(localScope, owner, provider);
    },
    /** The local account/endpoint generation this client currently serves. */
    scope(): string { return scopeKey(); },
    /** Existing only; never creates a generation during a read/scope check. */
    scopeEpoch(owner: string, provider: string): number | undefined {
      return isScopedPeer(owner) ? undefined : peekEpoch(scopeKey(), owner, provider);
    },
    /** The group settings verified by the last acknowledged pick, still inside its original deadline. */
    readConfig(owner: string, provider: string): ProviderGroupConfig | null {
      if (isScopedPeer(owner)) return null;
      prune();
      const localScope = scopeKey();
      for (const row of rows.values()) {
        if (row.scope === localScope && row.owner === owner && row.provider === provider && valid(row)) {
          return row.pick.continuity!.config;
        }
      }
      return null;
    },
    async pick(owner: string, input: Input): Promise<ProviderGroupRemotePick> {
      if (isScopedPeer(owner) || owner.startsWith('share:')) return deps.livePick(owner, input);
      const localScope = scopeKey();
      // Online picks use the live authorization chain. The metadata capture is
      // deliberately offline-only: at its target cap it may already be false while
      // the actual live directory/owner pick is still authoritative.
      const ownerCurrent = deps.onlineCapture?.(owner) ?? (() => scopeKey() === localScope);
      if (!ownerCurrent()) throw new Error('[ACCESS_REVOKED] Group owner scope changed');
      const scopeEpoch = epochFor(localScope, owner, input.providerId);
      const current = () => ownerCurrent() && scopeKey() === localScope
        && peekEpoch(localScope, owner, input.providerId) === scopeEpoch;
      // remember() retires this group's rows on an authoritative non-member answer
      // (none/unavailable), which advances this flight's own epoch. That is not a
      // caller account/link change, so return the owner's answer. A writable member
      // still requires the full generation check.
      const currentResult = (result: ProviderGroupRemotePick) => ownerCurrent()
        && scopeKey() === localScope && (result.kind === 'member' ? current() : true);
      // A task can be opened twice before the binding is persisted. Coalesce an
      // identical in-flight pick so one task cannot reserve two executors. The
      // caller's own scope is checked again after sharing the result.
      const key = JSON.stringify([localScope, owner, input.sessionId, input.providerId, input.agentKind, input.model,
        [...input.exclude].sort(), input.quotaRebalance ?? null, input.allowOffline === true]);
      const flight = sessionFlights.get(key);
      if (flight?.current()) {
        const result = await flight.promise;
        if (!currentResult(result)) throw new Error('[ACCESS_REVOKED] Group owner scope changed while waiting');
        return result;
      }
      if (flight) sessionFlights.delete(key);
      // Never start a new pick without a coalescing entry: at the capacity bound two
      // identical same-task calls would otherwise be admitted twice. Reuse the existing
      // key above; new keys get a bounded temporary failure instead.
      if (sessionFlights.size >= 512) {
        throw new ProviderGroupLocalCapacityError();
      }
      const work = pickOnce(owner, input, current, localScope, scopeEpoch);
      const entry = { promise: work, current, scope: localScope, owner, provider: input.providerId };
      sessionFlights.set(key, entry);
      try {
        const result = await work;
        // A deletion/reset can land between remember()/admission and this continuation.
        // Never hand a writable member back after the captured generation ended.
        if (!currentResult(result)) throw new Error('[ACCESS_REVOKED] Group owner scope changed before returning');
        return result;
      } finally { if (sessionFlights.get(key) === entry) sessionFlights.delete(key); }
    },
  };
}
