/**
 * Codex tool-process reaper (quit only).
 * ---------------------------------------------------------------------------
 * Why this exists (#6024):
 *   On quit, `shutdown-maker` closes each local `codex app-server` by stdin EOF
 *   and only confirms the direct child's exit. Commands started through Codex
 *   `exec_command` (and their build-system grandchildren, e.g. xcodebuild →
 *   swift-frontend, which llbuild places in their own process groups) are not
 *   signalled. When app-server exits, they are reparented to launchd and keep
 *   running without an owner. Claude tasks already lose their whole tree on quit
 *   via `reap-claude-children`; this brings Codex to the same behaviour.
 *
 * Timing trap (same as claude-orphan-reaper):
 *   Must run in lifecycle's sync phase, before the async `shutdown-maker`. Once
 *   app-server exits, the PPID chain proving ownership is gone.
 *
 * Scope:
 *   - Only descendants of app-server are killed. app-server itself keeps the
 *     EOF graceful close so it can persist history (#3985).
 *   - Ownership starts with the live ChildProcess from the registered spawn.
 *     Each signal needs a fresh PID/PPID chain to that same child.
 *   - POSIX only. Processes that already left the tree (crash, or intentionally
 *     detached via setsid + parent exit) are not identifiable and are left alone.
 *   - Best-effort: scan / kill failures never block quit.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createLogger } from './logger';
import { listCodexProcessReapTargets } from './process-monitor/codex-process-registry';

const log = createLogger('codex-tool-tree-reaper');
const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)$/;
const EXIT_BUDGET_MS = 1500;
const FULL_SCAN_BUDGET_MS = 750;
const SCOPED_DISCOVERY_BUDGET_MS = 1125;
const SCOPED_CALL_BUDGET_MS = 120;
const MAX_DEPTH = 32;
const MAX_PROCESSES = 256;

type ProcessRow = readonly [pid: number, ppid: number];
type ProcessQuery =
  | { kind: 'all' }
  | { kind: 'children'; parentPid: number }
  | { kind: 'parents'; pids: readonly number[] };

export type CodexProcessSampler = (query: ProcessQuery, timeoutMs: number) =>
  Pick<SpawnSyncReturns<string>, 'stdout' | 'status' | 'signal' | 'error'>;

export interface CodexToolReapResult {
  appServers: number;
  killedToolTrees: number;
  durationMs: number;
  scanFailed: boolean;
  fallbackUsed: boolean;
  unreapedAppServers: number;
}

function platformSampler(): CodexProcessSampler {
  const mac = process.platform === 'darwin';
  const ps = mac || existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  return (query, timeout) => {
    const options = { encoding: 'utf8' as const, timeout, killSignal: 'SIGKILL' as const };
    if (query.kind === 'all') return spawnSync(ps, ['-A', '-o', 'pid=,ppid='], options);
    if (query.kind === 'parents') {
      return spawnSync(ps, ['-p', query.pids.join(','), '-o', 'pid=,ppid='], options);
    }
    return mac
      ? spawnSync('/usr/bin/pgrep', ['-P', String(query.parentPid)], options)
      : spawnSync(ps, ['--ppid', String(query.parentPid), '-o', 'pid='], options);
  };
}

function parseProcessRows(stdout: string): ProcessRow[] | null {
  if (!stdout) return [];
  const rows: ProcessRow[] = [];
  const seen = new Set<number>();
  for (const raw of stdout.split(/\r?\n/)) {
    const match = raw.trim().match(POSIX_PS_ROW_RE);
    if (!match) return null;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || seen.has(pid)) return null;
    seen.add(pid);
    rows.push([pid, parent]);
  }
  return rows;
}

function parseChildPids(stdout: string): number[] | null {
  if (!stdout) return [];
  const pids = stdout.split(/\r?\n/).map(line => Number(line.trim()));
  return pids.every(pid => Number.isSafeInteger(pid) && pid > 0) ? pids : null;
}

function indexChildren(rows: readonly ProcessRow[]): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, ppid] of rows) {
    if (!pid) continue;
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }
  return childrenByParent;
}

/** Reaps proven tool descendants within the quit-side process scan budget. */
export function reapCodexToolTreesSync(sample?: CodexProcessSampler): CodexToolReapResult {
  const start = performance.now();
  const deadline = start + EXIT_BUDGET_MS;
  const result: CodexToolReapResult = {
    appServers: 0, killedToolTrees: 0, durationMs: 0,
    scanFailed: false, fallbackUsed: false, unreapedAppServers: 0,
  };
  if (process.platform === 'win32') return result;
  const registered = listCodexProcessReapTargets();
  if (!registered.length) return result;
  const owned = registered.filter(target => target.isCurrent());
  result.appServers = owned.length;
  result.unreapedAppServers = registered.length - owned.length;
  const readProcesses = sample ?? platformSampler();

  function query<T>(request: ProcessQuery, stopAt: number, parse: (stdout: string) => T | null): T | null {
    const started = performance.now();
    const available = Math.floor(stopAt - started);
    if (available < 1) return null;
    let attempt: ReturnType<CodexProcessSampler> | undefined;
    try { attempt = readProcesses(request, available); } catch { /* Record a failed scan below. */ }
    const stdout = attempt?.stdout?.trim() ?? '';
    const emptySelection = request.kind !== 'all' && attempt?.status === 1 && !stdout;
    const rows = attempt && !attempt.error && !attempt.signal && (attempt.status === 0 || emptySelection)
      ? parse(stdout) : null;
    if (rows !== null) return rows;
    result.scanFailed = true;
    log.warn('Codex process scan failed', {
      code: 'CODEX_REAPER_SCAN_FAILED',
      query: request.kind,
      durationMs: Math.round(performance.now() - started),
      exitCode: attempt?.status ?? null,
      signal: attempt?.signal ?? null,
      reason: (attempt?.error as NodeJS.ErrnoException | undefined)?.code ?? 'unavailable',
    });
    return null;
  }

  if (owned.length) {
    const full = query({ kind: 'all' }, start + FULL_SCAN_BUDGET_MS, parseProcessRows);
    const children = full && indexChildren(full);
    result.fallbackUsed = full === null;
    const findChildren = (parentPid: number) => children ? children.get(parentPid) ?? []
      : query({ kind: 'children', parentPid },
        Math.min(start + SCOPED_DISCOVERY_BUDGET_MS, performance.now() + SCOPED_CALL_BUDGET_MS), parseChildPids);
    let visits = 0;
    for (const target of owned) {
      const seen = new Set([process.pid, target.pid]);
      const signalledTrees = new Set<number>();
      let incomplete = !target.isCurrent();

      function walk(tools: readonly number[], ancestors: readonly ProcessRow[], toolRoot?: number): void {
        for (const pid of tools) {
          if (visits >= MAX_PROCESSES || performance.now() >= deadline || !target.isCurrent()) {
            incomplete = true;
            break;
          }
          if (seen.has(pid)) {
            incomplete = true;
            continue;
          }
          seen.add(pid);
          visits++;
          const chain: ProcessRow[] = [[pid, ancestors[0][0]], ...ancestors];
          const descendants = findChildren(pid);
          if (!descendants || (ancestors.length >= MAX_DEPTH && descendants.length)) incomplete = true;
          else walk(descendants, chain, toolRoot ?? pid);

          // Re-read the target and its ancestors together immediately before the signal.
          const rows = query({ kind: 'parents', pids: chain.map(row => row[0]) },
            Math.min(deadline, performance.now() + SCOPED_CALL_BUDGET_MS), parseProcessRows);
          const parents = rows && new Map(rows);
          if (!parents || chain.some(([child, parent]) => parents.get(child) !== parent)
              || !target.isCurrent() || performance.now() >= deadline) {
            incomplete = true;
            continue;
          }
          try {
            process.kill(pid, 'SIGKILL');
            signalledTrees.add(toolRoot ?? pid);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') incomplete = true;
          }
        }
      }

      if (!incomplete) {
        const tools = findChildren(target.pid);
        if (tools) walk(tools, [[target.pid, process.pid]]);
        else incomplete = true;
      }
      result.killedToolTrees += signalledTrees.size;
      if (incomplete) result.unreapedAppServers++;
    }
  }
  result.durationMs = Math.round(performance.now() - start);
  log.info('codex tool tree reap completed', result);
  return result;
}
