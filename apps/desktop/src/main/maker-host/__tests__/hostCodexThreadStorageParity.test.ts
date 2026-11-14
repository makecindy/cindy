// Unit: Desktop's real entry and Host's real storage binding share fixtures.
// cp18d: preserve original history/SQLite across logins; read-only means zero writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOwnerContext } from '../../ownerContext.js';
import { legacyCodexAccountHome } from '../codex-account-path.js';
import { CodexThreadLocations } from '../codex-thread-locations.js';
import * as desktop from '../codex-thread-storage.js';
import * as sessionState from '../../appSessionState.js';
import * as localSessions from '../codex-local-sessions.js';
import { getDesktopCodexHome } from '../codex-local-sessions.js';
import { createHostCodexThreadStorage } from '../../../../../host/src/agent/codex-thread-storage.js';
import { createHostCodexAccounts } from '../../../../../host/src/agent/provider-config.js';

const h = vi.hoisted(() => ({
  profile: '',
  owner: 'storage-owner' as string | null,
  generation: 1,
}));
vi.mock('electron', () => ({ app: { getPath: () => h.profile } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {} }) }));
vi.mock('../codex-account-auth.desktop.js', () => ({
  codexAccountHome: (id: string) => legacyCodexAccountHome(h.profile, h.owner, id),
}));
vi.mock('../../appSessionState.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../appSessionState.js')>()),
  getActiveAppSession: () => ({
    mode: h.owner ? 'cloud' : 'signed-out',
    dataOwnerId: h.owner,
    generation: h.generation,
  }),
  activeOwnerScopeKey: () => `${h.owner ?? 'none'}:${h.generation}`,
  isAppSessionBoundaryPending: () => false,
}));
const id = '019dcd5a-6e54-7960-95e0-aa68117a28d1';
let root = '';
function index() {
  return new CodexThreadLocations(
    path.join(legacyCodexAccountHome(h.profile, h.owner, 'thread-index'), 'locations'),
  );
}
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory()
          ? [
              [entry.name, 'directory'],
              ...Object.entries(snapshot(file)).map(([key, value]) => [
                path.join(entry.name, key),
                value,
              ]),
            ]
          : [[entry.name, fs.readFileSync(file).toString('base64')]];
      }),
  );
}
function rollout(home: string) {
  const file = path.join(home, 'sessions', `rollout-2026-11-14T00-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-11-14T00:00:00Z',
      payload: {
        id,
        timestamp: '2026-11-14T00:00:00Z',
        cwd: root,
        originator: 'codex_cli_rs',
        source: 'cli',
        model_provider: 'openai',
      },
    }) + '\n',
  );
  return file;
}
function state(home: string, file: string) {
  const db = new Database(path.join(home, 'state_1.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, model TEXT, reasoning_effort TEXT, thread_source TEXT, originator TEXT)',
  );
  db.prepare(
    "INSERT INTO threads (id,rollout_path,created_at,updated_at,source,cwd,title,approval_mode) VALUES (?,?,1,1,'cli',?,'Fixture','on-request')",
  ).run(id, file, root);
  db.close();
}
function host() {
  let closed = false;
  const owner = `${h.owner ?? 'none'}:${h.generation}`;
  const check = () => {
    if (closed || owner !== `${h.owner ?? 'none'}:${h.generation}`)
      throw Error('CODEX_RUNTIME_OWNER_CHANGED');
  };
  const accounts = createHostCodexAccounts(
    { profileDir: h.profile },
    { owner, check, closed: () => closed },
  );
  const binding = createHostCodexThreadStorage({ profileDir: h.profile, accounts, check });
  return {
    ...binding.deps,
    readCodexThreadStorageReadOnly: binding.readCodexThreadStorageReadOnly,
    close: () => {
      closed = true;
    },
  };
}
beforeEach(() => {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-storage-parity-')),
  );
  h.profile = path.join(root, 'profiles', 'CindyGlobal');
  h.owner = 'storage-owner';
  h.generation = 1;
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(h.profile, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(root, 'external'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  }))
    vi.stubEnv(key, value);
  configureOwnerContext({
    read: () => ({ dataOwnerId: h.owner, generation: h.generation, boundaryPending: false }),
    fallbackBaseDir: () => h.profile,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(['desktop', 'host'] as const)('canonical history through %s', (launcher) => {
  const binding = () => (launcher === 'desktop' ? desktop : host());
  it.each(['indexed', 'indexed-legacy', 'current', 'external', 'ownerless'] as const)(
    'locates %s history with zero writes and no scan outside the fixture',
    async (source) => {
      const home =
        source === 'external' ? process.env.CODEX_HOME! : path.join(h.profile, 'codex-home');
      const file = rollout(home);
      if (source === 'indexed') await index().record(id, file, path.join(root, 'separate-sqlite'));
      if (source === 'indexed-legacy') await index().record(id, file);
      if (source === 'ownerless') h.owner = null;
      const before = snapshot(root);
      const reads: string[] = [];
      const native = fs.realpathSync.native;
      const realpath = fs.realpathSync;
      const readdir = fsp.readdir;
      vi.spyOn(fs, 'realpathSync').mockImplementation(((...args: Parameters<typeof realpath>) => {
        reads.push(String(args[0]));
        return Reflect.apply(realpath, fs, args);
      }) as typeof realpath);
      Object.assign(fs.realpathSync, { native });
      vi.spyOn(fsp, 'readdir').mockImplementation(((...args: Parameters<typeof readdir>) => {
        reads.push(String(args[0]));
        return Reflect.apply(readdir, fsp, args);
      }) as typeof readdir);
      expect(await binding().readCodexThreadStorageReadOnly(id)).toEqual({
        historyHome: home,
        sqliteHome: source === 'indexed' ? path.join(root, 'separate-sqlite') : home,
        rolloutPath: file,
      });
      expect(snapshot(root)).toEqual(before);
      if (!source.startsWith('indexed')) expect(reads.length).toBeGreaterThan(0);
      for (const file of reads)
        expect(
          file === root || file.startsWith(root + path.sep),
          `outside fixture: ${file}; root=${root}`,
        ).toBe(true);
    },
  );
  it('prepares indexed history without changing its original SQLite home', async () => {
    const home = path.join(root, 'account-a');
    const file = rollout(home);
    const sqliteHome = path.join(root, 'original-state');
    await index().record(id, file, sqliteHome);
    const b = binding();
    expect(await b.resolveCodexThreadStorage(id)).toEqual({
      historyHome: home,
      sqliteHome,
      rolloutPath: file,
    });
    expect(await b.prepareCodexResumeSession(id)).toBe(file);
  });
  it('registers unindexed existing native history before resume', async () => {
    const home = path.join(h.profile, 'codex-home');
    const file = rollout(home);
    state(home, file);
    expect(await binding().resolveCodexThreadStorage(id)).toEqual({
      historyHome: home,
      sqliteHome: home,
      rolloutPath: file,
    });
    expect(await index().readStorage(id)).toEqual({
      historyHome: home,
      sqliteHome: home,
      rolloutPath: file,
    });
  });
  it('keeps an unmaterialized indexed path instead of an external copy', async () => {
    const home = path.join(root, 'account-a');
    const file = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    await index().record(id, file, home);
    rollout(process.env.CODEX_HOME!);
    const b = binding();
    expect(await b.resolveCodexThreadStorage(id)).toEqual({
      historyHome: home,
      sqliteHome: home,
      rolloutPath: file,
    });
    expect(await b.prepareCodexResumeSession(id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('returns no storage when legacy preparation finds no history', async () => {
    const b = binding();
    expect(await b.resolveCodexThreadStorage(id)).toBeUndefined();
    expect(await b.prepareCodexResumeSession(id)).toBeUndefined();
  });
  it.each(['invalid-index', 'directory-rollout', 'read-error'] as const)(
    'rejects %s without falling back to a different home',
    async (fault) => {
      const home = path.join(root, 'account-a');
      const file = rollout(home);
      await index().record(id, file, home);
      rollout(process.env.CODEX_HOME!);
      if (fault === 'invalid-index')
        fs.writeFileSync(
          path.join(
            legacyCodexAccountHome(h.profile, h.owner, 'thread-index'),
            'locations',
            id + '.json',
          ),
          '{broken',
        );
      else if (fault === 'directory-rollout') {
        fs.unlinkSync(file);
        fs.mkdirSync(file);
      } else
        vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(
          Object.assign(Error('fixture denied'), { code: 'EACCES' }),
        );
      await expect(binding().prepareCodexResumeSession(id)).rejects.toThrow();
    },
  );
  it('rejects a read whose owner changes while the index is being read', async () => {
    const file = rollout(path.join(root, 'account-a'));
    await index().record(id, file, root);
    const b = binding();
    const read = fsp.readFile;
    vi.spyOn(fsp, 'readFile').mockImplementationOnce((async (...args: Parameters<typeof read>) => {
      const result = await Reflect.apply(read, fsp, args);
      h.generation++;
      return result;
    }) as typeof read);
    await expect(b.readCodexThreadStorageReadOnly(id)).rejects.toThrow('owner changed');
  });
  it('rejects a location changed by another process during repair without overwriting it', async () => {
    const file = rollout(path.join(root, 'account-a'));
    await index().record(id, file, root);
    const indexFile = path.join(
      legacyCodexAccountHome(h.profile, h.owner, 'thread-index'),
      'locations',
      id + '.json',
    );
    const newer = {
      threadId: id,
      path: path.join(root, 'other', 'sessions', 'newer.jsonl'),
      sqliteHome: root,
    };
    const read = fsp.readFile;
    let indexReads = 0;
    vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof read>) => {
      if (String(args[0]) === indexFile && ++indexReads === 2)
        fs.writeFileSync(indexFile, JSON.stringify(newer));
      return Reflect.apply(read, fsp, args);
    }) as typeof read);
    await expect(binding().prepareCodexResumeSession(id)).rejects.toThrow('location changed');
    expect(JSON.parse(fs.readFileSync(indexFile, 'utf8'))).toEqual(newer);
  });
  it('records native paths in the current owner index and ignores missing paths', async () => {
    const b = binding();
    const home = path.join(root, 'account-a');
    const file = rollout(home);
    await b.recordCodexThreadLocation(id, home);
    expect(await index().readStorage(id)).toBeUndefined();
    await b.recordCodexThreadLocation(id, home, file);
    expect(await index().readStorage(id)).toEqual({
      historyHome: home,
      sqliteHome: home,
      rolloutPath: file,
    });
  });
  it('preserves ownerless writes as no-ops without opening a Host login path', async () => {
    h.owner = null;
    const b = binding();
    const home = path.join(h.profile, 'codex-home');
    const file = rollout(home);
    const before = snapshot(root);
    expect(await b.resolveCodexThreadStorage(id)).toBeUndefined();
    expect(await b.prepareCodexResumeSession(id)).toBeUndefined();
    await b.recordCodexThreadLocation(id, root, file);
    expect(await b.resolveCodexThreadStorage(id, { readOnly: true })).toEqual({
      historyHome: home,
      sqliteHome: home,
      rolloutPath: file,
    });
    expect(snapshot(root)).toEqual(before);
  });
});
it('reads Desktop profile changes at call time and refuses a closed Host runtime', async () => {
  expect(getDesktopCodexHome()).toBe(path.join(h.profile, 'codex-home'));
  const b = host();
  b.close();
  await expect(b.resolveCodexThreadStorage(id)).rejects.toThrow('CODEX_RUNTIME_OWNER_CHANGED');
  h.profile = path.join(root, 'other-profile');
  expect(getDesktopCodexHome()).toBe(path.join(h.profile, 'codex-home'));
});

// Binding contract: late module replacements must affect the next operation,
// as before extraction, rather than keep a value captured during module loading.
it('reads late Desktop exports when a storage operation runs', async () => {
  const session = sessionState.getActiveAppSession();
  vi.spyOn(sessionState, 'getActiveAppSession').mockReturnValue({
    ...session,
    mode: 'signed-out',
    dataOwnerId: null,
    generation: 2,
  });
  vi.spyOn(sessionState, 'activeOwnerScopeKey').mockReturnValue('signed-out:none:2');
  const expected = {
    historyHome: path.join(root, 'late-history'),
    sqliteHome: path.join(root, 'late-state'),
    rolloutPath: path.join(root, 'late-history', 'sessions', 'fixture.jsonl'),
  };
  const reader = vi
    .spyOn(localSessions, 'readCodexThreadStorageForArchiveAsync')
    .mockResolvedValue(expected);
  expect(await desktop.readCodexThreadStorageReadOnly(id)).toEqual(expected);
  expect(reader).toHaveBeenCalledExactlyOnceWith(id);
});
