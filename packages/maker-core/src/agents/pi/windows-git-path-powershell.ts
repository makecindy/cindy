import type { Logger } from '../../interfaces/logger.js';

export type WindowsGitPathLogger = Pick<Logger, 'warn'>;

const DIAGNOSTIC_PREFIX = '__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__';

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

export function buildWindowsPathKindProbeScript(candidateCount: number, timeoutMs: number): string {
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
  const maxConcurrency = Math.min(Math.max(candidateCount, 1), 4);
  return [
    ...inputPrelude,
    '$paths = @($json | ConvertFrom-Json)',
    "$probeScript = @'",
    'param([string]$candidate)',
    ...windowsPathKindProbeLines('  $kind + "`t" + $encoded'),
    "'@",
    `$budgetMs = ${timeoutMs - 250}`,
    '$clock = [Diagnostics.Stopwatch]::StartNew()',
    `$maxConcurrency = ${maxConcurrency}`,
    '$runspacePool = $null',
    '$operations = New-Object System.Collections.ArrayList',
    '$nextPathIndex = 0',
    'try {',
    '  $runspacePool = [RunspaceFactory]::CreateRunspacePool(1, $maxConcurrency)',
    '  $runspacePool.Open()',
    '  while (($nextPathIndex -lt $paths.Count -or $operations.Count -gt 0) -and $clock.ElapsedMilliseconds -lt $budgetMs) {',
    '    while ($nextPathIndex -lt $paths.Count -and $operations.Count -lt $maxConcurrency -and $clock.ElapsedMilliseconds -lt $budgetMs) {',
    '      $candidate = [string]$paths[$nextPathIndex]',
    '      $nextPathIndex += 1',
    '      $shell = [PowerShell]::Create()',
    '      $shell.RunspacePool = $runspacePool',
    '      [void]$shell.AddScript($probeScript)',
    '      [void]$shell.AddArgument($candidate)',
    '      try {',
    '        $async = $shell.BeginInvoke()',
    '        [void]$operations.Add([PSCustomObject]@{ Shell = $shell; Async = $async })',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-runspace")`,
    '        $shell.Dispose()',
    '      }',
    '    }',
    '    $completed = @($operations | Where-Object { $_.Async.IsCompleted })',
    '    if ($completed.Count -eq 0) {',
    '      Start-Sleep -Milliseconds 10',
    '      continue',
    '    }',
    '    foreach ($operation in $completed) {',
    '      try {',
    '        foreach ($line in $operation.Shell.EndInvoke($operation.Async)) {',
    '          [Console]::Out.WriteLine([string]$line)',
    '        }',
    '      } catch {',
    `        [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-runspace")`,
    '      } finally {',
    '        $operation.Shell.Dispose()',
    '        [void]$operations.Remove($operation)',
    '      }',
    '    }',
    '  }',
    '  if ($nextPathIndex -lt $paths.Count -or $operations.Count -gt 0) {',
    `    [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-runspace")`,
    '  }',
    '} catch {',
    `  [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-runspace")`,
    '} finally {',
    '  foreach ($operation in @($operations)) {',
    '    try {',
    '      $operation.Shell.Stop()',
    '    } catch {',
    `      [Console]::Out.WriteLine("${DIAGNOSTIC_PREFIX}\`tpath-runspace")`,
    '    } finally {',
    '      $operation.Shell.Dispose()',
    '    }',
    '  }',
    '  if ($null -ne $runspacePool) {',
    '    $runspacePool.Dispose()',
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
