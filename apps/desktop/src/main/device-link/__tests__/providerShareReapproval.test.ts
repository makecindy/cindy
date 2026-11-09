import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerShareGuestPeer, PROVIDER_SHARE_RELAY_CAPABILITY, type DeviceLinkClient } from '@cindy/device-link';

const scope = vi.hoisted(() => ({ root: '', oldLease: false }));
vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-test/app', getPath: () => scope.root, getVersion: () => 'test' },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../appSessionState', async importOriginal => ({
  ...(await importOriginal<typeof import('../../appSessionState')>()),
  activeOwnerScopeKey: () => scope.root,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(scope.root, ...parts),
}));
vi.mock('../providerShareDelegatedAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('../providerShareDelegatedAccess')>()),
  delegatedProviderShareLeases: () => scope.oldLease ? [{ peer, sessionId: 'old-task', lease: { nonce: 'old-approval' } }] : [],
  invalidateProviderShareDelegation: () => { scope.oldLease = false; },
}));
import { __testing, revokeProviderShareControllers, setProviderShareAccess, setRemoteAgentHandler } from '../dispatch';
import { reconcileStandbyGuest } from '../providerShareAvailabilityGuests';

const peer = providerShareGuestPeer('fake-share', 'fake-member', 'fake-device');
const access = { shareId: 'fake-share', memberId: 'fake-member', providerId: 'fake-provider' };
const payload = { capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY] };
beforeEach(async () => {
  __testing.reset();
  scope.oldLease = true;
  scope.root = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-reapproval-'));
  await reconcileStandbyGuest(peer, 1);
});
afterEach(() => {
  __testing.reset();
  setProviderShareAccess(null);
  setRemoteAgentHandler(null);
  fs.rmSync(scope.root, { recursive: true, force: true });
});

// Integration: real handshake, durable approval fence and dispatch cleanup;
// only authority/transport and the deletion acknowledgement are fake.
function scenario(joinedAt: number | null = 2) {
  let epoch = 1;
  let approved = false;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const deletion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const purge = vi.fn(async (match: (value: string) => boolean, strict?: boolean) => {
    expect(match(peer)).toBe(true);
    expect(match('same-account')).toBe(false);
    expect(strict).toBe(true);
    await deletion;
  });
  setRemoteAgentHandler({ handle: vi.fn(), abortAll: vi.fn(), purgeControllers: purge });
  const prepared: Promise<void>[] = [];
  setProviderShareAccess({
    guestAccess: () => approved || scope.oldLease ? access : null,
    hasShares: () => false,
    ensureKnown: () => {
      // Like ensureProviderSharePeerKnown, failed standby preparation may fall
      // back to cached access for legacy O-issued grants.
      const work = reconcileStandbyGuest(peer, joinedAt).then(() => { approved = joinedAt !== null; }).catch(() => {});
      prepared.push(work);
      return work;
    },
  });
  const accept = vi.fn(); const close = vi.fn();
  const client = { sendLinkAccept: accept, closeLink: close, getConnectionEpoch: () => epoch, getStatus: () => 'online' } as unknown as DeviceLinkClient;
  __testing.setActiveClient(client);
  const open = (request = 'new-approval') => __testing.handleLinkOpen(client, peer, request, payload as never);
  const settle = async () => { await Promise.allSettled(prepared); await Promise.resolve(); };
  return { client, open, purge, accept, close, finish, fail, settle, changeEpoch: () => { epoch++; } };
}

it('accepts the first reapproved handshake only after strict old-member cleanup succeeds', async () => {
  const s = scenario(); s.open();
  await vi.waitFor(() => expect(s.purge).toHaveBeenCalledTimes(1));
  expect(s.accept).not.toHaveBeenCalled();
  s.finish(); await s.settle();
  expect(s.accept).toHaveBeenCalledExactlyOnceWith(peer, 'new-approval', expect.any(Object));
  expect(s.close).not.toHaveBeenCalled();
  const stored = JSON.parse(fs.readFileSync(path.join(scope.root, 'provider-share-standby-members.json'), 'utf8'));
  expect(stored.members[peer]).toEqual({ joinedAt: 2 });
});

it('retains the cleanup fence and refuses the handshake on deletion failure', async () => {
  const s = scenario(); s.open();
  await vi.waitFor(() => expect(s.purge).toHaveBeenCalledTimes(1));
  s.fail(new Error('EBUSY')); await s.settle();
  expect(s.accept).not.toHaveBeenCalled();
  expect(s.close).toHaveBeenCalled();
  const stored = JSON.parse(fs.readFileSync(path.join(scope.root, 'provider-share-standby-members.json'), 'utf8'));
  expect(stored.members[peer].pendingCleanup).toBe(true);
});

it.each(['revoked', 'disconnected', 'superseded'] as const)('does not revive a %s handshake after cleanup', async reason => {
  const s = scenario(); s.open('old-attempt');
  await vi.waitFor(() => expect(s.purge).toHaveBeenCalledTimes(1));
  if (reason === 'revoked') await revokeProviderShareControllers(value => value === peer, false);
  else if (reason === 'disconnected') s.changeEpoch();
  else s.open('latest-attempt');
  s.finish(); await s.settle();
  expect(s.accept.mock.calls.some(call => call[1] === 'old-attempt')).toBe(false);
  if (reason === 'superseded') expect(s.accept).toHaveBeenCalledExactlyOnceWith(peer, 'latest-attempt', expect.any(Object));
  else expect(s.accept).not.toHaveBeenCalled();
});

it('still cancels a pending handshake when the member was deleted without reapproval', async () => {
  const s = scenario(null); s.open();
  await vi.waitFor(() => expect(s.purge).toHaveBeenCalledTimes(1));
  s.finish(); await s.settle();
  expect(s.accept).not.toHaveBeenCalled();
  expect(s.close).toHaveBeenCalledWith(peer, 'revoked', 'inbound');
});
