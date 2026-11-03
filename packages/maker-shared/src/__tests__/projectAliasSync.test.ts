import { describe, expect, it, vi } from 'vitest';
// Regression: desktop project renames were never mirrored to controllers.
// Production entry: createProjectAliasMirror + host identity parsing; the old project-order
// tests did not cover alias deletion, identity separation or a rename during an in-flight read.
// Minimal failure: an old read resolves after a changed notification; unit tier uses deferred
// promises so it verifies the published name and account fencing without real timers or IO.
import {
  createProjectAliasMirror,
  parseHostProjectAliasesSnapshot,
  projectAliasComparisonKey,
  resolveProjectAliasForSessions,
  type HostProjectAliasesSnapshot,
  type ProjectAliasSessionLike,
} from '../projectAliasSync';

function snapshot(alias: string | null, owner = 'owner-a'): HostProjectAliasesSnapshot {
  return {
    aliases: alias === null ? [] : [{ projectKey: 'local:/repo', alias }],
    platform: 'darwin',
    ownerStamp: { dataOwnerId: owner, ownerGeneration: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function drainMicrotasks() {
  for (let count = 0; count < 12; count += 1) await Promise.resolve();
}

function session(overrides: Partial<ProjectAliasSessionLike> = {}): ProjectAliasSessionLike {
  return { workingDir: '/repo', deviceLinkDeviceId: 'dev-a', ...overrides };
}

describe('project alias identity and snapshot parsing', () => {
  it.each([
    ['local:C:\\Work\\App\\', 'win32', 'local:c:/work/app'],
    ['local:C:/', 'win32', 'local:c:/'],
    ['local:\\\\?\\C:\\Work\\App', 'win32', 'local:c:/work/app'],
    ['local:\\\\Server\\Share\\App', 'win32', 'local://server/share/app'],
    ['local:\\\\?\\UNC\\Server\\Share\\App', 'win32', 'local://server/share/app'],
    ['local://Server/Share/App/', 'win32', 'local://server/share/app'],
    ['local:C:/Work/App', 'linux', 'local:C:/Work/App'],
    ['local:/repo/Foo\\Bar', 'linux', 'local:/repo/Foo\\Bar'],
    ['local:/repo/Foo\\', 'linux', 'local:/repo/Foo\\'],
    ['local:/repo/weird\\.worktrees/name', 'linux', 'local:/repo/weird\\.worktrees/name'],
    ['local:/repo/.cindy-worktrees/branch/src', 'darwin', 'local:/repo'],
    ['local:/repo/.xdt-worktrees/branch', 'linux', 'local:/repo'],
    ['local:/repo/.worktrees/branch', 'linux', 'local:/repo'],
    ['local:/repo/.claude/worktrees/branch', 'linux', 'local:/repo'],
    ['remote:ssh%2Fone:C:/Work/App', 'win32', 'remote:ssh%2Fone:C:/Work/App'],
    ['remote:ssh%3Aone:/repo/.worktrees/branch', 'darwin', 'remote:ssh%3Aone:/repo'],
  ])('normalizes comparison identity without changing source identity: %s', (key, platform, expected) => {
    expect(projectAliasComparisonKey(key, platform)).toBe(expected);
  });

  it.each(['device:other:/repo', 'remote:bad%:/repo', 'remote::/repo', 'remote:ssh', 'local:', 'local:   ', '/repo'])('rejects a non-host or invalid identity: %s', (key) => {
    expect(projectAliasComparisonKey(key, 'darwin')).toBeNull();
  });

  it('retains newest-first duplicates while rejecting invalid rows and controller-local overrides', () => {
    expect(parseHostProjectAliasesSnapshot({
      platform: 'win32',
      aliases: [
        { projectKey: 'local:C:/Repo', alias: ' Newest ' },
        { projectKey: 'local:c:/repo', alias: 'Older' },
        { projectKey: 'remote:ssh:/repo', alias: 'SSH' },
        { projectKey: 'device:other:/repo', alias: 'Private override' },
        { projectKey: 'local:/empty', alias: ' ' },
        { projectKey: 'local:/long', alias: 'a'.repeat(81) },
        null,
        { projectKey: 1, alias: 'invalid' },
      ],
    })).toEqual({
      platform: 'win32',
      aliases: [
        { projectKey: 'local:C:/Repo', alias: 'Newest' },
        { projectKey: 'remote:ssh:/repo', alias: 'SSH' },
      ],
    });
  });

  it.each([null, [], {}, { aliases: [], platform: 1 }, { aliases: [], platform: 'darwin', ownerStamp: {} }])('does not turn a malformed response into an authoritative deletion', (raw) => {
    expect(parseHostProjectAliasesSnapshot(raw)).toBeNull();
  });

  it('looks up full host identity on the physical source without borrowing canonical device aliases', () => {
    const snapshots = new Map([
      ['dev-a', {
        ...snapshot('Local'),
        aliases: [
          { projectKey: 'local:/repo', alias: 'Local' },
          { projectKey: 'remote:ssh-a:/repo', alias: 'SSH A' },
          { projectKey: 'remote:ssh-b:/repo', alias: 'SSH B' },
        ],
      }],
      ['dev-b', snapshot('Other machine')],
    ]);
    expect(resolveProjectAliasForSessions([session()], snapshots)).toBe('Local');
    expect(resolveProjectAliasForSessions([session({ remoteHostId: 'ssh-a' })], snapshots)).toBe('SSH A');
    expect(resolveProjectAliasForSessions([session({ remoteHostId: 'ssh-b' })], snapshots)).toBe('SSH B');
    expect(resolveProjectAliasForSessions([session({ deviceLinkDeviceId: 'dev-b' })], snapshots)).toBe('Other machine');
    const historical = { ...session({ deviceLinkDeviceId: 'old-device' }), canonicalDeviceId: 'dev-a' };
    expect(resolveProjectAliasForSessions([historical], snapshots)).toBeNull();
    expect(resolveProjectAliasForSessions([session({ deviceLinkDeviceId: undefined })], snapshots, 'dev-a')).toBe('Local');
  });

  it('preserves default titles for mixed local/SSH or physical-device groups in either session order', () => {
    const snapshots = new Map([['dev-a', snapshot('Local')], ['dev-b', snapshot('Other')]]);
    const local = session();
    for (const different of [session({ remoteHostId: 'ssh' }), session({ deviceLinkDeviceId: 'dev-b' })]) {
      expect(resolveProjectAliasForSessions([local, different], snapshots)).toBeNull();
      expect(resolveProjectAliasForSessions([different, local], snapshots)).toBeNull();
    }
    expect(resolveProjectAliasForSessions([local, session({ workingDir: '/repo/.worktrees/topic' })], snapshots)).toBe('Local');
  });
});

describe('project alias mirror lifecycle', () => {
  it('limits reads across more than six devices while continuing queued work as slots free', async () => {
    const mirror = createProjectAliasMirror();
    const responses = Array.from({ length: 9 }, () => deferred<unknown>());
    let active = 0;
    let maxActive = 0;
    const readers = responses.map((response) => vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await response.promise;
      } finally {
        active -= 1;
      }
    }));
    const pending = readers.map((read, index) => mirror.refresh(`dev-${index}`, read));
    await drainMicrotasks();
    expect(readers.map((read) => read.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(active).toBe(6);
    responses[0].resolve(snapshot('First complete'));
    await drainMicrotasks();
    expect(readers[6]).toHaveBeenCalledTimes(1);
    expect(readers[7]).not.toHaveBeenCalled();
    expect(active).toBe(6);
    responses.forEach((response, index) => response.resolve(snapshot(`Name ${index}`)));
    await Promise.all(pending);
    expect(maxActive).toBe(6);
    expect(mirror.getSnapshot().size).toBe(9);
  });

  it.each(['clear', 'remove', 'suspend'] as const)('%s skips obsolete queued reads while issued reads keep occupying their slots', async (operation) => {
    const mirror = createProjectAliasMirror();
    const issued = Array.from({ length: 6 }, () => deferred<unknown>());
    const pendingIssued = issued.map((response, index) => mirror.refresh(`running-${index}`, () => response.promise));
    const obsoleteRead = vi.fn(async () => snapshot('Never send this'));
    const obsoletePending = mirror.refresh('queued-obsolete', obsoleteRead);
    await drainMicrotasks();
    expect(obsoleteRead).not.toHaveBeenCalled();
    if (operation === 'clear') mirror.clear();
    else mirror[operation]('queued-obsolete');
    const replacement = deferred<unknown>();
    const replacementRead = vi.fn(() => replacement.promise);
    const replacementPending = mirror.refresh('queued-replacement', replacementRead);
    await drainMicrotasks();
    expect(obsoleteRead).not.toHaveBeenCalled();
    expect(replacementRead).not.toHaveBeenCalled();
    issued[0].resolve(snapshot('Issued read settled'));
    await drainMicrotasks();
    expect(obsoleteRead).not.toHaveBeenCalled();
    expect(replacementRead).toHaveBeenCalledTimes(1);
    replacement.resolve(snapshot('Replacement'));
    issued.forEach((response) => response.resolve(snapshot('Issued')));
    await Promise.all([...pendingIssued, obsoletePending, replacementPending]);
    expect(mirror.getSnapshot().has('queued-obsolete')).toBe(false);
    expect(mirror.getSnapshot().get('queued-replacement')).toEqual(snapshot('Replacement'));
  });

  it('does not send a queued read after its account or connection authority expires without a store reset', async () => {
    const mirror = createProjectAliasMirror();
    const issued = Array.from({ length: 6 }, () => deferred<unknown>());
    const pendingIssued = issued.map((response, index) => mirror.refresh(`running-${index}`, () => response.promise));
    let authorized = true;
    const read = vi.fn(async () => snapshot('Must not read after authority expired'));
    const pending = mirror.refresh('queued', read, () => authorized);
    await drainMicrotasks();
    expect(read).not.toHaveBeenCalled();
    authorized = false;
    issued.forEach((response) => response.resolve(snapshot('Issued')));
    await Promise.all([...pendingIssued, pending]);
    expect(read).not.toHaveBeenCalled();
    expect(mirror.getSnapshot().has('queued')).toBe(false);
  });

  it('shares concurrent reads for one device while allowing another device to finish independently', async () => {
    const mirror = createProjectAliasMirror();
    const first = deferred<unknown>();
    const read = vi.fn(() => first.promise);
    const pending = mirror.refresh('dev-a', read);
    const duplicate = mirror.refresh('dev-a', read);
    await mirror.refresh('dev-b', async () => snapshot('B'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(mirror.getSnapshot().get('dev-b')).toEqual(snapshot('B'));
    expect(mirror.getSnapshot().has('dev-a')).toBe(false);
    first.resolve(snapshot('A'));
    await Promise.all([pending, duplicate]);
    expect(mirror.getSnapshot().get('dev-a')).toEqual(snapshot('A'));
  });

  it('discards a pre-change read and coalesces several invalidations into one fresh read', async () => {
    const mirror = createProjectAliasMirror();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const seen: string[] = [];
    mirror.subscribe(() => { seen.push(mirror.getSnapshot().get('dev-a')?.aliases[0]?.alias ?? ''); });
    const pending = mirror.refresh('dev-a', read);
    await drainMicrotasks();
    const invalidated = [mirror.invalidate('dev-a', read), mirror.invalidate('dev-a', read)];
    first.resolve(snapshot('Stale'));
    await drainMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
    expect(mirror.getSnapshot().has('dev-a')).toBe(false);
    second.resolve(snapshot('Renamed'));
    await Promise.all([pending, ...invalidated]);
    expect(seen).toEqual(['Renamed']);
  });

  it('also reruns when the invalidated read failed', async () => {
    const mirror = createProjectAliasMirror();
    const first = deferred<unknown>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot('Fresh'));
    const pending = mirror.refresh('dev-a', read);
    await drainMicrotasks();
    mirror.invalidate('dev-a', read);
    first.reject(new Error('old connection failed'));
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(mirror.getSnapshot().get('dev-a')).toEqual(snapshot('Fresh'));
  });

  it('applies deletions as whole-device replacement without clearing other devices', async () => {
    const mirror = createProjectAliasMirror();
    await mirror.refresh('dev-a', async () => snapshot('A'));
    await mirror.refresh('dev-b', async () => snapshot('B'));
    await mirror.invalidate('dev-a', async () => snapshot(null));
    expect(mirror.getSnapshot().get('dev-a')?.aliases).toEqual([]);
    expect(mirror.getSnapshot().get('dev-b')?.aliases[0]?.alias).toBe('B');
  });

  it.each([
    { code: 'CHANNEL_NOT_ALLOWED' },
    new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old host'),
  ])('falls back for an explicitly unsupported host channel', async (error) => {
    const mirror = createProjectAliasMirror();
    await mirror.refresh('dev-a', async () => snapshot('Known'));
    await mirror.refresh('dev-a', async () => { throw error; });
    expect(mirror.getSnapshot().get('dev-a')?.aliases).toEqual([]);
  });

  it.each([new Error('timeout'), { code: 'NOT_CONNECTED' }, { code: 'REMOTE_DISABLED' }])('keeps known names on transient/authorization failure instead of treating it as deletion', async (error) => {
    const mirror = createProjectAliasMirror();
    await mirror.refresh('dev-a', async () => snapshot('Known'));
    const before = mirror.getSnapshot();
    await mirror.refresh('dev-a', async () => { throw error; });
    expect(mirror.getSnapshot()).toBe(before);
  });

  it('keeps a known snapshot on malformed data and avoids redundant notifications', async () => {
    const mirror = createProjectAliasMirror();
    const listener = vi.fn();
    const off = mirror.subscribe(listener);
    await mirror.refresh('dev-a', async () => snapshot('Known'));
    await mirror.refresh('dev-a', async () => snapshot('Known'));
    await mirror.refresh('dev-a', async () => ({ platform: 'darwin' }));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await mirror.refresh('dev-a', async () => snapshot('New'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(['clear', 'remove', 'suspend'] as const)('%s fences old responses and does not let their completion clear a new pending read', async (operation) => {
    const mirror = createProjectAliasMirror();
    await mirror.refresh('dev-a', async () => snapshot('Known'));
    const old = deferred<unknown>();
    const oldPending = mirror.refresh('dev-a', () => old.promise);
    await drainMicrotasks();
    if (operation === 'clear') mirror.clear();
    else mirror[operation]('dev-a');
    expect(mirror.getSnapshot().has('dev-a')).toBe(operation === 'suspend');
    const fresh = deferred<unknown>();
    const readFresh = vi.fn(() => fresh.promise);
    const freshPending = mirror.refresh('dev-a', readFresh);
    await drainMicrotasks();
    old.resolve(snapshot('Stale'));
    await oldPending;
    const joined = mirror.refresh('dev-a', readFresh);
    await drainMicrotasks();
    expect(readFresh).toHaveBeenCalledTimes(1);
    fresh.resolve(snapshot('Fresh'));
    await Promise.all([freshPending, joined]);
    expect(mirror.getSnapshot().get('dev-a')).toEqual(snapshot('Fresh'));
  });

  it('does not recreate a removed device when its old read fails as unsupported', async () => {
    const mirror = createProjectAliasMirror();
    const old = deferred<unknown>();
    const pending = mirror.refresh('dev-a', () => old.promise);
    await drainMicrotasks();
    mirror.remove('dev-a');
    old.reject({ code: 'CHANNEL_NOT_ALLOWED' });
    await pending;
    expect(mirror.getSnapshot().has('dev-a')).toBe(false);
  });

  it('rejects old-account responses and does not trust a snapshot from another owner', async () => {
    const mirror = createProjectAliasMirror();
    let currentOwner = 'owner-a';
    const old = deferred<unknown>();
    const pending = mirror.refresh('dev-a', () => old.promise, (value) => currentOwner === 'owner-a'
      && (value === undefined || value.ownerStamp?.dataOwnerId === currentOwner));
    await drainMicrotasks();
    currentOwner = 'owner-b';
    old.resolve(snapshot('Private old name'));
    await pending;
    expect(mirror.getSnapshot().has('dev-a')).toBe(false);
    await mirror.refresh('dev-a', async () => snapshot('Wrong owner'), (value) => value === undefined || value.ownerStamp?.dataOwnerId === currentOwner);
    expect(mirror.getSnapshot().has('dev-a')).toBe(false);
    await mirror.refresh('dev-a', async () => snapshot('B name', 'owner-b'), (value) => value === undefined || value.ownerStamp?.dataOwnerId === currentOwner);
    expect(mirror.getSnapshot().get('dev-a')).toEqual(snapshot('B name', 'owner-b'));
  });

  it.each(['synchronous', 'microtask'] as const)('does not lose a change received from a %s subscriber during snapshot delivery', async (delivery) => {
    const mirror = createProjectAliasMirror();
    const read = vi.fn().mockResolvedValueOnce(snapshot('Before')).mockResolvedValueOnce(snapshot('After'));
    let invalidated: Promise<void> | undefined;
    let changed = false;
    mirror.subscribe(() => {
      if (changed) return;
      changed = true;
      const invalidate = () => { invalidated = mirror.invalidate('dev-a', read); };
      if (delivery === 'synchronous') invalidate();
      else queueMicrotask(invalidate);
    });
    await mirror.refresh('dev-a', read);
    await drainMicrotasks();
    await invalidated;
    expect(read).toHaveBeenCalledTimes(2);
    expect(mirror.getSnapshot().get('dev-a')).toEqual(snapshot('After'));
  });
});
