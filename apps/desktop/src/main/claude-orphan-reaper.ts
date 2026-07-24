/**
 * Claude Code orphan reaper.
 * ---------------------------------------------------------------------------
 * Why this exists:
 *   Claude Code is launched by maker-core through the Anthropic SDK. The SDK's
 *   abort path only terminates the direct `claude` child. On Windows that kill
 *   is a Win32 TerminateProcess call: it does not propagate to grandchildren,
 *   so stdio MCP servers started below `claude.exe` can survive as orphaned
 *   `node` processes after xdt-maker quits, restarts, or crashes.
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
 *     the current Electron main process.
 *   - Historical cleanup requires both an xdt-maker bundled Claude binary path
 *     marker and a dead parent, so an active second xdt-maker instance is left
 *     alone.
 *   - External Claude installs (for example `/usr/local/bin/claude`) do not
 *     contain the xdt-maker marker and are not historical-orphan candidates.
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

const XDT_CLAUDE_PATH_MARKERS = [
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
const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)\s+(.+)$/;

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
}

const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 1000;

async function getWindowsProcessSnapshot(): Promise<IProcessInfo[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (processes: IProcessInfo[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(processes);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.debug('windows process snapshot timed out', {
        timeoutMs: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
      });
      resolve([]);
    }, WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS);

    try {
      getAllProcesses(finish, ProcessDataFlag.CommandLine);
    } catch (err) {
      settled = true;
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function scanWindowsClaudeProcesses(): Promise<ProcessRow[]> {
  const processes = await getWindowsProcessSnapshot();
  return processes
    .filter((proc) => proc.name.toLowerCase() === 'claude.exe')
    .map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      cmdLine: proc.commandLine ?? '',
    }));
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
}

function scanPosixAllProcesses(): ScanResult {
  const result = spawnSync(
    'ps',
    ['-A', '-o', 'pid=,ppid=,command='],
    { encoding: 'utf8', timeout: 1500 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`ps exited with status ${result.status}`);
  }

  const rows: ProcessRow[] = [];
  const childrenByParent = new Map<number, number[]>();

  for (const raw of (result.stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(POSIX_PS_ROW_RE);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const cmdLine = match[3];
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);

    if (isClaudeCommandLine(cmdLine)) {
      rows.push({ pid, ppid, cmdLine });
    }
  }

  return { rows, childrenByParent };
}

async function scanClaudeProcesses(): Promise<ScanResult> {
  if (process.platform === 'win32') {
    return { rows: await scanWindowsClaudeProcesses(), childrenByParent: new Map() };
  }
  return scanPosixAllProcesses();
}

function hasXdtClaudeMarker(cmdLine: string): boolean {
  const haystack = cmdLine.toLowerCase();
  return XDT_CLAUDE_PATH_MARKERS.some((marker) => haystack.includes(marker));
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

/**
 * Reaps Claude Code process trees owned by this app instance, plus historical
 * Cindy-bundled Claude processes whose parent has already died.
 */
export async function reapClaudeOrphans(): Promise<ReaperResult> {
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
      if (killProcessTree(proc.pid, scan.childrenByParent)) killedSelfSpawned += 1;
      continue;
    }

    if (hasXdtClaudeMarker(proc.cmdLine) && !isParentAlive(proc.ppid)) {
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
