import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** OS birth time and executable, not an application registration/heartbeat time. */
export interface DesktopProcessIdentity {
  startedAtMs: number;
  executablePath: string;
}

type IdentityCommand = (file: string, args: string[], options: {
  encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: boolean;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string }>;

function validIdentity(value: unknown, platform: NodeJS.Platform): value is DesktopProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DesktopProcessIdentity>;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return typeof identity.startedAtMs === 'number' && Number.isFinite(identity.startedAtMs)
    && identity.startedAtMs > 0 && typeof identity.executablePath === 'string'
    && paths.isAbsolute(identity.executablePath);
}

/** Bounded, read-only probe. Missing, inaccessible and malformed results remain unknown. */
export async function readDesktopProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  runCommand: IdentityCommand = execFileAsync,
): Promise<DesktopProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const options = { encoding: 'utf8' as const, timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true };
  try {
    let identity: unknown;
    if (platform === 'win32') {
      const powershell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // No command line or environment is collected. Serialize only identity fields.
      const script = `$ErrorActionPreference = 'Stop'; `
        + `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); `
        + `$instance = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; `
        + `if ($null -ne $instance) { [pscustomobject]@{ `
        + `startedAtMs = ([DateTimeOffset]$instance.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); `
        + `executablePath = $instance.ExecutablePath } | ConvertTo-Json -Compress }`;
      const { stdout } = await runCommand(powershell,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], options);
      identity = JSON.parse(stdout);
    } else {
      const { stdout } = await runCommand('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='],
        { ...options, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } });
      const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(stdout.trim());
      if (!match) return null;
      identity = { startedAtMs: Date.parse(`${match[1]} UTC`), executablePath: match[2] };
    }
    return validIdentity(identity, platform) ? identity : null;
  } catch {
    return null;
  }
}

/**
 * Proves PID reuse without deleting the record or releasing any detached-child lease.
 * Legacy startedAtMs was captured during registration: a substantially later OS birth
 * cannot belong to that instance. Earlier/equal times are deliberately inconclusive.
 */
export function isReusedDesktopInstancePid(
  record: { startedAtMs?: unknown; processIdentity?: unknown; rootDir?: unknown },
  current: DesktopProcessIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!validIdentity(current, platform)) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = paths.normalize(current.executablePath).replaceAll('\\', '/').toLowerCase();
  // A replacement Cindy/Electron might not have published its own registration
  // yet. Such a runtime remains protective even when its birth time is newer.
  // Also retain Node launchers and executables within the recorded checkout/app.
  const name = paths.basename(current.executablePath).toLowerCase();
  if (/^(?:cindy|electron|node)(?:\.exe)?$/.test(name)
    || executable.includes('/cindy.app/') || executable.includes('/electron.app/')) return false;
  if (typeof record.rootDir === 'string' && paths.isAbsolute(record.rootDir)) {
    const root = paths.normalize(record.rootDir).replaceAll('\\', '/').toLowerCase();
    const resourcesIndex = root.indexOf('/resources/');
    const runtimeRoot = (resourcesIndex >= 0 ? root.slice(0, resourcesIndex) : root).replace(/\/$/, '');
    if (executable.startsWith(`${runtimeRoot}/`)) return false;
  }
  // ps reports whole seconds; also allow timestamp rounding in legacy records.
  const toleranceMs = 2_000;
  if (record.processIdentity !== undefined) {
    if (!validIdentity(record.processIdentity, platform)) return false;
    const previous = record.processIdentity;
    if (current.startedAtMs > previous.startedAtMs + toleranceMs) return true;
    // POSIX exec can change the executable without ending the process. Windows
    // cannot, so a different executable also disproves the recorded identity.
    return platform === 'win32'
      && path.win32.normalize(previous.executablePath).toLowerCase()
        !== path.win32.normalize(current.executablePath).toLowerCase();
  }
  return typeof record.startedAtMs === 'number' && Number.isFinite(record.startedAtMs)
    && record.startedAtMs > 0 && current.startedAtMs > record.startedAtMs + toleranceMs;
}
