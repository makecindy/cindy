import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const HELPER_START_TIMEOUT_MS = 5_000;
const HELPER_PROBE_TIMEOUT_MS = 5_000;
const HELPER_EXIT_TIMEOUT_MS = 2_000;
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;

const WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('{"status":"started"}')
[Console]::Out.Flush()

$mutex = [System.Threading.Mutex]::new($false, $env:CINDY_SINGLETON_MUTEX_NAME)
$acquired = $false
try {
  try {
    $acquired = $mutex.WaitOne([int]$env:CINDY_SINGLETON_WAIT_MS)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    [Console]::Out.WriteLine('{"status":"busy"}')
    [Console]::Out.Flush()
    exit 2
  }

  [Console]::Out.WriteLine('{"status":"locked"}')
  [Console]::Out.Flush()
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CindyProcessSingletonProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindWindowEx(
    IntPtr parent,
    IntPtr childAfter,
    string className,
    string windowName
  );

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

  $messageOnlyWindow = [IntPtr]::new(-3)
  $window = [CindyProcessSingletonProbe]::FindWindowEx(
    $messageOnlyWindow,
    [IntPtr]::Zero,
    $env:CINDY_SINGLETON_WINDOW_CLASS,
    $env:CINDY_SINGLETON_WINDOW_TITLE
  )
  if ($window -ne [IntPtr]::Zero) {
    [uint32]$ownerPid = 0
    [void][CindyProcessSingletonProbe]::GetWindowThreadProcessId($window, [ref]$ownerPid)
    if ($ownerPid -ne [uint32]$env:CINDY_SINGLETON_SELF_PID) {
      [Console]::Out.WriteLine((@{ status = 'occupied'; pid = $ownerPid } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      exit 3
    }
  }

  [Console]::Out.WriteLine('{"status":"acquired"}')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  if ($acquired) {
    try { [void]$mutex.ReleaseMutex() } catch {}
  }
  $mutex.Dispose()
}
`;

type BarrierStatus =
  | { status: 'started' }
  | { status: 'locked' }
  | { status: 'acquired' }
  | { status: 'busy' }
  | { status: 'occupied'; pid: number };

function processSingletonNames(programName: string): {
  mutexName: string;
  windowClass: string;
} {
  return {
    // Electron makes only the startup mutex program-specific. Chromium's
    // message-only window class remains the shared Chrome constant; the
    // userData path in the window title selects this app instance.
    mutexName: `Local\\${programName}ProcessSingletonStartup`,
    windowClass: 'Chrome_MessageWindow',
  };
}

export interface WindowsPackagedInstanceBarrierLease {
  /** False if the helper exited unexpectedly and no longer owns the startup mutex. */
  isHeld(): boolean;
  /** Idempotent; always releases or terminates the helper within a bounded interval. */
  release(): Promise<void>;
}

function powershellPath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function waitForBarrierStatus(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ line: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      settle();
    };
    // timeoutMs 只度量 mutex 竞争；PowerShell 冷启动与 Add-Type 编译是独立阶段，
    // 满载 CI 上共预算会把健康的 acquire 误杀成超时。
    const armTimeout = (durationMs: number, stage: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`timed out ${stage} Windows packaged-instance barrier`)),
        );
        child.kill();
      }, durationMs);
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdout += chunk.toString();
      if (stdout.length > MAX_HELPER_OUTPUT_BYTES) {
        finish(() =>
          reject(new Error('Windows packaged-instance barrier emitted too much output')),
        );
        child.kill();
        return;
      }
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        let status: BarrierStatus;
        try {
          status = parseBarrierStatus(line);
        } catch (error) {
          finish(() => reject(error));
          child.kill();
          return;
        }
        if (status.status === 'started') {
          armTimeout(timeoutMs + 1_000, 'waiting for');
        } else if (status.status === 'locked') {
          // Add-Type + message-window 探测只在 mutex 安全持有后发生。
          armTimeout(HELPER_PROBE_TIMEOUT_MS, 'probing');
        } else {
          finish(() => resolve({ line, stderr }));
          return;
        }
        newline = stdout.indexOf('\n');
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (stderr.length < MAX_HELPER_OUTPUT_BYTES) stderr += chunk.toString();
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onExit = (code: number | null): void =>
      finish(() =>
        reject(
          new Error(
            `Windows packaged-instance barrier exited before readiness (code=${String(code)})${
              stderr.trim() ? `: ${stderr.trim()}` : ''
            }`,
          ),
        ),
      );

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
    armTimeout(HELPER_START_TIMEOUT_MS, 'starting');
  });
}

function parseBarrierStatus(line: string): BarrierStatus {
  const value = JSON.parse(line) as Partial<BarrierStatus>;
  if (
    value.status === 'started' ||
    value.status === 'locked' ||
    value.status === 'acquired' ||
    value.status === 'busy'
  ) {
    return { status: value.status };
  }
  if (
    value.status === 'occupied' &&
    typeof value.pid === 'number' &&
    Number.isInteger(value.pid) &&
    value.pid > 0
  ) {
    return { status: 'occupied', pid: value.pid };
  }
  throw new Error('Windows packaged-instance barrier returned an invalid status');
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = HELPER_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      clearTimeout(forceFinishTimer);
      child.off('exit', finish);
      resolve();
    };
    let forceFinishTimer: ReturnType<typeof setTimeout> | undefined;
    const terminateTimer = setTimeout(() => {
      child.kill();
      // Windows 上 TerminateProcess 是异步的。继续等真实 exit 事件，
      // 避免重试与仍持有 mutex 的进程竞态；坏主机再留第二段兜底。
      forceFinishTimer = setTimeout(() => {
        child.kill();
        finish();
      }, timeoutMs);
    }, timeoutMs);
    child.once('exit', finish);
  });
}

/**
 * Hold Chromium/Electron's packaged-process startup mutex while local-v1 is
 * snapshotted and published. The helper also probes the packaged singleton's
 * message-only window under that mutex, which is the only durable signal left
 * by Windows builds predating `.dev-instances` registration.
 *
 * The mutex closes the scan-to-publication race: an older packaged Cindy that
 * starts after the probe cannot finish ProcessSingleton setup until release.
 * Missing PowerShell, P/Invoke failures, a busy mutex, or malformed output all
 * reject so first-login adoption remains fail-closed.
 */
export async function acquireWindowsPackagedInstanceBarrier(options: {
  userDataDir: string;
  programName: string;
  selfPid?: number;
  timeoutMs?: number;
}): Promise<WindowsPackagedInstanceBarrierLease> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const singletonNames = processSingletonNames(options.programName);
  const child = spawn(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT],
    {
      env: {
        ...process.env,
        CINDY_SINGLETON_MUTEX_NAME: singletonNames.mutexName,
        CINDY_SINGLETON_WINDOW_CLASS: singletonNames.windowClass,
        CINDY_SINGLETON_WINDOW_TITLE: options.userDataDir,
        CINDY_SINGLETON_SELF_PID: String(options.selfPid ?? process.pid),
        CINDY_SINGLETON_WAIT_MS: String(timeoutMs),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let status: BarrierStatus;
  try {
    const { line } = await waitForBarrierStatus(child, timeoutMs);
    status = parseBarrierStatus(line);
  } catch (error) {
    child.kill();
    await waitForExit(child);
    throw error;
  }
  if (status.status !== 'acquired') {
    await waitForExit(child);
    if (status.status === 'occupied') {
      throw new Error(
        `local profile database adoption deferred: legacy packaged instance ${status.pid} is using shared userData`,
      );
    }
    throw new Error('local profile database adoption deferred: packaged startup barrier is busy');
  }

  let held = child.exitCode === null && child.signalCode === null;
  let released = false;
  child.once('exit', () => {
    held = false;
  });
  return {
    isHeld: () => held,
    release: async () => {
      if (released) return;
      released = true;
      held = false;
      try {
        child.stdin.end('\n');
      } catch {
        child.kill();
      }
      await waitForExit(child);
    },
  };
}

export const __testing = {
  WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT,
  parseBarrierStatus,
  processSingletonNames,
  waitForExit,
};
