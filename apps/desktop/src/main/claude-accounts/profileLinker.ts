/**
 * Profile linker: makes an extra account's CLI config dir share the master's local memory.
 *
 * Shared dirs become junctions (Windows; directory symlinks elsewhere), shared files become
 * hard links, so every write lands in the master. When hard links are impossible (another
 * volume) files are mirrored and synced back after a turn. `.credentials.json` and
 * `.claude.json` are never linked, copied or read: the CLI owns them per account.
 *
 * Data is never deleted silently. Any losing copy goes to `<profile>/.cindy/conflicts`.
 * Design: docs/dev-rules/claude-multi-account.md §4.3.
 */
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { EXTRA_ACCOUNT_ID_PATTERN } from './types.js';

/** Directories shared with the master (transcripts + per-project memory live in `projects`). */
export const SHARED_DIRS = [
  'projects',
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
  'todos',
  'file-history',
  'plans',
] as const;

/** Files shared with the master. */
export const SHARED_FILES = ['CLAUDE.md', 'settings.json'] as const;

/** Owned by the CLI per account. Linking, copying or reading these is a bug. */
export const NEVER_LINKED_FILES = ['.credentials.json', '.claude.json'] as const;

const CONFLICTS_DIR = path.join('.cindy', 'conflicts');
const HARD_LINK_UNSUPPORTED = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EACCES']);

export type ClaudeProfileErrorCode = 'unsafe_profile_dir' | 'never_linked' | 'unexpected_link' | 'link_failed';

export class ClaudeProfileError extends Error {
  constructor(readonly code: ClaudeProfileErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeProfileError';
  }
}

/** File-system surface the linker uses; tests override single calls (e.g. `link` → EXDEV). */
export interface LinkerFs {
  lstat: typeof fsp.lstat;
  stat: typeof fsp.stat;
  mkdir: typeof fsp.mkdir;
  readdir: typeof fsp.readdir;
  readFile: typeof fsp.readFile;
  writeFile: typeof fsp.writeFile;
  rename: typeof fsp.rename;
  unlink: typeof fsp.unlink;
  rmdir: typeof fsp.rmdir;
  rm: typeof fsp.rm;
  symlink: typeof fsp.symlink;
  link: typeof fsp.link;
  realpath: typeof fsp.realpath;
  copyFile: typeof fsp.copyFile;
  cp: typeof fsp.cp;
  utimes: typeof fsp.utimes;
}

const nodeFs: LinkerFs = {
  lstat: fsp.lstat,
  stat: fsp.stat,
  mkdir: fsp.mkdir,
  readdir: fsp.readdir,
  readFile: fsp.readFile,
  writeFile: fsp.writeFile,
  rename: fsp.rename,
  unlink: fsp.unlink,
  rmdir: fsp.rmdir,
  rm: fsp.rm,
  symlink: fsp.symlink,
  link: fsp.link,
  realpath: fsp.realpath,
  copyFile: fsp.copyFile,
  cp: fsp.cp,
  utimes: fsp.utimes,
};

export interface ProfilePaths {
  profileDir: string;
  masterDir: string;
  /** Root every profile must live directly under (owner-scoped userData dir). */
  accountsRoot: string;
}

interface LinkerOptions extends ProfilePaths {
  fs?: Partial<LinkerFs>;
  now?: () => number;
}

export type PrepareStatus = 'ok' | 'created' | 'repaired' | 'merged' | 'mirrored' | 'absent';

export interface PrepareReport {
  profileDir: string;
  masterDir: string;
  /** `mirror` when at least one shared file could not be hard linked. */
  mode: 'linked' | 'mirror';
  entries: Array<{ name: string; kind: 'dir' | 'file'; status: PrepareStatus }>;
  /** Conflict copies written during this run (file names inside `.cindy/conflicts`). */
  conflicts: string[];
}

export function assertSafeEntryName(name: string): void {
  if ((NEVER_LINKED_FILES as readonly string[]).includes(name)) {
    throw new ClaudeProfileError('never_linked', `${name} belongs to the CLI and must never be shared`);
  }
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A profile is `<accountsRoot>/<generated id>` and never overlaps the master. */
export function assertProfileDirSafe(profileDir: string, paths: Omit<ProfilePaths, 'profileDir'>): void {
  const fail = (why: string) => {
    throw new ClaudeProfileError('unsafe_profile_dir', `unsafe Claude profile dir (${why}): ${profileDir}`);
  };
  if (!path.isAbsolute(profileDir) || !path.isAbsolute(paths.accountsRoot) || !path.isAbsolute(paths.masterDir)) {
    fail('not absolute');
  }
  const resolved = path.resolve(profileDir);
  if (!samePath(path.dirname(resolved), paths.accountsRoot)) fail('not directly under the accounts root');
  if (!EXTRA_ACCOUNT_ID_PATTERN.test(path.basename(resolved))) fail('not a generated account id');
  if (samePath(resolved, paths.masterDir) || isInside(resolved, paths.masterDir) || isInside(paths.masterDir, resolved)) {
    fail('overlaps the master config dir');
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

type Kind = 'missing' | 'link' | 'dir' | 'file' | 'other';

async function kindOf(fs: LinkerFs, p: string): Promise<Kind> {
  try {
    const s = await fs.lstat(p);
    if (s.isSymbolicLink()) return 'link';
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    return 'other';
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
}

async function linkTargets(fs: LinkerFs, link: string, target: string): Promise<boolean> {
  try {
    return samePath(await fs.realpath(link), await fs.realpath(target));
  } catch {
    return false;
  }
}

async function sameFile(fs: LinkerFs, a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

async function sameContent(fs: LinkerFs, a: string, b: string): Promise<boolean> {
  const [ca, cb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return ca.equals(cb);
}

async function mtimeMs(fs: LinkerFs, p: string): Promise<number> {
  return (await fs.stat(p)).mtimeMs;
}

class Run {
  readonly fs: LinkerFs;
  readonly conflicts: string[] = [];
  private readonly now: () => number;

  constructor(readonly paths: ProfilePaths, options: LinkerOptions) {
    this.fs = { ...nodeFs, ...options.fs };
    this.now = options.now ?? (() => Date.now());
  }

  /** Move (or copy) `source` into the conflicts dir under a descriptive name. */
  async keepConflict(source: string, relName: string, origin: 'master' | 'profile', move: boolean): Promise<void> {
    const dir = path.join(this.paths.profileDir, CONFLICTS_DIR);
    await this.fs.mkdir(dir, { recursive: true });
    const base = relName.split(/[\\/]+/).join('__');
    let name = `${base}.${this.now()}.${origin}`;
    for (let i = 1; this.conflicts.includes(name) || (await kindOf(this.fs, path.join(dir, name))) !== 'missing'; i += 1) {
      name = `${base}.${this.now()}-${i}.${origin}`;
    }
    const dest = path.join(dir, name);
    if (move) await this.moveEntry(source, dest);
    else await this.fs.copyFile(source, dest);
    this.conflicts.push(name);
  }

  /** rename with a copy fallback for cross-volume moves. */
  async moveEntry(from: string, to: string): Promise<void> {
    try {
      await this.fs.rename(from, to);
    } catch (err) {
      if (errCode(err) !== 'EXDEV') throw err;
      await this.fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await this.fs.rm(from, { recursive: true, force: true });
    }
  }

  /** Merge a real directory into the master without ever overwriting master data. */
  async mergeDir(src: string, dst: string, rel: string): Promise<void> {
    for (const entry of await this.fs.readdir(src)) {
      const from = path.join(src, entry);
      const to = path.join(dst, entry);
      const entryRel = `${rel}/${entry}`;
      const fromKind = await kindOf(this.fs, from);
      const toKind = await kindOf(this.fs, to);
      if (fromKind === 'link' || fromKind === 'other') {
        await this.keepConflict(from, entryRel, 'profile', true);
      } else if (toKind === 'missing') {
        await this.moveEntry(from, to);
      } else if (fromKind === 'dir' && toKind === 'dir') {
        await this.mergeDir(from, to, entryRel);
      } else if (fromKind === 'file' && toKind === 'file' && (await sameContent(this.fs, from, to))) {
        await this.fs.unlink(from);
      } else {
        await this.keepConflict(from, entryRel, 'profile', true);
      }
    }
    await this.fs.rmdir(src);
  }

  async createDirLink(link: string, target: string): Promise<void> {
    try {
      await this.fs.symlink(target, link, 'junction');
    } catch (err) {
      throw new ClaudeProfileError('link_failed', `could not link ${link} → ${target}: ${errCode(err) ?? String(err)}`);
    }
  }

  async prepareDir(name: string): Promise<PrepareStatus> {
    assertSafeEntryName(name);
    const link = path.join(this.paths.profileDir, name);
    const target = path.join(this.paths.masterDir, name);
    await this.fs.mkdir(target, { recursive: true });
    const kind = await kindOf(this.fs, link);
    if (kind === 'link') {
      if (await linkTargets(this.fs, link, target)) return 'ok';
      await this.fs.unlink(link);
      await this.createDirLink(link, target);
      return 'repaired';
    }
    if (kind === 'missing') {
      await this.createDirLink(link, target);
      return 'created';
    }
    if (kind === 'dir') {
      await this.mergeDir(link, target, name);
      await this.createDirLink(link, target);
      return 'merged';
    }
    await this.keepConflict(link, name, 'profile', true);
    await this.createDirLink(link, target);
    return 'repaired';
  }

  /** Hard link `master` at `profile`; returns false (and copies) when hard links are impossible. */
  async hardLinkOrCopy(master: string, profile: string): Promise<boolean> {
    try {
      await this.fs.link(master, profile);
      return true;
    } catch (err) {
      if (!HARD_LINK_UNSUPPORTED.has(errCode(err) ?? '')) throw err;
      await this.fs.copyFile(master, profile);
      return false;
    }
  }

  async prepareFile(name: string): Promise<PrepareStatus> {
    assertSafeEntryName(name);
    const profile = path.join(this.paths.profileDir, name);
    const master = path.join(this.paths.masterDir, name);
    let profileKind = await kindOf(this.fs, profile);
    const masterKind = await kindOf(this.fs, master);
    if (profileKind === 'link' || profileKind === 'dir' || profileKind === 'other') {
      await this.keepConflict(profile, name, 'profile', true);
      profileKind = 'missing';
    }
    if (masterKind === 'missing' || masterKind !== 'file') {
      if (profileKind === 'missing') return 'absent';
      // Profile-only file: it becomes the master's file.
      await this.moveEntry(profile, master);
      return (await this.hardLinkOrCopy(master, profile)) ? 'repaired' : 'mirrored';
    }
    if (profileKind === 'missing') {
      return (await this.hardLinkOrCopy(master, profile)) ? 'created' : 'mirrored';
    }
    if (await sameFile(this.fs, profile, master)) return 'ok';

    // Two different files: reconcile content first (newer wins), then try to relink.
    if (!(await sameContent(this.fs, profile, master))) {
      if ((await mtimeMs(this.fs, profile)) > (await mtimeMs(this.fs, master))) {
        await this.keepConflict(master, name, 'master', false);
        // Write in place so other profiles' hard links to the master stay valid.
        await this.fs.writeFile(master, await this.fs.readFile(profile));
      } else {
        await this.keepConflict(profile, name, 'profile', false);
      }
    }
    await this.fs.unlink(profile);
    if (await this.hardLinkOrCopy(master, profile)) return 'repaired';
    return 'mirrored';
  }
}

/** Idempotent: run before every CLI spawn on an extra account. */
export async function prepareProfile(options: LinkerOptions): Promise<PrepareReport> {
  assertProfileDirSafe(options.profileDir, options);
  const run = new Run(options, options);
  await run.fs.mkdir(options.profileDir, { recursive: true });
  await run.fs.mkdir(options.masterDir, { recursive: true });
  const entries: PrepareReport['entries'] = [];
  for (const name of SHARED_DIRS) entries.push({ name, kind: 'dir', status: await run.prepareDir(name) });
  let mirror = false;
  for (const name of SHARED_FILES) {
    const status = await run.prepareFile(name);
    if (status === 'mirrored') mirror = true;
    entries.push({ name, kind: 'file', status });
  }
  return {
    profileDir: options.profileDir,
    masterDir: options.masterDir,
    mode: mirror ? 'mirror' : 'linked',
    entries,
    conflicts: run.conflicts,
  };
}

/**
 * Mirror mode only: after a turn, copy newer profile edits of shared files back to the master.
 * Returns the names that were synced. Linked files are skipped (they are already one file).
 */
export async function syncMirrorBack(options: LinkerOptions): Promise<string[]> {
  assertProfileDirSafe(options.profileDir, options);
  const run = new Run(options, options);
  const synced: string[] = [];
  for (const name of SHARED_FILES) {
    const profile = path.join(options.profileDir, name);
    const master = path.join(options.masterDir, name);
    if ((await kindOf(run.fs, profile)) !== 'file') continue;
    const masterKind = await kindOf(run.fs, master);
    if (masterKind === 'file') {
      if (await sameFile(run.fs, profile, master)) continue;
      if (await sameContent(run.fs, profile, master)) continue;
      if ((await mtimeMs(run.fs, profile)) <= (await mtimeMs(run.fs, master))) continue;
      await run.keepConflict(master, name, 'master', false);
      await run.fs.writeFile(master, await run.fs.readFile(profile));
    } else if (masterKind === 'missing') {
      await run.fs.copyFile(profile, master);
    } else {
      continue;
    }
    synced.push(name);
  }
  return synced;
}

export type DirState = 'linked' | 'missing' | 'wrong_target' | 'real_dir' | 'blocked';
export type FileState = 'linked' | 'copy' | 'missing' | 'absent' | 'diverged' | 'profile_only' | 'blocked';

export interface ProfileHealth {
  profileDir: string;
  exists: boolean;
  healthy: boolean;
  mode: 'linked' | 'mirror';
  entries: Array<{ name: string; kind: 'dir'; state: DirState } | { name: string; kind: 'file'; state: FileState }>;
}

/** Read-only health check for the diagnostics panel. Never repairs anything. */
export async function inspectProfile(options: LinkerOptions): Promise<ProfileHealth> {
  assertProfileDirSafe(options.profileDir, options);
  const fs: LinkerFs = { ...nodeFs, ...options.fs };
  const exists = (await kindOf(fs, options.profileDir)) === 'dir';
  const entries: ProfileHealth['entries'] = [];
  for (const name of SHARED_DIRS) {
    const link = path.join(options.profileDir, name);
    const kind = await kindOf(fs, link);
    const state: DirState =
      kind === 'missing'
        ? 'missing'
        : kind === 'dir'
          ? 'real_dir'
          : kind === 'link'
            ? (await linkTargets(fs, link, path.join(options.masterDir, name)))
              ? 'linked'
              : 'wrong_target'
            : 'blocked';
    entries.push({ name, kind: 'dir', state });
  }
  let mirror = false;
  for (const name of SHARED_FILES) {
    const profile = path.join(options.profileDir, name);
    const master = path.join(options.masterDir, name);
    const pk = await kindOf(fs, profile);
    const mk = await kindOf(fs, master);
    let state: FileState;
    if (pk !== 'file' && pk !== 'missing') state = 'blocked';
    else if (mk !== 'file') state = pk === 'missing' ? 'absent' : 'profile_only';
    else if (pk === 'missing') state = 'missing';
    else if (await sameFile(fs, profile, master)) state = 'linked';
    else if (await sameContent(fs, profile, master)) state = 'copy';
    else state = 'diverged';
    if (state === 'copy') mirror = true;
    entries.push({ name, kind: 'file', state });
  }
  const healthy = exists && entries.every((e) => e.state === 'linked' || e.state === 'absent' || e.state === 'copy');
  return { profileDir: options.profileDir, exists, healthy, mode: mirror ? 'mirror' : 'linked', entries };
}

async function findLinks(fs: LinkerFs, dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir)) {
    const p = path.join(dir, entry);
    const kind = await kindOf(fs, p);
    if (kind === 'link') out.push(p);
    else if (kind === 'dir') await findLinks(fs, p, out);
  }
}

/**
 * Remove a profile: unlink the known links first (that removes only the link, never the
 * master data), refuse if any other link remains, and only then delete the directory.
 */
export async function removeProfile(options: LinkerOptions): Promise<void> {
  assertProfileDirSafe(options.profileDir, options);
  const fs: LinkerFs = { ...nodeFs, ...options.fs };
  if ((await kindOf(fs, options.profileDir)) === 'missing') return;
  // Mirror mode keeps real copies: push newer edits to the master before they are deleted.
  await syncMirrorBack(options);
  for (const name of SHARED_DIRS) {
    const link = path.join(options.profileDir, name);
    if ((await kindOf(fs, link)) === 'link') await fs.unlink(link);
  }
  for (const name of SHARED_FILES) {
    const file = path.join(options.profileDir, name);
    // Unlinking a hard link only drops this name; the master keeps its file.
    if ((await kindOf(fs, file)) !== 'missing') await fs.unlink(file);
  }
  const leftovers: string[] = [];
  await findLinks(fs, options.profileDir, leftovers);
  if (leftovers.length > 0) {
    throw new ClaudeProfileError('unexpected_link', `refusing to delete: links remain in profile: ${leftovers.join(', ')}`);
  }
  await fs.rm(options.profileDir, { recursive: true, force: true });
}
