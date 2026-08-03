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

/**
 * Create a Windows-only launcher that passes the complete file URL as an argv
 * value. Direct execFile avoids cmd.exe percent expansion and command parsing.
 */
export function createWindowsFileUrlOpener(
  options: WindowsFileUrlOpenerOptions,
): ((fileUrl: string) => Promise<void>) | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const rundll32 = options.windowsDir
    ? path.win32.join(options.windowsDir, 'System32', 'rundll32.exe')
    : 'rundll32.exe';

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
