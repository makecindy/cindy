import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  cleanupCopiedLoginsThen,
  cleanupRealProfileSnapshots,
  isolatedProfileDestDir,
  lastUsedProfileName,
  mergeManagedPreferences,
  probeOsSourceProfileReadAccess,
  probeSourceProfileReadAccess,
  profileIsLocked,
  readCopiedLoginsCdpPort,
  realProfileDestDir,
  realProfileProfileDir,
  rememberCopiedLoginsCdpPort,
  rewriteLocalStateForManagedDefault,
  snapshotRealProfile,
} from '../snapshot.js';
import { REAL_MANAGED_PROFILE } from '../../browser-managed-config.js';
import { REAL_PROFILE_READ_DENIED } from '../../../../shared/browserBackend.js';
import { RealProfileError, type InstalledChromium } from '../types.js';

describe('node:sqlite main-process packaging', () => {
  it('keeps node:sqlite external so Vite does not stub it as a browser module', () => {
    const viteConfig = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', '..', 'vite.main.config.ts'),
      'utf8',
    );
    expect(viteConfig).toContain("'node:sqlite'");
  });
});

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

function leftoverStagingNames(destDir: string): string[] {
  const parent = path.dirname(destDir);
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent)
    .filter((name) => name.startsWith(`${path.basename(destDir)}.staging`));
}

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

function setCookieEncryptionPrefix(filePath: string, prefix: 'v10' | 'v20'): void {
  const db = new DatabaseSync(filePath);
  const encryptedHex = Buffer.from(`${prefix}-encrypted-cookie`).toString('hex');
  db.exec(
    `ALTER TABLE cookies ADD COLUMN encrypted_value BLOB; UPDATE cookies SET encrypted_value = x'${encryptedHex}';`,
  );
  db.close();
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
    const rewritten = JSON.parse(rewriteLocalStateForManagedDefault('not-json')) as {
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
    expect(realProfileProfileDir('/runtime')).toBe(
      path.join('/runtime', 'browser', REAL_MANAGED_PROFILE),
    );
  });
});

describe('copied browser identity isolation', () => {
  it.each([null, 'not-json', '{}'])(
    'removes old browser identity even when source Preferences is %s',
    (sourceRaw) => {
      const destRaw = JSON.stringify({
        account_info: [{ account_id: 'fake-account' }],
        google: { services: { account_id: 'fake-account' } },
        sync: { has_setup_completed: true },
        signin: { allowed: true },
        extensions: { install_signature: 'agent' },
      });
      expect(JSON.parse(mergeManagedPreferences(sourceRaw, destRaw))).toEqual({
        signin: { allowed: false, allowed_on_next_startup: false },
        extensions: { install_signature: 'agent' },
      });
    },
  );

  it('does not inherit browser-device or Google account state from Local State', () => {
    const source = JSON.stringify({
      os_crypt: { encrypted_key: 'fake-encrypted-key' },
      signin: { scoped_device_id: 'fake-device' },
      profile: { info_cache: { Default: { gaia_id: 'fake-gaia-id' } } },
    });
    const rewritten = JSON.parse(rewriteLocalStateForManagedDefault(source));
    expect(rewritten.os_crypt).toEqual({ encrypted_key: 'fake-encrypted-key' });
    expect(rewritten.signin).toBeUndefined();
    expect(rewritten.profile.info_cache.Default.gaia_id).toBeUndefined();
  });
});

describe('snapshotRealProfile', () => {
  // Regression: a copied Google cookie jar plus Chrome identity metadata can
  // activate DICE without matching refresh tokens, causing a network logout.
  // The public snapshot must preserve website cookies/autofill while excluding
  // browser identity and server-revocable OAuth tokens, including on refresh.
  // Existing fixtures only covered anonymous profiles. Unit tier, fake data.
  it('preserves website logins without cloning Chrome identity or OAuth tokens', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const sourceProfile = path.join(source.userDataDir, 'Profile 6');
    const sourceLocalState = path.join(source.userDataDir, 'Local State');
    const localState = JSON.parse(fs.readFileSync(sourceLocalState, 'utf8'));
    localState.signin = { scoped_device_id: 'fake-browser-device' };
    localState.profile.info_cache['Profile 6'] = {
      name: 'Personal', gaia_id: 'fake-gaia-id', is_consented_primary_account: true,
    };
    fs.writeFileSync(sourceLocalState, JSON.stringify(localState));
    const sourcePrefs = path.join(sourceProfile, 'Preferences');
    fs.writeFileSync(sourcePrefs, JSON.stringify({
      account_info: [{ account_id: 'fake-account' }],
      account_values: { 'fake-account': {} },
      account_tracker_service_last_update: '123',
      google: { services: { account_id: 'fake-account' } },
      signin: { allowed: true, allowed_on_next_startup: true },
      sync: { has_setup_completed: true },
      gaia_cookie: { changed_time: '123' },
      session: { restore_on_startup: 1 },
    }));
    const webData = path.join(sourceProfile, 'Web Data');
    const db = new DatabaseSync(webData);
    db.exec(`
      CREATE TABLE token_service (service TEXT PRIMARY KEY, encrypted_token BLOB);
      INSERT INTO token_service VALUES ('AccountId-fake', x'66616b65');
      CREATE TABLE autofill (name TEXT);
      INSERT INTO autofill VALUES ('saved-autofill');
    `);
    db.close();
    const sourceBefore = [sourceLocalState, sourcePrefs, webData].map((file) => fs.readFileSync(file));
    const destDir = realProfileDestDir(path.join(root, 'runtime'));

    // Both an initial snapshot and a refresh of an existing signed-in copy
    // must be safe before the next Chrome launch.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await snapshotRealProfile({ source, destDir, platform: 'darwin' });
      const copiedState = JSON.parse(fs.readFileSync(path.join(destDir, 'Local State'), 'utf8'));
      expect(copiedState.os_crypt).toEqual({ keep: true });
      expect(copiedState.signin).toBeUndefined();
      expect(copiedState.profile.info_cache.Default.gaia_id).toBeUndefined();
      expect(copiedState.profile.info_cache.Default.is_consented_primary_account).not.toBe(true);
      const copiedPrefs = JSON.parse(fs.readFileSync(path.join(destDir, 'Default', 'Preferences'), 'utf8'));
      expect(copiedPrefs).toEqual({
        session: { restore_on_startup: 1 },
        signin: { allowed: false, allowed_on_next_startup: false },
      });
      expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
      expect(readSqlite(path.join(destDir, 'Default', 'Web Data'), 'autofill')).toBe('saved-autofill');
      const copiedDb = new DatabaseSync(path.join(destDir, 'Default', 'Web Data'), { readOnly: true });
      expect(copiedDb.prepare('SELECT COUNT(*) AS count FROM token_service').get()?.count).toBe(0);
      copiedDb.close();

      // Simulate identity left by an older Cindy build, never by a real login.
      fs.writeFileSync(path.join(destDir, 'Default', 'Preferences'), fs.readFileSync(sourcePrefs));
    }
    for (const [index, file] of [sourceLocalState, sourcePrefs, webData].entries()) {
      expect(fs.readFileSync(file)).toEqual(sourceBefore[index]);
    }
  });

  it('discards Web Data if browser tokens cannot be removed before launch', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const db = new DatabaseSync(path.join(source.userDataDir, 'Profile 6', 'Web Data'));
    db.exec(`
      CREATE TABLE token_service (service TEXT PRIMARY KEY, encrypted_token BLOB);
      INSERT INTO token_service VALUES ('AccountId-fake', x'66616b65');
      CREATE TRIGGER cannot_delete_token BEFORE DELETE ON token_service
        BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END;
    `);
    db.close();
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const destWebData = path.join(destDir, 'Default', 'Web Data');
    writeSqlite(destWebData, 'token_service', 'old-fake-token');
    fs.writeFileSync(`${destWebData}-wal`, 'stale-wal');

    const result = await snapshotRealProfile({ source, destDir, platform: 'darwin' });

    expect(result.warnings).toEqual([{ database: 'Web Data', reason: 'copy-failed' }]);
    expect(result.filesCopied).not.toContain(path.join('Default', 'Web Data'));
    expect(fs.existsSync(destWebData)).toBe(false);
    expect(fs.existsSync(`${destWebData}-wal`)).toBe(false);
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
    expect(leftoverStagingNames(destDir)).toEqual([]);
  });

  it('copies only the last_used profile into dest Default', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const result = await snapshotRealProfile({ source, destDir, platform: 'darwin' });

    expect(result.sourceProfile).toBe('Profile 6');
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
    expect(readSqlite(path.join(destDir, 'Default', 'Login Data'), 'logins')).toBe(
      'saved-password',
    );
    expect(fs.existsSync(path.join(destDir, 'Default', 'Preferences'))).toBe(true);
    expect(result.filesCopied).toContain('Local State');
    expect(result.filesCopied).toContain(path.join('Default', 'Cookies'));
    const destLocalState = JSON.parse(
      fs.readFileSync(path.join(destDir, 'Local State'), 'utf8'),
    ) as {
      os_crypt: { keep: boolean };
      profile: {
        last_used: string;
        last_active_profiles: string[];
        info_cache: Record<string, { name: string }>;
      };
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

  it('drops leftover site credential stores but keeps HTTP/GPU caches', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const destDefault = path.join(destDir, 'Default');
    fs.mkdirSync(path.join(destDefault, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(destDefault, 'Local Storage', 'leveldb'), 'old-ls');
    fs.mkdirSync(path.join(destDefault, 'IndexedDB'), { recursive: true });
    fs.writeFileSync(path.join(destDefault, 'IndexedDB', 'site'), 'old-idb');
    fs.mkdirSync(path.join(destDefault, 'Service Worker'), { recursive: true });
    fs.writeFileSync(path.join(destDefault, 'Service Worker', 'script'), 'old-sw');
    fs.mkdirSync(path.join(destDefault, 'GPUCache'), { recursive: true });
    fs.writeFileSync(path.join(destDefault, 'GPUCache', 'data'), 'gpu');
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.existsSync(path.join(destDefault, 'Local Storage'))).toBe(false);
    expect(fs.existsSync(path.join(destDefault, 'IndexedDB', 'site'))).toBe(false);
    expect(fs.existsSync(path.join(destDefault, 'Service Worker'))).toBe(false);
    expect(fs.readFileSync(path.join(destDefault, 'GPUCache', 'data'), 'utf8')).toBe('gpu');
    expect(fs.existsSync(path.join(destDefault, 'Cookies'))).toBe(true);
    expect(leftoverStagingNames(destDir)).toEqual([]);
  });

  it('keeps extensions installed in the agent browser across re-snapshots', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const destDefault = path.join(destDir, 'Default');
    const extensionId = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
    const extensionIdb = `chrome-extension_${extensionId}_0.indexeddb.leveldb`;
    fs.mkdirSync(path.join(destDefault, 'Extensions', extensionId, '8.0.0_0'), { recursive: true });
    fs.writeFileSync(
      path.join(destDefault, 'Extensions', extensionId, '8.0.0_0', 'manifest.json'),
      '{}',
    );
    fs.writeFileSync(
      path.join(destDefault, 'Secure Preferences'),
      '{"extensions":{"settings":{}}}',
    );
    fs.mkdirSync(path.join(destDefault, 'Local Extension Settings', extensionId), {
      recursive: true,
    });
    fs.mkdirSync(path.join(destDefault, 'IndexedDB', extensionIdb), { recursive: true });
    fs.mkdirSync(path.join(destDefault, 'IndexedDB', 'https_example.com_0.indexeddb.leveldb'), {
      recursive: true,
    });
    const extensionCookieFiles = [
      'Extension Cookies',
      'Extension Cookies-wal',
      'Extension Cookies-journal',
    ];
    for (const name of extensionCookieFiles) {
      fs.writeFileSync(path.join(destDefault, name), name);
    }
    fs.mkdirSync(path.join(destDefault, 'DNR Extension Rules', extensionId), { recursive: true });

    await snapshotRealProfile({ source, destDir, platform: 'darwin' });

    for (const name of extensionCookieFiles) {
      expect(fs.readFileSync(path.join(destDefault, name), 'utf8'), name).toBe(name);
    }
    expect(fs.existsSync(path.join(destDefault, 'DNR Extension Rules', extensionId))).toBe(true);

    expect(
      fs.existsSync(path.join(destDefault, 'Extensions', extensionId, '8.0.0_0', 'manifest.json')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(destDefault, 'Secure Preferences'), 'utf8')).toBe(
      '{"extensions":{"settings":{}}}',
    );
    expect(fs.existsSync(path.join(destDefault, 'Local Extension Settings', extensionId))).toBe(
      true,
    );
    expect(fs.readdirSync(path.join(destDefault, 'IndexedDB'))).toEqual([extensionIdb]);
  });

  it('refreshes Preferences from the source but keeps the agent browser extensions subtree', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const sourcePrefs = path.join(source.userDataDir, 'Profile 6', 'Preferences');
    fs.writeFileSync(
      sourcePrefs,
      JSON.stringify({ session: { restore_on_startup: 1 }, extensions: { commands: 'source' } }),
    );
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    const destPrefs = path.join(destDir, 'Default', 'Preferences');

    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(JSON.parse(fs.readFileSync(destPrefs, 'utf8'))).toEqual({
      session: { restore_on_startup: 1 },
      signin: { allowed: false, allowed_on_next_startup: false },
    });

    fs.writeFileSync(
      destPrefs,
      JSON.stringify({
        session: { restore_on_startup: 5 },
        extensions: { install_signature: 'agent' },
      }),
    );
    fs.writeFileSync(
      sourcePrefs,
      JSON.stringify({ session: { restore_on_startup: 4 }, extensions: { commands: 'source' } }),
    );
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(JSON.parse(fs.readFileSync(destPrefs, 'utf8'))).toEqual({
      session: { restore_on_startup: 4 },
      extensions: { install_signature: 'agent' },
      signin: { allowed: false, allowed_on_next_startup: false },
    });
  });

  it('creates safe Preferences when neither source nor dest is valid', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    fs.writeFileSync(path.join(source.userDataDir, 'Profile 6', 'Preferences'), 'not-json');
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(JSON.parse(fs.readFileSync(path.join(destDir, 'Default', 'Preferences'), 'utf8'))).toEqual({
      signin: { allowed: false, allowed_on_next_startup: false },
    });
  });

  it('keeps a valid dest Preferences when the source one is malformed or missing', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    const destPrefs = path.join(destDir, 'Default', 'Preferences');
    const agentPrefs = JSON.stringify({
      extensions: { install_signature: 'agent' },
      signin: { allowed: false, allowed_on_next_startup: false },
    });
    fs.writeFileSync(destPrefs, agentPrefs);
    const sourcePrefs = path.join(source.userDataDir, 'Profile 6', 'Preferences');
    fs.writeFileSync(sourcePrefs, '{"trunc');

    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.readFileSync(destPrefs, 'utf8')).toBe(agentPrefs);

    fs.rmSync(sourcePrefs);
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.readFileSync(destPrefs, 'utf8')).toBe(agentPrefs);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the snapshot when leftover site IndexedDB cannot be enumerated',
    async () => {
      const root = makeTempDir();
      const source = seedSource(root);
      const destDir = realProfileDestDir(path.join(root, 'runtime'));
      const indexedDb = path.join(destDir, 'Default', 'IndexedDB');
      fs.mkdirSync(path.join(indexedDb, 'https_example.com_0.indexeddb.leveldb'), {
        recursive: true,
      });
      fs.chmodSync(indexedDb, 0o000);
      try {
        await expect(
          snapshotRealProfile({ source, destDir, platform: 'darwin' }),
        ).rejects.toThrow();
        expect(fs.existsSync(path.join(destDir, '.cindy-real-profile-complete'))).toBe(false);
      } finally {
        fs.chmodSync(indexedDb, 0o700);
      }
    },
  );

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
      await expect(
        snapshotRealProfile({ source, destDir, platform: 'darwin' }),
      ).rejects.toMatchObject({
        code: 'REAL_PROFILE_READ_DENIED',
        message: REAL_PROFILE_READ_DENIED,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('replaces dest auth files and deletes leftovers absent from this snapshot', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.existsSync(path.join(destDir, 'Default', 'Login Data'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies'))).toBe(true);

    const nextRoot = makeTempDir();
    const userDataDir = path.join(nextRoot, 'Chrome');
    const profileDir = path.join(userDataDir, 'Default');
    fs.mkdirSync(path.join(profileDir, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'Local State'), '{"profile":{"last_used":"Default"}}');
    writeSqlite(path.join(profileDir, 'Network', 'Cookies'), 'cookies', 'network-cookie');

    await snapshotRealProfile({
      source: {
        kind: 'chrome',
        executablePath: '/chrome',
        userDataDir,
      },
      destDir,
      platform: 'darwin',
    });

    expect(readSqlite(path.join(destDir, 'Default', 'Network', 'Cookies'), 'cookies')).toBe(
      'network-cookie',
    );
    expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'Default', 'Login Data'))).toBe(false);
  });

  it('leaves dest unchanged when a later sqlite backup fails', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    fs.mkdirSync(path.join(destDir, 'Default'), { recursive: true });
    writeSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies', 'stale-cookie');
    writeSqlite(path.join(destDir, 'Default', 'Login Data'), 'logins', 'stale-login');
    // The first cookie DB copies; failure of another required cookie DB must
    // still leave the previous complete snapshot untouched.
    fs.writeFileSync(
      path.join(source.userDataDir, 'Profile 6', 'Network', 'Cookies'),
      'not-a-sqlite-db',
    );

    await expect(
      snapshotRealProfile({ source, destDir, platform: 'darwin' }),
    ).rejects.toMatchObject({
      code: 'COPY_FAILED',
    });
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('stale-cookie');
    expect(readSqlite(path.join(destDir, 'Default', 'Login Data'), 'logins')).toBe('stale-login');
    expect(fs.existsSync(`${destDir}.staging`)).toBe(false);
    expect(leftoverStagingNames(destDir)).toEqual([]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)(
    'copies cookies while optional stores have exclusive SQLite locks (%s)',
    async (platform) => {
      const source = seedSource(makeTempDir());
      const profile = path.join(source.userDataDir, 'Profile 6');
      const destDir = realProfileDestDir(path.join(makeTempDir(), 'runtime'));
      const names = ['Login Data', 'Login Data For Account', 'Web Data'] as const;
      writeSqlite(path.join(profile, names[1]), 'logins', 'account-password');
      writeSqlite(path.join(profile, names[2]), 'autofill', 'saved-form');
      await snapshotRealProfile({ source, destDir, platform });
      const locks = names.map((name) => {
        const db = new DatabaseSync(path.join(profile, name));
        db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
        return db;
      });
      try {
        const result = await snapshotRealProfile({ source, destDir, platform });
        expect(result.warnings).toEqual(names.map((database) => ({ database, reason: 'locked' })));
        expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe(
          'session-cookie',
        );
        for (const name of names) {
          // Never leave an old password store from a previous snapshot behind.
          expect(fs.existsSync(path.join(destDir, 'Default', name))).toBe(false);
          expect(result.filesCopied).not.toContain(path.join('Default', name));
        }
        expect(leftoverStagingNames(destDir)).toEqual([]);
      } finally {
        for (const db of locks) db.close();
      }
      const retry = await snapshotRealProfile({ source, destDir, platform });
      expect(retry.warnings).toBeUndefined();
      expect(readSqlite(path.join(destDir, 'Default', 'Login Data'), 'logins')).toBe(
        'saved-password',
      );
    },
  );

  it('skips a corrupt password database with a controlled warning', async () => {
    const source = seedSource(makeTempDir());
    const destDir = realProfileDestDir(path.join(makeTempDir(), 'runtime'));
    fs.writeFileSync(path.join(source.userDataDir, 'Profile 6', 'Login Data'), 'not-a-sqlite-db');
    const result = await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(result.warnings).toEqual([{ database: 'Login Data', reason: 'copy-failed' }]);
    expect(fs.existsSync(path.join(destDir, 'Default', 'Login Data'))).toBe(false);
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
  });

  it.each(['darwin', 'win32'] as const)(
    'skips optional read denial without exposing paths (%s)',
    async (platform) => {
      const source = seedSource(makeTempDir());
      const destDir = realProfileDestDir(path.join(makeTempDir(), 'runtime'));
      const realOpen = fs.openSync.bind(fs);
      vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
        if (String(file) === path.join(source.userDataDir, 'Profile 6', 'Login Data')) {
          throw Object.assign(new Error(`Access denied: ${file}`), { code: 'EACCES' });
        }
        return realOpen(file, flags, mode);
      }) as typeof fs.openSync);
      try {
        const result = await snapshotRealProfile({ source, destDir, platform });
        expect(result.warnings).toEqual([{ database: 'Login Data', reason: 'permission-denied' }]);
        expect(fs.existsSync(path.join(destDir, 'Default', 'Login Data'))).toBe(false);
        expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe(
          'session-cookie',
        );
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('fails closed with a lock reason when the required cookie DB is locked', async () => {
    const source = seedSource(makeTempDir());
    const destDir = realProfileDestDir(path.join(makeTempDir(), 'runtime'));
    const db = new DatabaseSync(path.join(source.userDataDir, 'Profile 6', 'Cookies'));
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    const realExec = DatabaseSync.prototype.exec;
    // Keep the real exclusive-lock conflict, but do not spend the production
    // busy timeout waiting for a lock this test only releases in finally.
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'BEGIN') realExec.call(this, 'PRAGMA busy_timeout = 0');
      return realExec.call(this, sql);
    });
    try {
      await expect(
        snapshotRealProfile({ source, destDir, platform: 'darwin' }),
      ).rejects.toMatchObject({ code: 'PROFILE_LOCKED' });
      expect(fs.existsSync(destDir)).toBe(false);
      expect(leftoverStagingNames(destDir)).toEqual([]);
    } finally {
      exec.mockRestore();
      db.close();
    }
  }, 10_000);

  it('uses sqlite backup so dest has no WAL sidecar from the source', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const cookies = path.join(source.userDataDir, 'Profile 6', 'Cookies');
    fs.writeFileSync(`${cookies}-wal`, 'wal-bytes');
    fs.writeFileSync(`${cookies}-shm`, 'shm-bytes');
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    await snapshotRealProfile({ source, destDir, platform: 'darwin' });
    expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies-wal'))).toBe(false);
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
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

  it('rejects Windows v20 cookies before publishing a new snapshot', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    setCookieEncryptionPrefix(path.join(source.userDataDir, 'Profile 6', 'Cookies'), 'v20');
    const destDir = realProfileDestDir(path.join(root, 'runtime'));
    fs.mkdirSync(path.join(destDir, 'Default'), { recursive: true });
    writeSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies', 'existing-snapshot');

    await expect(snapshotRealProfile({ source, destDir, platform: 'win32' })).rejects.toMatchObject(
      {
        code: 'APP_BOUND_ENCRYPTION_UNSUPPORTED',
      },
    );

    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe(
      'existing-snapshot',
    );
    expect(leftoverStagingNames(destDir)).toEqual([]);
  });

  it('keeps the Windows snapshot path for legacy v10 cookies', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    setCookieEncryptionPrefix(path.join(source.userDataDir, 'Profile 6', 'Cookies'), 'v10');
    const destDir = realProfileDestDir(path.join(root, 'runtime'));

    await expect(
      snapshotRealProfile({ source, destDir, platform: 'win32' }),
    ).resolves.toMatchObject({
      sourceKind: 'chrome',
      sourceProfile: 'Profile 6',
    });
    expect(readSqlite(path.join(destDir, 'Default', 'Cookies'), 'cookies')).toBe('session-cookie');
  });

  it('does not apply the App-Bound Encryption gate outside Windows', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    setCookieEncryptionPrefix(path.join(source.userDataDir, 'Profile 6', 'Cookies'), 'v20');
    const destDir = realProfileDestDir(path.join(root, 'runtime'));

    await expect(
      snapshotRealProfile({ source, destDir, platform: 'darwin' }),
    ).resolves.toMatchObject({
      sourceKind: 'chrome',
    });
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
  it('does not require optional password read permission before launching', () => {
    const source = seedSource(makeTempDir());
    const realOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (String(file).endsWith(`${path.sep}Login Data`)) {
        throw Object.assign(new Error('private source path'), { code: 'EACCES' });
      }
      return realOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(probeSourceProfileReadAccess(source)).toEqual({ readable: true });
    } finally {
      vi.restoreAllMocks();
    }
  });

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

describe('copied logins CDP port marker', () => {
  it('round-trips a relocated port on the complete marker', async () => {
    const root = makeTempDir();
    const source = seedSource(root);
    const runtimeDir = path.join(root, 'runtime');
    await snapshotRealProfile({
      source,
      destDir: realProfileDestDir(runtimeDir),
      platform: 'darwin',
    });
    expect(readCopiedLoginsCdpPort(runtimeDir)).toBeNull();
    rememberCopiedLoginsCdpPort(runtimeDir, 18801);
    expect(readCopiedLoginsCdpPort(runtimeDir)).toBe(18801);
  });

  it('ignores missing markers and ports outside the managed range', () => {
    expect(readCopiedLoginsCdpPort('')).toBeNull();
    const runtimeDir = path.join(makeTempDir(), 'runtime');
    rememberCopiedLoginsCdpPort(runtimeDir, 18801);
    expect(readCopiedLoginsCdpPort(runtimeDir)).toBeNull();
    rememberCopiedLoginsCdpPort(runtimeDir, 80);
    expect(readCopiedLoginsCdpPort(runtimeDir)).toBeNull();
  });
});

describe('cleanupCopiedLoginsThen', () => {
  it('runs persist only after Cindy-real is gone', () => {
    const runtimeDir = makeTempDir();
    const profileDir = realProfileProfileDir(runtimeDir);
    fs.mkdirSync(path.join(profileDir, 'user-data'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'user-data', 'Cookies'), 'copied');
    const order: string[] = [];
    cleanupCopiedLoginsThen(runtimeDir, () => {
      order.push('persist');
      expect(fs.existsSync(profileDir)).toBe(false);
    });
    expect(order).toEqual(['persist']);
  });

  it('does not persist when deleting the copy fails', () => {
    const runtimeDir = makeTempDir();
    const profileDir = realProfileProfileDir(runtimeDir);
    fs.mkdirSync(profileDir, { recursive: true });
    const persist = vi.fn();
    const realRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation(((target, opts) => {
      if (path.resolve(String(target)) === path.resolve(profileDir)) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return realRm(target, opts);
    }) as typeof fs.rmSync);
    try {
      expect(() => cleanupCopiedLoginsThen(runtimeDir, persist)).toThrow(/busy/);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
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

  it('uses bounded retries for transient Windows directory locks', () => {
    const runtimeDir = makeTempDir();
    const profileDir = realProfileProfileDir(runtimeDir);
    fs.mkdirSync(profileDir, { recursive: true });
    const rm = vi.spyOn(fs, 'rmSync');
    try {
      cleanupRealProfileSnapshots(runtimeDir);
      expect(rm).toHaveBeenCalledWith(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } finally {
      rm.mockRestore();
    }
  });
});
