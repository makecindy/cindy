import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ root: '', id: 'owner-a', generation: 1, pending: false }));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(owner.root, owner.id, ...parts),
  activeOwnerScopeKey: () => `${owner.id}:${owner.generation}`,
  isAppSessionBoundaryPending: () => owner.pending,
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import * as locks from '../../device-link/crossProcessLock.js';
import {
  relocateGhostCindyPrefs, readGhostCindyOverrides, readGhostCindyInflightLimit,
  writeGhostCindyOverride, writeGhostCindyInflightLimit,
} from '../cindyPrefsStore.js';
import {
  relocateGhostErrandPrefs, readGhostErrandConfig, readGhostErrandSessionId,
  writeGhostErrandConfig, writeGhostErrandSessionId,
} from '../errandPrefsStore.js';
import { relocateGhostPickedDirs, isGhostPickedDir, recordGhostPickedDir } from '../pickGrantsStore.js';
import { relocateGhostUnread, readGhostUnread, markGhostUnread, clearGhostUnread } from '../ghostUnreadStore.js';
import { updateGhostPrefsForRelocation } from '../ghostPreferenceRelocation.js';

const from = 'helper';
const to = '_ns__acme__helper';
const resources = [
  {
    name: 'Cindy overrides and limits',
    file: 'ghost-cindy-prefs.json',
    relocate: relocateGhostCindyPrefs,
    source: { overrides: { [from]: { 'image.generate': 'model', future: { value: 1 } } }, inflightLimits: { [from]: 2 } },
    destination: { overrides: { [to]: { 'image.generate': 'model', future: { value: 1 } } }, inflightLimits: { [to]: 2 } },
    collision: { overrides: { [from]: { 'image.generate': 'model' } }, inflightLimits: { [to]: 3 } },
    invalid: { overrides: [] },
  },
  {
    name: 'errand configuration and all session keys',
    file: 'ghost-errand-prefs.json',
    relocate: relocateGhostErrandPrefs,
    source: {
      errand: { [from]: { permissionMode: 'acceptEdits', workingDir: '/project', future: true } },
      sessions: { [from]: 'shared-session', [`${from}#daily`]: 'daily-session', 'helper-other#daily': 'other-session' },
    },
    destination: {
      errand: { [to]: { permissionMode: 'acceptEdits', workingDir: '/project', future: true } },
      sessions: { [to]: 'shared-session', [`${to}#daily`]: 'daily-session', 'helper-other#daily': 'other-session' },
    },
    collision: { errand: { [from]: { permissionMode: 'auto' } }, sessions: { [`${to}#other`]: 'other-session' } },
    invalid: { sessions: null },
  },
  {
    name: 'picked directory grants',
    file: 'ghost-pick-grants.json',
    relocate: relocateGhostPickedDirs,
    source: { grants: { [from]: ['/project'], unrelated: ['/other'] } },
    destination: { grants: { [to]: ['/project'], unrelated: ['/other'] } },
    collision: { grants: { [from]: ['/project'], [to]: ['/project'] } },
    invalid: { grants: 'unreadable' },
  },
  {
    name: 'unread entries',
    file: 'ghost-unread.json',
    relocate: relocateGhostUnread,
    source: { entries: { [from]: { summary: 'new activity', at: 100, future: true } } },
    destination: { entries: { [to]: { summary: 'new activity', at: 100, future: true } } },
    collision: { entries: { [from]: { at: 100 }, [to]: { at: 100 } } },
    invalid: { entries: [] },
  },
];

function write(file: string, value: unknown, ownerId = owner.id): string {
  const target = path.join(owner.root, ownerId, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}

const writers = [
  {
    name: 'Cindy override', resource: resources[0],
    prime: () => readGhostCindyOverrides(from),
    write: (id: string) => writeGhostCindyOverride(id, 'image.generate', 'next-model'),
  },
  {
    name: 'Cindy limit', resource: resources[0],
    prime: () => readGhostCindyInflightLimit(from),
    write: (id: string) => writeGhostCindyInflightLimit(id, 4),
  },
  {
    name: 'errand config', resource: resources[1],
    prime: () => readGhostErrandConfig(from),
    write: (id: string) => writeGhostErrandConfig(id, { permissionMode: 'auto' }),
  },
  ...[undefined, 'daily'].map((sessionKey) => ({
    name: 'errand session ' + (sessionKey ?? 'shared'), resource: resources[1],
    prime: () => readGhostErrandSessionId(from, sessionKey),
    write: (id: string) => writeGhostErrandSessionId(id, 'next-session', sessionKey),
  })),
  {
    name: 'picked directory', resource: resources[2],
    prime: () => isGhostPickedDir(from, '/project'),
    write: (id: string) => recordGhostPickedDir(id, '/next-project'),
  },
  {
    name: 'unread mark', resource: resources[3],
    prime: () => readGhostUnread(from),
    write: (id: string) => markGhostUnread(id, 'next activity', 200),
  },
  {
    name: 'unread clear', resource: resources[3],
    prime: () => readGhostUnread(from),
    write: (id: string) => clearGhostUnread(id),
  },
];

describe.each(writers)('$name relocation write gate', ({ resource, prime, write: mutate }) => {
  it.each([from, 'another-plugin'])('blocks %s during actual lock release, even with unchanged mtime', async (id) => {
    const file = write(resource.file, resource.source);
    const time = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    prime();
    const rename = fs.promises.rename;
    let attempted = false;
    let failure: unknown;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(source) === file + '.lock' && String(destination).startsWith(file + '.lock.release-')) {
        attempted = true;
        fs.utimesSync(file, time, time);
        try { mutate(id); } catch (error) { failure = error; }
      }
      await rename(source, destination);
    });
    await resource.relocate(from, to);
    expect(attempted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/relocating/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(resource.destination);
    expect(() => mutate('another-plugin')).not.toThrow();
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).not.toContain('"' + from + '"');
    expect(contents).toContain('"' + to + '"');
  });

  it.each(['write', 'release'])('recovers after a %s failure and refreshes caches before unblocking', async (stage) => {
    const file = write(resource.file, resource.source);
    const time = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    prime();
    if (stage === 'write') {
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === file) throw new Error('simulated write failure');
        rename(source, destination);
      });
    } else {
      const withLock = locks.withCrossProcessLock;
      vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (target, options, task, signal) => {
        await withLock(target, options, task, signal);
        fs.utimesSync(file, time, time);
        throw new Error('simulated release failure');
      });
    }
    await expect(resource.relocate(from, to)).rejects.toThrow('simulated ' + stage + ' failure');
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(stage === 'write' ? resource.source : resource.destination);
    expect(() => mutate('another-plugin')).not.toThrow();
    if (stage === 'release') {
      const committed = fs.readFileSync(file, 'utf8');
      expect(committed).not.toContain('"' + from + '"');
      expect(committed).toContain('"' + to + '"');
    }
    await resource.relocate(from, to);
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).not.toContain('"' + from + '"');
    expect(contents).toContain('"' + to + '"');
  });

  it('allows another owner to write during release without changing the relocating owner', async () => {
    const file = write(resource.file, resource.source);
    const otherFile = write(resource.file, resource.source, 'owner-b');
    prime();
    const withLock = locks.withCrossProcessLock;
    let attempted = false;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (target, options, task, signal) => {
      const result = await withLock(target, options, task, signal);
      owner.id = 'owner-b';
      try {
        mutate(from);
        attempted = true;
      } finally {
        owner.id = 'owner-a';
      }
      return result;
    });
    await resource.relocate(from, to);
    expect(attempted).toBe(true);
    expect(fs.existsSync(otherFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(resource.destination);
    expect(() => mutate('another-plugin')).not.toThrow();
  });
});

it('keeps the gate through cache reset, rejects overlap, and clears it if the callback fails', async () => {
  write('ghost-cindy-prefs.json', resources[0].source);
  const reset = vi.fn(() => {
    expect(() => writeGhostCindyInflightLimit(from, 4)).toThrow(/relocating/);
    throw new Error('simulated cache reset failure');
  });
  const withLock = locks.withCrossProcessLock;
  vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (target, options, task, signal) => {
    await expect(relocateGhostCindyPrefs(from, to)).rejects.toThrow(/relocating/);
    expect(() => writeGhostCindyInflightLimit(from, 4)).toThrow(/relocating/);
    expect(() => writeGhostErrandSessionId(from, 'other-file-session')).not.toThrow();
    return withLock(target, options, task, signal);
  });
  await expect(updateGhostPrefsForRelocation('ghost-cindy-prefs.json', () => ({}), reset))
    .rejects.toThrow(/simulated cache reset failure/);
  expect(reset).toHaveBeenCalledOnce();
  expect(() => writeGhostCindyInflightLimit(from, 4)).not.toThrow();
  await relocateGhostCindyPrefs(from, to);
});

beforeEach(() => {
  owner.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-prefs-relocation-'));
  owner.id = 'owner-a';
  owner.generation = 1;
  owner.pending = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(owner.root, { recursive: true, force: true });
});

describe.each(resources)('$name relocation', (resource) => {
  it('moves the complete identity, preserves unknown fields, replays and reverses', async () => {
    const extra = { futureTopLevel: { enabled: true } };
    const file = write(resource.file, { ...resource.source, ...extra });
    await resource.relocate(from, to);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...resource.destination, ...extra });
    await resource.relocate(from, to);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...resource.destination, ...extra });
    await resource.relocate(to, from);
    await resource.relocate(to, from);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...resource.source, ...extra });
  });

  it('refuses a destination collision without merging identities or grants', async () => {
    const file = write(resource.file, resource.collision);
    const before = fs.readFileSync(file, 'utf8');
    await expect(resource.relocate(from, to)).rejects.toThrow(/collision/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it.each(['{invalid json', '[]'])('preserves an unreadable document: %s', async (contents) => {
    const file = write(resource.file, {});
    fs.writeFileSync(file, contents);
    await expect(resource.relocate(from, to)).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  });

  it('refuses a malformed identity map', async () => {
    const file = write(resource.file, resource.invalid);
    const before = fs.readFileSync(file, 'utf8');
    await expect(resource.relocate(from, to)).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not mutate another owner or recreate absent data', async () => {
    const otherFile = write(resource.file, resource.source, 'owner-b');
    const before = fs.readFileSync(otherFile, 'utf8');
    await resource.relocate(from, to);
    expect(fs.readFileSync(otherFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(owner.root, owner.id, resource.file))).toBe(false);
  });

  it('rejects owner generation changes while acquiring the write lock', async () => {
    const file = write(resource.file, resource.source);
    const before = fs.readFileSync(file, 'utf8');
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => {
      owner.generation += 1;
      return task({ held: true });
    });
    await expect(resource.relocate(from, to)).rejects.toThrow(/scope changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not write when the lock is unavailable', async () => {
    const file = write(resource.file, resource.source);
    const before = fs.readFileSync(file, 'utf8');
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) =>
      task({ held: false, reason: 'unavailable' }),
    );
    await expect(resource.relocate(from, to)).rejects.toThrow(/busy/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

it('moves directory authorization without letting a newly installed root inherit the grant', async () => {
  write('ghost-pick-grants.json', { grants: { [from]: ['/project'] } });
  expect(isGhostPickedDir(from, '/project')).toBe(true);
  await relocateGhostPickedDirs(from, to);
  expect(isGhostPickedDir(from, '/project')).toBe(false);
  expect(isGhostPickedDir(to, '/project')).toBe(true);
});

describe.each([
  {
    resource: resources[0],
    read: (id: string) => [readGhostCindyOverrides(id), readGhostCindyInflightLimit(id)],
    empty: [{}, null],
  },
  {
    resource: resources[1],
    read: (id: string) => [readGhostErrandConfig(id), readGhostErrandSessionId(id), readGhostErrandSessionId(id, 'daily')],
    empty: [{}, null, null],
  },
  {
    resource: resources[2],
    read: (id: string) => isGhostPickedDir(id, '/project'),
    empty: false,
  },
  {
    resource: resources[3],
    read: (id: string) => {
      const entry = readGhostUnread(id);
      return entry ? { summary: entry.summary, at: entry.at } : null;
    },
    empty: null,
  },
])('$resource.name live reader', ({ resource, read, empty }) => {
  it('does not expose the old identity even when the replacement has the same mtime', async () => {
    const file = write(resource.file, resource.source);
    const time = new Date('2026-09-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    const previous = read(from);
    expect(previous).not.toEqual(empty);
    await resource.relocate(from, to);
    fs.utimesSync(file, time, time);
    expect(read(from)).toEqual(empty);
    expect(read(to)).toEqual(previous);
    await resource.relocate(to, from);
    fs.utimesSync(file, time, time);
    expect(read(to)).toEqual(empty);
    expect(read(from)).toEqual(previous);
  });
});
