import path from 'node:path';

export interface WindowsFileUrlOpenerOptions {
  platform?: NodeJS.Platform;
  windowsDir?: string;
  execFile: (
    file: string,
    args: string[],
    options: { windowsHide: boolean },
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
  ) => unknown;
}

const DEFAULT_WINDOWS_DIR = 'C:\\Windows';

function resolveRundll32Path(windowsDir: string | undefined): string {
  const candidate = windowsDir?.trim();
  const normalized = candidate ? path.win32.normalize(candidate) : '';
  const isLocalAbsolutePath = /^[A-Za-z]:[\\/]/.test(candidate ?? '');
  const isUncPath = candidate?.startsWith('\\\\') || candidate?.startsWith('//');

  if (!normalized || !isLocalAbsolutePath || isUncPath) {
    return path.win32.join(DEFAULT_WINDOWS_DIR, 'System32', 'rundll32.exe');
  }

  if (path.win32.basename(normalized).toLowerCase() === 'system32') {
    return path.win32.join(normalized, 'rundll32.exe');
  }

  return path.win32.join(normalized, 'System32', 'rundll32.exe');
}

/**
 * Create a Windows-only launcher that passes the complete file URL as an argv
 * value. Direct execFile avoids cmd.exe percent expansion and command parsing.
 */
export function createWindowsFileUrlOpener(
  options: WindowsFileUrlOpenerOptions,
): ((fileUrl: string) => Promise<void>) | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  // Never fall back to PATH lookup for this privileged URL handoff. WINDIR is
  // normally present, but the fixed default keeps a stripped-down environment
  // from becoming an executable-search-path trust boundary.
  const rundll32 = resolveRundll32Path(options.windowsDir);

  return (fileUrl) =>
    new Promise<void>((resolve, reject) => {
      options.execFile(
        rundll32,
        ['url.dll,FileProtocolHandler', fileUrl],
        { windowsHide: true },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }
          const detail = String(stderr).trim();
          reject(new Error(detail || error.message));
        },
      );
    });
}
