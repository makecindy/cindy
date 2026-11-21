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
import { classifyWindowsSupport, parseServiceRegistration } from '../windowsSupportState';

/** `promisify(execFile)` calls the callback form, so replies go through it. */
type ExecReply = { stdout: string; exitCode: number };
let helperReply: ExecReply = { stdout: '', exitCode: 0 };
/** null = the `sc` process itself failed (binary missing / timeout). */
let scReply: ExecReply | null = null;

function installExecMock(): void {
  execFile.mockImplementation((_binary, args, _options, callback) => {
    const target: ExecReply | null =
      Array.isArray(args) && args.includes('state=') ? scReply : helperReply;
    if (target === null) {
      callback(Object.assign(new Error('sc unavailable'), { code: 1 }));
      return;
    }
    if (target.exitCode === 0) {
      callback(null, { stdout: target.stdout, stderr: '' });
      return;
    }
    callback(
      Object.assign(new Error('exit'), {
        code: target.exitCode,
        stdout: target.stdout,
        stderr: '',
      }),
    );
  });
}

function helperPrints(stdout: string, exitCode = 0): void {
  helperReply = { stdout, exitCode };
  installExecMock();
}

/** Reply for the `sc query state= all` registration probe (issue #11862). */
function scPrints(stdout: string, exitCode = 0): void {
  scReply = { stdout, exitCode };
  installExecMock();
}

/** Make the SCM probe itself fail so production falls back to the intent. */
function scUnavailable(): void {
  scReply = null;
  installExecMock();
}

afterEach(() => {
  electronApp.isPackaged = true;
  electronApp.getAppPath.mockReset();
  electronApp.getPath.mockReset();
  execFile.mockReset();
  helperReply = { stdout: '', exitCode: 0 };
  scReply = null;
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
    // SCM answers with no CindyRemoteDesktop- service → genuinely uninstalled.
    scPrints('');
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

  // ── issue #11862: 未安装 / 已安装未运行 / 运行中 三态 ──

  it('separates a registered-but-stopped service from an uninstalled one (#11862)', async () => {
    // After a reboot the SERVICE_DEMAND_START service is STOPPED while
    // service::pid requires SERVICE_RUNNING, so --status prints `missing` for
    // both cases; the SCM registration probe is what splits them.
    helperPrints('missing');
    scPrints(
      'SERVICE_NAME: CindyRemoteDesktop-18e20dabd4ab34c95b1e0e430d252389\r\nSTATE : 1  STOPPED\r\n',
    );
    expect(await readWindowsDesktopSupport()).toBe('stopped');

    scPrints(''); // no CindyRemoteDesktop- service → not registered
    expect(await readWindowsDesktopSupport()).toBe('missing');
  });

  it('falls back to the persisted authorization only when the SCM probe fails', async () => {
    helperPrints('missing');
    scUnavailable();
    expect(await readWindowsDesktopSupport(true)).toBe('stopped');
    expect(await readWindowsDesktopSupport()).toBe('missing');
    // A working probe wins over the stored intent: authorized but the service
    // is really gone still reads as `missing`.
    scPrints('');
    expect(await readWindowsDesktopSupport(true)).toBe('missing');
  });

  it('reports stopped when the running service refuses the pipe probe', async () => {
    // status=ready means registered and running; the probe then loads the
    // native addon, which does not exist in this fixture → refused.
    helperPrints('ready');
    expect(await readWindowsDesktopSupport()).toBe('stopped');
  });
});

// Platform-independent: the pure state machine needs no helper, no SCM and no
// win32, so it runs on every CI runner (the describe above is win32-only).
describe('three-state classification (pure)', () => {
  it('maps helper words and probe results to ready / stopped / missing / unavailable', () => {
    expect(classifyWindowsSupport('ready', { pipeProbe: 'ok' })).toBe('ready');
    expect(classifyWindowsSupport('ready', { pipeProbe: 'refused' })).toBe('stopped');
    expect(classifyWindowsSupport('missing', { registration: 'exists' })).toBe('stopped');
    expect(classifyWindowsSupport('missing', { registration: 'absent' })).toBe('missing');
    expect(classifyWindowsSupport('missing', { registration: 'unknown', authorized: true })).toBe(
      'stopped',
    );
    expect(classifyWindowsSupport('missing', { registration: 'unknown' })).toBe('missing');
    // Intent never overrides a conclusive probe.
    expect(classifyWindowsSupport('missing', { registration: 'absent', authorized: true })).toBe(
      'missing',
    );
    expect(classifyWindowsSupport('installRequired protected-root 0')).toBe('unavailable');
  });

  it('recognizes the service-name prefix whatever the installation id is', () => {
    expect(
      parseServiceRegistration(
        'SERVICE_NAME: CindyRemoteDesktop-18e20dabd4ab34c95b1e0e430d252389\r\nSTATE : 1  STOPPED',
      ),
    ).toBe('exists');
    expect(parseServiceRegistration('SERVICE_NAME: SomeOtherService')).toBe('absent');
    expect(parseServiceRegistration('')).toBe('absent');
  });
});
