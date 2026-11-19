import { isProviderSharePeer, parseProviderSharePeer, providerShareGuestPeer, type RemoteAgentRequest } from '@cindy/device-link';
import { randomUUID } from 'node:crypto';

import { getDeviceId } from '../authManager.js';
import { isRemoteProviderInvocationAllowed, remoteProviderAccessEpoch } from '../maker-host/remote-provider-access-store.js';
import { checkProviderShareDelegation, providerShareOwnerKey } from './providerShareApi.js';
import { readDeviceLinkSettings } from './settings-store.desktop.js';
import { groupFastPolicyStore } from '../provider-group/fastPolicyStore.js';
import { hostSessionIdFor } from '../remote-agent/host/sessionIdentity.js';
import { notifySubscriptionFastPolicyChanged } from '../maker-host/subscription-fast-policy.js';
import { agentNetProviderExecutorProof } from './agentNetSharing.js';
import { remoteModelAccess } from './remoteModelAccess.js';
import { remoteControlAccessGeneration } from './remoteControlAccess.js';

const LEASE_MS = 30 * 60_000;
const MAX_LEASES = 512;
/** A completed turn can report its counters just after its execution lease expires. */
const RECEIPT_GRACE_MS = 5 * 60_000;
const MAX_RECEIPT_AUTHORITIES = 20_000;
const MAX_BLOCKED_PEERS = 20_000;

type Delegate = Extract<RemoteAgentRequest, { op: 'delegate' }>;
type StandbyAdmit = Extract<RemoteAgentRequest, { op: 'standby-admit' }>;
type Access = { shareId: string; memberId: string; providerId: string };
type Lease = { ownerScope: string; ownerDeviceId: string; access: Access; model: string;
  generation: string; availability?: boolean; cleanupEpoch: number; wallUntil: number; monoUntil: number; nonce: string;
  standby?: NonNullable<Delegate['standby']> & { providerEpoch: string; controlEpoch: number; token: string; proofId: string };
  standbySource?: { sessionId: string; token: string; agentKind: StandbyAdmit['agentKind']; receiptGeneration: string } };
type ReceiptAuthority = Pick<Lease, 'ownerScope' | 'ownerDeviceId' | 'generation' | 'availability' | 'wallUntil' | 'monoUntil' | 'standbySource'>;
/** One guest peer may have concurrent tasks with different approved models. */
const leases = new Map<string, Map<string, Lease>>();
/** Accounting only: never consulted by guest admission, model access, or run lifetime. */
const receiptOnlyAuthorities = new Map<string, ReceiptAuthority>();
const pending = new Map<string, { mark: symbol; generation: string; ownerDeviceId: string;
  cleanupEpoch: number }>();
const blockedPeers = new Map<string, { ownerScope: string; ownerDeviceId: string }>();
const standbyReservations = new Map<string, { providerId: string; until: number; active?: true }>();
let standbyRunningGeneration = 0;
const receiptKey = (peer: string, sessionId: string) => JSON.stringify([peer, sessionId]);

function retainReceiptAuthority(peer: string, sessionId: string, lease: Lease,
  wall = Date.now(), mono = performance.now()): void {
  if (lease.ownerScope !== providerShareOwnerKey()) return;
  // A stopped run may still deliver the done event for a turn it already used.
  // Its accounting window starts when execution stops, never after the lease deadline.
  const wallUntil = Math.min(lease.wallUntil, wall) + RECEIPT_GRACE_MS;
  const monoUntil = Math.min(lease.monoUntil, mono) + RECEIPT_GRACE_MS;
  if (wallUntil <= wall || monoUntil <= mono) return;
  const key = receiptKey(peer, sessionId);
  receiptOnlyAuthorities.delete(key);
  receiptOnlyAuthorities.set(key, { ownerScope: lease.ownerScope, ownerDeviceId: lease.ownerDeviceId,
    generation: lease.generation, availability: lease.availability, standbySource: lease.standbySource, wallUntil, monoUntil });
  while (receiptOnlyAuthorities.size > MAX_RECEIPT_AUTHORITIES) {
    receiptOnlyAuthorities.delete(receiptOnlyAuthorities.keys().next().value!);
  }
}

function prune(): void {
  const wall = Date.now(), mono = performance.now(), scope = providerShareOwnerKey();
  for (const [peer, tasks] of leases) {
    for (const [sessionId, lease] of tasks) {
      if (lease.ownerScope !== scope) {
        tasks.delete(sessionId);
        releaseAgentNetStandbyReservation(peer, sessionId);
      } else if (lease.wallUntil <= wall || lease.monoUntil <= mono) {
        tasks.delete(sessionId);
        releaseAgentNetStandbyReservation(peer, sessionId);
        retainReceiptAuthority(peer, sessionId, lease, wall, mono);
      }
    }
    if (!tasks.size) leases.delete(peer);
  }
  for (const [key, authority] of receiptOnlyAuthorities) {
    if (authority.ownerScope !== scope || authority.wallUntil <= wall
      || authority.monoUntil <= mono) receiptOnlyAuthorities.delete(key);
  }
}

function leaseAllowed(lease: Lease): boolean {
  const settings = readDeviceLinkSettings();
  return settings.remoteControlEnabled && !settings.revokedControllers?.includes(lease.ownerDeviceId)
    && isRemoteProviderInvocationAllowed(lease.access.providerId);
}

function validTask(peer: string, sessionId: string): Lease | null {
  prune();
  const lease = leases.get(peer)?.get(sessionId);
  return lease && !lease.standby?.only && leaseAllowed(lease) && (!lease.standbySource
    || standbyAnchor(peer, lease.standbySource.sessionId)?.standby?.token === lease.standbySource.token)
    ? lease : null;
}

function executorProof(peer: string) {
  const guest = parseProviderSharePeer(peer), executorDeviceId = getDeviceId();
  return guest?.role === 'guest' && executorDeviceId
    ? agentNetProviderExecutorProof({ shareId: guest.shareId, memberId: guest.memberId, guestDeviceId: guest.deviceId, executorDeviceId })
    : null;
}

/** A standby task is authorized by a previously confirmed scoped grant on this executor. */
function standbyAnchor(peer: string, sessionId: string): Lease | null {
  const lease = leases.get(peer)?.get(sessionId);
  if (!lease?.standby || lease.standbySource || guestBlocked(peer)
    || !leaseAllowed(lease) || remoteProviderAccessEpoch(lease.access.providerId) !== lease.standby.providerEpoch
    || remoteControlAccessGeneration() !== lease.standby.controlEpoch
    || !remoteModelAccess.allows(lease.access.providerId, lease.model)) return null;
  const proof = executorProof(peer);
  if (!proof || proof.ownerDeviceId !== lease.ownerDeviceId || proof.expiresAt <= Date.now()
    || lease.standby.proofId !== proof.delegation.id) return null;
  return lease;
}

async function withStandbyLoad<T>(readRunning: () => Promise<ReadonlyMap<string, number> | null>,
  use: (running: ReadonlyMap<string, number> | null) => T): Promise<T> {
  // The host includes turns that have claimed capacity, even if native send
  // has not started yet. Re-read when such a claim raced the load snapshot.
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = standbyRunningGeneration;
    const running = await readRunning();
    if (!running || generation === standbyRunningGeneration) return use(running);
  }
  throw new Error('[REMOTE_AGENT_BUSY] Shared standby executor load is changing');
}

function reserveStandby(key: string, source: Lease, running: ReadonlyMap<string, number>, active = false): void {
  const now = performance.now(), providerId = source.access.providerId;
  let reserved = 0;
  for (const [id, reservation] of standbyReservations) {
    if (reservation.until <= now && !reservation.active) standbyReservations.delete(id);
    else if (id !== key && reservation.providerId === providerId && !reservation.active) reserved++;
  }
  const limit = source.standby!.limit;
  if (limit !== null && (running.get(providerId) ?? 0) + reserved >= limit) {
    throw new Error('[REMOTE_AGENT_BUSY] Shared standby executor is full');
  }
  if (active) standbyRunningGeneration++;
  standbyReservations.set(key, { providerId, until: Math.min(source.monoUntil, active ? Infinity : now + 30_000),
    ...(active ? { active: true as const } : {}) });
}

export async function admitAgentNetProviderStandby(peer: string, request: StandbyAdmit,
  readRunning: () => Promise<ReadonlyMap<string, number> | null>) {
  prune();
  const source = standbyAnchor(peer, request.sourceSessionId);
  const permit = source?.standby;
  if (!source || !permit || request.model !== source.model || request.agentKind !== permit.agentKind) {
    throw new Error('[REMOTE_AGENT_UNAVAILABLE] Shared standby permission is unavailable');
  }
  return withStandbyLoad(readRunning, running => {
    prune();
    if (!running || standbyAnchor(peer, request.sourceSessionId)?.standby !== permit) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] Shared standby permission is unavailable');
    }
    const tasks = leases.get(peer)!;
    let lease = tasks.get(request.sessionId);
    if (lease && (lease.generation !== request.admissionId || lease.standbySource?.sessionId !== request.sourceSessionId
      || lease.standbySource.token !== permit.token)) {
      throw new Error('[REMOTE_AGENT_BUSY] Shared task already has an executor permission');
    }
    if (!lease) {
      if ([...leases.values()].reduce((count, tasks) => count + tasks.size, 0) >= MAX_LEASES) {
        throw new Error('[REMOTE_AGENT_BUSY] Shared standby executor is full');
      }
      reserveStandby(receiptKey(peer, request.sessionId), source, running);
      lease = { ...source, generation: request.admissionId, standby: undefined, standbySource: {
        sessionId: request.sourceSessionId, token: permit.token, agentKind: permit.agentKind, receiptGeneration: source.generation,
      }, nonce: randomUUID() };
      groupFastPolicyStore.requireOrigin(hostSessionIdFor(peer, request.sessionId), source.ownerDeviceId);
      tasks.set(request.sessionId, lease);
    }
    const leaseDurationMs = Math.floor(Math.min(lease.wallUntil - Date.now(), lease.monoUntil - performance.now()));
    if (leaseDurationMs <= 0) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Shared standby permission has expired');
    return { generation: lease.generation, leaseDurationMs };
  });
}

export async function beginAgentNetStandbyTurn(peer: string, sessionId: string,
  readRunning: () => Promise<ReadonlyMap<string, number> | null>,
  captureCompletion: (complete: () => Promise<void>, countsLocally?: true) => void): Promise<void> {
  const lease = leases.get(peer)?.get(sessionId);
  if (!lease?.standbySource) return;
  const { sessionId: sourceId, token } = lease.standbySource;
  await withStandbyLoad(readRunning, running => {
    const source = standbyAnchor(peer, sourceId);
    if (!running || !source || source.standby?.token !== token || validTask(peer, sessionId) !== lease) {
      throw new Error('[REMOTE_AGENT_UNAVAILABLE] Shared standby permission is unavailable');
    }
    const key = receiptKey(peer, sessionId);
    reserveStandby(key, source, running, true);
    const reservation = standbyReservations.get(key);
    captureCompletion(async () => {
      if (standbyReservations.get(key) === reservation) releaseAgentNetStandbyReservation(peer, sessionId);
    }, true);
  });
}

export function releaseAgentNetStandbyReservation(peer: string, sessionId: string): void {
  const key = receiptKey(peer, sessionId);
  if (standbyReservations.get(key)?.active) standbyRunningGeneration++;
  standbyReservations.delete(key);
}

export function releaseUnusedAgentNetStandby(peer: string, sessionId: string, generation: string): boolean {
  prune();
  const tasks = leases.get(peer), lease = tasks?.get(sessionId);
  if (!tasks || !lease?.standbySource || lease.generation !== generation) return false;
  tasks.delete(sessionId);
  if (!tasks.size) leases.delete(peer);
  releaseAgentNetStandbyReservation(peer, sessionId);
  return true;
}

/** A grant only comes from a same-account, authenticated device-link peer; runHost checks that before calling. */
export async function applyProviderShareDelegation(ownerDeviceId: string, request: Delegate,
  check: typeof checkProviderShareDelegation = checkProviderShareDelegation, availability = false): Promise<boolean> {
  if (isProviderSharePeer(ownerDeviceId) || !getDeviceId() || ownerDeviceId === getDeviceId()) {
    throw new Error('REMOTE_AGENT_INVALID');
  }
  const settings = readDeviceLinkSettings();
  if (request.action === 'grant'
    && (!settings.remoteControlEnabled || settings.revokedControllers?.includes(ownerDeviceId))) {
    throw new Error('REMOTE_AGENT_UNAVAILABLE');
  }
  const peer = providerShareGuestPeer(request.shareId, request.memberId, request.guestDeviceId);
  const key = receiptKey(peer, request.sessionId);
  prune();
  const tasks = leases.get(peer);
  if (request.action === 'disarm-standby') {
    const lease = tasks?.get(request.sessionId);
    if (lease?.standby && lease.ownerDeviceId === ownerDeviceId && lease.generation === request.generation) {
      const token = lease.standby.token;
      if (lease.standby.only) invalidateProviderShareDelegation(peer, request.sessionId, lease.nonce);
      else delete lease.standby;
      for (const [sessionId, task] of tasks!) {
        if (task.standbySource?.token === token) invalidateProviderShareDelegation(peer, sessionId, task.nonce);
      }
      return true;
    }
    return false;
  }
  if (request.action === 'revoke') {
    if (pending.get(key)?.generation === request.generation) pending.delete(key);
    const lease = tasks?.get(request.sessionId);
    if (tasks && lease?.ownerDeviceId === ownerDeviceId
      && request.generation && lease.generation === request.generation) {
      retainReceiptAuthority(peer, request.sessionId, lease);
      tasks.delete(request.sessionId);
      releaseAgentNetStandbyReservation(peer, request.sessionId);
      if (!tasks.size) leases.delete(peer);
      return true;
    }
    return false;
  }
  if (!request.generation) throw new Error('REMOTE_AGENT_INVALID');
  const count = [...leases.values()].reduce((sum, entries) => sum + entries.size, 0);
  if (!isRemoteProviderInvocationAllowed(request.providerId)
    || (!tasks?.has(request.sessionId) && count >= MAX_LEASES)) throw new Error('REMOTE_AGENT_UNAVAILABLE');
  if (tasks && [...tasks.values()].some((lease) => lease.ownerDeviceId !== ownerDeviceId)) {
    throw new Error('REMOTE_AGENT_INVALID');
  }
  const scope = providerShareOwnerKey();
  const standbyEpoch = request.standby && !availability
    ? { providerEpoch: remoteProviderAccessEpoch(request.providerId), controlEpoch: remoteControlAccessGeneration() } : undefined;
  const mark = Symbol();
  pending.set(key, { mark, generation: request.generation, ownerDeviceId,
    cleanupEpoch: request.cleanupEpoch ?? 0 });
  let approved: Awaited<ReturnType<typeof check>>;
  try {
    approved = await check({ shareId: request.shareId, memberId: request.memberId,
      guestDeviceId: request.guestDeviceId, executorDeviceId: getDeviceId()! }, request.generation);
  } catch (error) {
    if (pending.get(key)?.mark === mark) pending.delete(key);
    throw error;
  }
  try {
    if (pending.get(key)?.mark !== mark || !approved.active || approved.ownerDeviceId !== ownerDeviceId
      || approved.generation !== request.generation
      || !approved.expiresAt || approved.expiresAt <= Date.now()
      || providerShareOwnerKey() !== scope) throw new Error('REMOTE_AGENT_INVALID');
    // Revalidate after the network round trip; a settings/account change cannot
    // turn an old response into a fresh local guest permission.
    const currentSettings = readDeviceLinkSettings();
    if (!currentSettings.remoteControlEnabled || currentSettings.revokedControllers?.includes(ownerDeviceId)
      || !isRemoteProviderInvocationAllowed(request.providerId)) throw new Error('REMOTE_AGENT_UNAVAILABLE');
    const assertCurrent = () => {
      const settings = readDeviceLinkSettings();
      if (pending.get(key)?.mark !== mark || providerShareOwnerKey() !== scope
        || !settings.remoteControlEnabled || settings.revokedControllers?.includes(ownerDeviceId)
        || !isRemoteProviderInvocationAllowed(request.providerId)
        || !approved.expiresAt || approved.expiresAt <= Date.now()) throw new Error('REMOTE_AGENT_INVALID');
    };
    if (request.fastPolicy) {
      // The existing delegation check authenticates O once. Do not issue another
      // cloud check just to synchronize a speed preference during grant/renewal.
      // Bind the verified task, never any task name supplied by G.
      try {
        await groupFastPolicyStore.receive(ownerDeviceId, { ...request.fastPolicy,
          binding: { sessionId: request.sessionId } }, getDeviceId(), assertCurrent,
          hostSessionIdFor(peer, request.sessionId));
      } catch {
        assertCurrent();
        groupFastPolicyStore.suppress(hostSessionIdFor(peer, request.sessionId), ownerDeviceId, request.fastPolicy.group);
      }
      assertCurrent();
      void notifySubscriptionFastPolicyChanged().catch(() => undefined);
    }
    const next = leases.get(peer) ?? new Map<string, Lease>();
    if ([...next.values()].some((lease) => lease.ownerDeviceId !== ownerDeviceId)) {
      throw new Error('REMOTE_AGENT_INVALID');
    }
    if (!next.has(request.sessionId) && [...leases.values()].reduce((sum, entries) => sum + entries.size, 0) >= MAX_LEASES) {
      throw new Error('REMOTE_AGENT_UNAVAILABLE');
    }
    const duration = Math.min(LEASE_MS, approved.expiresAt - Date.now());
    const previous = next.get(request.sessionId);
    const standby = request.standby && standbyEpoch && approved.proofId
      && standbyEpoch.providerEpoch === remoteProviderAccessEpoch(request.providerId)
      && standbyEpoch.controlEpoch === remoteControlAccessGeneration()
      ? { ...request.standby, ...standbyEpoch, proofId: approved.proofId } : undefined;
    if (request.standby?.only && !standby) throw new Error('REMOTE_AGENT_UNAVAILABLE');
    const original = previous?.standby;
    const sameStandby = standby && original && previous.model === request.model && previous.access.providerId === request.providerId
      && original.agentKind === standby.agentKind && original.limit === standby.limit && original.providerEpoch === standby.providerEpoch
      && original.controlEpoch === standby.controlEpoch && original.proofId === standby.proofId && original.only === standby.only;
    // Only the server-confirmed issuer may supply this delegated task's group
    // policy. Neither M's local default nor G's self-binding can replace O.
    groupFastPolicyStore.requireOrigin(hostSessionIdFor(peer, request.sessionId), ownerDeviceId);
    // A fresh task lease supersedes any accounting-only authority for this task.
    receiptOnlyAuthorities.delete(key);
    next.set(request.sessionId, {
      ownerScope: scope, ownerDeviceId,
      access: { shareId: request.shareId, memberId: request.memberId, providerId: request.providerId },
      model: request.model, generation: request.generation, availability,
      cleanupEpoch: request.cleanupEpoch ?? 0,
      wallUntil: Date.now() + duration, monoUntil: performance.now() + duration,
      nonce: randomUUID(),
      ...(standby ? { standby: { ...standby, token: sameStandby ? original.token : randomUUID() } } : {}),
    });
    leases.set(peer, next);
    blockedPeers.delete(peer);
    return false;
  } finally {
    if (pending.get(key)?.mark === mark) pending.delete(key);
  }
}

function guestBlocked(peer: string): boolean {
  const blocked = blockedPeers.get(peer);
  if (!blocked) return false;
  if (blocked.ownerScope === providerShareOwnerKey()) return true;
  blockedPeers.delete(peer);
  return false;
}

/** Periodic server recheck catches share revocation even if O restarted and lost its in-memory routing state. */
export function delegatedProviderShareLeases(): Array<{ peer: string; sessionId: string; lease: Lease }> {
  prune();
  return [...leases].flatMap(([peer, tasks]) => [...tasks].map(([sessionId, lease]) => ({ peer, sessionId, lease })));
}

export function invalidateProviderShareDelegation(peer: string, sessionId: string, nonce: string): void {
  const tasks = leases.get(peer);
  const lease = tasks?.get(sessionId);
  if (!tasks || lease?.nonce !== nonce) return;
  retainReceiptAuthority(peer, sessionId, lease);
  tasks.delete(sessionId);
  releaseAgentNetStandbyReservation(peer, sessionId);
  if (!tasks.size) leases.delete(peer);
}

export function delegatedProviderShareGuestAccess(controller: string): Access | null {
  prune();
  for (const lease of leases.get(controller)?.values() ?? []) {
    if (leaseAllowed(lease)) return lease.access;
  }
  return null;
}

/** A live signed Agent Net route makes a legacy standby lookup unnecessary. */
export function locallyProvenProviderShareDelegation(controller: string): boolean {
  if (guestBlocked(controller)) return false;
  prune();
  const tasks = leases.get(controller);
  if (!tasks?.size) return false;
  const proof = executorProof(controller);
  return !!proof && [...tasks.values()].some(lease => !lease.availability && lease.ownerDeviceId === proof.ownerDeviceId && leaseAllowed(lease));
}

/** A delegated provider belongs to one task, even when the same guest uses another local provider concurrently. */
export function delegatedProviderShareTaskAccess(controller: string, sessionId: string): Access | null {
  return validTask(controller, sessionId)?.access ?? null;
}

export function delegatedProviderShareModelAllowed(controller: string, model: string, sessionId?: string): boolean {
  return !guestBlocked(controller) && sessionId !== undefined
    && validTask(controller, sessionId)?.model === model;
}

export function delegatedProviderShareSessionAllowed(controller: string, sessionId: string, agentKind?: StandbyAdmit['agentKind']): boolean {
  if (guestBlocked(controller)) return false;
  const lease = validTask(controller, sessionId);
  return !!lease && (!agentKind || !lease.standbySource || lease.standbySource.agentKind === agentKind);
}

export function delegatedProviderShareOwnerDevice(controller: string, sessionId: string): string | null {
  return validTask(controller, sessionId)?.ownerDeviceId ?? null;
}

export function delegatedProviderShareReceiptAuthority(controller: string, sessionId: string):
  { ownerDeviceId: string; generation: string; availability?: true; receiptSessionId?: string } | null {
  // Accounting a finished turn is independent of whether another turn could
  // start now; prune still enforces expiry and the current account scope.
  prune();
  const lease = leases.get(controller)?.get(sessionId);
  if (lease) return { ownerDeviceId: lease.ownerDeviceId, generation: lease.standbySource?.receiptGeneration ?? lease.generation,
    ...(lease.availability ? { availability: true as const } : {}),
    ...(lease.standbySource ? { receiptSessionId: lease.standbySource.sessionId } : {}) };
  const expired = receiptOnlyAuthorities.get(receiptKey(controller, sessionId));
  return expired ? { ownerDeviceId: expired.ownerDeviceId, generation: expired.standbySource?.receiptGeneration ?? expired.generation,
    ...(expired.availability ? { availability: true as const } : {}),
    ...(expired.standbySource ? { receiptSessionId: expired.standbySource.sessionId } : {}) } : null;
}

/** An authenticated O's deletion invalidates every old task for exactly this direct guest. */
export function revokeDelegatedProviderShareGuest(ownerDeviceId: string, peer: string,
  forgetEpoch: number, confirmedOwnership = false): boolean {
  if (!isProviderSharePeer(peer)) throw new Error('REMOTE_AGENT_INVALID');
  const scope = providerShareOwnerKey();
  let matched = false;
  const tasks = leases.get(peer);
  const prefix = `[${JSON.stringify(peer)},`;
  // A new server-checked grant can be installed before runHost has persisted
  // its higher epoch in the guest index. Never erase that newer task.
  if ([...(tasks?.values() ?? [])].some((lease) => lease.ownerDeviceId === ownerDeviceId
    && lease.ownerScope === scope && lease.cleanupEpoch > forgetEpoch)
    || [...pending].some(([key, grant]) => key.startsWith(prefix)
      && grant.ownerDeviceId === ownerDeviceId && grant.cleanupEpoch > forgetEpoch)) return false;
  if (tasks) {
    for (const [sessionId, lease] of tasks) {
      if (lease.ownerDeviceId === ownerDeviceId && lease.ownerScope === scope
        && lease.cleanupEpoch <= forgetEpoch) {
        tasks.delete(sessionId);
        releaseAgentNetStandbyReservation(peer, sessionId);
        matched = true;
      }
    }
    if (!tasks.size) leases.delete(peer);
  }
  for (const [key, grant] of pending) {
    if (key.startsWith(prefix) && grant.ownerDeviceId === ownerDeviceId
      && grant.cleanupEpoch <= forgetEpoch) {
      pending.delete(key);
      matched = true;
    }
  }
  for (const [key, authority] of receiptOnlyAuthorities) {
    if (key.startsWith(prefix) && authority.ownerDeviceId === ownerDeviceId
      && authority.ownerScope === scope) {
      receiptOnlyAuthorities.delete(key);
      matched = true;
    }
  }
  if (!matched && !confirmedOwnership) return true;
  blockedPeers.delete(peer);
  blockedPeers.set(peer, { ownerScope: scope, ownerDeviceId });
  while (blockedPeers.size > MAX_BLOCKED_PEERS) blockedPeers.delete(blockedPeers.keys().next().value!);
  return true;
}

export function clearProviderShareDelegations(): void {
  leases.clear(); receiptOnlyAuthorities.clear(); pending.clear(); blockedPeers.clear(); standbyReservations.clear();
}
