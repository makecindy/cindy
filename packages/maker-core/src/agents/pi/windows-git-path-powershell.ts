import type { Logger } from '../../interfaces/logger.js';

export type WindowsGitPathLogger = Pick<Logger, 'warn'>;

const DIAGNOSTIC_PREFIX = '__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__';

const WINDOWS_KILL_ON_CLOSE_JOB_TYPE = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CindyWindowsGitPathJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", EntryPoint = "IsProcessInJob", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJobNative(IntPtr process, IntPtr job, out bool contains);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnCloseForCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int informationLength = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr informationPointer = Marshal.AllocHGlobal(informationLength);
            try
            {
                Marshal.StructureToPtr(information, informationPointer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    informationPointer,
                    (uint)informationLength))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(informationPointer);
            }

            using (Process current = Process.GetCurrentProcess())
            {
                if (!AssignProcessToJobObject(job, current.Handle))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public static bool ContainsProcess(IntPtr job, IntPtr process)
    {
        bool contains;
        if (!IsProcessInJobNative(process, job, out contains))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return contains;
    }
}
`.trim();

const WINDOWS_KILL_ON_CLOSE_JOB_TYPE_BASE64 = Buffer
  .from(WINDOWS_KILL_ON_CLOSE_JOB_TYPE, 'utf16le')
  .toString('base64');

export function buildWindowsRegistryProbeScript(registryPaths: readonly string[]): string {
  const quotedPaths = registryPaths.map((registryPath) => `'${registryPath.replaceAll("'", "''")}'`).join(', ');
  return [
    `$keys = @(${quotedPaths})`,
    'foreach ($key in $keys) {',
    '  try {',
    "    $value = Get-ItemPropertyValue -LiteralPath $key -Name 'InstallPath' -ErrorAction Stop",
    '    if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {',
    '      [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$value))',
    '    }',
    '  } catch [System.Management.Automation.ItemNotFoundException] {',
    '    # Git for Windows is not installed under this optional registry key.',
    '  } catch {',
    `    [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tregistry")`,
    '  }',
    '}',
  ].join('\n');
}

export function buildWindowsNetworkDriveProbeScript(): string {
  return [
    'try {',
    '  [System.IO.DriveInfo]::GetDrives() |',
    '    Where-Object { $_.DriveType -eq [System.IO.DriveType]::Network } |',
    '    ForEach-Object { [Console]::Out.WriteLine($_.Name.Substring(0, 1)) }',
    '} catch {',
    `  [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tnetwork-drives")`,
    '}',
  ].join('\n');
}

function windowsPathKindProbeLines(outputLine: string): string[] {
  return [
    'try {',
    '  $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop',
    "  $kind = if ($item.PSIsContainer) { 'D' } else { 'F' }",
    '  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($candidate))',
    outputLine,
    '  } catch [System.Management.Automation.ItemNotFoundException] {',
    '    # Missing candidate paths are expected during discovery.',
    '  } catch {',
    `    "${DIAGNOSTIC_PREFIX}\`tpath-kind"`,
    '  }',
  ];
}

export function buildWindowsPathKindProbeScript(
  candidateCount: number,
  timeoutMs: number,
  batchCount = candidateCount,
): string {
  const inputPrelude = [
    '$stdin = [Console]::OpenStandardInput()',
    '$memory = New-Object System.IO.MemoryStream',
    '$stdin.CopyTo($memory)',
    '$json = [Text.Encoding]::UTF8.GetString($memory.ToArray())',
  ];
  if (candidateCount === 1) {
    return [
      ...inputPrelude,
      '$candidate = [string]($json | ConvertFrom-Json)',
      ...windowsPathKindProbeLines('  [Console]::Out.WriteLine($kind + "`t" + $encoded)'),
    ].join('\n');
  }
  const budgetMs = Math.max(timeoutMs - 250, 1);
  const operationCount = Math.min(Math.max(batchCount, 1), Math.max(candidateCount, 1));
  const maxConcurrency = Math.min(operationCount, 4);
  const operationWaves = Math.ceil(operationCount / maxConcurrency);
  const operationTimeoutMs = Math.min(
    Math.max(Math.floor(Math.max(budgetMs - 250, 1) / operationWaves), 1),
    1_250,
  );
  const encodedProbeCommand = Buffer.from([
    '$paths = @(([string]$env:CINDY_WINDOWS_GIT_PATH_CANDIDATES | ConvertFrom-Json))',
    'foreach ($pathValue in $paths) {',
    '  $candidate = [string]$pathValue',
    ...windowsPathKindProbeLines('    [Console]::Out.WriteLine($kind + "`t" + $encoded)'),
    '}',
  ].join('\n'), 'utf16le').toString('base64');
  return [
    ...inputPrelude,
    '$groups = @($json | ConvertFrom-Json)',
    `$probeCommand = '${encodedProbeCommand}'`,
    `$jobTypeSource = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${WINDOWS_KILL_ON_CLOSE_JOB_TYPE_BASE64}'))`,
    'try {',
    '  Add-Type -TypeDefinition $jobTypeSource -ErrorAction Stop | Out-Null',
    '  $jobHandle = [CindyWindowsGitPathJob]::CreateKillOnCloseForCurrentProcess()',
    '} catch {',
    `  [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '  return',
    '}',
    `$budgetMs = ${budgetMs}`,
    `$operationTimeoutMs = ${operationTimeoutMs}`,
    '$clock = [Diagnostics.Stopwatch]::StartNew()',
    `$maxConcurrency = ${maxConcurrency}`,
    '$operations = New-Object System.Collections.ArrayList',
    '$nextGroupIndex = 0',
    'function Write-ProbeOutput([System.Diagnostics.Process]$process) {',
    '  try {',
    "    foreach ($line in $process.StandardOutput.ReadToEnd() -split '\\r?\\n') {",
    '      if (-not [string]::IsNullOrWhiteSpace($line)) {',
    '        [Console]::Out.WriteLine([string]$line)',
    '      }',
    '    }',
    '  } catch {',
    `    [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '  }',
    '}',
    'try {',
    '  while (($nextGroupIndex -lt $groups.Count -or $operations.Count -gt 0) -and $clock.ElapsedMilliseconds -lt $budgetMs) {',
    '    while ($nextGroupIndex -lt $groups.Count -and $operations.Count -lt $maxConcurrency -and $clock.ElapsedMilliseconds -lt $budgetMs) {',
    '      $group = $groups[$nextGroupIndex]',
    '      $nextGroupIndex += 1',
    '      $process = $null',
    '      try {',
    '        $startInfo = New-Object System.Diagnostics.ProcessStartInfo',
    "        $startInfo.FileName = [IO.Path]::Combine($PSHOME, 'powershell.exe')",
    '        $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand $probeCommand"',
    '        $startInfo.UseShellExecute = $false',
    '        $startInfo.RedirectStandardOutput = $true',
    '        $startInfo.CreateNoWindow = $true',
    "        $startInfo.EnvironmentVariables['CINDY_WINDOWS_GIT_PATH_CANDIDATES'] = (ConvertTo-Json -InputObject @($group.paths) -Compress)",
    '        $process = New-Object System.Diagnostics.Process',
    '        $process.StartInfo = $startInfo',
    '        [void]$process.Start()',
    '        if (-not [CindyWindowsGitPathJob]::ContainsProcess($jobHandle, $process.Handle)) {',
    "          throw 'path probe child escaped kill-on-close job'",
    '        }',
    '        [void]$operations.Add([PSCustomObject]@{ Process = $process; StartedAt = $clock.ElapsedMilliseconds })',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '        if ($null -ne $process) {',
    '          try {',
    '            if (-not $process.HasExited) {',
    '              $process.Kill()',
    '              $process.WaitForExit()',
    '            }',
    '          } catch {',
    `            [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '          } finally {',
    '            $process.Dispose()',
    '          }',
    '        }',
    '      }',
    '    }',
    '    $now = $clock.ElapsedMilliseconds',
    '    $completed = @($operations | Where-Object { $_.Process.HasExited })',
    '    $expired = @($operations | Where-Object { -not $_.Process.HasExited -and $now - $_.StartedAt -ge $operationTimeoutMs })',
    '    if ($completed.Count -eq 0 -and $expired.Count -eq 0) {',
    '      Start-Sleep -Milliseconds 10',
    '      continue',
    '    }',
    '    foreach ($operation in $completed) {',
    '      try {',
    '        Write-ProbeOutput $operation.Process',
    '        if ($operation.Process.ExitCode -ne 0) {',
    `          [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '        }',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '      } finally {',
    '        $operation.Process.Dispose()',
    '        [void]$operations.Remove($operation)',
    '      }',
    '    }',
    '    foreach ($operation in $expired) {',
    `      [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '      try {',
    '        $operation.Process.Kill()',
    '        $operation.Process.WaitForExit()',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '      } finally {',
    '        if ($operation.Process.HasExited) {',
    '          Write-ProbeOutput $operation.Process',
    '        }',
    '        $operation.Process.Dispose()',
    '        [void]$operations.Remove($operation)',
    '      }',
    '    }',
    '  }',
    '  if ($nextGroupIndex -lt $groups.Count -or $operations.Count -gt 0) {',
    `    [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '  }',
    '} catch {',
    `  [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '} finally {',
    '  foreach ($operation in @($operations)) {',
    '    try {',
    '      if (-not $operation.Process.HasExited) {',
    '        $operation.Process.Kill()',
    '        $operation.Process.WaitForExit()',
    '      }',
    '    } catch {',
    `      [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '    } finally {',
    '      if ($operation.Process.HasExited) {',
    '        Write-ProbeOutput $operation.Process',
    '      }',
    '      $operation.Process.Dispose()',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

export function countWindowsPowerShellDiagnostics(output: string): number {
  return output.split(/\r?\n/).filter((line) => line.startsWith(`${DIAGNOSTIC_PREFIX}\t`)).length;
}

export function warnWindowsGitPathProbeDiagnostics(
  logger: WindowsGitPathLogger | undefined,
  probe: 'registry' | 'network-drives' | 'path-kinds',
  output: string,
): void {
  const failures = countWindowsPowerShellDiagnostics(output);
  if (failures === 0) return;
  logger?.warn('windows git path probe completed with recoverable PowerShell errors', { probe, failures });
}

export function warnWindowsGitPathProbeFailure(
  logger: WindowsGitPathLogger | undefined,
  probe: 'registry' | 'network-drives' | 'path-kinds',
  error: unknown,
): void {
  if (!logger) return;
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  logger.warn('windows git path probe failed; continuing without unavailable metadata', {
    probe,
    errorName: error instanceof Error ? error.name : typeof error,
    code: failure?.code,
    signal: failure?.signal,
    killed: failure?.killed,
  });
}
