import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerShareGuestPeer } from '@cindy/device-link';
import { createRemoteAgentHost } from '../../remote-agent/host/runHost';

const scope = vi.hoisted(() => ({ root: '', owner: '' }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => scope.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(scope.root, ...parts),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  scope.root = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-cleanup-'));
  scope.owner = scope.root;
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scope.root, { recursive: true, force: true }); });

// Production cleanup/store with fake persisted guest history: an EBUSY failure
// must survive a process restart without allowing a new membership to reuse it.
it.each([null, 2])('keeps pendingCleanup until deletion is confirmed (next approval=%s)', async joinedAt => {
  const peer = providerShareGuestPeer('fake-share', 'fake-member', 'fake-device');
  const digest = createHash('sha256').update(peer).digest('hex').slice(0, 32);
  const runsRoot = path.join(scope.root, 'remote-agent');
  const home = path.join(runsRoot, 'guest-homes', digest.slice(0, 16));
  const index = path.join(runsRoot, 'guest-sessions.json');
  const memberFile = path.join(scope.root, 'provider-share-standby-members.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'history'), 'old fake history');
  fs.writeFileSync(index, JSON.stringify({ [digest]: { controller: peer, hostSessionIds: [], nativeIds: ['fake-native'] } }));
  const purge = vi.fn(async () => {});
  const makeHost = () => createRemoteAgentHost({
    startHosted: async () => { throw new Error('no engine used in persisted cleanup'); },
    isAgentAvailable: () => true, isControllerAuthorized: () => false,
    captureOwner: () => scope.owner, isOwnerCurrent: owner => owner === scope.owner,
    runsRoot, purgeHostedTranscripts: purge,
  });
  let host = makeHost();
  let members = await import('../providerShareAvailabilityGuests');
  members.configureStandbyGuestCleanup(controller => host.purgeControllers(value => value === controller, true));
  try {
    await members.reconcileStandbyGuest(peer, 1);
    const remove = fsp.rm.bind(fsp);
    const failure = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === home) throw Object.assign(new Error('guest history busy'), { code: 'EBUSY' });
      await remove(target, options);
    });
    await expect(members.reconcileStandbyGuest(peer, joinedAt)).rejects.toThrow('guest history busy');
    expect(JSON.parse(fs.readFileSync(memberFile, 'utf8')).members[peer].pendingCleanup).toBe(true);
    expect(JSON.parse(fs.readFileSync(index, 'utf8'))[digest].nativeIds).toEqual(['fake-native']);
    expect(fs.existsSync(path.join(home, 'history'))).toBe(true);
    failure.mockRestore();
    await host.dispose();
    // reset-modules: simulate reopening the durable cleanup fence after process restart.
    vi.resetModules();
    host = makeHost();
    members = await import('../providerShareAvailabilityGuests');
    members.configureStandbyGuestCleanup(controller => host.purgeControllers(value => value === controller, true));
    expect(members.knownStandbyGuests()).toContain(peer);
    await members.reconcileStandbyGuest(peer, joinedAt);
    expect(fs.existsSync(home)).toBe(false);
    expect(JSON.parse(fs.readFileSync(index, 'utf8'))).toEqual({});
    expect(JSON.parse(fs.readFileSync(memberFile, 'utf8')).members[peer]).toEqual(joinedAt === null ? undefined : { joinedAt });
    expect(purge).toHaveBeenCalledWith([], ['fake-native']);
  } finally { await host.dispose(); }
});
