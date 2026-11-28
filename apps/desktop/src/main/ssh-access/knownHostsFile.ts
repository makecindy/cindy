/**
 * `~/.ssh/cindy_known_hosts`: the host keys of the person's own devices for the terminal aliases Cindy writes into
 * `~/.ssh/cindy.conf` (each alias has `HostKeyAlias cindy-device-<id>`, `UserKnownHostsFile ~/.ssh/cindy_known_hosts`
 * and `StrictHostKeyChecking yes`, decision 8). Cindy owns this file; `~/.ssh/known_hosts` is never read or written.
 *
 * Lines are owned per HostKeyAlias: an update replaces exactly the lines of the aliases it names and keeps every
 * other line byte for byte, so two Cindy profiles or accounts on this computer never drop each other's devices.
 * Writes are conflict-checked and atomic: a 0600 temporary file next to the target, the target read again and
 * compared with the bytes the update was computed from, then a rename; `~/.ssh` is created 0700 when missing. A
 * symlink, a non-regular file or an oversized file is refused rather than rewritten. Desktop main only; no Electron.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { isDeviceHostKeyAlias } from './deviceHostNames.js';

export const CINDY_KNOWN_HOSTS_FILE = 'cindy_known_hosts';
/** First line of a file Cindy creates. Only informative: ownership is per alias, not by this line. */
export const CINDY_KNOWN_HOSTS_HEADER = '# Host keys of your own devices for the cindy-* SSH aliases. Cindy rewrites these lines.';
const MAX_FILE_BYTES = 1024 * 1024;
const WRITE_ATTEMPTS = 3;
const HOST_KEY = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{16,1400}={0,2}$/;

export class KnownHostsFileError extends Error {
  constructor(readonly code: 'UNSUPPORTED' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'KnownHostsFileError';
  }
}

export interface DeviceHostKeys {
  /** `cindy-device-<id>`. */
  hostKeyAlias: string;
  /** `<type> <base64>` lines as the device reported them; an empty list removes the alias's lines. */
  hostKeys: readonly string[];
}

export function cindyKnownHostsPath(homeDir: string): string {
  return path.join(homeDir, '.ssh', CINDY_KNOWN_HOSTS_FILE);
}

/** Exact content (latin1 so other bytes round-trip), or null when the file does not exist. */
async function readExact(filePath: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new KnownHostsFileError('UNSUPPORTED', 'cindy_known_hosts is not a regular file');
  if (stat.size > MAX_FILE_BYTES) throw new KnownHostsFileError('UNSUPPORTED', 'cindy_known_hosts is too large');
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new KnownHostsFileError('UNSUPPORTED', 'cindy_known_hosts is too large');
    return bytes.toString('latin1');
  } finally {
    await handle.close();
  }
}

/** The host field of a known_hosts line (after an optional `@marker`), or null for comments and blank lines. */
function hostField(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const words = trimmed.split(/\s+/);
  return (words[0]?.startsWith('@') ? words[1] : words[0]) ?? null;
}

/**
 * The next content with the named aliases' lines replaced where they stood (new aliases at the end), or null when
 * nothing changes; repeated updates of the same keys therefore never rewrite the file.
 */
export function renderCindyKnownHosts(content: string | null, entries: readonly DeviceHostKeys[]): string | null {
  const replaced = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isDeviceHostKeyAlias(entry.hostKeyAlias)) throw new Error('invalid device host key alias');
    const keys = [...new Set(entry.hostKeys)];
    if (keys.some((key) => !HOST_KEY.test(key))) throw new Error('invalid device host key');
    replaced.set(entry.hostKeyAlias, keys.map((key) => `${entry.hostKeyAlias} ${key}\n`));
  }
  const out: string[] = [];
  const placed = new Set<string>();
  for (const line of content?.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const host = hostField(line.replace(/\r?\n$/, ''));
    if (host === null || !replaced.has(host)) {
      out.push(line);
    } else if (!placed.has(host)) {
      placed.add(host);
      out.push(...replaced.get(host)!);
    }
  }
  const appended = [...replaced].filter(([alias]) => !placed.has(alias)).flatMap(([, lines]) => lines);
  if (appended.length) {
    if (!out.length) out.push(`${CINDY_KNOWN_HOSTS_HEADER}\n`);
    else if (!out[out.length - 1]!.endsWith('\n')) out[out.length - 1] += '\n';
    out.push(...appended);
  }
  const next = out.join('');
  return next === (content ?? '') ? null : next;
}

/**
 * Replaces the lines of the given aliases (and only those) in `~/.ssh/cindy_known_hosts`. Returns whether the file
 * changed. Throws KnownHostsFileError UNSUPPORTED for a file Cindy must not rewrite, CONFLICT when it kept changing.
 */
export async function updateCindyKnownHosts(homeDir: string, entries: readonly DeviceHostKeys[]): Promise<boolean> {
  const filePath = cindyKnownHostsPath(homeDir);
  const sshDir = path.dirname(filePath);
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  return withCrossProcessLock(`${filePath}.lock`, { label: 'cindy-known-hosts', waitMs: 12_000 }, async (lock) => {
    if (!lock.held) throw new KnownHostsFileError('CONFLICT', 'cindy_known_hosts is busy in another process');
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const content = await readExact(filePath);
      const next = renderCindyKnownHosts(content, entries);
      if (next === null) return false;
      const temp = path.join(sshDir, `.${CINDY_KNOWN_HOSTS_FILE}.cindy-${process.pid}-${randomBytes(6).toString('hex')}`);
      try {
        await fs.writeFile(temp, Buffer.from(next, 'latin1'), { flag: 'wx', mode: 0o600 });
        await fs.chmod(temp, 0o600);
        if (await readExact(filePath) !== content) {
          await fs.unlink(temp).catch(() => undefined);
          continue;
        }
        await fs.rename(temp, filePath);
        return true;
      } catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    throw new KnownHostsFileError('CONFLICT', 'cindy_known_hosts kept changing while Cindy was updating it');
  });
}
