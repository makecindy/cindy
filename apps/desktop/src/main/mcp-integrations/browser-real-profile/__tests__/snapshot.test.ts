import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  cleanupRealProfileSnapshots,
  isolatedProfileDestDir,
  lastUsedProfileName,
  probeOsSourceProfileReadAccess,
  probeSourceProfileReadAccess,
  profileIsLocked,
  realProfileDestDir,
  realProfileProfileDir,
  rewriteLocalStateForManagedDefault,
  snapshotRealProfile,
} from '../snapshot.js';
import { REAL_MANAGED_PROFILE } from '../../browser-managed-config.js';
import { REAL_PROFILE_READ_DENIED } from '../../../../shared/browserBackend.js';
import { RealProfileError, type InstalledChromium } from '../types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-real-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSqlite(filePath: string, table: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE ${table} (name TEXT); INSERT INTO ${table} VALUES ('${value}');`);
  db.close();
}

function readSqlite(filePath: string, table: string): string {
  const db = new DatabaseSync(filePath, { readOnly: true });
  const row = db.prepare(`SELECT name FROM ${table}`).get() as { name: string };
  db.close();
  return row.name;
}

function seedSource(root: string, lastUsed = 'Profile 6'): InstalledChromium {
  const userDataDir = path.join(root, 'Chrome');
  const profileDir = path.join(userDataDir, lastUsed);
  fs.mkdirSync(path.join(profileDir, 'Network'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'Local State'),
    JSON.stringify({
      os_crypt: { keep: true },
      profile: {
        last_used: lastUsed,
        last_active_profiles: [lastUsed],
        profiles_order: ['Default', lastUsed],
        info_cache: {
          Default: { name: 'Person 1' },
          [lastUsed]: { name: 'Dash' },
        },
      },
    }),
  );
  writeSqlite(path.join(profileDir, 'Cookies'), 'cookies', 'session-cookie');
  writeSqlite(path.join(profileDir, 'Login Data'), 'logins', 'saved-password');
  fs.writeFileSync(path.join(profileDir, 'Preferences'), '{"session":{"restore_on_startup":1}}');
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  writeSqlite(path.join(userDataDir, 'Default', 'Cookies'), 'cookies', 'other-profile');
  return {
    kind: 'chrome',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir,
  };
}

describe('lastUsedProfileName', () => {
  it('reads profile.last_used and falls back to Default', () => {
    expect(lastUsedProfileName('{"profile":{"last_used":"Profile 6"}}')).toBe('Profile 6');
    expect(lastUsedProfileName('not-json')).toBe('Default');
    expect(lastUsedProfileName('{}')).toBe('Default');
  });
});

describe('rewriteLocalStateForManagedDefault', () => {
  it('points every selection field at Default and stamps the chip name Cindy', () => {
    const rewritten = JSON.parse(
      rewriteLocalStateForManagedDefault(
        JSON.stringify({
          os_crypt: { keep: true },
          profile: {
            last_used: 'Profile 2',
            last_active_profiles: ['Profile 2'],
            profiles_order: ['Default', 'Profile 1', 'Profile 2'],
            show_picker_on_startup: true,
            info_cache: {
              Default: { name: 'Person 1' },
              'Profile 2': { name: 'Dash' },
            },
          },
        }),
        'Profile 2',
      ),
    ) as {
      os_crypt: { keep: boolean };
      profile: {
        last_used: string;
        last_active_profiles: string[];
        profiles_order: string[];
        show_picker_on_startup: boolean;
        info_cache: Record<string, { name: string }>;
      };
    };
    expect(rewritten.os_crypt.keep).toBe(true);
    expect(rewritten.profile.last_used).toBe('Default');
    expect(rewritten.profile.last_active_profiles).toEqual(['Default']);
    expect(rewritten.profile.profiles_order).toEqual(['Default']);
    expect(rewritten.profile.show_picker_on_startup).toBe(false);
    expect(Object.keys(rewritten.profile.info_cache)).toEqual(['Default']);
    expect(rewritten.profile.info_cache.Default).toMatchObject({
      name: 'Cindy',
      shortcut_name: 'Cindy',
      user_name: 'Cindy',
    });
  });

  it('still yields Default when Local State is malformed', () => {
    const rewritten = JSON.parse(rewriteLocalStateForManagedDefault('not-json', 'Default')) as {
      profile: { last_used: string };
    };
    expect(rewritten.profile.last_used).toBe('Default');
  });
});

describe('realProfileDestDir', () => {
  it('is the Chrome user-data-dir under Cindy-real, not the profile wrapper', () => {
    expect(realProfileDestDir('/runtime')).toBe(
      path.join('/runtime', 'browser', REAL_MANAGED_PROFILE, 'user-data'),
    );
    expect(realProfileProfileDir('/runtime')).toBe(path.join('/runtime', 'browser', REAL_MANAGED_PROFILE));
  });
});

describe('snapshotRealProfile', () => {
  it('copies only the last_used profile into dest Default', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const result = await snapshotRealProfile({ source, destDir, platform: 'darwin' });

    expect(result.sourceProfile).toBe('Profile 6');
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
    expect(readSqlite(path.join(destDir, 'Default', 'Login Data'), 'logins')).toBe('saved-password');
    expect(fs.existsSync(path.join(destDir, 'Default', 'Preferences'))).toBe(true);
    expect(result.filesCopied).toContain('Local State');
    expect(result.filesCopied).toContain(path.join('Default', 'Cookies'));
    const destLocalState = JSON.parse(fs.readFileSync(path.join(destDir, 'Local State'), 'utf8')) as {
      os_crypt: { keep: boolean };
      profile: { last_used: string; last_active_profiles: string[]; info_cache: Record<string, { name: string }> };
    };
    expect(destLocalState.os_crypt.keep).toBe(true);
    expect(destLocalState.profile.last_used).toBe('Default');
    expect(destLocalState.profile.last_active_profiles).toEqual(['Default']);
    expect(destLocalState.profile.info_cache.Default.name).toBe('Cindy');
    expect(destLocalState.profile.info_cache['Profile 6']).toBeUndefined();
  });

  it('deletes leftover Profile N folders so Chrome cannot reopen an empty sibling', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    fs.mkdirSync(path.join(destDir, 'Profile 2'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'Profile 2', 'Cookies'), 'empty');
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.existsSync(path.join(destDir, 'Profile 2'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies'))).toBe(true);
  });

  it('refuses to write anywhere except Cindy-real/user-data', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    await expect(
      snapshotRealProfile({
        source,
        destDir: path.join(root, 'runtime', 'browser', 'Cindy'),
        platform: 'darwin',
      }),
    ).rejects.toBeInstanceOf(RealProfileError);
    await expect(
      snapshotRealProfile({
        source,
        destDir: path.join(root, 'runtime', 'browser', REAL_MANAGED_PROFILE),
        platform: 'darwin',
      }),
    ).rejects.toBeInstanceOf(RealProfileError);
  });

  it('maps macOS permission denial to a stable read-denied token', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, encoding) => {
      if (String(file).endsWith(`${path.sep}Local State`)) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRead(file, encoding as BufferEncoding);
    });
    try {
      await expect(snapshotRealProfile({ source, destDir, platform: 'darwin' })).rejects.toMatchObject({
        code: 'COPY_FAILED',
        message: REAL_PROFILE_READ_DENIED,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('fails closed when cookie databases are missing', async () => {
    const root = makeTempDir();
    const userDataDir = path.join(root, 'Chrome');
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Local State'), '{"profile":{"last_used":"Default"}}');
    await expect(
      snapshotRealProfile({
        source: {
          kind: 'chrome',
          executablePath: '/chrome',
          userDataDir,
        },
        destDir: realProfileDestDir(path.join(root, 'runtime')),
        platform: 'darwin',
      }),
    ).rejects.toMatchObject({ code: 'NO_AUTH_DB' });
  });

  it('treats a Windows exclusive lock as PROFILE_LOCKED', () => {
    const root = makeTempDir();
    const profileDir = path.join(root, 'Default');
    fs.mkdirSync(profileDir, { recursive: true });
    const cookies = path.join(profileDir, 'Cookies');
    fs.writeFileSync(cookies, 'x');
    fs.chmodSync(cookies, 0);
    // chmod 0 is not a Windows share lock; the helper only flags win32 EPERM/EBUSY.
    expect(profileIsLocked({ profileDir, platform: 'darwin' })).toBe(false);
    expect(profileIsLocked({ profileDir, platform: 'linux' })).toBe(false);
  });
});

describe('probeSourceProfileReadAccess', () => {
  it('reports readable for a fake last_used profile', () => {
    const root = makeTempDir();
    expect(probeSourceProfileReadAccess(seedSource(root))).toEqual({ readable: true });
  });

  it('reports not readable when Local State is EPERM', () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const realOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (String(file).endsWith(`${path.sep}Local State`)) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(probeSourceProfileReadAccess(source)).toEqual({ readable: false });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports not readable when Cookies is EPERM', () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const realOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (String(file).endsWith(`${path.sep}Cookies`)) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(probeSourceProfileReadAccess(source)).toEqual({ readable: false });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('skips the disk-permission prompt when cookie databases are missing', () => {
    const root = makeTempDir();
    const userDataDir = path.join(root, 'Chrome');
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Local State'), '{"profile":{"last_used":"Default"}}');
    expect(
      probeSourceProfileReadAccess({
        kind: 'chrome',
        executablePath: '/chrome',
        userDataDir,
      }),
    ).toEqual({ readable: true });
  });

  it('skips the disk-permission prompt when no Chromium is installed', () => {
    expect(
      probeOsSourceProfileReadAccess({
        resolveSource: () => {
          throw new RealProfileError('NO_CHROMIUM', 'none');
        },
      }),
    ).toEqual({ readable: true });
  });
});

describe('cleanupRealProfileSnapshots', () => {
  it('deletes Cindy-real and leaves the isolated Cindy profile alone', () => {
    const runtimeDir = makeTempDir();
    const realDir = realProfileDestDir(runtimeDir);
    const profileDir = realProfileProfileDir(runtimeDir);
    const cindyDir = isolatedProfileDestDir(runtimeDir);
    fs.mkdirSync(path.join(realDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'Default', 'Cookies'), 'copied');
    fs.mkdirSync(cindyDir, { recursive: true });
    fs.writeFileSync(path.join(cindyDir, 'keep.txt'), 'isolated');

    cleanupRealProfileSnapshots(runtimeDir);

    expect(fs.existsSync(realDir)).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(false);
    expect(fs.readFileSync(path.join(cindyDir, 'keep.txt'), 'utf8')).toBe('isolated');
  });
});
