// Protects the diagnosis path for Windows lock-screen setup. Before this, the
// helper printed a bare "error", Main threw a generic failure and the settings
// page said only "authorization was not completed" — so a failed setup gave
// nobody anything to act on. These cases assert the production entry points
// carry the helper's step code through, and that a helper which cannot work out
// where it would install is not offered to the user as a setup they can finish.
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const execFile = vi.hoisted(() => vi.fn());
const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  getAppPath: vi.fn(),
  getPath: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import {
  configureWindowsDesktopSupport,
  readWindowsDesktopDetail,
  readWindowsDesktopSupport,
  windowsCargoTarget,
  WindowsDesktopSetupError,
} from '../windowsHost';

/** `promisify(execFile)` calls the callback form, so replies go through it. */
function helperPrints(stdout: string, exitCode = 0): void {
  execFile.mockImplementation((_binary, _args, _options, callback) => {
    if (exitCode === 0) {
      callback(null, { stdout, stderr: '' });
      return;
    }
    callback(Object.assign(new Error('exit'), { code: exitCode, stdout, stderr: '' }));
  });
}

afterEach(() => {
  electronApp.isPackaged = true;
  electronApp.getAppPath.mockReset();
  electronApp.getPath.mockReset();
  execFile.mockReset();
});
// Set by Electron in a packaged app; the helper path is built from it.
Object.defineProperty(process, 'resourcesPath', {
  value: 'C:\\Program Files\\Cindy\\resources',
  configurable: true,
});

describe.skipIf(process.platform !== 'win32')('windows lock-screen setup diagnostics', () => {
  it('builds source helpers for the running Electron architecture', () => {
    expect(windowsCargoTarget('x64')).toBe('x86_64-pc-windows-msvc');
    expect(windowsCargoTarget('arm64')).toBe('aarch64-pc-windows-msvc');
    expect(() => windowsCargoTarget('ia32')).toThrow('Unsupported Windows desktop architecture');
  });

  it('reads the failed step from a status line and from an error line', () => {
    expect(readWindowsDesktopDetail('installRequired protected-root 0')).toBe('protected-root 0');
    expect(readWindowsDesktopDetail('error service-create 5')).toBe('service-create 5');
    expect(readWindowsDesktopDetail('error elevate-child/stage-write 5')).toBe(
      'elevate-child/stage-write 5',
    );
    // Nothing that is not a step code may reach the log or the settings page,
    // since a path or account name there would leak machine content.
    expect(readWindowsDesktopDetail('error C:\\Users\\someone\\Cindy failed')).toBeUndefined();
    expect(readWindowsDesktopDetail('ready')).toBeUndefined();
    expect(readWindowsDesktopDetail(undefined)).toBeUndefined();
  });

  it('keeps the step code on the error a failed setup throws', async () => {
    helperPrints('error elevate-child/stage-write 5', 21);
    const failure = await configureWindowsDesktopSupport(true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WindowsDesktopSetupError);
    expect((failure as WindowsDesktopSetupError).detail).toBe('elevate-child/stage-write 5');
  });

  it('offers setup when the service is simply not installed yet', async () => {
    helperPrints('missing');
    expect(await readWindowsDesktopSupport()).toBe('missing');
  });

  it('does not compile source helpers during a status-only read', async () => {
    electronApp.isPackaged = false;
    electronApp.getAppPath.mockReturnValue(
      path.basename(process.cwd()).toLowerCase() === 'desktop'
        ? process.cwd()
        : path.join(process.cwd(), 'apps', 'desktop'),
    );
    electronApp.getPath.mockReturnValue(
      path.join(os.tmpdir(), `cindy-lock-screen-status-${process.pid}`),
    );

    expect(await readWindowsDesktopSupport()).toBe('missing');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('does not offer setup when the helper cannot locate an installation', async () => {
    // `installRequired` from the helper means it could not work out where it
    // would install at all. Reporting that as a pending setup would leave the
    // user pressing a button that can never succeed.
    helperPrints('installRequired protected-root 0');
    expect(await readWindowsDesktopSupport()).toBe('unavailable');
  });
});
