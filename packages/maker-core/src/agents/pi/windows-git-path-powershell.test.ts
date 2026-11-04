import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildWindowsNetworkDriveProbeScript,
  buildWindowsPathKindProbeScript,
  buildWindowsRegistryProbeScript,
  countWindowsPowerShellDiagnostics,
  maxWindowsPathKindProbeBatchCount,
  warnWindowsGitPathProbeDiagnostics,
  warnWindowsGitPathProbeFailure,
} from './windows-git-path-powershell.js';

// Test-only startup/teardown headroom around the positive case's 30s coordinator;
// the deadline must cover the coordinator budget plus PowerShell cold start.
const PATH_PROBE_TEST_PROCESS_TIMEOUT_MS = 60_000;

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
    for (const phase of ['output', 'start', 'exit', 'complete', 'timeout', 'budget', 'coordinator', 'cleanup']) {
      expect(script).toContain(`WriteLine("__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__\`tpath-process-${phase}")`);
    }
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

  it('attaches the coordinator to its owned job before starting any nested probe', () => {
    const script = buildWindowsPathKindProbeScript(2, 3_000);

    expect(script).toContain('limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(script).toContain('AssignProcessToJobObject(job, GetCurrentProcess())');
    expect(script.indexOf('[CindyWindowsPathProbeJob]::Attach()')).toBeLessThan(
      script.indexOf('[void]$process.Start()'),
    );
    expect(script).toContain('__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tpath-process-job');
    expect(script).not.toContain('Get-CimInstance');
  });

  it('bounds an explicit child budget and queue admission by the coordinator budget', () => {
    expect(maxWindowsPathKindProbeBatchCount(3_000)).toBe(8);
    expect(maxWindowsPathKindProbeBatchCount(10_000, 10_000)).toBe(4);
    const script = buildWindowsPathKindProbeScript(25, 10_000, 25, { operationTimeoutMs: 10_000 });
    expect(script).toContain('$operationTimeoutMs = 9500');
    expect(script).toContain('$budgetMs = 9750');
    expect(script).toContain('$groups = @($allGroups | Select-Object -First 4)');
    expect(script).toContain('$maxConcurrency = 4');
  });

  it.runIf(process.platform === 'win32').each([0, 2_000])(
    'executes grouped path probes in Windows PowerShell with %i ms child delay',
    (delayMs) => {
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
        const runProbe = (script: string, childDelayMs = delayMs) => {
          // Inject latency in the real nested command, without adding a production
          // delay hook. This deterministically exercises the old 1250ms cutoff.
          const encoded = script.match(/\$probeCommand = '([^']+)'/)?.[1];
          if (!encoded) throw new Error('Missing nested probe command');
          const delayedCommand = Buffer.from(
            `Start-Sleep -Milliseconds ${childDelayMs}\n${Buffer.from(encoded, 'base64').toString('utf16le')}`,
            'utf16le',
          ).toString('base64');
          const label = `[windows-git-path-test] child-delay=${childDelayMs}ms`;
          const instrumentedScript = [
            `[Console]::Error.WriteLine('${label} START coordinator')`,
            script.replace(encoded, delayedCommand),
            `[Console]::Error.WriteLine('${label} END coordinator')`,
          ].join('\n');
          const started = performance.now();
          console.info(`${label} START process (timeout=${PATH_PROBE_TEST_PROCESS_TIMEOUT_MS}ms)`);
          try {
            return execFileSync(
              path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
              ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', instrumentedScript],
              {
                encoding: 'utf8',
                input: Buffer.from(JSON.stringify(groups), 'utf8'),
                stdio: ['pipe', 'pipe', 'inherit'],
                timeout: PATH_PROBE_TEST_PROCESS_TIMEOUT_MS,
                windowsHide: true,
              },
            );
          } finally {
            console.info(`${label} END process (${Math.round(performance.now() - started)}ms)`);
          }
        };
        if (delayMs > 0) {
          // Outlive even the outer deadline, so scheduler pauses cannot make the
          // negative case complete before the coordinator observes expiry.
          const expired = runProbe(
            buildWindowsPathKindProbeScript(4, 10_000, 2),
            PATH_PROBE_TEST_PROCESS_TIMEOUT_MS * 2,
          );
          expect(expired).toMatch(/__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__\tpath-process-(timeout|budget)/);
          expect(expired).not.toContain(`F\t${Buffer.from(validGit, 'utf16le').toString('base64')}`);
        }

        // Correctness needs startup headroom at BOTH timeout layers. Production
        // callers retain their default 1250ms child budget and 3000ms outer budget.
        // On a loaded CI shard a nested powershell.exe has taken >9.5s just to start
        // (the coordinator's own startup and teardown are also outside its budget),
        // so the positive case waits up to 30s per child while the outer deadline
        // stays well above the coordinator budget at 60s.
        const output = runProbe(buildWindowsPathKindProbeScript(4, 30_000, 2, { operationTimeoutMs: 30_000 }));

        expect(output).toContain(`D\t${Buffer.from(validCmd, 'utf16le').toString('base64')}`);
        expect(output).toContain(`F\t${Buffer.from(validGit, 'utf16le').toString('base64')}`);
        expect(output).not.toContain(Buffer.from(path.join(staleRoot, 'cmd'), 'utf16le').toString('base64'));
        expect(countWindowsPowerShellDiagnostics(output)).toBe(0);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    PATH_PROBE_TEST_PROCESS_TIMEOUT_MS * 2 + 10_000,
  );

  // Regression: #6117 CI left a real child alive when the separate CIM cleanup
  // timed out. Exercise the production coordinator and keep the OS liveness
  // assertion; source-contract tests above cannot validate a Windows Job Object.
  // Tier: existing native Windows unit probe; macOS/Linux explicitly skip it.
  it.runIf(process.platform === 'win32').each(['terminated', 'exited'] as const)(
    'reaps live probe descendants when the coordinator is %s',
    async (exitMode) => {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new Error('Windows system root is unavailable');
      const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const productionScript = buildWindowsPathKindProbeScript(2, 30_000, 1, { operationTimeoutMs: 30_000 });
      const encoded = productionScript.match(/\$probeCommand = '([^']+)'/)?.[1];
      if (!encoded) throw new Error('Missing nested probe command');
      const sleepingCommand = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
      // Instrument the existing spawn boundary, never a production delay hook.
      // Publish the real child PID before terminating/exiting the coordinator.
      const script = productionScript.replace(encoded, sleepingCommand).replace(
        '[void]$process.Start()',
        [
          '[void]$process.Start()',
          '[Console]::Out.WriteLine("child=" + $process.Id)',
          '[Console]::Out.Flush()',
          ...(exitMode === 'exited' ? ['exit 0'] : []),
        ].join('\n'),
      );
      let childPid: number | undefined;
      let childGone = false;
      let coordinator: ReturnType<typeof spawn> | undefined;
      try {
        coordinator = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const coordinatorExit = new Promise<void>((resolve) => {
          coordinator?.once('exit', () => resolve());
        });
        coordinator.stdin?.end(JSON.stringify([{ paths: ['unused-one', 'unused-two'] }]));
        let output = '';
        let errors = '';
        coordinator.stdout?.setEncoding('utf8');
        coordinator.stdout?.on('data', (chunk: string) => { output += chunk; });
        coordinator.stderr?.setEncoding('utf8');
        coordinator.stderr?.on('data', (chunk: string) => { errors += chunk; });
        await vi.waitFor(() => {
          childPid = Number(output.match(/child=(\d+)/)?.[1]);
          expect(Number.isInteger(childPid) && childPid > 0, JSON.stringify({ output, errors })).toBe(true);
        }, { timeout: PATH_PROBE_TEST_PROCESS_TIMEOUT_MS, interval: 50 });
        if (exitMode === 'terminated') expect(coordinator.kill()).toBe(true);
        await coordinatorExit;

        // Probe the actual OS process directly, without another cold PowerShell
        // startup. Only ESRCH proves absence; permission or other errors fail.
        await vi.waitFor(() => {
          let exists = true;
          try {
            process.kill(childPid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            exists = false;
          }
          expect(exists, JSON.stringify({ coordinatorPid: coordinator?.pid, childPid, output, errors })).toBe(false);
        }, { timeout: 8_000, interval: 50 });
        childGone = true;
      } finally {
        // Only this fixture's live coordinator is owned. A completed PID can
        // already be reused; do not send taskkill to it after a successful exit.
        if (coordinator && coordinator.exitCode === null && coordinator.signalCode === null) coordinator.kill();
        if (childPid && !childGone) {
          spawnSync('taskkill.exe', ['/PID', String(childPid), '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        }
      }
    },
    PATH_PROBE_TEST_PROCESS_TIMEOUT_MS + 15_000,
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
