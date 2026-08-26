import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildWindowsNetworkDriveProbeScript,
  buildWindowsPathKindProbeScript,
  buildWindowsRegistryProbeScript,
  buildWindowsDescendantCleanupScript,
  countWindowsPowerShellDiagnostics,
  terminateWindowsPowerShellDescendants,
  warnWindowsGitPathProbeDiagnostics,
  warnWindowsGitPathProbeFailure,
} from './windows-git-path-powershell.js';

describe('Windows Git PATH PowerShell probes', () => {
  it('locks the registry probe command and distinguishes missing keys from real failures', () => {
    const script = buildWindowsRegistryProbeScript([
      'Registry::HKEY_CURRENT_USER\\SOFTWARE\\GitForWindows',
      'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows',
    ]);

    expect(script).toContain("Get-ItemPropertyValue -LiteralPath $key -Name 'InstallPath' -ErrorAction Stop");
    expect(script).toContain('[Text.Encoding]::Unicode.GetBytes([string]$value)');
    expect(script).toContain('catch [System.Management.Automation.ItemNotFoundException]');
    expect(script).toContain('WriteLine("__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tregistry")');
    expect(script).not.toContain('catch {}');
  });

  it('locks the mapped-drive classification probe and emits an unexpected-failure record', () => {
    const script = buildWindowsNetworkDriveProbeScript();

    expect(script).toContain('[System.IO.DriveInfo]::GetDrives()');
    expect(script).toContain('[System.IO.DriveType]::Network');
    expect(script).toContain('WriteLine("__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tnetwork-drives")');
    expect(script).not.toContain('catch {}');
  });

  it('locks the single-candidate UTF-8 JSON and path metadata probe', () => {
    const script = buildWindowsPathKindProbeScript(1, 3_000);

    expect(script).toContain('[Console]::OpenStandardInput()');
    expect(script).toContain('[Text.Encoding]::UTF8.GetString($memory.ToArray())');
    expect(script).toContain('$candidate = [string]($json | ConvertFrom-Json)');
    expect(script).toContain('Get-Item -LiteralPath $candidate -Force -ErrorAction Stop');
    expect(script).toContain('"__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tpath-kind"');
    expect(script).not.toContain('catch {}');
  });

  it('locks the bounded install-root process coordinator for multiple candidates', () => {
    const script = buildWindowsPathKindProbeScript(8, 3_000);

    expect(script).toContain('$allGroups = @($json | ConvertFrom-Json)');
    expect(script).toContain('$groups = @($allGroups | Select-Object -First 8)');
    expect(script).toContain('$clock = [Diagnostics.Stopwatch]::StartNew()');
    expect(script).toContain('$maxConcurrency = 4');
    expect(script).toContain('$operationTimeoutMs = 1250');
    expect(script).toContain('$operations.Count -lt $maxConcurrency');
    expect(script).toContain('$nextGroupIndex -lt $groups.Count -or $operations.Count -gt 0');
    expect(script).toContain("$startInfo.FileName = [IO.Path]::Combine($PSHOME, 'powershell.exe')");
    expect(script).toContain("$startInfo.EnvironmentVariables['CINDY_WINDOWS_GIT_PATH_CANDIDATES']");
    expect(script).toContain('[void]$process.Start()');
    expect(script).toContain('$expired = @($operations | Where-Object');
    expect(script).toContain('$operation.Process.Kill()');
    expect(script).toContain('Write-ProbeOutput $operation.Process');
    expect(script).toContain('$budgetMs = 2750');
    expect(script).toContain('if ($nextGroupIndex -lt $groups.Count -or $operations.Count -gt 0) {');
    expect(script).toContain('WriteLine("__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tpath-process")');
    expect(script).not.toContain('foreach ($candidate in $paths)');
    expect(script).not.toContain('[RunspaceFactory]');
    expect(script.indexOf('$clock = [Diagnostics.Stopwatch]::StartNew()'))
      .toBeLessThan(script.indexOf('[void]$process.Start()'));
    expect(script.indexOf('$completed = @($operations | Where-Object { $_.Process.HasExited })'))
      .toBeLessThan(script.indexOf('foreach ($operation in $completed)'));
    expect(script).not.toContain('catch {}');

    const encodedProbeCommand = script.match(/\$probeCommand = '([^']+)'/)?.[1];
    expect(encodedProbeCommand).toBeTruthy();
    const probeCommand = Buffer.from(encodedProbeCommand ?? '', 'base64').toString('utf16le');
    expect(probeCommand).toContain('$env:CINDY_WINDOWS_GIT_PATH_CANDIDATES | ConvertFrom-Json');
    expect(probeCommand).toContain('foreach ($pathValue in $paths)');
    expect(probeCommand).toContain('Get-Item -LiteralPath $candidate -Force -ErrorAction Stop');
    expect(probeCommand).toContain('WriteLine($kind + "`t" + $encoded)');
  });

  it('caps queued install roots instead of shrinking PowerShell startup time', () => {
    const script = buildWindowsPathKindProbeScript(25, 3_000, 25);

    expect(script).toContain('$maxConcurrency = 4');
    expect(script).toContain('$operationTimeoutMs = 1250');
    expect(script).toContain('$groups = @($allGroups | Select-Object -First 8)');
    expect(script).toContain('__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tpath-budget');
    expect(script).toContain('$nextGroupIndex += 1');
  });

  it('builds a recursive descendant cleanup script without candidate path data', () => {
    const script = buildWindowsDescendantCleanupScript(4321);

    expect(script).toContain('[void]$pending.Add(4321)');
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('ParentProcessId = ');
    expect(script).toContain('$descendants.Count - 1');
    expect(script).toContain('Stop-Process -Id ([int]$descendants[$index]) -Force');
    expect(script).not.toContain('C:\\');
    expect(() => buildWindowsDescendantCleanupScript(0)).toThrow(RangeError);
  });

  it.runIf(process.platform === 'win32')('executes grouped path probes in Windows PowerShell', () => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows system root is unavailable');
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-git-path-'));
    try {
      const staleRoot = path.join(tempRoot, 'stale-git');
      const validRoot = path.join(tempRoot, '有效 Git');
      const validCmd = path.join(validRoot, 'cmd');
      const validGit = path.join(validCmd, 'git.exe');
      mkdirSync(validCmd, { recursive: true });
      writeFileSync(validGit, '');
      const groups = [
        { paths: [path.join(staleRoot, 'cmd'), path.join(staleRoot, 'cmd', 'git.exe')] },
        { paths: [validCmd, validGit] },
      ];
      const output = execFileSync(
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', buildWindowsPathKindProbeScript(4, 3_000, 2)],
        {
          encoding: 'utf8',
          input: Buffer.from(JSON.stringify(groups), 'utf8'),
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5_000,
          windowsHide: true,
        },
      );

      expect(output).toContain(`D\t${Buffer.from(validCmd, 'utf16le').toString('base64')}`);
      expect(output).toContain(`F\t${Buffer.from(validGit, 'utf16le').toString('base64')}`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'kills probe descendants after the coordinator is terminated',
    async () => {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error('Windows system root is unavailable');
      const powershell = path.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const encodedSleepCommand = Buffer.from('Start-Sleep -Seconds 30', 'utf16le').toString(
        'base64',
      );
      const script = [
        '$startInfo = New-Object System.Diagnostics.ProcessStartInfo',
        `$startInfo.FileName = '${powershell.replaceAll("'", "''")}'`,
        `$startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedSleepCommand}'`,
        '$startInfo.UseShellExecute = $false',
        '$startInfo.CreateNoWindow = $true',
        '$process = New-Object System.Diagnostics.Process',
        '$process.StartInfo = $startInfo',
        '[void]$process.Start()',
        '[Console]::Out.WriteLine($process.Id)',
        '[Console]::Out.Flush()',
        'Start-Sleep -Seconds 30',
      ].join('\n');
      let childPid: number | undefined;
      let coordinatorPid: number | undefined;
      let coordinator: ReturnType<typeof spawn> | undefined;
      try {
        coordinator = spawn(
          powershell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        coordinatorPid = coordinator.pid;
        expect(Number.isInteger(coordinatorPid) && (coordinatorPid ?? 0) > 0).toBe(true);

        let output = '';
        coordinator.stdout?.setEncoding('utf8');
        coordinator.stdout?.on('data', (chunk: string) => {
          output += chunk;
        });
        await vi.waitFor(
          () => {
            childPid = Number(output.trim().split(/\r?\n/).at(-1));
            expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
          },
          { timeout: 5_000, interval: 50 },
        );

        const coordinatorExit = new Promise<void>((resolve) => {
          coordinator?.once('exit', () => resolve());
        });
        expect(coordinator.kill()).toBe(true);
        await coordinatorExit;

        terminateWindowsPowerShellDescendants(powershell, coordinatorPid);

        execFileSync(
          powershell,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            [
              '$deadline = [DateTime]::UtcNow.AddSeconds(3)',
              `while (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) {`,
              '  if ([DateTime]::UtcNow -ge $deadline) { exit 1 }',
              '  Start-Sleep -Milliseconds 50',
              '}',
            ].join('\n'),
          ],
          { stdio: 'ignore', timeout: 5_000, windowsHide: true },
        );
      } finally {
        if (coordinatorPid) {
          spawnSync('taskkill.exe', ['/PID', String(coordinatorPid), '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
        if (childPid) {
          spawnSync('taskkill.exe', ['/PID', String(childPid), '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        }
      }
    },
    12_000,
  );

  it('reports recoverable script failures only when a logger is supplied', () => {
    const warn = vi.fn();
    const output = [
      '__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__\tpath-kind',
      '__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__\tpath-runspace',
      'F\tignored-record',
    ].join('\r\n');

    expect(countWindowsPowerShellDiagnostics(output)).toBe(2);
    warnWindowsGitPathProbeDiagnostics({ warn }, 'path-kinds', output);
    warnWindowsGitPathProbeDiagnostics(undefined, 'path-kinds', output);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'windows git path probe completed with recoverable PowerShell errors',
      { probe: 'path-kinds', failures: 2 },
    );
  });

  it('reports bounded subprocess failures without logging candidate paths', () => {
    const warn = vi.fn();
    const error = Object.assign(new Error('command included C:\\Users\\alice\\Git'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      killed: true,
    });

    warnWindowsGitPathProbeFailure({ warn }, 'registry', error);

    expect(warn).toHaveBeenCalledWith(
      'windows git path probe failed; continuing without unavailable metadata',
      {
        probe: 'registry',
        errorName: 'Error',
        code: 'ETIMEDOUT',
        signal: 'SIGTERM',
        killed: true,
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('alice');
  });
});
