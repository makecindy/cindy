/**
 * Ends SSH sessions of keys that just lost access on this target (decision 11, 2026-11-26). Linux first; macOS only
 * supports "end all" for now. Shared by the desktop and the Node Host; no Electron imports.
 *
 * OpenSSH runs each login as a root-owned monitor (`sshd: <user> [priv]`, or `sshd-session: <user> [priv]` from 9.8)
 * with an unprivileged child owned by the user (`sshd: <user>@pts/0` / `sshd-session: <user>@notty`). Ending that child
 * closes the connection. This module only ever signals such children: same uid as Cindy, named for Cindy's own OS user,
 * never root-owned processes or the daemon, and never the session Cindy itself runs in.
 *
 * Which key a session used:
 * 1. `SSH_USER_AUTH` (sshd `ExposeAuthInfo yes`, set on Cindy cloud images): the environment of the session's shell
 *    names a file listing the exact public key. Preferred when present.
 * 2. Otherwise the sshd log line of the monitor PID: `Accepted publickey for <user> from <ip> port <p> ssh2: ED25519
 *    SHA256:<fp>` (journald, else /var/log/auth.log; the Ubuntu cloud user is in group adm). The last line for a live
 *    monitor PID is that monitor's own login.
 * A session whose key cannot be determined is reported as unmapped and left running; this module never ends every
 * session on its own. Ending all same-user sessions is a separate, explicitly confirmed action.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSshEd25519PublicKey } from '@cindy/device-link';
import { sshKeyFingerprint } from './sshAccessRecord.js';

const execFileAsync = promisify(execFile);
const KILL_GRACE_MS = 2_000;
const MAX_AUTH_INFO_BYTES = 64 * 1024;
const MAX_AUTH_LOG_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;

export interface SshProcess {
  pid: number;
  ppid: number;
  uid: number;
  command: string;
}

export interface SessionTerminatorPorts {
  platform: NodeJS.Platform | string;
  /** Cindy's OS user name and uid; only that user's session processes are ever signalled. */
  user: string;
  uid: number;
  /** This process; the SSH session it runs inside (if any) is never ended. */
  selfPid: number;
  listProcesses(): Promise<SshProcess[]>;
  /** NUL-separated environment of a same-user process, or null when unreadable. */
  readEnviron(pid: number): Promise<string | null>;
  /** The `SSH_USER_AUTH` file named by a session, or null when it is not a safe, readable file. */
  readAuthInfo(file: string): Promise<string | null>;
  /** sshd log text that mentions these monitor PIDs (journald, else auth.log); empty when unreadable. */
  readAuthLog(monitorPids: readonly number[]): Promise<string>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  wait(ms: number): Promise<void>;
}

export interface SessionTerminationReport {
  /** False where this cannot work yet (fingerprint mapping off Linux; everything off macOS/Linux). */
  supported: boolean;
  terminated: number;
  /** Sessions of this user whose key could not be determined; they keep running. */
  unmapped: number;
}

export interface SessionTerminator {
  /**
   * Whether this computer can end the sessions of particular keys (terminateFingerprints): Linux, not running as root.
   * Elsewhere a revoked key's open sessions keep running; the settings UI says so before the person revokes a device.
   */
  readonly endsKeySessions: boolean;
  terminateFingerprints(fingerprints: ReadonlySet<string>): Promise<SessionTerminationReport>;
  terminateAll(): Promise<SessionTerminationReport>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACCEPTED = /\b(?:sshd|sshd-session)\[(\d+)\]: Accepted publickey for (\S+) from \S+ port \d+ ssh2: [A-Z0-9-]+ (SHA256:[A-Za-z0-9+/]{43})\b/;

/** Parses `ps -eo pid=,ppid=,uid=,args=` output. */
export function parseProcessTable(output: string): SshProcess[] {
  const rows: SshProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), command: match[4]! });
  }
  return rows;
}

/** Monitor PID → fingerprint of the key its login was accepted with (the last line per PID wins). */
export function parseAcceptedPublickeyLog(log: string, user: string): Map<number, string> {
  const byMonitor = new Map<number, string>();
  for (const line of log.split('\n')) {
    const match = ACCEPTED.exec(line);
    if (match && match[2] === user) byMonitor.set(Number(match[1]), match[3]!);
  }
  return byMonitor;
}

export function createSessionTerminator(ports: SessionTerminatorPorts): SessionTerminator {
  const session = new RegExp(`^(?:sshd|sshd-session): ${escapeRegExp(ports.user)}@\\S+`);
  const identity = (row: SshProcess) => `${row.pid}:${row.ppid}:${row.uid}:${row.command}`;

  /** Same-user session children, minus the one this process runs in. */
  function sessionsOf(table: readonly SshProcess[]): SshProcess[] {
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const ancestors = new Set<number>();
    for (let pid: number | undefined = ports.selfPid, hops = 0; pid && hops < 64; hops += 1) {
      ancestors.add(pid);
      pid = byPid.get(pid)?.ppid;
    }
    return table.filter((row) => row.uid === ports.uid && session.test(row.command) && !ancestors.has(row.pid));
  }

  async function fingerprintFromAuthInfo(table: readonly SshProcess[], sessionPid: number): Promise<string | null> {
    for (const child of table) {
      if (child.ppid !== sessionPid || child.uid !== ports.uid) continue;
      const environ = await ports.readEnviron(child.pid);
      const file = environ?.split('\0').find((entry) => entry.startsWith('SSH_USER_AUTH='))?.slice('SSH_USER_AUTH='.length);
      const info = file ? await ports.readAuthInfo(file) : null;
      for (const line of info?.split('\n') ?? []) {
        const key = /^publickey (.+)$/.exec(line.trim());
        const parsed = key ? parseSshEd25519PublicKey(key[1]) : null;
        if (parsed) return sshKeyFingerprint(parsed.publicKey);
      }
    }
    return null;
  }

  /** Signals the given sessions; a process that changed identity since the table was read is left alone. */
  async function end(targets: readonly SshProcess[]): Promise<number> {
    if (!targets.length) return 0;
    const live = async (wanted: ReadonlySet<string>) => (await ports.listProcesses()).filter((row) => wanted.has(identity(row)));
    const signalled = new Set<string>();
    for (const row of await live(new Set(targets.map(identity)))) {
      try { ports.kill(row.pid, 'SIGTERM'); signalled.add(identity(row)); } catch { /* already gone */ }
    }
    if (!signalled.size) return 0;
    await ports.wait(KILL_GRACE_MS);
    // Only a session that got SIGTERM and is still the same process is forced.
    for (const row of await live(signalled)) {
      try { ports.kill(row.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    return signalled.size;
  }

  // Running as root, "same user" would mean root's sessions: never touch those.
  const endsKeySessions = ports.platform === 'linux' && ports.uid !== 0;

  return {
    endsKeySessions,
    async terminateFingerprints(fingerprints) {
      if (!endsKeySessions) return { supported: false, terminated: 0, unmapped: 0 };
      if (!fingerprints.size) return { supported: true, terminated: 0, unmapped: 0 };
      const table = await ports.listProcesses();
      const sessions = sessionsOf(table);
      const mapped = new Map<number, string>();
      for (const row of sessions) {
        const fingerprint = await fingerprintFromAuthInfo(table, row.pid);
        if (fingerprint) mapped.set(row.pid, fingerprint);
      }
      const unknown = sessions.filter((row) => !mapped.has(row.pid));
      if (unknown.length) {
        const fromLog = parseAcceptedPublickeyLog(await ports.readAuthLog([...new Set(unknown.map((row) => row.ppid))]), ports.user);
        for (const row of unknown) {
          const fingerprint = fromLog.get(row.ppid);
          if (fingerprint) mapped.set(row.pid, fingerprint);
        }
      }
      const targets = sessions.filter((row) => fingerprints.has(mapped.get(row.pid) ?? ''));
      const unmapped = sessions.filter((row) => !mapped.has(row.pid)).length;
      return { supported: true, terminated: await end(targets), unmapped };
    },
    async terminateAll() {
      if ((ports.platform !== 'linux' && ports.platform !== 'darwin') || ports.uid === 0) return { supported: false, terminated: 0, unmapped: 0 };
      return { supported: true, terminated: await end(sessionsOf(await ports.listProcesses())), unmapped: 0 };
    },
  };
}

/** Reads up to `max` bytes from the start; works for /proc files, whose size reads as 0. */
async function readHead(file: string, max: number): Promise<string | null> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < max) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, max - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** The last `max` bytes of a regular file (the newest log lines). */
async function readTail(file: string, max: number): Promise<string | null> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, max);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** The Node implementation: `ps`, /proc, journalctl or /var/log/auth.log, process.kill. */
export function nodeSessionTerminatorPorts(platform: NodeJS.Platform | string = process.platform): SessionTerminatorPorts {
  const info = os.userInfo();
  return {
    platform,
    user: info.username,
    uid: info.uid,
    selfPid: process.pid,
    async listProcesses() {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,uid=,args='], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      return parseProcessTable(stdout);
    },
    readEnviron: (pid) => readHead(`/proc/${pid}/environ`, 256 * 1024),
    async readAuthInfo(file) {
      // sshd writes it as `<tmp>/sshauth.XXXX`, owned by the user; anything else is not followed.
      if (!path.isAbsolute(file) || !/^sshauth\.[A-Za-z0-9]+$/.test(path.basename(file))) return null;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.uid !== info.uid) return null;
      return readHead(file, MAX_AUTH_INFO_BYTES);
    },
    async readAuthLog(monitorPids) {
      if (!monitorPids.length) return '';
      try {
        const { stdout } = await execFileAsync('journalctl', ['--no-pager', '-q', '-o', 'short', '-n', '2000',
          ...monitorPids.map((pid) => `_PID=${pid}`)], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
        if (stdout.trim()) return stdout;
      } catch { /* no journal access; try the syslog file */ }
      const wanted = new Set(monitorPids.map(String));
      const log = await readTail('/var/log/auth.log', MAX_AUTH_LOG_BYTES);
      return (log ?? '').split('\n').filter((line) => wanted.has(/\[(\d+)\]:/.exec(line)?.[1] ?? '')).join('\n');
    },
    kill: (pid, signal) => { process.kill(pid, signal); },
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  };
}
