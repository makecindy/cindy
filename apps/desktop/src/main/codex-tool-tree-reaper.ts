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
 *   - Ownership: the pid is registered as a local Codex app-server AND its
 *     parent in a fresh `ps` snapshot is the current Electron main process.
 *   - POSIX only. Processes that already left the tree (crash, or intentionally
 *     detached via setsid + parent exit) are not identifiable and are left alone.
 *   - Best-effort: scan / kill failures never block quit.
 */

import { spawnSync } from 'node:child_process';
import { killProcessTree } from './claude-orphan-reaper';
import { createLogger } from './logger';
import { listCodexProcessPids } from './process-monitor/codex-process-registry';

const log = createLogger('codex-tool-tree-reaper');

const POSIX_PS_ROW_RE = /^(\d+)\s+(\d+)$/;

export interface CodexToolReapResult {
  appServers: number;
  killedToolTrees: number;
  durationMs: number;
}

function scanPosixChildrenByParent(): Map<number, number[]> {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 1500 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`ps exited with status ${result.status}`);
  }
  const childrenByParent = new Map<number, number[]>();
  for (const raw of (result.stdout ?? '').split(/\r?\n/)) {
    const match = raw.trim().match(POSIX_PS_ROW_RE);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const siblings = childrenByParent.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenByParent.set(ppid, [pid]);
  }
  return childrenByParent;
}

/** Kills every process tree below this instance's local Codex app-servers. */
export function reapCodexToolTreesSync(): CodexToolReapResult {
  const start = Date.now();
  const result: CodexToolReapResult = { appServers: 0, killedToolTrees: 0, durationMs: 0 };
  const registered = listCodexProcessPids();
  if (process.platform === 'win32' || registered.length === 0) return result;

  let childrenByParent: Map<number, number[]>;
  try {
    childrenByParent = scanPosixChildrenByParent();
  } catch (err) {
    log.debug('failed to scan processes', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  // PID 复用防护：登记表里的 PID 必须仍是本进程的直接子进程。
  const ownChildren = new Set(childrenByParent.get(process.pid) ?? []);
  for (const appServerPid of registered) {
    if (!ownChildren.has(appServerPid)) continue;
    result.appServers += 1;
    for (const toolPid of childrenByParent.get(appServerPid) ?? []) {
      if (killProcessTree(toolPid, childrenByParent)) result.killedToolTrees += 1;
    }
  }
  result.durationMs = Date.now() - start;
  log.info('codex tool tree reap completed', result);
  return result;
}
