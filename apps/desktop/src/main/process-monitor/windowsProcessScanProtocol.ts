export const WINDOWS_PROCESS_SCAN_SCRIPT = [
  'Get-CimInstance Win32_Process |',
  'ForEach-Object {',
  '  $cmd = ([string]$_.CommandLine) -replace "`r|`n", " "',
  '  $created = if ($null -eq $_.CreationDate) { "" } else { $_.CreationDate.ToUniversalTime().Ticks }',
  '  Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.UserModeTime + $_.KernelModeTime), $created, $cmd)',
  '}',
].join('\n');

export type WindowsProcessScanWorkerResponse =
  | { ok: true; stdout: string }
  | {
      ok: false;
      error: {
        message: string;
        code?: string;
        syscall?: string;
      };
    };

export type WindowsProcessScanWorkerMessage =
  { type: 'started'; pid: number } | { type: 'result'; response: WindowsProcessScanWorkerResponse };

export function isWindowsProcessScanWorkerResponse(
  value: unknown,
): value is WindowsProcessScanWorkerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as {
    ok?: unknown;
    stdout?: unknown;
    error?: { message?: unknown; code?: unknown; syscall?: unknown };
  };
  if (response.ok === true) return typeof response.stdout === 'string';
  if (response.ok !== false || !response.error || typeof response.error !== 'object') return false;
  return (
    typeof response.error.message === 'string' &&
    (response.error.code === undefined || typeof response.error.code === 'string') &&
    (response.error.syscall === undefined || typeof response.error.syscall === 'string')
  );
}

export function isWindowsProcessScanWorkerMessage(
  value: unknown,
): value is WindowsProcessScanWorkerMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { type?: unknown; pid?: unknown; response?: unknown };
  if (message.type === 'started') {
    return Number.isSafeInteger(message.pid) && Number(message.pid) > 0;
  }
  return message.type === 'result' && isWindowsProcessScanWorkerResponse(message.response);
}
