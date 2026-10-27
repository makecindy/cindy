import { execFile } from 'node:child_process';

/**
 * OS-reported identity of a live PID. A PID alone cannot tell an old Cindy process from an
 * unrelated program that later received the same number: macOS and Windows reuse PIDs
 * routinely. Kept dependency-free so early startup code can use it.
 */
export interface ProcessIdentitySnapshot {
  startedAtMs: number;
  command: string;
}

const PROCESS_IDENTITY_QUERY_TIMEOUT_MS = 1_500;

function parseProcessIdentityOutput(raw: string): ProcessIdentitySnapshot | null {
  const newline = raw.indexOf('\n');
  if (newline < 0) return null;
  const startedAtMs = Date.parse(raw.slice(0, newline).trim());
  const command = raw.slice(newline + 1).trim();
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0 || command.length === 0) return null;
  return { startedAtMs, command };
}

function execFileUtf8(
  file: string,
  args: readonly string[],
  options: {
    maxBuffer: number;
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
    timeoutMs?: number;
  },
): Promise<string> {
  const { timeoutMs = PROCESS_IDENTITY_QUERY_TIMEOUT_MS, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        ...execOptions,
        encoding: 'utf-8',
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Read all candidate process identities asynchronously with one OS query per scan.
 * PIDs whose identity cannot be read are absent from the result; callers must treat that
 * as "unknown", never as proof that the process is gone.
 */
export async function readProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, ProcessIdentitySnapshot | null>> {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const result = new Map<number, ProcessIdentitySnapshot | null>();
  if (uniquePids.length === 0) return result;
  try {
    if (process.platform === 'win32') {
      const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const output = await execFileUtf8(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ids = @(${uniquePids.join(',')}); ` +
            '$rows = Get-Process -Id $ids -ErrorAction Stop | ForEach-Object { ' +
            '$command = if ($_.Path) { $_.Path } else { $_.ProcessName }; ' +
            "[PSCustomObject]@{ pid = $_.Id; startedAt = $_.StartTime.ToUniversalTime().ToString('O'); command = $command } }; " +
            '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
            '$rows | ConvertTo-Json -Compress',
        ],
        {
          maxBuffer: 16_384,
          windowsHide: true,
        },
      );
      const parsed = JSON.parse(output) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const value = row as Record<string, unknown>;
        const pid = value.pid;
        const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
        const command = value.command;
        if (
          typeof pid === 'number' &&
          Number.isInteger(pid) &&
          Number.isFinite(startedAtMs) &&
          startedAtMs > 0 &&
          typeof command === 'string' &&
          command.length > 0
        ) {
          result.set(pid, { startedAtMs, command });
        }
      }
      return result;
    }

    const output = await execFileUtf8(
      'ps',
      ['-p', uniquePids.join(','), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='],
      {
        maxBuffer: 16_384,
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.{24})\s+([\s\S]+)$/.exec(line.trimEnd());
      if (!match) continue;
      const pid = Number(match[1]);
      const identity = parseProcessIdentityOutput(`${match[2]}\n${match[3]}`);
      if (identity) result.set(pid, identity);
    }
  } catch {
    // Missing entries keep the caller fail-closed when provenance is ambiguous.
  }
  return result;
}

/**
 * Read only OS process start times, for background checks that run off the startup path.
 *
 * Unlike readProcessIdentities, Windows uses `Win32_Process.CreationDate`: `Get-Process`
 * cannot read `StartTime` of service or elevated processes from a non-elevated caller, and
 * those are exactly the programs that tend to inherit a PID for days. PIDs without a readable
 * start time are absent from the result and must be treated as "unknown".
 */
export async function readProcessStartTimes(
  pids: readonly number[],
  options: { timeoutMs: number },
): Promise<ReadonlyMap<number, number>> {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const result = new Map<number, number>();
  if (uniquePids.length === 0) return result;
  try {
    if (process.platform === 'win32') {
      const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const filter = uniquePids.map((pid) => `ProcessId=${pid}`).join(' OR ');
      const output = await execFileUtf8(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter '${filter}' -ErrorAction Stop | ` +
            'Where-Object { $_.CreationDate } | ForEach-Object { ' +
            "[PSCustomObject]@{ pid = [int]$_.ProcessId; startedAt = $_.CreationDate.ToUniversalTime().ToString('O') } }); " +
            '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
            'ConvertTo-Json -InputObject $rows -Compress',
        ],
        { maxBuffer: 16_384, windowsHide: true, timeoutMs: options.timeoutMs },
      );
      const parsed = JSON.parse(output) as unknown;
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row || typeof row !== 'object') continue;
        const value = row as Record<string, unknown>;
        const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
        if (
          typeof value.pid === 'number' &&
          Number.isInteger(value.pid) &&
          Number.isFinite(startedAtMs) &&
          startedAtMs > 0
        ) {
          result.set(value.pid, startedAtMs);
        }
      }
      return result;
    }

    const output = await execFileUtf8(
      'ps',
      ['-p', uniquePids.join(','), '-o', 'pid=', '-o', 'lstart='],
      { maxBuffer: 16_384, env: { ...process.env, LC_ALL: 'C' }, timeoutMs: options.timeoutMs },
    );
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.{24})\s*$/.exec(line.trimEnd());
      if (!match) continue;
      const startedAtMs = Date.parse(match[2].trim());
      if (Number.isFinite(startedAtMs) && startedAtMs > 0)
        result.set(Number(match[1]), startedAtMs);
    }
  } catch {
    // Missing entries keep the caller fail-closed when provenance is ambiguous.
  }
  return result;
}
