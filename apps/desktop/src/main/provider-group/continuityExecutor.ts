import { isScopedPeer, isProviderAccessDeniedError } from '@cindy/device-link';
import { GROUP_CONTINUITY_MS, parseGroupContinuityRequest, type GroupContinuityAck,
  type GroupContinuityGrant } from '../../shared/providerGroupContinuity.js';

interface Entry { origin: string; grant: GroupContinuityGrant; wall: number; mono: number; current(): boolean }
export interface GroupContinuityExecutorDeps {
  /** Captures the local owner, realm and both peers' explicit-close generations. */
  capture(origin: string, controller: string, providerId: string): () => boolean;
  /** Reads this executor's current provider/model permission and running load, never cloud metadata. */
  inspect(grant: GroupContinuityGrant): Promise<{ running: number; fastPolicyRequired: boolean }>;
  /** Binds the already received O policy; the caller supplies no policy value/revision. */
  bindFast(origin: string, grant: GroupContinuityGrant, sessionId: string, current: () => boolean): Promise<void>;
  wall(): number;
  mono(): number;
}

/** M retains an explicit O-issued routing context for C, not a reusable guest task grant. */
export function createGroupContinuityExecutor(deps: GroupContinuityExecutorDeps) {
  const entries = new Map<string, Entry>();
  const revoked = new Map<string, { wall: number; mono: number }>();
  /**
   * Entries retired by a local permission change. They keep their original
   * deadline, so a delayed prepare can never revive a context that the old
   * permission window no longer covers. This table is not an explicit revoke
   * fence and therefore never blocks a new grant from the same origin.
   */
  const closed = new Map<string, { wall: number; mono: number }>();
  const CLOSED_LIMIT = 4096;
  /**
   * When the individual tombstone table is full, an untracked closed entry is
   * covered by a bounded per-origin backpressure deadline instead of evicting
   * an older unexpired fence. A full per-origin map falls back to one temporary
   * global busy deadline; neither path can mint a fresh positive context.
   */
  const closedOverflow = new Map<string, { wall: number; mono: number }>();
  let closedOverflowAll: { wall: number; mono: number } | null = null;
  const CLOSED_OVERFLOW_ORIGINS = 256;
  /** Revoked-table overflow fences new prepares for one origin (bounded, target-local). */
  const revokedOverflow = new Map<string, { wall: number; mono: number; lastId: string }>();
  let revokedOverflowAll: { wall: number; mono: number; lastId: string } | null = null;
  const pending = new Map<string, { provider: string; wall: number; mono: number; current(): boolean }>();
  const tails = new Map<string, Promise<unknown>>();
  const key = (origin: string, id: string) => JSON.stringify([origin, id]);
  const valid = (entry: Entry) => entry.current() && deps.wall() < entry.wall && deps.mono() < entry.mono;
  /**
   * Retire an entry that was installed under an older permission scope. The
   * tombstone keeps only the entry's remaining original window, so a delayed
   * prepare cannot recreate it while still allowing a genuinely new grant.
   */
  const rememberClosed = (id: string, entry: Entry) => {
    if (deps.wall() >= entry.wall || deps.mono() >= entry.mono) return;
    if (closed.size >= CLOSED_LIMIT) {
      // Reclaim naturally expired tombstones first; never evict an unexpired
      // fence just to make room for a new one.
      for (const [closedId, row] of closed) {
        if (deps.wall() >= row.wall || deps.mono() >= row.mono) closed.delete(closedId);
      }
    }
    if (closed.size >= CLOSED_LIMIT) {
      markClosedOverflow(entry.origin, entry.wall, entry.mono);
      return;
    }
    closed.set(id, { wall: entry.wall, mono: entry.mono });
  };
  const markClosedOverflow = (origin: string, wall: number, mono: number) => {
    if (closedOverflowAll) {
      closedOverflowAll = { wall: Math.max(closedOverflowAll.wall, wall),
        mono: Math.max(closedOverflowAll.mono, mono) };
      return;
    }
    if (!closedOverflow.has(origin) && closedOverflow.size >= CLOSED_OVERFLOW_ORIGINS) {
      closedOverflowAll = { wall, mono };
      return;
    }
    const previous = closedOverflow.get(origin);
    closedOverflow.set(origin, { wall: Math.max(previous?.wall ?? 0, wall),
      mono: Math.max(previous?.mono ?? 0, mono) });
  };
  const closedOverflowActive = (origin: string): boolean => {
    if (closedOverflowAll && deps.wall() < closedOverflowAll.wall && deps.mono() < closedOverflowAll.mono) {
      return true;
    }
    const row = closedOverflow.get(origin);
    if (!row) return false;
    if (deps.wall() < row.wall && deps.mono() < row.mono) return true;
    closedOverflow.delete(origin);
    return false;
  };
  const prune = () => {
    for (const [id, row] of entries) {
      if (valid(row)) continue;
      entries.delete(id);
      // A context that became invalid while its original window is still open
      // must not be recreated by a delayed prepare (control switch, link or
      // permission epoch changes). Natural expiry needs no tombstone.
      rememberClosed(id, row);
    }
    for (const [id, row] of revoked) if (deps.wall() >= row.wall || deps.mono() >= row.mono) revoked.delete(id);
    for (const [id, row] of closed) if (deps.wall() >= row.wall || deps.mono() >= row.mono) closed.delete(id);
    for (const [origin, row] of closedOverflow) if (deps.wall() >= row.wall || deps.mono() >= row.mono) closedOverflow.delete(origin);
    if (closedOverflowAll && (deps.wall() >= closedOverflowAll.wall || deps.mono() >= closedOverflowAll.mono)) {
      closedOverflowAll = null;
    }
    for (const [origin, row] of revokedOverflow) if (deps.wall() >= row.wall || deps.mono() >= row.mono) revokedOverflow.delete(origin);
    if (revokedOverflowAll && (deps.wall() >= revokedOverflowAll.wall || deps.mono() >= revokedOverflowAll.mono)) {
      revokedOverflowAll = null;
    }
    for (const [id, row] of pending) if (!row.current() || deps.wall() >= row.wall || deps.mono() >= row.mono) pending.delete(id);
  };
  const denied = (): never => { throw new Error('[ACCESS_REVOKED] Group routing context is no longer valid'); };
  const busy = (): never => { throw new Error('[REMOTE_AGENT_UNAVAILABLE] Group routing capacity is temporarily exhausted'); };
  const overflowActive = (origin: string): boolean => {
    if (revokedOverflowAll) return true;
    const row = revokedOverflow.get(origin);
    if (!row) return false;
    if (deps.wall() < row.wall && deps.mono() < row.mono) return true;
    revokedOverflow.delete(origin);
    return false;
  };
  const markOverflow = (origin: string, id: string): void => {
    const wall = deps.wall() + GROUP_CONTINUITY_MS;
    const mono = deps.mono() + GROUP_CONTINUITY_MS;
    if (revokedOverflowAll) {
      if (revokedOverflowAll.lastId === id) return;
      revokedOverflowAll = { wall: Math.max(revokedOverflowAll.wall, wall),
        mono: Math.max(revokedOverflowAll.mono, mono), lastId: id };
      return;
    }
    if (!revokedOverflow.has(origin) && revokedOverflow.size >= 256) {
      revokedOverflowAll = { wall, mono, lastId: id };
      return;
    }
    const previous = revokedOverflow.get(origin);
    if (previous?.lastId === id) return;
    revokedOverflow.set(origin, { wall: Math.max(previous?.wall ?? 0, wall),
      mono: Math.max(previous?.mono ?? 0, mono), lastId: id });
  };
  const ack = (entry: Entry): GroupContinuityAck => ({ id: entry.grant.id,
    remainingMs: Math.min(entry.wall - deps.wall(), entry.mono - deps.mono()) });

  return {
    async handle(origin: string, raw: unknown): Promise<GroupContinuityAck | { ok: true }> {
      if (isScopedPeer(origin)) return denied();
      const request = parseGroupContinuityRequest(raw);
      prune();
      if (request.action === 'continuity-revoke') {
        const id = key(origin, request.id);
        entries.delete(id);
        if (!revoked.has(id) && revoked.size >= 1024) {
          // Do not lose the tombstone for this new revoke. The bounded
          // per-origin overflow fence blocks late prepares until the normal
          // revoke window has elapsed; other origins remain independent.
          // Repeated revokes for an already-removed grant do not renew it.
          markOverflow(origin, id);
          return { ok: true };
        }
        // A revoke also fences a delayed prepare. Repeated revokes do not extend it.
        if (!revoked.has(id)) revoked.set(id, { wall: deps.wall() + GROUP_CONTINUITY_MS, mono: deps.mono() + GROUP_CONTINUITY_MS });
        return { ok: true };
      }
      if (request.action === 'continuity-prepare') {
        // Only a separate group owner may install a context for this controller.
        // A controller which prepares its own grant would bypass the owner's
        // assignment and Fast-policy binding; legitimate O->M prepares always
        // carry a controller distinct from the sender.
        if (request.grant.controller === origin) return denied();
        const id = key(origin, request.grant.id);
        if (revoked.has(id) || closed.has(id)) return denied();
        const before = entries.get(id);
        if (before) {
          if (JSON.stringify(before.grant) !== JSON.stringify(request.grant)) return denied();
          return ack(before);
        }
        // Only a genuinely new entry is subject to overflow backpressure;
        // an already acknowledged surviving context stays idempotently
        // confirmable even while another grant on the same origin is fenced.
        if (overflowActive(origin) || closedOverflowActive(origin)) return busy();
        if (entries.size >= 512) return busy();
        const row: Entry = { origin, grant: request.grant, wall: deps.wall() + request.grant.remainingMs,
          mono: deps.mono() + request.grant.remainingMs, current: deps.capture(origin, request.grant.controller, request.grant.providerId) };
        if (!valid(row)) return denied();
        entries.set(id, row);
        return ack(row);
      }
      const id = key(request.ownerDeviceId, request.id);
      const entry = entries.get(id);
      // Only the issuer may distinguish a lost in-memory context from a denial.
      // Zero is never a positive ACK for C, and remembered closures stay denied.
      if (!entry && request.action === 'continuity-inspect' && origin === request.ownerDeviceId
        && !revoked.has(id) && !closed.has(id)) return { id: request.id, remainingMs: 0 };
      if (!entry || !valid(entry)) return denied();
      // The group owner that installed this context may verify that M still
      // holds it. This is read-only; admission remains controller-only.
      const verifier = request.action === 'continuity-inspect' && entry.origin === origin;
      if (entry.grant.controller !== origin && !verifier) return denied();
      const current = () => entries.get(id) === entry && valid(entry);
      const retireEntry = () => {
        if (entries.get(id) !== entry) return false;
        entries.delete(id);
        rememberClosed(id, entry);
        return true;
      };
      // Serial admission makes provisional counts visible to simultaneous callers on this M.
      const read = async () => {
        if (!current()) return denied();
        const live = await deps.inspect(entry.grant).catch(error => {
          if (isProviderAccessDeniedError(error)) retireEntry();
          throw error;
        });
        if (!current() || !Number.isSafeInteger(live.running) || live.running < 0) return denied();
        if (request.action === 'continuity-admit' && (entry.grant.fastPolicyRequired || live.fastPolicyRequired)) {
          await deps.bindFast(entry.origin, entry.grant, request.sessionId, current);
          if (!current()) return denied();
        }
        prune();
        const running = live.running + [...pending.values()].filter(row => row.provider === entry.grant.providerId).length;
        if (request.action === 'continuity-admit') {
          const reservation = JSON.stringify([origin, request.sessionId, entry.grant.providerId]);
          if (!pending.has(reservation)) {
            if (pending.size >= 1024) return busy();
            pending.set(reservation, { provider: entry.grant.providerId, wall: deps.wall() + 30_000,
              mono: deps.mono() + 30_000, current });
          }
        }
        return { ...ack(entry), running };
      };
      const tailKey = JSON.stringify([entry.origin, origin, entry.grant.group]);
      const prior = tails.get(tailKey) ?? Promise.resolve();
      const result = prior.then(read, read).catch(error => {
        if (isProviderAccessDeniedError(error)) retireEntry();
        throw error;
      });
      const tail = result.then(() => undefined, () => undefined);
      tails.set(tailKey, tail);
      void tail.finally(() => { if (tails.get(tailKey) === tail) tails.delete(tailKey); });
      return result;
    },
    /**
     * Retire entries that belonged to a permission scope which just changed.
     * The tombstone keeps the entry's original wall/mono deadline, so it can
     * reject a delayed prepare without granting a fresh window or blocking a
     * new grant from the same origin.
     */
    invalidate(match: (entry: Entry) => boolean): number {
      let invalidated = 0;
      for (const [id, entry] of entries) {
        if (!match(entry)) continue;
        entries.delete(id);
        invalidated += 1;
        rememberClosed(id, entry);
      }
      // A reservation is only a temporary load count. Drop those whose entry
      // was retired so they cannot keep the next selection needlessly busy.
      for (const [id, row] of pending) if (!row.current()) pending.delete(id);
      return invalidated;
    },
  };
}
