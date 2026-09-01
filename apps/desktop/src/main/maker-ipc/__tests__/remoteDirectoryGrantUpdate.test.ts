import { describe, expect, it, vi } from 'vitest';

import { excludeDirectoryGrantConflicts } from '../extraDirsValidator.js';
import {
  applyRemoteDirectoryGrantUpdate,
  isPersistedDirectoryGrantSubset,
  type RemoteDirectoryGrantAxis,
} from '../remoteDirectoryGrantUpdate.js';

function createState(extraDirs: string[] = [], writableDirs: string[] = []) {
  const db = { extraDirs: [...extraDirs], writableDirs: [...writableDirs] };
  const runtime = { extraDirs: [...extraDirs], writableDirs: [...writableDirs] };
  const setExtraDirs = vi.fn(async (dirs: string[]) => { runtime.extraDirs = [...dirs]; });
  const setWritableDirs = vi.fn(async (dirs: string[]) => { runtime.writableDirs = [...dirs]; });
  const persist = vi.fn(async (patch: { extraDirs?: string[]; writableDirs?: string[] }) => {
    if (patch.extraDirs) db.extraDirs = [...patch.extraDirs];
    if (patch.writableDirs) db.writableDirs = [...patch.writableDirs];
  });
  const terminate = vi.fn(async () => undefined);
  const update = (axis: RemoteDirectoryGrantAxis, dirs: string[]) =>
    applyRemoteDirectoryGrantUpdate(axis, dirs, { setExtraDirs, setWritableDirs }, {
      validate: async (requested) => ({ valid: [...requested], rejected: [] }),
      readExtraDirs: async () => [...db.extraDirs],
      readWritableDirs: async () => [...db.writableDirs],
      excludeConflicts: excludeDirectoryGrantConflicts,
      persist,
      terminate,
    });
  return { db, runtime, persist, terminate, setExtraDirs, setWritableDirs, update };
}

function createSessionSerializer() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => undefined).then(task);
    tail = run;
    return run;
  };
}

describe('remote directory grant atomic update', () => {
  it('accepts exact remote retention/revocation subsets and rejects additions', () => {
    expect(isPersistedDirectoryGrantSubset([], ['/shared', '/output'])).toBe(true);
    expect(isPersistedDirectoryGrantSubset(['/shared'], ['/shared', '/output'])).toBe(true);
    expect(isPersistedDirectoryGrantSubset(
      ['/shared', '/outside'],
      ['/shared', '/output'],
    )).toBe(false);
    expect(isPersistedDirectoryGrantSubset(['/outside'], [])).toBe(false);
  });

  it('restores runtime and persisted mirror when persistence fails', async () => {
    const state = createState(['/old-read'], ['/old-write']);
    let failNext = true;
    state.persist.mockImplementation(async (patch) => {
      if (patch.extraDirs) state.db.extraDirs = [...patch.extraDirs];
      if (patch.writableDirs) state.db.writableDirs = [...patch.writableDirs];
      if (failNext) {
        failNext = false;
        throw new Error('patched-session broadcast failed');
      }
    });

    await expect(state.update('writableDirs', ['/new-write']))
      .rejects.toThrow('patched-session broadcast failed');

    expect(state.setWritableDirs.mock.calls.map(([dirs]) => dirs)).toEqual([
      ['/new-write'],
      ['/old-write'],
    ]);
    expect(state.runtime.writableDirs).toEqual(['/old-write']);
    expect(state.db.writableDirs).toEqual(['/old-write']);
    expect(state.persist).toHaveBeenNthCalledWith(2, { writableDirs: ['/old-write'] });
    expect(state.terminate).not.toHaveBeenCalled();
  });

  it.each([
    ['read-first', 'extraDirs', ['/shared/specs'], 'writableDirs', ['/shared']] as const,
    ['write-first', 'writableDirs', ['/shared'], 'extraDirs', ['/shared/specs']] as const,
  ])('serializes concurrent %s overlapping grants against the latest full state', async (
    _label,
    firstAxis,
    firstDirs,
    secondAxis,
    secondDirs,
  ) => {
    const state = createState();
    const withSessionLock = createSessionSerializer();

    await Promise.all([
      withSessionLock(() => state.update(firstAxis, [...firstDirs])),
      withSessionLock(() => state.update(secondAxis, [...secondDirs])),
    ]);

    expect(state.db.extraDirs.length > 0 && state.db.writableDirs.length > 0).toBe(false);
    expect(state.runtime).toEqual(state.db);
  });

  it('persists a remote revoke as the new complete axis state', async () => {
    const state = createState(['/reference'], ['/shared']);

    await expect(state.update('writableDirs', [])).resolves.toMatchObject({ dirs: [] });

    expect(state.runtime.writableDirs).toEqual([]);
    expect(state.db).toEqual({ extraDirs: ['/reference'], writableDirs: [] });
  });

  it('surfaces rollback failure without hiding the original persistence error', async () => {
    const state = createState([], ['/old-write']);
    state.persist.mockRejectedValue(new Error('sqlite unavailable'));
    state.setWritableDirs
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('runtime rollback failed'));

    await expect(state.update('writableDirs', ['/new-write']))
      .rejects.toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({ message: 'sqlite unavailable' }),
          expect.objectContaining({ message: 'runtime rollback failed' }),
        ]),
      });
    expect(state.terminate).toHaveBeenCalledOnce();
  });

  it('runtime setExtraDirs 抛错则不持久化,避免假授权', async () => {
    const state = createState(['/old-read']);
    state.setExtraDirs.mockRejectedValueOnce(new Error('require app-server 0.144.6 or newer'));
    await expect(state.update('extraDirs', ['/library-root'])).rejects.toThrow(
      'require app-server 0.144.6 or newer',
    );
    expect(state.runtime.extraDirs).toEqual(['/old-read']);
    expect(state.db.extraDirs).toEqual(['/old-read']);
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.terminate).not.toHaveBeenCalled();
  });
});
