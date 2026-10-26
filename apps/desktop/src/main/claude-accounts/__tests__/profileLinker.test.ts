/**
 * Profile linker against the real file system (temp dirs): real junctions / directory
 * symlinks and real hard links. Nothing here touches the user's ~/.claude.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ClaudeProfileError,
  NEVER_LINKED_FILES,
  SHARED_DIRS,
  SHARED_FILES,
  assertProfileDirSafe,
  assertSafeEntryName,
  inspectProfile,
  prepareProfile,
  removeProfile,
  syncMirrorBack,
  type LinkerFs,
} from '../profileLinker.js';

let root: string;
let master: string;
let accountsRoot: string;
let profile: string;

const T_OLD = new Date('2026-01-01T00:00:00Z');
const T_NEW = new Date('2026-06-01T00:00:00Z');

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

async function conflicts(): Promise<string[]> {
  const dir = path.join(profile, '.cindy', 'conflicts');
  return (await exists(dir)) ? (await readdir(dir)).sort() : [];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-acct-linker-'));
  master = path.join(root, 'home', '.claude');
  accountsRoot = path.join(root, 'userData', 'claude-accounts');
  profile = path.join(accountsRoot, 'acct_test0001');
  await mkdir(path.join(master, 'projects', 'proj-a'), { recursive: true });
  await writeFile(path.join(master, 'projects', 'proj-a', 'old.jsonl'), '{"type":"user"}\n');
  await writeFile(path.join(master, 'CLAUDE.md'), '# master memory\n');
  await writeFile(path.join(master, 'settings.json'), '{"theme":"dark"}\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('guards', () => {
  it('never allows credentials or account state to be linked', () => {
    expect(NEVER_LINKED_FILES).toEqual(['.credentials.json', '.claude.json']);
    for (const name of NEVER_LINKED_FILES) {
      expect([...SHARED_DIRS, ...SHARED_FILES]).not.toContain(name);
      expect(() => assertSafeEntryName(name)).toThrow(ClaudeProfileError);
    }
    expect(() => assertSafeEntryName('CLAUDE.md')).not.toThrow();
  });

  it('accepts only generated account dirs strictly inside the accounts root', () => {
    expect(() => assertProfileDirSafe(profile, { accountsRoot, masterDir: master })).not.toThrow();
    const bad = [
      accountsRoot,
      path.join(accountsRoot, 'not-an-id'),
      path.join(accountsRoot, '..', 'acct_test0001'),
      path.join(root, 'elsewhere', 'acct_test0001'),
      'relative/acct_test0001',
    ];
    for (const dir of bad) {
      expect(() => assertProfileDirSafe(dir, { accountsRoot, masterDir: master }), dir).toThrow(ClaudeProfileError);
    }
    // A profile can never live inside the master config dir.
    expect(() =>
      assertProfileDirSafe(path.join(master, 'acct_test0001'), { accountsRoot: master, masterDir: master }),
    ).toThrow(ClaudeProfileError);
  });
});

describe('prepareProfile', () => {
  it('links every shared dir and file on a fresh profile', async () => {
    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(report.mode).toBe('linked');
    for (const name of SHARED_DIRS) {
      const link = path.join(profile, name);
      expect((await lstat(link)).isSymbolicLink(), name).toBe(true);
      // Missing master dirs are created so every link has a real target.
      expect((await stat(path.join(master, name))).isDirectory(), name).toBe(true);
    }
    for (const name of SHARED_FILES) {
      expect(await sameFile(path.join(profile, name), path.join(master, name)), name).toBe(true);
    }
    expect(report.entries.every((e) => e.status === 'created')).toBe(true);
  });

  it('makes writes through the profile land in the master', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    await writeFile(path.join(profile, 'projects', 'proj-a', 'new.jsonl'), '{"type":"assistant"}\n');
    await writeFile(path.join(profile, 'CLAUDE.md'), '# master memory\n- learned on account B\n');
    expect(await readFile(path.join(master, 'projects', 'proj-a', 'new.jsonl'), 'utf8')).toContain('assistant');
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toContain('learned on account B');
    // And the profile sees what the master already had.
    expect(await readFile(path.join(profile, 'projects', 'proj-a', 'old.jsonl'), 'utf8')).toContain('user');
  });

  it('is idempotent', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    const second = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(second.entries.every((e) => e.status === 'ok')).toBe(true);
    expect(await conflicts()).toEqual([]);
  });

  it('merges a real dir the CLI created before linking, keeping clashes aside', async () => {
    await mkdir(path.join(profile, 'projects', 'proj-a'), { recursive: true });
    await mkdir(path.join(profile, 'projects', 'proj-b'), { recursive: true });
    await writeFile(path.join(profile, 'projects', 'proj-b', 's.jsonl'), 'b');
    await writeFile(path.join(profile, 'projects', 'proj-a', 'old.jsonl'), 'different content');
    await writeFile(path.join(profile, 'projects', 'proj-a', 'same.jsonl'), 'x');
    await writeFile(path.join(master, 'projects', 'proj-a', 'same.jsonl'), 'x');

    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(report.entries.find((e) => e.name === 'projects')?.status).toBe('merged');
    expect((await lstat(path.join(profile, 'projects'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(master, 'projects', 'proj-b', 's.jsonl'), 'utf8')).toBe('b');
    // The master's version is never overwritten by a merge.
    expect(await readFile(path.join(master, 'projects', 'proj-a', 'old.jsonl'), 'utf8')).toContain('user');
    const kept = await conflicts();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^projects__proj-a__old\.jsonl\.\d+\.profile$/);
  });

  it('re-points a link that targets the wrong dir', async () => {
    const wrong = path.join(root, 'wrong');
    await mkdir(wrong, { recursive: true });
    await mkdir(profile, { recursive: true });
    await symlink(wrong, path.join(profile, 'skills'), 'junction');
    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(report.entries.find((e) => e.name === 'skills')?.status).toBe('repaired');
    await writeFile(path.join(profile, 'skills', 'probe.md'), 'p');
    expect(await exists(path.join(master, 'skills', 'probe.md'))).toBe(true);
    expect(await exists(path.join(wrong, 'probe.md'))).toBe(false);
  });

  it('repairs a hard link broken by an atomic rewrite: newer profile content wins', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    const tmp = path.join(profile, 'CLAUDE.md.tmp');
    await writeFile(tmp, '# rewritten on account B\n');
    await rename(tmp, path.join(profile, 'CLAUDE.md'));
    await utimes(path.join(master, 'CLAUDE.md'), T_OLD, T_OLD);
    await utimes(path.join(profile, 'CLAUDE.md'), T_NEW, T_NEW);

    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(report.entries.find((e) => e.name === 'CLAUDE.md')?.status).toBe('repaired');
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toBe('# rewritten on account B\n');
    expect(await sameFile(path.join(profile, 'CLAUDE.md'), path.join(master, 'CLAUDE.md'))).toBe(true);
    const kept = await conflicts();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^CLAUDE\.md\.\d+\.master$/);
    expect(await readFile(path.join(profile, '.cindy', 'conflicts', kept[0]!), 'utf8')).toBe('# master memory\n');
  });

  it('repairs a broken hard link: newer master content wins and the profile copy is kept', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    await rm(path.join(profile, 'settings.json'));
    await writeFile(path.join(profile, 'settings.json'), '{"theme":"light"}\n');
    await utimes(path.join(profile, 'settings.json'), T_OLD, T_OLD);
    await utimes(path.join(master, 'settings.json'), T_NEW, T_NEW);

    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(await readFile(path.join(master, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
    expect(await sameFile(path.join(profile, 'settings.json'), path.join(master, 'settings.json'))).toBe(true);
    expect((await conflicts())[0]).toMatch(/^settings\.json\.\d+\.profile$/);
  });

  it('relinks identical copies without keeping a conflict', async () => {
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'CLAUDE.md'), '# master memory\n');
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(await sameFile(path.join(profile, 'CLAUDE.md'), path.join(master, 'CLAUDE.md'))).toBe(true);
    expect(await conflicts()).toEqual([]);
  });

  it('moves a profile-only memory file into the master', async () => {
    await rm(path.join(master, 'CLAUDE.md'));
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'CLAUDE.md'), '# written on account B\n');
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toBe('# written on account B\n');
    expect(await sameFile(path.join(profile, 'CLAUDE.md'), path.join(master, 'CLAUDE.md'))).toBe(true);
  });

  it('leaves absent files absent and never touches credentials or account state', async () => {
    await rm(path.join(master, 'settings.json'));
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, '.credentials.json'), 'TOKEN-OF-ACCOUNT-B');
    await writeFile(path.join(profile, '.claude.json'), '{"oauthAccount":{}}');
    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(report.entries.find((e) => e.name === 'settings.json')?.status).toBe('absent');
    expect(await exists(path.join(master, 'settings.json'))).toBe(false);
    expect(await readFile(path.join(profile, '.credentials.json'), 'utf8')).toBe('TOKEN-OF-ACCOUNT-B');
    expect(await exists(path.join(master, '.credentials.json'))).toBe(false);
    expect((await lstat(path.join(profile, '.credentials.json'))).isSymbolicLink()).toBe(false);
  });

  it('falls back to mirror mode when hard links are impossible (e.g. another volume)', async () => {
    const noHardLinks: Partial<LinkerFs> = {
      link: async () => {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      },
    };
    const report = await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot, fs: noHardLinks });
    expect(report.mode).toBe('mirror');
    expect(report.entries.find((e) => e.name === 'CLAUDE.md')?.status).toBe('mirrored');
    expect(await readFile(path.join(profile, 'CLAUDE.md'), 'utf8')).toBe('# master memory\n');
    expect(await sameFile(path.join(profile, 'CLAUDE.md'), path.join(master, 'CLAUDE.md'))).toBe(false);

    // After a turn, newer profile edits flow back to the master; the old master copy is kept.
    await writeFile(path.join(profile, 'CLAUDE.md'), '# master memory\n- from account B\n');
    await utimes(path.join(master, 'CLAUDE.md'), T_OLD, T_OLD);
    await utimes(path.join(profile, 'CLAUDE.md'), T_NEW, T_NEW);
    const synced = await syncMirrorBack({ profileDir: profile, masterDir: master, accountsRoot });
    expect(synced).toEqual(['CLAUDE.md']);
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toContain('from account B');
    expect((await conflicts())[0]).toMatch(/^CLAUDE\.md\.\d+\.master$/);
  });

  it('refuses unsafe profile dirs before touching anything', async () => {
    await expect(
      prepareProfile({ profileDir: path.join(accountsRoot, '..', 'oops'), masterDir: master, accountsRoot }),
    ).rejects.toMatchObject({ code: 'unsafe_profile_dir' });
    expect(await exists(path.join(root, 'userData', 'oops'))).toBe(false);
  });
});

describe('inspectProfile', () => {
  it('reports problems without changing anything', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    await rm(path.join(profile, 'skills'));
    await rm(path.join(profile, 'CLAUDE.md'));
    await writeFile(path.join(profile, 'CLAUDE.md'), 'diverged');
    const health = await inspectProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(health.healthy).toBe(false);
    expect(health.entries.find((e) => e.name === 'skills')?.state).toBe('missing');
    expect(health.entries.find((e) => e.name === 'CLAUDE.md')?.state).toBe('diverged');
    expect(health.entries.find((e) => e.name === 'projects')?.state).toBe('linked');
    // Inspection must not have repaired anything.
    expect(await exists(path.join(profile, 'skills'))).toBe(false);
  });
});

describe('removeProfile', () => {
  it('deletes the profile but never the master data behind the links', async () => {
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    await writeFile(path.join(profile, '.credentials.json'), 'TOKEN');
    await removeProfile({ profileDir: profile, masterDir: master, accountsRoot });
    expect(await exists(profile)).toBe(false);
    expect(await readFile(path.join(master, 'projects', 'proj-a', 'old.jsonl'), 'utf8')).toContain('user');
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toBe('# master memory\n');
    expect(await readFile(path.join(master, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
  });

  it('aborts when an unknown link is still inside the profile', async () => {
    const outside = path.join(root, 'precious');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot });
    await mkdir(path.join(profile, 'nested'), { recursive: true });
    await symlink(outside, path.join(profile, 'nested', 'sneaky'), 'junction');

    await expect(removeProfile({ profileDir: profile, masterDir: master, accountsRoot })).rejects.toMatchObject({
      code: 'unexpected_link',
    });
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await exists(path.join(profile, 'nested', 'sneaky'))).toBe(true);
  });

  it('syncs unsynced mirror-mode edits back to the master before deleting', async () => {
    const noHardLinks: Partial<LinkerFs> = {
      link: async () => {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      },
    };
    await prepareProfile({ profileDir: profile, masterDir: master, accountsRoot, fs: noHardLinks });
    await writeFile(path.join(profile, 'CLAUDE.md'), '# edited on B, never synced\n');
    await utimes(path.join(master, 'CLAUDE.md'), T_OLD, T_OLD);
    await utimes(path.join(profile, 'CLAUDE.md'), T_NEW, T_NEW);
    await removeProfile({ profileDir: profile, masterDir: master, accountsRoot, fs: noHardLinks });
    expect(await readFile(path.join(master, 'CLAUDE.md'), 'utf8')).toBe('# edited on B, never synced\n');
    expect(await exists(profile)).toBe(false);
  });

  it('is a no-op for a profile that does not exist', async () => {
    await expect(removeProfile({ profileDir: profile, masterDir: master, accountsRoot })).resolves.toBeUndefined();
  });
});
