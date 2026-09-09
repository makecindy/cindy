import { execFileSync } from 'node:child_process';

import type { Logger } from '../../interfaces/logger.js';

export type WindowsGitPathLogger = Pick<Logger, 'warn'>;

const DIAGNOSTIC_PREFIX = '__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__';
// 忙碌的 Windows 宿主(如 CI hosted runner)上 PowerShell 冷启动就可能超过
// 5 秒:2 秒预算会让清理进程在 Stop-Process 执行前就被 execFileSync 超时
// 杀掉,后代进程泄漏(#3574 的偶发失败正是这个竞态)。清理只在探测已经
// 失败的收尾路径运行,放宽预算不影响任何成功路径的耗时。
const WINDOWS_DESCENDANT_CLEANUP_TIMEOUT_MS = 10_000;

type WindowsPowerShellProbe = 'registry' | 'network-drives' | 'path-kinds' | 'path-cleanup';

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

export function buildWindowsDescendantCleanupScript(rootProcessId: number): string {
  if (!Number.isInteger(rootProcessId) || rootProcessId <= 0) {
    throw new RangeError('rootProcessId must be a positive integer');
  }
  return [
    '$pending = New-Object System.Collections.ArrayList',
    '$descendants = New-Object System.Collections.ArrayList',
    `[void]$pending.Add(${rootProcessId})`,
    'while ($pending.Count -gt 0) {',
    '  $parentProcessId = [int]$pending[0]',
    '  $pending.RemoveAt(0)',
    '  $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $parentProcessId) -ErrorAction Stop)',
    '  foreach ($child in $children) {',
    '    $childProcessId = [int]$child.ProcessId',
    '    [void]$descendants.Add($childProcessId)',
    '    [void]$pending.Add($childProcessId)',
    '  }',
    '}',
    'for ($index = $descendants.Count - 1; $index -ge 0; $index -= 1) {',
    '  Stop-Process -Id ([int]$descendants[$index]) -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n');
}

export function terminateWindowsPowerShellDescendants(
  powershell: string,
  rootProcessId: number | undefined,
  logger?: WindowsGitPathLogger,
): void {
  if (typeof rootProcessId !== 'number' || !Number.isInteger(rootProcessId) || rootProcessId <= 0) return;
  try {
    execFileSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsDescendantCleanupScript(rootProcessId)],
      {
        stdio: 'ignore',
        timeout: WINDOWS_DESCENDANT_CLEANUP_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    warnWindowsGitPathProbeFailure(logger, 'path-cleanup', error);
  }
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

export function maxWindowsPathKindProbeBatchCount(timeoutMs: number): number {
  const budgetMs = Math.max(timeoutMs - 250, 1);
  const availableOperationBudgetMs = Math.max(budgetMs - 250, 1);
  const operationTimeoutMs = Math.min(availableOperationBudgetMs, 1_250);
  const maxOperationWaves = Math.max(Math.floor(availableOperationBudgetMs / operationTimeoutMs), 1);
  return 4 * maxOperationWaves;
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
  const availableOperationBudgetMs = Math.max(budgetMs - 250, 1);
  const operationTimeoutMs = Math.min(availableOperationBudgetMs, 1_250);
  const maxOperationCount = Math.min(operationCount, maxWindowsPathKindProbeBatchCount(timeoutMs));
  const encodedProbeCommand = Buffer.from([
    '$paths = @(([string]$env:CINDY_WINDOWS_GIT_PATH_CANDIDATES | ConvertFrom-Json))',
    'foreach ($pathValue in $paths) {',
    '  $candidate = [string]$pathValue',
    ...windowsPathKindProbeLines('    [Console]::Out.WriteLine($kind + "`t" + $encoded)'),
    '}',
  ].join('\n'), 'utf16le').toString('base64');
  return [
    ...inputPrelude,
    '$allGroups = @($json | ConvertFrom-Json)',
    `$groups = @($allGroups | Select-Object -First ${maxOperationCount})`,
    'if ($allGroups.Count -gt $groups.Count) {',
    `  [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-budget")`,
    '}',
    `$probeCommand = '${encodedProbeCommand}'`,
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
    '        [void]$operations.Add([PSCustomObject]@{ Process = $process; StartedAt = $clock.ElapsedMilliseconds })',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-process")`,
    '        if ($null -ne $process) {',
    '          $process.Dispose()',
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
  probe: WindowsPowerShellProbe,
  output: string,
): void {
  const failures = countWindowsPowerShellDiagnostics(output);
  if (failures === 0) return;
  logger?.warn('windows git path probe completed with recoverable PowerShell errors', { probe, failures });
}

export function warnWindowsGitPathProbeFailure(
  logger: WindowsGitPathLogger | undefined,
  probe: WindowsPowerShellProbe,
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
