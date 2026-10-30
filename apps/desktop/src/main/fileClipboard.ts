import { execFile } from 'node:child_process';

/** Native file-list clipboard formats allow paste into both chat apps and folders. */
function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function copyFileToClipboardWindows(absPath: string): Promise<void> {
  // A single-quoted PowerShell literal only interprets doubled apostrophes.
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Set-Clipboard -LiteralPath '${absPath.replace(/'/g, "''")}'`]);
}

export function copyFileToClipboardMacOS(absPath: string): Promise<void> {
  // Keep the path in argv, never in AppleScript source.
  return run('osascript', ['-e', 'on run argv', '-e',
    'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', absPath]);
}
