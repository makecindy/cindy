import { releaseFailure, type ProfileHold } from './profile-hold.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  findConcurrentLiveInstancePids, parseRegisteredInstanceCandidate, recordedPidMayStillBeLive,
  type ConcurrentInstanceScanDeps,
} from '../../../desktop/src/main/concurrentInstanceScan.js';
import {
  readProcessIdentities,
  type ProcessIdentitySnapshot,
} from '../../../desktop/src/main/processIdentity.js';
import { explicitPorts } from './explicit-ports.js';

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
 * opens the database). Everything else is a desktop that opens the database: a record without
 * `runtime` (older desktops), a `passive: true` dev instance (it skips migrations and the scheduler but
 * opens and writes the same database: localDb/index.ts 171–197), a record that cannot be read, a PID
 * seen only through the SingletonLock.
 */
export const HOST_PROFILE_IN_USE_BY_DESKTOP = 'HOST_PROFILE_IN_USE_BY_DESKTOP';

/**
 * The Host's start refused because a desktop that opens this profile's database is running. Its own
 * code: `DB_SCHEMA_LOCKED` names the database migration lease, which this is not.
 */
export class HostProfileInUseError extends Error {
  readonly code = HOST_PROFILE_IN_USE_BY_DESKTOP;
  constructor(message: string) {
    super(message);
    this.name = 'HostProfileInUseError';
  }
}

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

interface Registration {
  fingerprint: string;
  recordedAtMs?: number;
  rootDir?: string;
  client: boolean;
}

type StartupScanResult = 'clear' | 'desktop' | 'unknown' | 'deadline';
interface StartupScanClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const startupClock: StartupScanClock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
const STARTUP_RECHECK_DELAYS_MS = [500, 1_000, 2_000];
const STARTUP_RECHECK_BUDGET_MS = 10_000;
type ReportRound = (round: number, elapsedMs: number, result: StartupScanResult) => void;

/**
 * One scan of a profile for desktops that open its database. Returns their PIDs (empty: none).
 *
 * Runtime scans cache positive identities. An uncertain startup rereads both the registry and the OS.
 * Between runtime scans, a live PID's OS identity is kept with the record
 * text (or the SingletonLock target and time) it was read for, and asked again only when that
 * changes. While a desktop runs, its record does not change, so a rescan starts no `ps`. An identity
 * the OS did not give is not kept (it is asked again; meanwhile the PID counts as live, as the scan
 * treats it). Throws when the registry exists but cannot be read, as the desktop's scan does.
 */
export function createDesktopScanner(profileDir: string, ports: ProfileScanPorts = nodeProfileScanPorts,
  clock: StartupScanClock = startupClock) {
  const identities = new Map<string, ProcessIdentitySnapshot>();

  // Capture only the provenance the shared scanner actually read. Its canonical/backup
  // handling, profile matching and PID-reuse decisions stay authoritative.
  async function discover(identityFor: (pid: number, registration?: Registration) => ProcessIdentitySnapshot | null) {
    const registrations = new Map<number, Registration>();
    let lock: { pid: number; target: string } | undefined;
    const live = await findConcurrentLiveInstancePids(explicitPorts<ConcurrentInstanceScanDeps>({
      readdir: ports.readdir, selfPid: ports.selfPid, isPidAlive: ports.isPidAlive,
      readFile: async file => {
        const raw = await ports.readFile(file);
        const name = path.basename(file).replace(/\.bak$/, '');
        const entry = parseRegisteredInstanceCandidate(raw, name);
        if (entry) registrations.set(entry.pid, { fingerprint: `registry\u0000${raw}`, client: allowedBesideHost(raw),
          recordedAtMs: entry.recordedAtMs, rootDir: entry.rootDir });
        return raw;
      },
      readlink: async file => {
        const target = await ports.readlink(file);
        const match = /-(\d+)$/.exec(target);
        if (match) lock = { pid: Number(match[1]), target };
        return target;
      },
      lstat: async file => {
        // The shared scanner asks for the lock identity only after this stat (also when it fails).
        let mtimeMs: number | undefined;
        try { const stat = await ports.lstat(file); mtimeMs = stat.mtimeMs; return stat; }
        finally {
          if (lock) registrations.set(lock.pid, { fingerprint: `lock\u0000${lock.target}\u0000${mtimeMs}`,
            client: false, recordedAtMs: mtimeMs });
        }
      },
      readProcessIdentity: pid => identityFor(pid, registrations.get(pid)),
    }), profileDir);
    return new Map(live.filter(pid => !registrations.get(pid)?.client).map(pid => [pid, registrations.get(pid)!]));
  }

  async function scanRound(previous?: Map<number, Registration>) {
    const candidates = await discover(() => null);
    const key = (pid: number, entry: Registration) => `${pid}\u0000${entry.fingerprint}`;
    const query = new Map(candidates);
    // A vanished registration alone cannot clear a still-live, unidentified PID.
    for (const [pid, entry] of previous ?? []) if (!query.has(pid) && ports.isPidAlive(pid)) query.set(pid, entry);
    const keys = new Set([...query].map(([pid, entry]) => key(pid, entry)));
    for (const cached of identities.keys()) if (previous || !keys.has(cached)) identities.delete(cached);
    const ask = [...query].filter(([pid, entry]) => !identities.has(key(pid, entry))).map(([pid]) => pid);
    if (ask.length) {
      for (const [pid, identity] of await ports.readProcessIdentities(ask)) {
        if (identity) identities.set(key(pid, query.get(pid)!), identity);
      }
    }
    const identityFor = (pid: number, entry?: Registration) => entry ? identities.get(key(pid, entry)) ?? null : null;
    // Re-read after the OS query. A replacement record cannot inherit its predecessor's evidence.
    const blockers = await discover(identityFor);
    for (const [pid, entry] of query) {
      if (!blockers.has(pid) && ports.isPidAlive(pid) &&
          recordedPidMayStillBeLive(entry.recordedAtMs, entry.rootDir, identityFor(pid, entry))) blockers.set(pid, entry);
    }
    const confirmed = [...blockers].some(([pid, entry]) => identityFor(pid, entry) !== null ||
      (previous !== undefined && previous.get(pid)?.fingerprint !== entry.fingerprint));
    return { blockers, confirmed };
  }

  return async function scan(report?: ReportRound): Promise<number[]> {
    if (!report) return [...(await scanRound()).blockers.keys()];
    const start = clock.now();
    const retryDeadline = start + STARTUP_RECHECK_BUDGET_MS;
    let previous: Map<number, Registration> | undefined;
    for (let round = 1; ; round++) {
      const { blockers, confirmed } = await scanRound(previous);
      const result = !blockers.size ? 'clear' : confirmed ? 'desktop' : 'unknown';
      const now = clock.now();
      report(round, Math.round(now - start), result);
      const delay = STARTUP_RECHECK_DELAYS_MS[round - 1];
      if (result !== 'unknown' || delay === undefined) return [...blockers.keys()];

      // Budget the wait for another observation. A completed scan always decides.
      if (now + delay <= retryDeadline) {
        await clock.sleep(delay);
        if (clock.now() <= retryDeadline) {
          previous = blockers;
          continue;
        }
      }
      report(round, Math.round(clock.now() - start), 'deadline');
      return [...blockers.keys()];
    }
  };
}

/** A client of a Host. Anything else (a passive instance, an unreadable record, no field) is not. */
function allowedBesideHost(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const record = JSON.parse(raw) as { runtime?: unknown } | null;
    return record?.runtime === 'client';
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

interface ProfilePluginRuntime {
  pauseForDesktop(message: ProfileHold): void;
  pluginPauseFailure(): unknown;
  resumeAfterDesktop(): Promise<boolean>;
}

interface HostProfileCoexistenceOptions extends Omit<CoexistenceMonitorOptions, 'onScan'> {
  message: string;
  isCurrent(): boolean;
  input: {
    isHeldForDesktop(): boolean;
    holdForDesktop(message: string): void;
    releaseDesktopHold(): Promise<boolean>;
  };
  getPlugins(): ProfilePluginRuntime | null;
  refreshPlugins(): Promise<void> | undefined;
  setState(state: { state: CoexistenceState['state'] | 'waiting-for-turns'; desktops: number[] }): void;
  onInputReleased(): void;
}

/** The input and plugin gates share the actual monitor's scan and rebuild boundaries. */
export function createHostProfileCoexistenceMonitor(options: HostProfileCoexistenceOptions): CoexistenceMonitor {
  const { input, log, isCurrent, getPlugins, setState } = options;
  let releasingInput = false;
  function resumePlugins() {
    const plugins = getPlugins();
    if (!plugins?.pluginPauseFailure()) return;
    void plugins.resumeAfterDesktop().then(resumed => {
      if (resumed && isCurrent() && getPlugins() === plugins && !plugins.pluginPauseFailure()) return options.refreshPlugins();
    }).catch((error: unknown) => log.warn('resuming plugins after profile hold failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const monitor = createCoexistenceMonitor({
    ...options,
    onScan: state => {
      if (!isCurrent()) return;
      if (state.state === 'desktop-running') {
        if (!input.isHeldForDesktop()) log.warn('a desktop opened this profile; new sends are held', { pids: state.desktops });
        input.holdForDesktop(options.message);
        getPlugins()?.pauseForDesktop(options.message);
        setState({ ...state });
        return;
      }
      if (!input.isHeldForDesktop()) {
        setState({ ...state });
        resumePlugins();
        return;
      }
      setState({ state: 'waiting-for-turns', desktops: [] });
      if (releasingInput) return;
      releasingInput = true;
      void input.releaseDesktopHold().then(released => {
        if (!released || !isCurrent() || monitor.state().state !== 'clear' || input.isHeldForDesktop()) return;
        setState({ state: 'clear', desktops: [] });
        resumePlugins();
        options.onInputReleased();
      }, (error: unknown) => {
        if (isCurrent() && monitor.state().state === 'clear' && input.isHeldForDesktop()) getPlugins()?.pauseForDesktop(releaseFailure());
        log.warn('releasing the profile hold failed', { error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { releasingInput = false; });
    },
  });
  return monitor;
}

