import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lockMock = vi.hoisted(() => ({ held: true }));
const pathMock = vi.hoisted(() => ({ homeDir: '', userDataDir: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => pathMock.homeDir },
    homedir: () => pathMock.homeDir,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => pathMock.userDataDir },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock('../device-link/crossProcessLock.js', () => ({
  withSecurityBoundaryLock: async (
    _lockPath: string,
    _options: unknown,
    task: (status: { held: true } | { held: false; reason: 'busy' }) => Promise<unknown>,
  ) => task(lockMock.held ? { held: true } : { held: false, reason: 'busy' }),
}));

import {
  __testing,
  isGhostSkillProjectionBoundaryStableForOwner,
  readGhostSkillProjectionBoundaryState,
  withGhostSkillProjectionOwnerCommit,
  withGhostSkillProjectionReadOnlyOwner,
  withGhostSkillProjectionReconcile,
} from '../authBoundaryQuarantine.js';

function readPersistedState(): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(pathMock.homeDir, '.cindy', 'ghost-skill-projection-boundary.json'),
      'utf8',
    ),
  );
}

beforeEach(() => {
  pathMock.homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-auth-boundary-'));
  pathMock.userDataDir = path.join(pathMock.homeDir, 'profile-user-data');
  lockMock.held = true;
  delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
  __testing.resetProcessQuarantine();
});

afterEach(() => {
  delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
  __testing.resetProcessQuarantine();
  vi.restoreAllMocks();
  fs.rmSync(pathMock.homeDir, { recursive: true, force: true });
});

describe('Ghost skill projection boundary state', () => {
  it('stores the machine-user projection marker beside the shared home skill roots', () => {
    expect(__testing.filePath()).toBe(
      path.join(pathMock.homeDir, '.cindy', 'ghost-skill-projection-boundary.json'),
    );
    expect(__testing.filePath()).not.toContain(pathMock.userDataDir);
  });

  it('accepts only versioned stable and pending records', () => {
    expect(
      __testing.normalizeRecord({
        version: 1,
        phase: 'stable',
        ownerId: 'owner-a',
        transitionId: 'transition-a',
        updatedAt: 123,
      }),
    ).toEqual({
      version: 1,
      phase: 'stable',
      ownerId: 'owner-a',
      transitionId: 'transition-a',
      updatedAt: 123,
    });
    expect(
      __testing.normalizeRecord({
        version: 1,
        phase: 'pending',
        previousOwnerId: 'owner-a',
        nextOwnerId: null,
        transitionId: 'transition-b',
        updatedAt: 124,
      }),
    ).toEqual({
      version: 1,
      phase: 'pending',
      previousOwnerId: 'owner-a',
      nextOwnerId: null,
      transitionId: 'transition-b',
        updatedAt: 124,
      });
    expect(
      __testing.normalizeRecord({
        version: 1,
        phase: 'quarantined',
        previousOwnerId: 'owner-a',
        nextOwnerId: 'owner-b',
        transitionId: 'transition-c',
        updatedAt: 125,
      }),
    ).toEqual({
      version: 1,
      phase: 'quarantined',
      previousOwnerId: 'owner-a',
      nextOwnerId: 'owner-b',
      transitionId: 'transition-c',
      updatedAt: 125,
    });
  });

  it.each([
    null,
    {},
    { version: 2, phase: 'stable', ownerId: 'owner-a', transitionId: 't', updatedAt: 1 },
    { version: 1, phase: 'stable', ownerId: '', transitionId: 't', updatedAt: 1 },
    { version: 1, phase: 'stable', ownerId: 'owner-a', transitionId: '', updatedAt: 1 },
    { version: 1, phase: 'stable', ownerId: 'owner-a', transitionId: 't', updatedAt: -1 },
    {
      version: 1,
      phase: 'pending',
      previousOwnerId: undefined,
      nextOwnerId: 'owner-b',
      transitionId: 't',
      updatedAt: 1,
    },
  ])('rejects malformed boundary data %#', (value) => {
    expect(__testing.normalizeRecord(value)).toBeNull();
  });

  it('keeps pending through the local commit and publishes stable afterward', async () => {
    const observations: string[] = [];

    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {
        const state = readPersistedState() as { phase: string; nextOwnerId: string };
        observations.push(`${state.phase}:${state.nextOwnerId}`);
      },
      commit: () => {
        const state = readPersistedState() as { phase: string; nextOwnerId: string };
        observations.push(`${state.phase}:${state.nextOwnerId}`);
      },
    });

    expect(observations).toEqual(['pending:owner-a', 'pending:owner-a']);
    expect(readGhostSkillProjectionBoundaryState()).toMatchObject({
      phase: 'stable',
      ownerId: 'owner-a',
    });
    expect(JSON.parse(fs.readFileSync(__testing.quarantinePath(), 'utf8'))).toMatchObject({
      phase: 'released',
    });
  });

  it('leaves a failed transition pending across a simulated restart', async () => {
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        prepareTransition: async () => {
          throw new Error('sweep failed');
        },
        commit: () => undefined,
      }),
    ).rejects.toThrow('sweep failed');

    expect(readGhostSkillProjectionBoundaryState()).toMatchObject({
      phase: 'pending',
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
    });
    await expect(
      withGhostSkillProjectionReconcile('owner-a', async () => 'unexpected'),
    ).rejects.toThrow('not stable');
  });

  it('publishes a durable quarantine before a transition can fail', async () => {
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        prepareTransition: async () => {
          expect(readPersistedState()).toMatchObject({ phase: 'pending' });
          expect(JSON.parse(fs.readFileSync(__testing.quarantinePath(), 'utf8'))).toMatchObject({
            phase: 'quarantined',
            previousOwnerId: null,
            nextOwnerId: 'owner-a',
          });
          throw new Error('teardown failed');
        },
        commit: () => undefined,
      }),
    ).rejects.toThrow('teardown failed');

    expect(readPersistedState()).toMatchObject({
      phase: 'pending',
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
    });
    expect(fs.existsSync(__testing.quarantinePath())).toBe(true);
    expect(isGhostSkillProjectionBoundaryStableForOwner('owner-a')).toBe(false);
    await expect(
      withGhostSkillProjectionReconcile('owner-a', async () => 'unexpected'),
    ).rejects.toThrow('not stable');
  });

  it('restores pending if the local owner commit fails after stable publication', async () => {
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        prepareTransition: async () => {},
        commit: () => {
          throw new Error('local commit failed');
        },
      }),
    ).rejects.toThrow('local commit failed');

    expect(readGhostSkillProjectionBoundaryState()).toMatchObject({
      phase: 'pending',
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
    });
  });

  it('requires a teardown hook whenever owner state is missing or mismatched', async () => {
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        commit: () => undefined,
      }),
    ).rejects.toThrow('requires a teardown hook');
    expect(fs.existsSync(__testing.filePath())).toBe(false);
  });

  it('rejects both owner commits and reconcile when the shared lock is unavailable', async () => {
    lockMock.held = false;
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        prepareTransition: async () => {},
        commit: () => undefined,
      }),
    ).rejects.toThrow('lock is busy or unavailable');
    await expect(
      withGhostSkillProjectionReconcile('owner-a', async () => undefined),
    ).rejects.toThrow('lock is busy or unavailable');
  });

  it('allows reconcile only for the exact durable stable owner', async () => {
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {},
      commit: () => undefined,
    });

    await expect(withGhostSkillProjectionReconcile('owner-a', async () => 42)).resolves.toBe(42);
    await expect(
      withGhostSkillProjectionReconcile('owner-b', async () => 42),
    ).rejects.toThrow('not stable');
  });

  it('fails closed when the durable quarantine record is malformed', async () => {
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {},
      commit: () => undefined,
    });
    fs.writeFileSync(__testing.quarantinePath(), '{not-json', 'utf8');

    expect(isGhostSkillProjectionBoundaryStableForOwner('owner-a')).toBe(false);
    await expect(
      withGhostSkillProjectionReconcile('owner-a', async () => 42),
    ).rejects.toThrow('quarantined');
  });

  it('skips teardown for an exact stable same-owner commit', async () => {
    const prepareTransition = vi.fn(async () => {});
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition,
      commit: () => undefined,
    });
    prepareTransition.mockClear();

    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: 'owner-a',
      nextOwnerId: 'owner-a',
      prepareTransition,
      commit: () => undefined,
    });

    expect(prepareTransition).not.toHaveBeenCalled();
  });

  it('repairs a durable mismatch even when the requested next owner already matches', async () => {
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {},
      commit: () => undefined,
    });
    const prepareTransition = vi.fn(async () => {});

    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: 'owner-b',
      nextOwnerId: 'owner-a',
      prepareTransition,
      commit: () => undefined,
    });

    expect(prepareTransition).toHaveBeenCalledWith({ ownerChanged: true });
  });

  it('lets a passive process join only the exact stable owner without mutation', async () => {
    await withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {},
      commit: () => undefined,
    });
    const before = fs.readFileSync(__testing.filePath(), 'utf8');
    process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';

    await expect(withGhostSkillProjectionReadOnlyOwner('owner-a', async () => 42)).resolves.toBe(42);
    await expect(
      withGhostSkillProjectionReadOnlyOwner('owner-b', async () => 42),
    ).rejects.toThrow('another active session');
    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: 'owner-a',
        nextOwnerId: 'owner-b',
        prepareTransition: async () => {},
        commit: () => undefined,
      }),
    ).rejects.toThrow('cannot publish');
    expect(fs.readFileSync(__testing.filePath(), 'utf8')).toBe(before);
  });

  it('serializes owner commit and reconcile inside one process', async () => {
    let releaseCommit!: () => void;
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitStarted = vi.fn();
    const reconcile = vi.fn(async () => 42);
    const ownerCommit = withGhostSkillProjectionOwnerCommit({
      previousOwnerId: null,
      nextOwnerId: 'owner-a',
      prepareTransition: async () => {},
      commit: async () => {
        commitStarted();
        await commitBlocked;
      },
    });
    await vi.waitFor(() => expect(commitStarted).toHaveBeenCalledOnce());
    const reconcileResult = withGhostSkillProjectionReconcile('owner-a', reconcile);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();

    releaseCommit();
    await ownerCommit;
    await expect(reconcileResult).resolves.toBe(42);
  });

  it('keeps a sticky process quarantine when stable publication is uncertain', async () => {
    const originalFsync = fs.fsyncSync.bind(fs);
    let fsyncCalls = 0;
    const stableFileFsyncCall = process.platform === 'win32' ? 3 : 5;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      fsyncCalls += 1;
      if (fsyncCalls === stableFileFsyncCall) throw new Error('stable fsync failed');
      return originalFsync(fd);
    });

    await expect(
      withGhostSkillProjectionOwnerCommit({
        previousOwnerId: null,
        nextOwnerId: 'owner-a',
        prepareTransition: async () => {},
        commit: () => undefined,
      }),
    ).rejects.toThrow('stable fsync failed');

    expect(isGhostSkillProjectionBoundaryStableForOwner('owner-a')).toBe(false);
    expect(fs.existsSync(__testing.quarantinePath())).toBe(true);
    await expect(
      withGhostSkillProjectionReconcile('owner-a', async () => undefined),
    ).rejects.toThrow('quarantined');
  });
});
