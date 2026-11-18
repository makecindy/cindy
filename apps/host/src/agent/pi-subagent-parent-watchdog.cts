import { spawnSync } from 'node:child_process';

/**
 * The Host's PI Subagent runner entry watches the Host that forked it. On the desktop an Electron
 * utilityProcess ends with the main process; a Node fork does not, so after a Host crash a runner
 * would otherwise run on unattended until it finishes or times out. Identity is the pid plus its
 * start time, as the runner's own parentInstanceAlive (maker-core cindy-subagent-runner-source.ts).
 */

function parseElapsedSeconds(text: string): number | null {
  // ps etime: [[dd-]hh:]mm:ss
  const match = String(text).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (Number(days ?? 0) * 24 * 3600) + (Number(hours ?? 0) * 3600) + (Number(minutes) * 60) + Number(seconds);
}

/** The start time of a process in Unix seconds, or null when it cannot be read (same probe as the runner). */
export function probeProcessStartTimeSec(pid: number): number | null {
  const now = Date.now();
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[int64]((Get-Process -Id ${pid}).StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds`,
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (probe.error || probe.status !== 0) return null;
      const seconds = Number(String(probe.stdout || '').trim());
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
    }
    const probe = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) return null;
    const elapsed = parseElapsedSeconds(probe.stdout);
    return elapsed === null ? null : Math.round(now / 1000 - elapsed);
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface ParentWatchdogOptions {
  parentPid: number;
  onParentGone(): void;
  /** Cheap checks (no child process) run this often. */
  intervalMs?: number;
  /** The start-time probe (a `ps` or PowerShell call) runs every this many ticks. */
  probeEveryTicks?: number;
  readStartTimeSec?(pid: number): number | null;
  isPidAlive?(pid: number): boolean;
  currentParentPid?(): number;
}

/**
 * Every tick (1 s by default): the parent is gone when this process was re-parented (POSIX) or the
 * pid no longer exists. Every 30th tick: also when the pid now belongs to a process started at another
 * time (pid reuse; on Windows the parent pid of a process never changes). One second keeps the end
 * within a few seconds of a Host crash at the cost of one signal-0 syscall per second while idle; the
 * subprocess probe stays at one every 30 seconds. An unknown start time counts as the same process,
 * as in the runner.
 */
export function startParentWatchdog(options: ParentWatchdogOptions): () => void {
  const readStartTimeSec = options.readStartTimeSec ?? probeProcessStartTimeSec;
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const currentParentPid = options.currentParentPid ?? (() => process.ppid);
  const probeEveryTicks = options.probeEveryTicks ?? 30;
  const startTimeSec = readStartTimeSec(options.parentPid);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    let gone = currentParentPid() !== options.parentPid || !isPidAlive(options.parentPid);
    if (!gone && startTimeSec !== null && ticks % probeEveryTicks === 0) {
      const live = readStartTimeSec(options.parentPid);
      gone = live !== null && Math.abs(live - startTimeSec) > 5;
    }
    if (!gone) return;
    clearInterval(timer);
    options.onParentGone();
  }, options.intervalMs ?? 1000);
  // The runner keeps itself alive; this timer must not.
  timer.unref();
  return () => clearInterval(timer);
}
