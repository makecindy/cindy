import { describe, expect, it, vi } from 'vitest';

import { collectDatabaseSizeWarningStatus } from '../database-size-warning-status';

describe('collectDatabaseSizeWarningStatus', () => {
  it('sums the database and SQLite sidecar files', () => {
    const statSync = vi.fn((filePath: string) => {
      const sizes: Record<string, number> = {
        '/db/main.sqlite': 10,
        '/db/main.sqlite-wal': 20,
        '/db/main.sqlite-shm': 30,
        '/db/main.sqlite-journal': 40,
      };
      if (!(filePath in sizes)) throw new Error('missing');
      return { isFile: () => true, size: sizes[filePath] };
    });

    expect(
      collectDatabaseSizeWarningStatus({
        getCurrentDbPath: () => '/db/main.sqlite',
        getCurrentUserId: () => null,
        resolveDbPathForUser: () => '/unused',
        statSync,
      }),
    ).toEqual({ databaseBytes: 100 });
    expect(statSync).toHaveBeenCalledTimes(4);
  });

  it('falls back to the resolved user database path', () => {
    const statSync = vi.fn(() => ({ isFile: () => true, size: 7 }));
    expect(
      collectDatabaseSizeWarningStatus({
        getCurrentDbPath: () => null,
        getCurrentUserId: () => 'user-1',
        resolveDbPathForUser: (userId) => `/db/${userId}.sqlite`,
        statSync,
      }),
    ).toEqual({ databaseBytes: 28 });
  });

  it('returns unknown when no candidate file is readable', () => {
    expect(
      collectDatabaseSizeWarningStatus({
        getCurrentDbPath: () => '/db/main.sqlite',
        getCurrentUserId: () => null,
        resolveDbPathForUser: () => '/unused',
        statSync: () => {
          throw new Error('inaccessible');
        },
      }),
    ).toEqual({ databaseBytes: null });
  });

  it('returns unknown when neither a path nor user is available', () => {
    expect(
      collectDatabaseSizeWarningStatus({
        getCurrentDbPath: () => null,
        getCurrentUserId: () => null,
        resolveDbPathForUser: () => '/unused',
        statSync: vi.fn(),
      }),
    ).toEqual({ databaseBytes: null });
  });
});
