import { describe, expect, it, vi } from 'vitest';

import {
  buildWindowsNetworkDriveProbeScript,
  buildWindowsPathKindProbeScript,
  buildWindowsRegistryProbeScript,
  countWindowsPowerShellDiagnostics,
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

  it('locks the bounded concurrent runspace coordinator for multiple candidates', () => {
    const script = buildWindowsPathKindProbeScript(2, 3_000);

    expect(script).toContain('$paths = @($json | ConvertFrom-Json)');
    expect(script).toContain('$async = $shell.BeginInvoke()');
    expect(script).toContain('$operation.Shell.EndInvoke($operation.Async)');
    expect(script).toContain('$budgetMs = 2750');
    expect(script).toContain('WriteLine("__CINDY_WINDOWS_GIT_PATH_DIAGNOSTIC__`tpath-runspace")');
    expect(script).not.toContain('catch {}');
  });

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
