import {
  access,
  constants as fsConstants,
  copyFile,
  link,
  lstat,
  mkdir,
  rename,
  readFile,
  open,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Stats } from 'node:fs';

export type SessionExportMode = 'link' | 'copy';

export interface SessionExportArgs {
  sourceDirs: string[];
  destDir: string;
  mode: SessionExportMode;
  dryRun: boolean;
}

/**
 * Parse the flags of `sessions export`. Pure, so the accepted grammar is tested without building
 * the CLI bundle; every unknown token is an error, since a typo like `--dryrun` would otherwise
 * turn a preview into a real export.
 */
export function parseSessionsExportArgs(argv: readonly string[]): SessionExportArgs {
  const valueFlags = new Set(['--source', '--dest']);
  const bareFlags = new Set(['--copy', '--dry-run']);
  const sourceDirs: string[] = [];
  let destDir: string | undefined;
  const destValues = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (valueFlags.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
        throw new Error(`${token} <dir> is missing a value`);
      }
      if (token === '--dest') {
        if (destValues.size > 0 && !destValues.has(value)) {
          throw new Error('--dest <dir> was given more than once with different values');
        }
        destValues.add(value);
        destDir = value;
      } else {
        sourceDirs.push(value);
      }
      index += 1;
      continue;
    }
    if (bareFlags.has(token)) {
      continue;
    }
    throw new Error(`unknown argument for sessions export: ${token}`);
  }

  if (sourceDirs.length === 0) {
    throw new Error('--source <dir> is required (repeatable)');
  }
  if (destDir === undefined) {
    throw new Error('--dest <dir> is required');
  }
  return {
    sourceDirs,
    destDir,
    mode: argv.includes('--copy') ? 'copy' : 'link',
    dryRun: argv.includes('--dry-run'),
  };
}

export interface SessionExportOptions {
  /** Directories scanned for Pi transcripts, e.g. the app's managed sessions and the agent home. */
  sourceDirs: string[];
  /** Root for the exported tree; it receives one `--<cwd>--` folder per project. */
  destDir: string;
  mode?: SessionExportMode;
  dryRun?: boolean;
  /**
   * How long to wait for another run's interrupted claim to become the transcript before reporting
   * it. Zero reports immediately, which is what tests use; the CLI keeps the default.
   */
  claimWaitMs?: number;
}

export interface SessionExportResult {
  added: number;
  /** Transcripts already exported and untouched. */
  unchanged: number;
  /** Files under a source root that are not Pi session transcripts. */
  notSessions: number;
  /** Entries that could not be exported, see `problems`. */
  skipped: number;
  problems: string[];
  /**
   * Runs reduced to a copy because the destination cannot hold hard links. Always 0 in a dry run:
   * learning it requires a `link()` attempt, and a preview performs no writes.
   */
  copyFallbacks: number;
}

const HEADER_READ_BYTES = 64 * 1024;
const COMPARE_CHUNK_BYTES = 1024 * 1024;
/** Written into a claimed name before the staged copy is renamed onto it. */
const CLAIM_MARKER = 'cindy-sessions-export-claim:';
/** Hidden staging files are named `.partial-<uuid>`; one this old has no live copier. */
const PARTIAL_PREFIX = '.partial-';
const PARTIAL_STALE_MS = 60 * 60 * 1000;

/**
 * Pi names a project folder after the session's working directory: one leading separator stripped,
 * then every separator and colon replaced by a dash, wrapped in double dashes. Because separators
 * become dashes, no header value can produce a path segment of its own.
 */
export function piProjectDirName(cwd: string): string {
  const trimmed = cwd.startsWith('/') || cwd.startsWith('\\') ? cwd.slice(1) : cwd;
  return `--${trimmed.replace(/[/\\:]/g, '-')}--`;
}

type SessionHeader =
  | { kind: 'session'; cwd: string; id: string }
  | { kind: 'not-session' }
  | { kind: 'unreadable' };

/** Only the first line is needed, and transcripts can be hundreds of megabytes. */
async function readSessionHeader(file: string): Promise<SessionHeader> {
  // O_NONBLOCK keeps a FIFO swapped in after the directory listing from blocking the open; the
  // fstat then proves the handle is a regular file before anything is read from it.
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(() => null);
  if (!handle) {
    return { kind: 'unreadable' };
  }
  if (!(await handle.stat().catch(() => null))?.isFile()) {
    await handle.close().catch(() => undefined);
    return { kind: 'unreadable' };
  }
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lineEnd = text.indexOf('\n');
    const header = JSON.parse(lineEnd === -1 ? text : text.slice(0, lineEnd)) as {
      type?: unknown;
      cwd?: unknown;
      id?: unknown;
    };
    if (header.type !== 'session') {
      return { kind: 'not-session' };
    }
    if (typeof header.cwd !== 'string' || !header.cwd.trim()) {
      return { kind: 'unreadable' };
    }
    if (/[\u0000-\u001f]/.test(header.cwd)) {
      return { kind: 'unreadable' };
    }
    return {
      kind: 'session',
      cwd: header.cwd,
      id: typeof header.id === 'string' ? header.id : '',
    };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await handle.close();
  }
}

interface Listing {
  files: string[];
  /** Symlinked or otherwise non-regular entries are reported, never silently skipped. */
  skipped: string[];
}

async function listTranscripts(dir: string, result: SessionExportResult): Promise<Listing> {
  const listing: Listing = { files: [], skipped: [] };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    result.problems.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    result.skipped += 1;
    return listing;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // `DT_UNKNOWN` on NFS/SMB leaves every type predicate false; a stat is then the only way to
    // know whether this is a directory to descend into, and dropping it would hide whole projects.
    if (!entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile()) {
      const info = await lstat(full).catch(() => null);
      if (!info) {
        listing.skipped.push(`${full}: cannot be inspected`);
      } else if (info.isSymbolicLink()) {
        listing.skipped.push(`${full}: symlink, not followed`);
      } else if (info.isDirectory()) {
        const nested = await listTranscripts(full, result);
        listing.files.push(...nested.files);
        listing.skipped.push(...nested.skipped);
      } else if (info.isFile() && entry.name.endsWith('.jsonl')) {
        listing.files.push(full);
      } else if (info.isFile()) {
        continue;
      } else {
        listing.skipped.push(`${full}: not a regular file`);
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      listing.skipped.push(`${full}: symlink, not followed`);
    } else if (entry.isDirectory()) {
      const nested = await listTranscripts(full, result);
      listing.files.push(...nested.files);
      listing.skipped.push(...nested.skipped);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      listing.files.push(full);
    } else if (entry.name.endsWith('.jsonl')) {
      listing.skipped.push(`${full}: not a regular file`);
    }
  }
  return listing;
}

/** A child literally named `..export` is inside; only `..` and `../…` are not. */
function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Resolve symlinks in the deepest existing ancestor, so an uncreated destination still compares by
 * where it would land. Lexical `path.resolve` would compare spellings instead of targets.
 */
async function canonicalPath(target: string): Promise<string> {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return path.resolve(target);
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Predicts whether a directory a real run would create with `mkdir(target, {recursive: true})`
 * can actually be created, and whether it can then receive writes, without creating anything:
 * the deepest existing node on the path must be a directory this process may write into. A
 * preview that skips this promises exports that the real run cannot perform, which is exactly
 * the drift a dry run must not have.
 *
 * `mkdirOnly` mirrors mkdir itself: creating a *missing* target needs write permission on the
 * deepest existing ancestor, while an *existing* directory needs none — mkdir succeeds on it
 * without touching its permissions, and only the writes that follow need it to be writable.
 */
async function uncreatableDir(target: string, mkdirOnly = false): Promise<string | null> {
  const resolved = path.resolve(target);
  let current = resolved;
  for (;;) {
    // stat, not lstat: mkdir resolves symlinks on the way down, so a symlink to a directory is
    // a perfectly good ancestor, and only what it points at decides whether the mkdir works.
    const info = await stat(current).catch(() => null);
    if (!info) {
      const node = await lstat(current).catch(() => null);
      if (node?.isSymbolicLink()) {
        return `${target}: ${current} is a symlink that does not resolve`;
      }
    }
    if (info) {
      if (!info.isDirectory()) {
        return `${target}: ${current} exists and is not a directory`;
      }
      if (mkdirOnly && current === resolved) {
        return null;
      }
      try {
        await access(current, fsConstants.W_OK | fsConstants.X_OK);
      } catch {
        return `${target}: permission denied, ${current} is not writable`;
      }
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return `${target}: no existing ancestor to create it in`;
    }
    current = parent;
  }
}

/**
 * Whether the destination volume folds case, discovered without writing: the destination's own
 * path is asked for again with its basename case-flipped. A hit means the volume treats the two
 * spellings as one file. Unknown answers count as case-sensitive, which is the wider promise.
 */
async function volumeFoldsCase(dir: string): Promise<boolean> {
  // Case sensitivity belongs to the directory that will hold the entries, so probe inside the
  // nearest existing directory on the path — never a sibling of it, whose behaviour is its
  // parent's and says nothing about lookups inside the target.
  let current = path.resolve(dir);
  for (;;) {
    const info = await lstat(current).catch(() => null);
    if (info) {
      if (!info.isDirectory()) {
        return false;
      }
      const names = await readdir(current).catch(() => [] as string[]);
      const candidate = names.find((name) => /[a-zA-Z]/.test(name));
      if (candidate) {
        return spellingsAlias(current, candidate);
      }
      // Nothing here can answer the question. A child inherits its parent's behaviour on the
      // platforms that make this per-directory, so keep walking; at the root the answer is
      // unavailable and the wider promise (case-sensitive) is the safe assumption.
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** Whether one directory treats two spellings of one of its entries as the same file. */
async function spellingsAlias(dir: string, name: string): Promise<boolean> {
  const flipped = name.replace(/[a-zA-Z]/g, (character) =>
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
  );
  if (flipped === name) {
    return false;
  }
  const [original, alternate] = await Promise.all([
    lstat(path.join(dir, name)).catch(() => null),
    lstat(path.join(dir, flipped)).catch(() => null),
  ]);
  if (!original || !alternate || original.isSymbolicLink() || alternate.isSymbolicLink()) {
    return false;
  }
  // Resolving the flipped spelling answers the question directly: a folding volume returns the
  // original name, a case-sensitive one returns the flipped name. Two hard links to one file share
  // an inode but keep their own spellings, so the inode is not evidence either way.
  const resolved = await realpath(path.join(dir, flipped)).catch(() => null);
  return resolved !== null && path.basename(resolved) === name;
}

/** POSIX limits a name component by UTF-8 bytes; NTFS and APFS limit it by UTF-16 code units. */
function componentTooLong(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
    ? name.length > 255
    : Buffer.byteLength(name) > 255;
}

/**
 * Copies or links Pi transcripts into `destDir/--<cwd>--/<name>.jsonl`, so a terminal `pi`, an
 * indexer, or a memory tool using the default layout finds sessions the app keeps in its managed
 * directory. Existing files are never replaced, and nothing outside `destDir` is written.
 *
 * There is no lock, no reservation and no sidecar index. `link()` is the no-replace primitive:
 * it is atomic and fails with `EEXIST`, which is the only synchronisation this tool needs. The
 * publish path therefore has one state — "the name is taken or it is not" — instead of a
 * protocol with holders, tokens and staleness to reason about.
 */
export async function exportPiSessions(options: SessionExportOptions): Promise<SessionExportResult> {
  const mode = options.mode ?? 'link';
  const result: SessionExportResult = {
    added: 0,
    unchanged: 0,
    notSessions: 0,
    skipped: 0,
    problems: [],
    copyFallbacks: 0,
  };

  const destDir = path.resolve(options.destDir);
  const destInfo = await stat(destDir).catch(() => null);
  if (destInfo && !destInfo.isDirectory()) {
    result.problems.push(`${destDir}: destination exists and is not a directory`);
    return result;
  }
  const canonicalDestDir = await canonicalPath(destDir);

  const sourceDirs: string[] = [];
  const canonicalSourceDirs: string[] = [];
  const seenSources = new Set<string>();
  for (const sourceDir of options.sourceDirs) {
    const info = await stat(sourceDir).catch(() => null);
    if (!info?.isDirectory()) {
      result.problems.push(`${sourceDir}: not a readable directory`);
      continue;
    }
    const canonicalSourceDir = await canonicalPath(sourceDir);
    if (seenSources.has(canonicalSourceDir)) {
      continue;
    }
    seenSources.add(canonicalSourceDir);
    // Compare where the paths land, not how they are spelled.
    if (isInside(canonicalSourceDir, canonicalDestDir)) {
      // Writing anywhere now would land inside a source root, so refuse the whole run.
      result.problems.push(`${destDir}: destination is inside source directory ${sourceDir}`);
      return result;
    }
    sourceDirs.push(sourceDir);
    canonicalSourceDirs.push(canonicalSourceDir);
  }

  if (options.dryRun) {
    const dryDest = await lstat(destDir).catch(() => null);
    if (dryDest?.isSymbolicLink() && !(await realpath(destDir).catch(() => null))) {
      result.problems.push(`${destDir}: destination is a dangling symlink`);
      return result;
    }
    // The real run creates the destination root before anything else and refuses the whole run
    // when that mkdir fails, so the preview must predict the same refusal instead of promising
    // exports that cannot happen.
    if (!dryDest) {
      const problem = await uncreatableDir(destDir, true);
      if (problem) {
        result.problems.push(problem);
        return result;
      }
    }
  }
  if (!options.dryRun) {
    try {
      await mkdir(destDir, { recursive: true });
    } catch (error) {
      result.problems.push(`${destDir}: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Containment compares resolved paths. macOS and Windows fold case through `realpath`, so an
   * alias of the source is recognised; a case-insensitive Linux mount (vfat, exfat) keeps the
   * spelling and can slip past, which is a documented exception rather than a silent guarantee.
   */
  /** Null when the folder may receive writes, otherwise the reason it may not. */
  const projectDirProblem = async (destination: string, projectDir: string): Promise<string | null> => {
    if ((await lstat(projectDir).catch(() => null))?.isSymbolicLink()) {
      return `${destination}: project folder is a symlink`;
    }
    const realProjectDir = await realpath(projectDir).catch(() => null);
    if (!realProjectDir) {
      return `${destination}: cannot resolve the project folder`;
    }
    // A project folder that is a symlink would move the write outside destDir. The canonical
    // destination also works when the directory has not been created yet, as in a dry run.
    if (!isInside(canonicalDestDir, realProjectDir)) {
      return `${destination}: project folder resolves outside the destination`;
    }
    // A project folder that already is, or sits inside, a source must never receive writes.
    if (canonicalSourceDirs.some((sourceDir) => isInside(sourceDir, realProjectDir))) {
      return `${destination}: project folder resolves inside a source directory`;
    }
    return null;
  };

  /**
   * Targets this run already decided, so a second root reaching the same name is not a conflict.
   * On a volume that folds case, `one.jsonl` and `ONE.jsonl` are the same target, and a preview
   * that keys by spelling would promise two exports the real run cannot both perform.
   */
  // Case sensitivity is per directory on NTFS, so each target's own parent decides; the probe runs
  // once per directory, not once per session.
  const foldsCaseCache = new Map<string, boolean>();
  const foldsCaseFor = async (dir: string): Promise<boolean> => {
    const cached = foldsCaseCache.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const answer = await volumeFoldsCase(dir);
    foldsCaseCache.set(dir, answer);
    return answer;
  };
  const planKey = async (target: string): Promise<string> =>
    (await foldsCaseFor(path.dirname(target))) ? target.toLowerCase() : target;
  const planned = new Map<string, { source: string; size: number }>();
  /** Project directories already checked for staging leftovers, so each is read once. */
  const scannedProjectDirs = new Set<string>();

  for (const sourceDir of sourceDirs) {
    const listing = await listTranscripts(sourceDir, result);
    for (const skipped of listing.skipped) {
      result.skipped += 1;
      result.problems.push(skipped);
    }

    for (const source of listing.files) {
      const header = await readSessionHeader(source);
      if (header.kind === 'not-session') {
        result.notSessions += 1;
        continue;
      }
      if (header.kind === 'unreadable') {
        result.skipped += 1;
        result.problems.push(`${source}: no readable Pi session header`);
        continue;
      }
      const projectDir = path.join(destDir, piProjectDirName(header.cwd));
      const destination = path.join(projectDir, path.basename(source));
      const sourceStat = await stat(source).catch(() => null);
      if (!sourceStat) {
        result.skipped += 1;
        result.problems.push(`${source}: cannot stat the transcript`);
        continue;
      }

      const key = await planKey(destination);
      const alreadyPlanned = planned.get(key);
      if (alreadyPlanned) {
        if (
          alreadyPlanned.size === sourceStat.size &&
          (await sameBytes(alreadyPlanned.source, source))
        ) {
          result.unchanged += 1;
          continue;
        }
        result.skipped += 1;
        result.problems.push(`${destination}: another source exports the same transcript name`);
        continue;
      }

      let occupant = await lstat(destination).catch(() => null);
      if (occupant && (await isClaimMarker(destination))) {
        // A claim belongs to a publisher that may still be between its write and its rename, and
        // no POSIX operation can "delete this only if it is still X". So this run waits for the
        // claim to become the transcript, and otherwise reports it: deleting it could remove the
        // file a resumed writer just published.
        const claimWaitMs = options.claimWaitMs ?? 2_000;
        for (let attempt = 0; attempt < Math.ceil(claimWaitMs / 50); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const settled = await lstat(destination).catch(() => null);
          if (!settled || !(await isClaimMarker(destination))) {
            occupant = settled;
            break;
          }
        }
        if (occupant && (await isClaimMarker(destination))) {
          result.skipped += 1;
          result.problems.push(
            `${destination}: claim left by an interrupted run; delete it to export here`,
          );
          continue;
        }
      }
      if (occupant) {
        // The name is taken. It is this tool's own export when the bytes match, whether the
        // destination holds a hard link, a copy, or a link broken by moving the tree; anything
        // else is someone else's file and is reported, never replaced.
        if (await sameTranscript(occupant, destination, source)) {
          result.unchanged += 1;
        } else {
          result.skipped += 1;
          result.problems.push(
            (await isLegacyPlaceholder(destination))
              ? `${destination}: placeholder left by an older build of this command; delete it to export here`
              : `${destination}: exists and is not this export; left alone`,
          );
        }
        continue;
      }

      planned.set(key, { source, size: sourceStat.size });

      if (options.dryRun) {
        // A name the filesystem cannot hold cannot be created. The real run learns that from its
        // mkdir; a dry run against a destination that does not exist yet gets only ENOENT from its
        // probe, so it must predict the limit instead of promising an export that cannot happen.
        if (componentTooLong(path.basename(destination))) {
          result.skipped += 1;
          result.problems.push(`${destination}: transcript file name is longer than a filesystem can hold`);
          continue;
        }
        if (componentTooLong(piProjectDirName(header.cwd))) {
          result.skipped += 1;
          result.problems.push(`${destination}: project folder name is longer than a filesystem can hold`);
          continue;
        }
        const existingProjectDir = await lstat(projectDir).catch((error: NodeJS.ErrnoException) => {
          // ENOENT means the folder would be created; anything else is what the real run would hit.
          if (error.code === 'ENOENT') {
            return null;
          }
          throw error;
        }).catch((error: unknown) => {
          result.problems.push(
            `${destination}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 'reported' as const;
        });
        if (existingProjectDir === 'reported') {
          result.skipped += 1;
          continue;
        }
        if (existingProjectDir) {
          if (!existingProjectDir.isDirectory() && !existingProjectDir.isSymbolicLink()) {
            result.skipped += 1;
            result.problems.push(`${destination}: project folder exists and is not a directory`);
            continue;
          }
          const problem = await projectDirProblem(destination, projectDir);
          if (problem) {
            result.skipped += 1;
            result.problems.push(problem);
            continue;
          }
        }
        if (existingProjectDir) {
          await reportStaleStaging(projectDir, result, scannedProjectDirs);
        }
        // The real run creates the project folder and writes the transcript into it, so the
        // deepest existing ancestor of that folder must be writable; the preview must report the
        // EACCES/ENOTDIR the real run would hit.
        const unwritable = await uncreatableDir(projectDir);
        if (unwritable) {
          result.skipped += 1;
          result.problems.push(`${destination}: ${unwritable}`);
          continue;
        }
        result.added += 1;
        continue;
      }

      try {
        await mkdir(projectDir, { recursive: true });
      } catch (error) {
        result.skipped += 1;
        result.problems.push(
          `${destination}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const problem = await projectDirProblem(destination, projectDir);
      if (problem) {
        result.skipped += 1;
        result.problems.push(problem);
        continue;
      }
      await reportStaleStaging(projectDir, result, scannedProjectDirs);

      let published: Publishing;
      try {
        published = await publishInto(source, destination, mode, result);
      } catch (error) {
        result.skipped += 1;
        result.problems.push(
          `${destination}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (published === 'changed') {
        result.skipped += 1;
        result.problems.push(`${destination}: source changed while it was being copied; run again`);
        continue;
      }
      if (published === 'written' || published === 'written-copy') {
        result.added += 1;
        continue;
      }
      // The name was taken by a writer that won the race: accept it only if it holds this
      // transcript, exactly as the occupant check above would have.
      const settled = await waitForSameTranscript(destination, source);
      if (settled) {
        result.unchanged += 1;
        continue;
      }
      result.skipped += 1;
      result.problems.push(
        (await isLegacyPlaceholder(destination))
          ? `${destination}: placeholder left by an older build of this command; delete it to export here`
          : `${destination}: exists and is not this export; left alone`,
      );
    }
  }

  return result;
}

type Publishing = 'written' | 'written-copy' | 'conflict' | 'changed';

/**
 * Publish under the final name without replacing anything. `link()` is the no-replace primitive:
 * atomic, and `EEXIST` means someone else already owns the name.
 *
 * Where the destination cannot hold hard links, the transcript is copied beside the target and
 * then linked from there; if even that link is unsupported, the finished copy is renamed into
 * place after an existence check. That last path is the only non-atomic one, so it is narrow: it
 * runs only on filesystems that refuse hard links entirely.
 */
async function publishInto(
  source: string,
  destination: string,
  mode: SessionExportMode,
  result: SessionExportResult,
): Promise<Publishing> {
  const reported: Publishing = mode === 'copy' ? 'written-copy' : 'written';
  if (mode === 'link') {
    try {
      await link(source, destination);
      return reported;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return 'conflict';
      }
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') {
        throw error;
      }
      result.copyFallbacks += 1;
    }
  }

  const sourceStat = await stat(source);
  // Copy beside the target first: an interrupted copy leaves a `.partial` file the scan ignores,
  // instead of a truncated `.jsonl` every later run would treat as occupied.
  // Hidden and short on purpose: appending to the target's basename would push a legal long name
  // past the component limit and fail a copy the preview promised.
  const partial = path.join(path.dirname(destination), `.partial-${randomUUID()}`);
  try {
    await copyFile(source, partial, fsConstants.COPYFILE_EXCL);
    // Pi appends to a live session, so a copy can capture half a turn. Only a source that stayed
    // still across the copy is a snapshot worth publishing.
    const after = await stat(source).catch(() => null);
    if (!after || after.size !== sourceStat.size || after.mtimeMs !== sourceStat.mtimeMs) {
      await rm(partial, { force: true }).catch(() => undefined);
      return 'changed';
    }
    await utimes(partial, sourceStat.atime, sourceStat.mtimeMs / 1000);
    try {
      await link(partial, destination);
      return reported;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return 'conflict';
      }
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK' && code !== 'EXDEV') {
        throw error;
      }
    }
    // No hard links at all on this destination, and the finished copy is already staged. Claim the
    // name with an exclusive create, verify the claim is still ours, then rename onto it.
    //
    // The residual window is a platform limit, not an oversight: POSIX offers no "rename only if
    // the target is still this file", so a process that ignores the claim and writes this name in
    // the microseconds between the read-back and the rename can be replaced. The alternatives are
    // worse — writing straight into the final name is atomic but leaves truncated bytes there
    // after a crash, which readers would consume and no later run could prove it should repair.
    let claim;
    try {
      claim = await open(destination, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return 'conflict';
      }
      throw error;
    }
    const marker = `${CLAIM_MARKER}${randomUUID()}\n`;
    try {
      await claim.writeFile(marker);
    } catch (error) {
      // The marker did not land (ENOSPC, EIO). The claim exists and would read as someone else's,
      // so this run — which provably just created it — removes it before failing.
      await claim.close().catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
    await claim.close().catch(() => undefined);
    try {
      // A paused run can lose its claim to a sibling that treated it as abandoned. Checking the
      // marker immediately before the rename is what stops the resumed run from replacing the
      // winner: if the name no longer holds this run's marker, this run did not win it.
      const current = await readFile(destination, 'utf8').catch(() => null);
      if (current !== marker) {
        return 'conflict';
      }
      await rename(partial, destination);
      return reported;
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

/**
 * A run that lost the name to `EEXIST` may have lost it to a publisher that is still copying, so
 * the destination can be short for a moment. Retry briefly before calling it a conflict.
 */
async function waitForSameTranscript(destination: string, source: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const occupant = await lstat(destination).catch(() => null);
    if (occupant && (await sameTranscript(occupant, destination, source))) {
      return true;
    }
    if (occupant?.isFile()) {
      const sourceStat = await stat(source).catch(() => null);
      if (sourceStat && occupant.size === sourceStat.size) {
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Reports staging files a killed copy left behind. They are never deleted — a name is not proof of
 * authorship — but silence would let them accumulate invisibly, so an aged one is a problem the
 * user can act on. A younger one may belong to a copy still running and is ignored.
 */
async function reportStaleStaging(
  projectDir: string,
  result: SessionExportResult,
  scanned: Set<string>,
): Promise<void> {
  if (scanned.has(projectDir)) {
    return;
  }
  scanned.add(projectDir);
  const names = await readdir(projectDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(PARTIAL_PREFIX)) {
      continue;
    }
    const info = await lstat(path.join(projectDir, name)).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > PARTIAL_STALE_MS) {
      result.problems.push(
        `${path.join(projectDir, name)}: staging file left by an interrupted run; delete it`,
      );
    }
  }
}

/** A claim left by a publisher between writing its marker and renaming the staged copy. */
async function isClaimMarker(destination: string): Promise<boolean> {
  const info = await lstat(destination).catch(() => null);
  // The marker is `${CLAIM_MARKER}${uuid}\n`; a smaller ceiling would reject this tool's own file.
  if (!info?.isFile() || info.size > CLAIM_MARKER.length + 40) {
    return false;
  }
  const content = await readFile(destination, 'utf8').catch(() => null);
  return (
    content !== null &&
    /^cindy-sessions-export-claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/i.test(
      content,
    )
  );
}

/** A reservation marker written by an earlier version of this command, never deleted by this one. */
async function isLegacyPlaceholder(destination: string): Promise<boolean> {
  const info = await lstat(destination).catch(() => null);
  if (!info?.isFile() || info.size > 256) {
    return false;
  }
  const content = await readFile(destination, 'utf8').catch(() => null);
  // The whole marker must match — that build wrote the word and a UUID. A file that merely begins
  // with the same characters is someone else's, and advising its deletion would be wrong.
  return (
    content !== null &&
    /^cindy-sessions-export-reservation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i.test(
      content,
    )
  );
}

/**
 * Whether an occupied target already holds this transcript. Bytes decide; the inode is a free
 * shortcut when the destination holds this tool's own hard link. Some mounts report the same
 * non-zero inode for unrelated files, so equality alone proves nothing: a real hard link between
 * two live paths always carries more than one link.
 */
async function sameTranscript(
  occupant: Stats,
  destination: string,
  sourcePath: string,
): Promise<boolean> {
  // Re-stat the source: Pi appends to a live session, so a size captured earlier in the pass may
  // already be stale, and comparing against it would report this tool's own export as foreign.
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat) {
    return false;
  }
  // Two paths sharing a non-zero inode with more than one link are one file: the destination is
  // this transcript, whether or not it is still growing. Bytes cannot decide for a moving file,
  // and refusing here would fail every rerun of a session that is being written.
  if (
    occupant.ino !== 0 &&
    sourceStat.ino !== 0 &&
    occupant.ino === sourceStat.ino &&
    occupant.dev === sourceStat.dev &&
    occupant.nlink >= 2 &&
    sourceStat.nlink >= 2
  ) {
    return true;
  }
  if (!occupant.isFile() || occupant.size !== sourceStat.size) {
    return false;
  }
  return sameBytes(destination, sourcePath);
}

/** Byte-for-byte comparison in bounded chunks, so a contested 500 MB transcript does not OOM. */
async function sameBytes(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    open(leftPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(() => null),
    open(rightPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK).catch(() => null),
  ]);
  if (!left || !right) {
    await left?.close().catch(() => undefined);
    await right?.close().catch(() => undefined);
    return false;
  }
  // A path swapped for a FIFO after the caller's lstat would block a plain read; fstat both
  // handles before reading a byte.
  const shapes = await Promise.all([left.stat().catch(() => null), right.stat().catch(() => null)]);
  if (!shapes[0]?.isFile() || !shapes[1]?.isFile()) {
    await left.close().catch(() => undefined);
    await right.close().catch(() => undefined);
    return false;
  }
  const leftBuffer = Buffer.alloc(COMPARE_CHUNK_BYTES);
  const rightBuffer = Buffer.alloc(COMPARE_CHUNK_BYTES);
  try {
    for (;;) {
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, COMPARE_CHUNK_BYTES, null).catch(() => null),
        right.read(rightBuffer, 0, COMPARE_CHUNK_BYTES, null).catch(() => null),
      ]);
      if (!leftRead || !rightRead) {
        return false;
      }
      if (leftRead.bytesRead !== rightRead.bytesRead) {
        return false;
      }
      if (leftRead.bytesRead === 0) {
        return true;
      }
      if (
        !leftBuffer.subarray(0, leftRead.bytesRead).equals(rightBuffer.subarray(0, rightRead.bytesRead))
      ) {
        return false;
      }
    }
  } finally {
    await left.close().catch(() => undefined);
    await right.close().catch(() => undefined);
  }
}

/** Exposed for tests that need a stat without importing node:fs. */
export type { Stats };
