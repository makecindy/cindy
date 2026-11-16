import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  findConcurrentLiveInstancePids,
  type ConcurrentInstanceScanDeps,
} from '../../../desktop/src/main/concurrentInstanceScan.ts';
import {
  readProcessIdentities,
  type ProcessIdentitySnapshot,
} from '../../../desktop/src/main/processIdentity.ts';
import { explicitPorts } from './explicit-ports.ts';

/**
 * The Host and a desktop that opens the same profile's database (coexistence plan A, release table).
 *
 * Until a desktop started beside a running Host connects to it (plan B), the Host refuses to start
 * on a profile a desktop is using, and while it runs it rescans: once a desktop that opens the
 * database is live there, it accepts no new sends until the desktop is gone. Desktops are found with
 * the desktop's own scan of `.dev-instances` and the Chromium SingletonLock (concurrentInstanceScan.ts),
 * which keeps its stale-PID proofs in this process. The Host does not register in `.dev-instances`.
 *
 * Allowed beside the Host: a record that says `runtime: 'client'` (a client of a Host, which never
 * opens the database) or `passive: true` (a passive dev instance). Everything else is a desktop that
 * opens the database: a record without `runtime` (older desktops), a record that cannot be read, a
 * PID seen only through the SingletonLock.
 */
export const HOST_PROFILE_IN_USE_BY_DESKTOP = 'HOST_PROFILE_IN_USE_BY_DESKTOP';

export interface ProfileScanPorts {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  readlink(file: string): Promise<string>;
  lstat(file: string): Promise<{ isDirectory(): boolean; mtimeMs?: number }>;
  selfPid(): number;
  isPidAlive(pid: number): boolean;
  /** The OS identity of live PIDs (one `ps` or PowerShell query for the batch). */
  readProcessIdentities(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessIdentitySnapshot | null>>;
}

export const nodeProfileScanPorts: ProfileScanPorts = {
  readdir: dir => fsp.readdir(dir),
  readFile: file => fsp.readFile(file, 'utf8'),
  readlink: file => fsp.readlink(file),
  lstat: file => fsp.lstat(file),
  selfPid: () => process.pid,
  isPidAlive: pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  readProcessIdentities: pids => readProcessIdentities(pids),
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const RECORD = /^(\d+)\.json(\.bak)?$/;

/**
 * One scan of a profile for desktops that open its database. Returns their PIDs (empty: none).
 *
 * Process identities are asked once per record: a live PID's OS identity is kept with the record
 * text (or the SingletonLock target and time) it was read for, and asked again only when that
 * changes. While a desktop runs, its record does not change, so a rescan starts no `ps`. An identity
 * the OS did not give is not kept (it is asked again; meanwhile the PID counts as live, as the scan
 * treats it). Throws when the registry exists but cannot be read, as the desktop's scan does.
 */
export function createDesktopScanner(profileDir: string, ports: ProfileScanPorts = nodeProfileScanPorts) {
  const registry = path.join(profileDir, '.dev-instances');
  const lockPath = path.join(profileDir, 'SingletonLock');
  const identities = new Map<string, ProcessIdentitySnapshot>();

  async function readRecords(): Promise<Map<number, string>> {
    let names: string[];
    try { names = await ports.readdir(registry); }
    catch (error) { if (isMissing(error)) return new Map(); throw error; }
    const records = new Map<number, string>();
    for (const name of names.sort()) {
      const match = RECORD.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (match[2] && records.has(pid)) continue; // `<pid>.json` (sorted first) wins over its backup
      try { records.set(pid, await ports.readFile(path.join(registry, name))); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    return records;
  }

  async function lockFingerprint(): Promise<{ pid: number; fingerprint: string } | null> {
    try {
      const target = await ports.readlink(lockPath);
      const match = /-(\d+)$/.exec(target);
      if (!match) return null;
      let mtime: number | undefined;
      try { mtime = (await ports.lstat(lockPath)).mtimeMs; } catch { /* the scan keeps such a PID live */ }
      return { pid: Number(match[1]), fingerprint: `lock\u0000${target}\u0000${mtime}` };
    } catch { return null; }
  }

  return async function scan(): Promise<number[]> {
    const records = await readRecords();
    const fingerprints = new Map<number, string>();
    for (const [pid, raw] of records) fingerprints.set(pid, `registry\u0000${raw}`);
    const lock = await lockFingerprint();
    if (lock && !fingerprints.has(lock.pid)) fingerprints.set(lock.pid, lock.fingerprint);
    const key = (pid: number) => `${pid}\u0000${fingerprints.get(pid)}`;
    const ask = [...fingerprints.keys()].filter(pid => pid !== ports.selfPid() && ports.isPidAlive(pid) && !identities.has(key(pid)));
    if (ask.length) {
      for (const [pid, identity] of await ports.readProcessIdentities(ask)) if (identity) identities.set(key(pid), identity);
    }
    // Forget identities of records that are gone or changed.
    const current = new Set([...fingerprints.keys()].map(key));
    for (const known of [...identities.keys()]) if (!current.has(known)) identities.delete(known);

    const live = await findConcurrentLiveInstancePids(explicitPorts<ConcurrentInstanceScanDeps>({
      readdir: ports.readdir, readFile: ports.readFile, readlink: ports.readlink, lstat: ports.lstat,
      selfPid: ports.selfPid, isPidAlive: ports.isPidAlive,
      // Synchronous: answered from the identities read above for this very record.
      readProcessIdentity: pid => (fingerprints.has(pid) ? identities.get(key(pid)) ?? null : null),
    }), profileDir);
    return live.filter(pid => !allowedBesideHost(records.get(pid)));
  };
}

/** A client of a Host, or a passive dev instance. Anything unreadable or without the field is not. */
function allowedBesideHost(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const record = JSON.parse(raw) as { runtime?: unknown; passive?: unknown } | null;
    return record?.runtime === 'client' || record?.passive === true;
  } catch { return false; }
}

export interface CoexistenceState {
  /** `clear`: no desktop opens this profile's database; `desktop-running`: one does (PIDs below). */
  state: 'clear' | 'desktop-running';
  /** PIDs only: no paths or command lines. */
  desktops: number[];
}

export interface CoexistenceTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CoexistenceMonitor {
  /** Start rescanning on the interval and on registry changes. */
  start(): void;
  scanNow(): Promise<void>;
  state(): CoexistenceState;
  stop(): void;
}

export interface CoexistenceMonitorOptions {
  scan(): Promise<number[]>;
  /** The `.dev-instances` directory; watched while it exists, rescanned on the interval regardless. */
  registryDir: string;
  /**
   * After every scan: `desktop-running` closes the gate (or keeps it closed); `clear` comes only
   * after two clean scans in a row and repeats on each later clean scan, so a reopen that had to wait
   * (a turn still running) is tried again. Both must be safe to receive repeatedly.
   */
  onScan(state: CoexistenceState): void;
  log: { warn(message: string, fields?: Record<string, unknown>): void };
  intervalMs?: number;
  debounceMs?: number;
  timers?: CoexistenceTimers;
  watch?(dir: string, listener: () => void): { close(): void };
}

export const COEXISTENCE_RESCAN_MS = 10_000;
const WATCH_DEBOUNCE_MS = 250;

/**
 * Rescans every 10 seconds and on changes in `.dev-instances` (debounced). One scan at a time; a
 * trigger during a scan runs one more after it. A desktop is reported at once; clear only after two
 * clean scans in a row, so a desktop restarting (old record gone, new one not yet written) does not
 * open the gate in between. A scan that fails is reported as a desktop (fail closed), with no PIDs.
 */
export function createCoexistenceMonitor(options: CoexistenceMonitorOptions): CoexistenceMonitor {
  const timers: CoexistenceTimers = options.timers ?? {
    setInterval: (fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle; },
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const watch = options.watch ?? ((dir, listener) => fs.watch(dir, { persistent: false }, () => listener()));
  let state: CoexistenceState = { state: 'clear', desktops: [] };
  let cleanScans = 2;
  let running: Promise<void> | null = null;
  let again = false;
  let interval: unknown = null;
  let debounce: unknown = null;
  let watcher: { close(): void } | null = null;
  let stopped = false;

  function ensureWatcher() {
    if (watcher || stopped) return;
    try {
      watcher = watch(options.registryDir, () => {
        if (debounce !== null) timers.clearTimeout(debounce);
        debounce = timers.setTimeout(() => { debounce = null; void scanNow(); }, options.debounceMs ?? WATCH_DEBOUNCE_MS);
      });
    } catch { watcher = null; } // no registry yet: the interval scan keeps looking
  }

  async function runScan() {
    let desktops: number[] | null;
    try { desktops = [...new Set(await options.scan())].sort((a, b) => a - b); }
    catch (error) {
      options.log.warn('profile coexistence scan failed; treating the profile as in use', {
        error: error instanceof Error ? error.message : String(error),
      });
      desktops = null;
    }
    if (desktops === null || desktops.length) {
      cleanScans = 0;
      state = { state: 'desktop-running', desktops: desktops ?? [] };
    } else {
      cleanScans += 1;
      if (cleanScans >= 2) state = { state: 'clear', desktops: [] };
    }
    ensureWatcher();
    if (!stopped) options.onScan(state);
  }

  function scanNow(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await runScan(); } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  return {
    start() {
      if (interval !== null || stopped) return;
      interval = timers.setInterval(() => { void scanNow(); }, options.intervalMs ?? COEXISTENCE_RESCAN_MS);
      ensureWatcher();
    },
    scanNow,
    state: (): CoexistenceState => state,
    stop() {
      stopped = true;
      if (interval !== null) timers.clearInterval(interval);
      if (debounce !== null) timers.clearTimeout(debounce);
      interval = null; debounce = null;
      watcher?.close(); watcher = null;
    },
  };
}

