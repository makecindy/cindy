/**
 * The authorized-keys file the SSH access target derives from its per-owner record (sshAccessRecord.ts, the source of
 * truth). Shared by the desktop and the Node Host; no Electron imports.
 *
 * Two layouts (decisions 2026-11-26, docs/dev-rules/protocol-compatibility/device-link-ssh-access.md):
 * - Cindy cloud guest: sshd reads ONLY `~/.ssh/cindy-owner-authorized-keys`. The file is Cindy's: its first line is
 *   exactly CLOUD_GUEST_FILE_MARKER (the image's boot gate only holds files that start with it), followed by Cindy
 *   blocks; other lines are dropped on the next write. A file WITHOUT the marker is maintained by hand: it is left alone
 *   until access is enabled, and then taken over only after its ed25519 keys were imported as manual keys (the target
 *   core does that); a hand-maintained file with lines that cannot be imported is never taken over.
 * - Every other machine: a marker-delimited block inside `~/.ssh/authorized_keys`, inserted at the top so the person's
 *   own bytes (including a missing final newline) stay exactly as they were; removing the block restores them.
 *
 * Each Cindy profile on the machine writes its own block (`# >>> Cindy SSH access <profileKey> >>>`), so a release and a
 * development profile, or a desktop and a Host, never overwrite each other's keys.
 *
 * Writes are conflict-checked and atomic: the new content goes to a 0600 temporary file next to the target, the target is
 * read again and must still hold the bytes the content was computed from, then the temporary file is renamed over it.
 * `~/.ssh` is created 0700 when missing. A symlinked or non-regular file, an oversized file or a damaged Cindy block is
 * refused (AuthorizedKeysError UNSUPPORTED) instead of being rewritten. Files are handled as latin1 so bytes outside
 * ASCII round-trip unchanged; everything Cindy writes is ASCII.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSshEd25519PublicKey } from '@cindy/device-link';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

export const CLOUD_GUEST_AUTHORIZED_KEYS_FILE = 'cindy-owner-authorized-keys';
/** The first line of the cloud guest's derived file, exactly (boot gate contract with the cloud image). */
export const CLOUD_GUEST_FILE_MARKER = '# Managed by Cindy SSH access; manual edits are overwritten.';
/** The file the cloud image's boot unit moves the derived file to before sshd starts. */
export const CLOUD_GUEST_HELD_SUFFIX = '.held';
const MAX_FILE_BYTES = 1024 * 1024;
const PROFILE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const BLOCK_BEGIN = /^# >>> Cindy SSH access ([A-Za-z0-9_-]{1,64}) >>>$/;
const BLOCK_END = /^# <<< Cindy SSH access ([A-Za-z0-9_-]{1,64}) <<<$/;

export type AuthorizedKeysKind = 'cloud-guest' | 'user';

export interface AuthorizedKeysTarget {
  kind: AuthorizedKeysKind;
  sshDir: string;
  filePath: string;
}

export class AuthorizedKeysError extends Error {
  constructor(readonly code: 'UNSUPPORTED' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'AuthorizedKeysError';
  }
}

/** One derived line: `<ssh-ed25519 base64> <comment>`; the comment is `cindy-device:<id>` or `cindy-manual:<label>`. */
export interface AuthorizedKeyLine {
  publicKey: string;
  comment: string;
}

export interface AuthorizedKeysSnapshot {
  target: AuthorizedKeysTarget;
  profileKey: string;
  /** Exact file content (latin1), or null when the file does not exist. */
  content: string | null;
  /** Cloud guest only: the file exists and does not start with the marker. */
  unmanaged: boolean;
  /** Cloud guest unmanaged only: ed25519 keys found in it, in file order. */
  importable: Array<{ publicKey: string; comment: string | null }>;
  /** Cloud guest unmanaged only: key lines that cannot be imported (other key types, options). */
  unimportable: number;
  /** Public keys currently inside this profile's block. */
  current: string[];
}

export function authorizedKeysTarget(homeDir: string, kind: AuthorizedKeysKind): AuthorizedKeysTarget {
  const sshDir = path.join(homeDir, '.ssh');
  return { kind, sshDir, filePath: path.join(sshDir, kind === 'cloud-guest' ? CLOUD_GUEST_AUTHORIZED_KEYS_FILE : 'authorized_keys') };
}

const begin = (profileKey: string) => `# >>> Cindy SSH access ${profileKey} >>>`;
const end = (profileKey: string) => `# <<< Cindy SSH access ${profileKey} <<<`;

/** Physical lines with their own terminators, so joining them gives back the exact content. */
function segments(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const text = (segment: string) => segment.replace(/\r?\n$/, '');

interface Block { profileKey: string; from: number; to: number }

/** Every Cindy block in file order; a damaged block (nested, unclosed, stray end) is refused. */
function blocks(lines: string[]): Block[] {
  const found: Block[] = [];
  let open: { profileKey: string; from: number } | null = null;
  lines.forEach((segment, index) => {
    const line = text(segment);
    const opened = BLOCK_BEGIN.exec(line);
    const closed = BLOCK_END.exec(line);
    if (opened) {
      if (open) throw new AuthorizedKeysError('UNSUPPORTED', 'nested Cindy SSH access block');
      open = { profileKey: opened[1]!, from: index };
    } else if (closed) {
      if (!open || open.profileKey !== closed[1]) throw new AuthorizedKeysError('UNSUPPORTED', 'unmatched Cindy SSH access block end');
      found.push({ ...open, to: index });
      open = null;
    }
  });
  if (open) throw new AuthorizedKeysError('UNSUPPORTED', 'unclosed Cindy SSH access block');
  const keys = found.map((block) => block.profileKey);
  if (new Set(keys).size !== keys.length) throw new AuthorizedKeysError('UNSUPPORTED', 'duplicate Cindy SSH access block');
  return found;
}

async function readExact(filePath: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new AuthorizedKeysError('UNSUPPORTED', 'authorized keys path is not a regular file');
  if (stat.size > MAX_FILE_BYTES) throw new AuthorizedKeysError('UNSUPPORTED', 'authorized keys file is too large');
  // O_NOFOLLOW closes the window between lstat and open; the platforms that support SSH access all define it.
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new AuthorizedKeysError('UNSUPPORTED', 'authorized keys file is too large');
    return bytes.toString('latin1');
  } finally {
    await handle.close();
  }
}

/** Reads the target file and this profile's block. Throws AuthorizedKeysError UNSUPPORTED for files Cindy must not rewrite. */
export async function readAuthorizedKeys(target: AuthorizedKeysTarget, profileKey: string): Promise<AuthorizedKeysSnapshot> {
  if (!PROFILE_KEY.test(profileKey)) throw new Error('invalid SSH access profile key');
  const content = await readExact(target.filePath);
  const lines = content === null ? [] : segments(content);
  const unmanaged = target.kind === 'cloud-guest' && content !== null && content.length > 0
    && text(lines[0] ?? '') !== CLOUD_GUEST_FILE_MARKER;
  const importable: AuthorizedKeysSnapshot['importable'] = [];
  let unimportable = 0;
  if (unmanaged) {
    for (const segment of lines) {
      const line = text(segment).trim();
      if (!line || line.startsWith('#')) continue;
      const key = parseSshEd25519PublicKey(line);
      if (key) importable.push(key);
      else unimportable += 1;
    }
    return { target, profileKey, content, unmanaged, importable, unimportable, current: [] };
  }
  const own = blocks(lines).find((block) => block.profileKey === profileKey);
  const current = own ? lines.slice(own.from + 1, own.to)
    .map((segment) => parseSshEd25519PublicKey(text(segment))?.publicKey)
    .filter((key): key is string => !!key) : [];
  return { target, profileKey, content, unmanaged, importable, unimportable, current };
}

function renderBlock(profileKey: string, lines: readonly AuthorizedKeyLine[]): string {
  if (!lines.length) return '';
  return [begin(profileKey), ...lines.map((line) => `${line.publicKey} ${line.comment}`), end(profileKey)].join('\n') + '\n';
}

/**
 * The content to write so this profile's block holds exactly `lines`, or null when nothing needs to change. A
 * hand-maintained cloud guest file stays untouched unless `takeOver` (its keys were imported first).
 */
export function renderAuthorizedKeys(
  snapshot: AuthorizedKeysSnapshot,
  lines: readonly AuthorizedKeyLine[],
  options: { takeOver?: boolean } = {},
): string | null {
  for (const line of lines) {
    if (!parseSshEd25519PublicKey(line.publicKey) || !/^cindy-(?:device|manual):[A-Za-z0-9._:@-]{1,128}$/.test(line.comment))
      throw new Error('invalid derived authorized key line');
  }
  const { profileKey } = snapshot;
  const block = renderBlock(profileKey, lines);
  let next: string;
  if (snapshot.target.kind === 'cloud-guest') {
    if (snapshot.unmanaged && !options.takeOver) return null;
    // Cindy's file: the marker, then the Cindy blocks (other profiles' verbatim); anything else is dropped.
    const existing = snapshot.unmanaged || snapshot.content === null ? [] : segments(snapshot.content);
    const kept: string[] = [];
    let placed = false;
    for (const item of blocks(existing)) {
      if (item.profileKey === profileKey) { kept.push(block); placed = true; continue; }
      const verbatim = existing.slice(item.from, item.to + 1).join('');
      kept.push(verbatim.endsWith('\n') ? verbatim : `${verbatim}\n`);
    }
    if (!placed) kept.push(block);
    next = `${CLOUD_GUEST_FILE_MARKER}\n${kept.join('')}`;
  } else {
    const existing = snapshot.content === null ? [] : segments(snapshot.content);
    const own = blocks(existing).find((item) => item.profileKey === profileKey);
    if (own) {
      next = existing.slice(0, own.from).join('') + block + existing.slice(own.to + 1).join('');
    } else {
      if (!block) return null;
      next = block + (snapshot.content ?? '');
    }
  }
  return next === snapshot.content ? null : next;
}

/** Atomically replaces the file with `next`, refusing when it changed since `snapshot` was read. */
export async function writeAuthorizedKeys(snapshot: AuthorizedKeysSnapshot, next: string): Promise<void> {
  const { target } = snapshot;
  await fs.mkdir(target.sshDir, { recursive: true, mode: 0o700 });
  await withCrossProcessLock(`${target.filePath}.cindy.lock`, { label: 'ssh-authorized-keys', waitMs: 12_000 }, async (lock) => {
    if (!lock.held) throw new AuthorizedKeysError('CONFLICT', 'authorized keys file is busy in another process');
    const temp = path.join(target.sshDir, `.${path.basename(target.filePath)}.cindy-${process.pid}-${randomBytes(6).toString('hex')}`);
    try {
      await fs.writeFile(temp, Buffer.from(next, 'latin1'), { flag: 'wx', mode: 0o600 });
      await fs.chmod(temp, 0o600);
      if (await readExact(target.filePath) !== snapshot.content) {
        throw new AuthorizedKeysError('CONFLICT', 'authorized keys file changed while Cindy was updating it');
      }
      await fs.rename(temp, target.filePath);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Cloud guest boot gate (item 12): once the derived file has been rewritten after start, the copy the image moved aside
 * is obsolete. Only a Cindy-managed copy (starting with the marker) is removed. Returns whether a file was removed.
 */
export async function removeHeldCloudGuestFile(homeDir: string): Promise<boolean> {
  const held = authorizedKeysTarget(homeDir, 'cloud-guest').filePath + CLOUD_GUEST_HELD_SUFFIX;
  let content: string | null;
  try {
    content = await readExact(held);
  } catch (error) {
    if (error instanceof AuthorizedKeysError) return false;
    throw error;
  }
  if (content === null || text(segments(content)[0] ?? '') !== CLOUD_GUEST_FILE_MARKER) return false;
  await fs.unlink(held);
  return true;
}
