/**
 * Claude Code orphan reaper.
 * ---------------------------------------------------------------------------
 * Why this exists:
 *   Claude Code is launched by maker-core through the Anthropic SDK. The SDK's
 *   abort path only terminates the direct `claude` child. On Windows that kill
 *   is a Win32 TerminateProcess call: it does not propagate to grandchildren,
 *   so stdio MCP servers started below `claude.exe` can survive as orphaned
 *   `node` processes after Cindy quits, restarts, or crashes.
 *
 * Timing trap:
 *   On a normal quit, this must run before maker-core asks the SDK to abort the
 *   Claude session. Once the direct `claude` process is dead, its child tree is
 *   reparented to System/init and the PPID chain that proves ownership is gone.
 *   That is why bootstrap-electron registers this reaper in lifecycle's
 *   awaited `pre-async` phase, before any concurrent teardown can stop the
 *   active sessions or their transports.
 *
 * Safety guarantees:
 *   - Current-session cleanup only targets `claude` processes whose parent is
 *     the current Electron main process, and only at quit time — the startup
 *     pass (`reapCurrentSession: false`) leaves them alone, so a session launched
 *     moments after a cold start is not misread as an orphan. The one exception
 *     is a ppid===self process that provably started before this one: it cannot
 *     be a child we spawned, so it is a previous instance's orphan whose PID we
 *     inherited via reuse, and it is reaped like any other historical orphan.
 *   - Historical cleanup requires both a Cindy-bundled Claude binary path marker
 *     (matching every current + historical userData dir name, plus dev-checkout
 *     `apps/claude-code-bin/` binaries) and a dead parent, so an active second
 *     Cindy instance is left alone.
 *   - External Claude installs (for example `/usr/local/bin/claude`) do not
 *     contain the Cindy marker and are not historical-orphan candidates.
 *   - Scan / kill failures are best-effort and never block app startup or quit.
 *   - Windows enumeration uses the Win32 Tool Help snapshot API through a
 *     native N-API module. It must not launch PowerShell during app startup:
 *     security products classify that child-process pattern as script attack.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  getAllProcesses,
  ProcessDataFlag,
  type IProcessInfo,
} from '@vscode/windows-process-tree';
import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { createLogger } from './logger';

const log = createLogger('claude-orphan-reaper');

/**
 * Build the lowercase command-line substrings that identify a Claude process
 * spawned from this product's bundled binary (`<userData>/claude-code/...`).
 *
 * Markers are compared lowercase so Windows paths whose case the shell may
 * normalize (e.g. `appdata\roaming\...`) still match. Update the path shape if
 * the packaged Claude binary ever moves out of `userData/claude-code/`.
 *
 * Markers cover every current + historical userData dir name (brand-identity
 * `legacyUserDataDirNames`): while retaining compatibility with legacy profiles, orphans
 * spawned by the pre-rename install still carry the old dir name in their
 * command line and must keep being recognized.
 */
export function buildClaudePathMarkers(dirNames: readonly string[]): string[] {
  return dirNames.flatMap((dirName) => {
    const dir = dirName.toLowerCase();
    return [
      `appdata\\roaming\\${dir}\\claude-code\\`,
      `appdata/roaming/${dir}/claude-code/`,
      `/library/application support/${dir}/claude-code/`,
    ];
  });
}

const CINDY_CLAUDE_PATH_MARKERS = [
  // 只认领本区域(+ 历史)userData 下的进程:同机双装时另一区域实例的
  // Claude 子进程属于对方,跨区域匹配会把人家活着的 agent 树误杀。
  ...buildClaudePathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION)),
  // Dev checkouts (and their current/legacy managed worktrees) launch the pinned binary from
  // <repo>/apps/claude-code-bin/<platform-arch>/ — without these markers a
  // dev-spawned orphan is misclassified as an external install and spared,
  // so every abrupt dev restart leaks a live agent tree mutating the workdir.
  'apps\\claude-code-bin\\',
  'apps/claude-code-bin/',
] as const;

const POSIX_CLAUDE_CMD_RE = /(^|[\s/"'])claude(\.exe)?($|[\s"'])/;
const POSIX_CLAUDE_CODE_CMD_RE = /(^|[\s/"'])claude-code($|[\s"'])/;
// pid ppid etime command — `etime` is a whitespace-free [[dd-]hh:]mm:ss token, so
// the command (which may contain spaces) is the greedy tail.
const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/;

// A ppid===self claude must be OLDER than this process by more than this margin
// before we treat it as a PID-reuse orphan. Our own children are always spawned
// after us (younger), so the margin only guards against clock/rounding skew
// between `ps etime`'s 1-second resolution and process.uptime(); it never lets a
// real current-session child be misread as an orphan and killed.
const PID_REUSE_SKEW_MS = 5_000;

/**
 * Parses a POSIX `ps -o etime=` value ([[dd-]hh:]mm:ss elapsed time) into
 * seconds. Returns null for anything that does not match, so an unexpected
 * column layout degrades to "creation time unknown" rather than a bogus age.
 */
export function parsePosixEtimeSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const days = match[1] ? Number.parseInt(match[1], 10) : 0;
  const hours = match[2] ? Number.parseInt(match[2], 10) : 0;
  const minutes = Number.parseInt(match[3], 10);
  const seconds = Number.parseInt(match[4], 10);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

export interface ReaperResult {
  scannedTotal: number;
  killedSelfSpawned: number;
  killedHistoricalOrphans: number;
  durationMs: number;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  cmdLine: string;
  // Epoch milliseconds when the process started, or undefined when the platform
  // could not supply it (older-than-us classification then stays conservative).
  createdAtMs?: number;
}

const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 1000;

// Serializes native enumerations. @vscode/windows-process-tree keeps a single
// module-level in-progress request: issuing getAllProcesses while a prior call is
// still running coalesces our callback onto that in-flight result. If a startup
// scan hits WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS and returns [] while its native
// call is still pending, a later quit-time scan could otherwise receive that
// stale snapshot — missing a claude.exe spawned after startup, right before
// `shutdown-maker` tears down transport. Chaining guarantees a fresh native
// enumeration is issued only after the previous one has actually drained.
let nativeSnapshotChain: Promise<unknown> = Promise.resolve();

function runNativeProcessSnapshot(): Promise<IProcessInfo[]> {
  return new Promise<IProcessInfo[]>((resolve, reject) => {
    try {
      getAllProcesses(resolve, ProcessDataFlag.CommandLine);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWindowsProcessSnapshot(): Promise<IProcessInfo[]> {
  // Phase 1 — wait for any in-flight native enumeration to drain before issuing
  // ours. The package hands every callback queued during one enumeration the
  // SAME snapshot and only clears `requestInProgress` after that callback drains,
  // so a call issued while a prior one is running would receive its (stale) list.
  // We cap the wait and, on expiry, return [] WITHOUT calling getAllProcesses —
  // enqueuing then would coalesce onto the stale in-flight scan.
  const previous = nativeSnapshotChain;
  const drained = await Promise.race([
    previous.then(
      () => true,
      () => true,
    ),
    delay(WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS).then(() => false),
  ]);
  if (!drained) {
    log.debug('windows process snapshot timed out waiting for prior scan', {
      timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    });
    return [];
  }

  // Phase 2 — the prior enumeration has drained (`requestInProgress` is false),
  // so this issues a FRESH native scan. Its deadline is armed only now, so time
  // spent waiting in phase 1 does not eat into this scan's budget (otherwise a
  // slow prior scan could make quit resolve [] before its fresh scan even runs,
  // missing the live Claude tree right before transport teardown).
  const nativeCall = runNativeProcessSnapshot();
  nativeSnapshotChain = nativeCall.then(
    () => undefined,
    () => undefined,
  );

  return new Promise<IProcessInfo[]>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.debug('windows process snapshot timed out', {
        timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
      });
      resolve([]);
    }, WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS);

    nativeCall.then(
      (processes) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(processes);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        log.debug('windows process snapshot failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        resolve([]);
      },
    );
  });
}

// The patched @vscode/windows-process-tree fills `creationTime` (epoch ms) via
// GetProcessTimes; upstream/unpatched builds and inaccessible processes omit it.
function readWindowsCreationTime(proc: IProcessInfo): number | undefined {
  const raw = (proc as { creationTime?: number }).creationTime;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

async function scanWindowsClaudeProcesses(): Promise<{
  rows: ProcessRow[];
  selfCreatedAtMs?: number;
}> {
  const processes = await getWindowsProcessSnapshot();
  const rows: ProcessRow[] = [];
  let selfCreatedAtMs: number | undefined;
  for (const proc of processes) {
    const createdAtMs = readWindowsCreationTime(proc);
    // Our own creation time comes from the same native clock as every candidate,
    // so PID-reuse orphans (from a previous instance) sort strictly before us.
    if (proc.pid === process.pid && createdAtMs !== undefined) {
      selfCreatedAtMs = createdAtMs;
    }
    if (proc.name.toLowerCase() === 'claude.exe') {
      rows.push({ pid: proc.pid, ppid: proc.ppid, cmdLine: proc.commandLine ?? '', createdAtMs });
    }
  }
  return { rows, selfCreatedAtMs };
}

function isClaudeCommandLine(cmdLine: string): boolean {
  return POSIX_CLAUDE_CMD_RE.test(cmdLine) || POSIX_CLAUDE_CODE_CMD_RE.test(cmdLine);
}

/**
 * POSIX scan parses the full `ps -A` once, then derives both the Claude rows
 * AND the global PPID → children map. The map lets the kill path walk the
 * tree in memory without spawning a `pgrep -P` per node (which is what the
 * first iteration did — O(depth) subprocess spawns per orphan, easily 4-8
 * pgrep invocations per target on a real tree).
 *
 * Windows uses `taskkill /T` which handles tree expansion in the OS itself,
 * so its scan only needs the Claude rows and returns an empty map.
 */
interface ScanResult {
  rows: ProcessRow[];
  childrenByParent: Map<number, number[]>;
  // Epoch milliseconds when THIS process started, used to tell PID-reuse orphans
  // (older than us) apart from children we spawned (younger). Undefined leaves
  // the classification conservative.
  selfCreatedAtMs?: number;
}

function scanPosixAllProcesses(): ScanResult {
  const result = spawnSync(
    'ps',
    ['-A', '-o', 'pid=,ppid=,etime=,command='],
    { encoding: 'utf8', timeout: 1500 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`ps exited with status ${result.status}`);
  }

  const rows: ProcessRow[] = [];
  const childrenByParent = new Map<number, number[]>();
  const nowMs = Date.now();
  let selfCreatedAtMs: number | undefined;

  for (const raw of (result.stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(POSIX_PS_ROW_RE);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const etimeSeconds = parsePosixEtimeSeconds(match[3]);
    const cmdLine = match[4];
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

    const createdAtMs = etimeSeconds !== null ? nowMs - etimeSeconds * 1000 : undefined;
    if (pid === process.pid && createdAtMs !== undefined) selfCreatedAtMs = createdAtMs;

    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);

    if (isClaudeCommandLine(cmdLine)) {
      rows.push({ pid, ppid, cmdLine, createdAtMs });
    }
  }

  // Fall back to our own reported uptime if `ps` did not list our row (or gave an
  // unparseable etime), keeping the comparison on the same "seconds ago" scale.
  if (selfCreatedAtMs === undefined && Number.isFinite(process.uptime())) {
    selfCreatedAtMs = nowMs - Math.round(process.uptime() * 1000);
  }

  return { rows, childrenByParent, selfCreatedAtMs };
}

async function scanClaudeProcesses(): Promise<ScanResult> {
  if (process.platform === 'win32') {
    const { rows, selfCreatedAtMs } = await scanWindowsClaudeProcesses();
    return { rows, childrenByParent: new Map(), selfCreatedAtMs };
  }
  return scanPosixAllProcesses();
}

function hasCindyClaudeMarker(cmdLine: string): boolean {
  const haystack = cmdLine.toLowerCase();
  return CINDY_CLAUDE_PATH_MARKERS.some((marker) => haystack.includes(marker));
}

function isParentAlive(ppid: number): boolean {
  if (ppid <= 4) return false;
  if (ppid === process.pid) return true;

  try {
    process.kill(ppid, 0);
    return true;
  } catch (err) {
    // ESRCH = process truly gone (the only signal we trust to mean "dead").
    // EPERM = process exists but is owned by another user / protected — we
    // must treat it as alive, otherwise we'd false-positive reap class-B
    // orphans whose parent is just opaque to us.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * True only when `childMs` is known to precede `selfMs` by more than the skew
 * margin — i.e. the process started before this one did. Undefined inputs (no
 * creation-time source) return false so the caller stays conservative.
 */
function startedBefore(childMs: number | undefined, selfMs: number | undefined): boolean {
  return childMs !== undefined && selfMs !== undefined && childMs < selfMs - PID_REUSE_SKEW_MS;
}

function killWindowsProcessTree(pid: number): void {
  execFileSync(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { timeout: 1000, windowsHide: true, stdio: 'ignore' },
  );
}

function collectPosixDescendants(pid: number, childrenByParent: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [pid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    const kids = childrenByParent.get(cur);
    if (kids) for (const k of kids) stack.push(k);
  }
  return out;
}

function killPosixProcessTree(pid: number, childrenByParent: Map<number, number[]>): void {
  const pids = collectPosixDescendants(pid, childrenByParent);
  if (pids.length === 0) return;
  const result = spawnSync(
    'kill',
    ['-9', ...pids.map(String)],
    { encoding: 'utf8', timeout: 1000 },
  );
  if (result.error) throw result.error;
  // kill -9 returns nonzero when any pid is already gone — that's fine, the
  // rest still got the signal. Only treat hard process errors (above) as failure.
}

function killProcessTree(pid: number, childrenByParent: Map<number, number[]>): boolean {
  try {
    if (process.platform === 'win32') {
      killWindowsProcessTree(pid);
    } else {
      killPosixProcessTree(pid, childrenByParent);
    }
    return true;
  } catch (err) {
    log.debug('failed to kill claude process tree', {
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface ReapOptions {
  /**
   * Kill Claude trees whose parent is the current Electron process.
   *
   * Quit-time cleanup sets this true. The startup pass must leave it false: it
   * runs fire-and-forget while bootstrap continues, so its async snapshot can
   * complete after a session was launched (interrupted-turn resume, scheduler,
   * a fast user action). Such a fresh `claude.exe` has `ppid === process.pid`
   * and would be misread as a self-spawned orphan and killed even though it is a
   * legitimate, live current session. Historical orphans (dead parent) are still
   * reaped at startup regardless of this flag; so is a ppid===self process that
   * provably predates this one (a previous instance's orphan we inherited via PID
   * reuse), which creation-time comparison distinguishes from a live child.
   */
  reapCurrentSession?: boolean;
}

/**
 * Reaps Claude Code process trees owned by this app instance, plus historical
 * Cindy-bundled Claude processes whose parent has already died.
 */
export async function reapClaudeOrphans(options: ReapOptions = {}): Promise<ReaperResult> {
  const reapCurrentSession = options.reapCurrentSession ?? true;
  const start = Date.now();
  let scan: ScanResult = { rows: [], childrenByParent: new Map() };

  try {
    scan = await scanClaudeProcesses();
  } catch (err) {
    log.debug('failed to scan claude processes', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let killedSelfSpawned = 0;
  let killedHistoricalOrphans = 0;

  for (const proc of scan.rows) {
    if (proc.pid === process.pid) continue;

    if (proc.ppid === process.pid) {
      if (reapCurrentSession) {
        // Quit-time cleanup reaps live current-session children.
        if (killProcessTree(proc.pid, scan.childrenByParent)) killedSelfSpawned += 1;
        continue;
      }
      // Startup pass. Normally we must NOT touch ppid===self processes: one may be
      // a session launched moments after cold start (see ReapOptions). But a claude
      // that provably started BEFORE this process cannot be a child we spawned —
      // our children are always younger. It is a previous instance's orphan whose
      // dead parent's PID this process happened to reuse after a crash + relaunch;
      // ppid alone can no longer prove ownership. Reap it under the same Cindy
      // marker guard as the dead-parent historical path. When creation time is
      // unknown the comparison stays false, so we fall back to the safe skip.
      if (startedBefore(proc.createdAtMs, scan.selfCreatedAtMs) && hasCindyClaudeMarker(proc.cmdLine)) {
        if (killProcessTree(proc.pid, scan.childrenByParent)) killedHistoricalOrphans += 1;
      }
      continue;
    }

    if (hasCindyClaudeMarker(proc.cmdLine) && !isParentAlive(proc.ppid)) {
      if (killProcessTree(proc.pid, scan.childrenByParent)) killedHistoricalOrphans += 1;
    }
  }

  const result = {
    scannedTotal: scan.rows.length,
    killedSelfSpawned,
    killedHistoricalOrphans,
    durationMs: Date.now() - start,
  };
  log.info('claude orphan reap completed', result);
  return result;
}
