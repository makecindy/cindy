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
  const pending = new Map<string, { provider: string; wall: number; mono: number }>();
  let tail: Promise<unknown> = Promise.resolve();
  const key = (origin: string, id: string) => JSON.stringify([origin, id]);
  const valid = (entry: Entry) => entry.current() && deps.wall() < entry.wall && deps.mono() < entry.mono;
  const prune = () => {
    for (const [id, row] of entries) if (!valid(row)) entries.delete(id);
    for (const [id, row] of revoked) if (deps.wall() >= row.wall || deps.mono() >= row.mono) revoked.delete(id);
    for (const [id, row] of pending) if (deps.wall() >= row.wall || deps.mono() >= row.mono) pending.delete(id);
  };
  const denied = (): never => { throw new Error('[ACCESS_REVOKED] Group routing context is no longer valid'); };
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
        if (!revoked.has(id) && revoked.size >= 1024) return denied();
        // A revoke also fences a delayed prepare. Repeated revokes do not extend it.
        if (!revoked.has(id)) revoked.set(id, { wall: deps.wall() + GROUP_CONTINUITY_MS, mono: deps.mono() + GROUP_CONTINUITY_MS });
        return { ok: true };
      }
      if (request.action === 'continuity-prepare') {
        const id = key(origin, request.grant.id);
        if (revoked.has(id)) return denied();
        const before = entries.get(id);
        if (before) {
          if (JSON.stringify(before.grant) !== JSON.stringify(request.grant)) return denied();
          return ack(before);
        }
        if (entries.size >= 512) return denied();
        const row: Entry = { origin, grant: request.grant, wall: deps.wall() + request.grant.remainingMs,
          mono: deps.mono() + request.grant.remainingMs, current: deps.capture(origin, request.grant.controller, request.grant.providerId) };
        if (!valid(row)) return denied();
        entries.set(id, row);
        return ack(row);
      }
      const id = key(request.ownerDeviceId, request.id);
      const entry = entries.get(id);
      if (!entry || entry.grant.controller !== origin || !valid(entry)) return denied();
      const current = () => entries.get(id) === entry && valid(entry);
      // Serial admission makes provisional counts visible to simultaneous callers on this M.
      const read = async () => {
        if (!current()) return denied();
        const live = await deps.inspect(entry.grant).catch(error => {
          if (isProviderAccessDeniedError(error) && entries.get(id) === entry) entries.delete(id);
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
          const reservation = JSON.stringify([origin, request.sessionId]);
          if (!pending.has(reservation)) {
            if (pending.size >= 1024) return denied();
            pending.set(reservation, { provider: entry.grant.providerId, wall: deps.wall() + 30_000, mono: deps.mono() + 30_000 });
          }
        }
        return { ...ack(entry), running };
      };
      const result = tail.then(read, read).catch(error => {
        if (isProviderAccessDeniedError(error) && entries.get(id) === entry) entries.delete(id);
        throw error;
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
