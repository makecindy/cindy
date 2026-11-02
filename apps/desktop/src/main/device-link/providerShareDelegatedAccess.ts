import { isProviderSharePeer, providerShareGuestPeer, type RemoteAgentRequest } from '@cindy/device-link';
import { randomUUID } from 'node:crypto';

import { getDeviceId } from '../authManager.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { checkProviderShareDelegation, providerShareOwnerKey } from './providerShareApi.js';
import { readDeviceLinkSettings } from './settings-store.js';

const LEASE_MS = 30 * 60_000;
const MAX_LEASES = 512;
/** A completed turn can report its counters just after its execution lease expires. */
const RECEIPT_GRACE_MS = 5 * 60_000;
const MAX_RECEIPT_AUTHORITIES = 20_000;
const MAX_BLOCKED_PEERS = 20_000;

type Delegate = Extract<RemoteAgentRequest, { op: 'delegate' }>;
type Access = { shareId: string; memberId: string; providerId: string };
type Lease = { ownerScope: string; ownerDeviceId: string; access: Access; model: string;
  generation: string; cleanupEpoch: number; wallUntil: number; monoUntil: number; nonce: string };
type ReceiptAuthority = Pick<Lease, 'ownerScope' | 'ownerDeviceId' | 'generation' | 'wallUntil' | 'monoUntil'>;
/** One guest peer may have concurrent tasks with different approved models. */
const leases = new Map<string, Map<string, Lease>>();
/** Accounting only: never consulted by guest admission, model access, or run lifetime. */
const receiptOnlyAuthorities = new Map<string, ReceiptAuthority>();
const pending = new Map<string, { mark: symbol; generation: string; ownerDeviceId: string;
  cleanupEpoch: number }>();
const blockedPeers = new Map<string, { ownerScope: string; ownerDeviceId: string }>();
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
    generation: lease.generation, wallUntil, monoUntil });
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
      } else if (lease.wallUntil <= wall || lease.monoUntil <= mono) {
        tasks.delete(sessionId);
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
  return lease && leaseAllowed(lease) ? lease : null;
}

/** A grant only comes from a same-account, authenticated device-link peer; runHost checks that before calling. */
export async function applyProviderShareDelegation(ownerDeviceId: string, request: Delegate,
  check: typeof checkProviderShareDelegation = checkProviderShareDelegation): Promise<boolean> {
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
  if (request.action === 'revoke') {
    if (pending.get(key)?.generation === request.generation) pending.delete(key);
    const lease = tasks?.get(request.sessionId);
    if (tasks && lease?.ownerDeviceId === ownerDeviceId
      && request.generation && lease.generation === request.generation) {
      retainReceiptAuthority(peer, request.sessionId, lease);
      tasks.delete(request.sessionId);
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
  const mark = Symbol();
  pending.set(key, { mark, generation: request.generation, ownerDeviceId,
    cleanupEpoch: request.cleanupEpoch ?? 0 });
  let approved: Awaited<ReturnType<typeof check>>;
  let current = false;
  try {
    approved = await check({ shareId: request.shareId, memberId: request.memberId,
      guestDeviceId: request.guestDeviceId, executorDeviceId: getDeviceId()! });
  } finally {
    current = pending.get(key)?.mark === mark;
    if (current) pending.delete(key);
  }
  if (!current || !approved.active || approved.ownerDeviceId !== ownerDeviceId
    || approved.generation !== request.generation
    || !approved.expiresAt || approved.expiresAt <= Date.now()
    || providerShareOwnerKey() !== scope) throw new Error('REMOTE_AGENT_INVALID');
  // Revalidate after the network round trip; a settings/account change cannot
  // turn an old response into a fresh local guest permission.
  const currentSettings = readDeviceLinkSettings();
  if (!currentSettings.remoteControlEnabled || currentSettings.revokedControllers?.includes(ownerDeviceId)
    || !isRemoteProviderInvocationAllowed(request.providerId)) throw new Error('REMOTE_AGENT_UNAVAILABLE');
  const next = leases.get(peer) ?? new Map<string, Lease>();
  if ([...next.values()].some((lease) => lease.ownerDeviceId !== ownerDeviceId)) {
    throw new Error('REMOTE_AGENT_INVALID');
  }
  if (!next.has(request.sessionId) && [...leases.values()].reduce((sum, entries) => sum + entries.size, 0) >= MAX_LEASES) {
    throw new Error('REMOTE_AGENT_UNAVAILABLE');
  }
  const duration = Math.min(LEASE_MS, approved.expiresAt - Date.now());
  // A fresh task lease supersedes any accounting-only authority for this task.
  receiptOnlyAuthorities.delete(key);
  next.set(request.sessionId, {
    ownerScope: scope, ownerDeviceId,
    access: { shareId: request.shareId, memberId: request.memberId, providerId: request.providerId },
    model: request.model, generation: request.generation,
    cleanupEpoch: request.cleanupEpoch ?? 0,
    wallUntil: Date.now() + duration, monoUntil: performance.now() + duration,
    nonce: randomUUID(),
  });
  leases.set(peer, next);
  blockedPeers.delete(peer);
  return false;
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
  if (!tasks.size) leases.delete(peer);
}

export function delegatedProviderShareGuestAccess(controller: string): Access | null {
  prune();
  for (const lease of leases.get(controller)?.values() ?? []) {
    if (leaseAllowed(lease)) return lease.access;
  }
  return null;
}

/** A delegated provider belongs to one task, even when the same guest uses another local provider concurrently. */
export function delegatedProviderShareTaskAccess(controller: string, sessionId: string): Access | null {
  return validTask(controller, sessionId)?.access ?? null;
}

export function delegatedProviderShareModelAllowed(controller: string, model: string, sessionId?: string): boolean {
  return !guestBlocked(controller) && sessionId !== undefined
    && validTask(controller, sessionId)?.model === model;
}

export function delegatedProviderShareSessionAllowed(controller: string, sessionId: string): boolean {
  return !guestBlocked(controller) && validTask(controller, sessionId) !== null;
}

export function delegatedProviderShareOwnerDevice(controller: string, sessionId: string): string | null {
  return validTask(controller, sessionId)?.ownerDeviceId ?? null;
}

export function delegatedProviderShareReceiptAuthority(controller: string, sessionId: string):
  { ownerDeviceId: string; generation: string } | null {
  // Accounting a finished turn is independent of whether another turn could
  // start now; prune still enforces expiry and the current account scope.
  prune();
  const lease = leases.get(controller)?.get(sessionId);
  if (lease) return { ownerDeviceId: lease.ownerDeviceId, generation: lease.generation };
  const expired = receiptOnlyAuthorities.get(receiptKey(controller, sessionId));
  return expired ? { ownerDeviceId: expired.ownerDeviceId, generation: expired.generation } : null;
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
  leases.clear(); receiptOnlyAuthorities.clear(); pending.clear(); blockedPeers.clear();
}
