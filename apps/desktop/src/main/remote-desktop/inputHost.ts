import { app, screen } from 'electron';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DesktopInput,
  DesktopPermissionStatus,
  RemoteDesktopDisplayMode,
} from '@cindy/device-link';
import { acquireHumanDesktopInput } from './inputOwnership';
import {
  openWindowsDesktopConnection,
  readWindowsDesktopSupport,
  type WindowsDesktopConnection,
} from './windowsHost';

const exec = promisify(execFile);
const binaryName =
  process.platform === 'darwin' ? 'cindy-macos-desktop-input' : 'cindy-windows-desktop-input.exe';
let build: Promise<string> | null = null;
async function resolveBinary(): Promise<string> {
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'tools', 'remote-desktop', binaryName);
  if (build) return build;
  const resolve = async () => {
    const sourceRoot = path.join(app.getAppPath(), 'native', 'remote-desktop');
    const source =
      process.platform === 'darwin'
        ? path.join(sourceRoot, 'macos-input.swift')
        : path.join(sourceRoot, 'windows-input', 'src', 'main.rs');
    const digest = createHash('sha256')
      .update(await fs.readFile(source))
      .update(process.arch)
      .update('v1-O');
    const callerSource =
      process.platform === 'darwin'
        ? await fs.readFile(
            path.resolve(
              app.getAppPath(),
              '../../packages/remote-credentials-native/Sources/DesktopNativeCaller/DesktopNativeCaller.swift',
            ),
            'utf8',
          )
        : '';
    digest.update(callerSource);
    if (process.platform === 'darwin') digest.update(process.execPath).update('dev-caller-v1');
    if (process.platform === 'win32') {
      digest.update(await fs.readFile(path.join(sourceRoot, 'windows-input', 'src', 'desktop.rs')));
      digest.update(
        await fs.readFile(path.join(sourceRoot, 'windows-input', 'src', 'selection.rs')),
      );
      digest.update(await fs.readFile(path.join(sourceRoot, 'windows-input', 'Cargo.toml')));
      digest.update(await fs.readFile(path.join(sourceRoot, 'windows-input', 'Cargo.lock')));
    }
    const hash = digest.digest('hex');
    const directory = path.join(app.getPath('userData'), 'remote-desktop', 'native', hash);
    const binary = path.join(directory, binaryName);
    try {
      await fs.access(binary);
      return binary;
    } catch {
      /* build this source version */
    }
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${binary}.${process.pid}.tmp`;
    if (process.platform === 'darwin') {
      // Only source-mode Electron uses this build. Packaged helpers always use
      // Apple's signing identity check; no runtime flag can downgrade it.
      const buildDirectory = await fs.mkdtemp(path.join(directory, 'compile-'));
      try {
        const main = path.join(buildDirectory, 'main.swift');
        const program = (callerSource + '\n' + (await fs.readFile(source, 'utf8'))).replace(
          '"DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE"',
          JSON.stringify(Buffer.from(process.execPath).toString('base64')),
        );
        await fs.writeFile(main, program);
        await exec('swiftc', ['-D', 'DESKTOP_INPUT_DEVELOPMENT', main, '-O', '-o', temporary], {
          timeout: 120_000,
        });
      } finally {
        await fs.rm(buildDirectory, { recursive: true, force: true });
      }
    } else {
      const manifest = path.join(sourceRoot, 'windows-input', 'Cargo.toml');
      await exec(
        'cargo',
        [
          'build',
          '--release',
          '--locked',
          '--manifest-path',
          manifest,
          '--target-dir',
          path.join(directory, 'build'),
        ],
        { timeout: 180_000 },
      );
      await fs.copyFile(path.join(directory, 'build', 'release', binaryName), temporary);
    }
    await fs.rename(temporary, binary);
    return binary;
  };
  build = resolve().finally(() => {
    build = null;
  });
  return build;
}

/** Probe the actual input process, never CuaDriver's or Electron's AX grant. */
export async function readDesktopLockState(): Promise<'locked' | 'unlocked' | 'unavailable'> {
  if (process.platform !== 'darwin') return 'unavailable';
  try {
    const { stdout } = await exec(await resolveBinary(), ['--lock-state'], {
      timeout: 5000,
      maxBuffer: 1024,
    });
    const value = stdout.trim();
    return value === 'locked' || value === 'unlocked' ? value : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function readDesktopInputPermission(): Promise<DesktopPermissionStatus> {
  if (process.platform !== 'darwin') return 'notRequired';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A cold dev build must prepare the helper too; preparation does not prompt.
    // Bound this caller's wait below the remote channel budget. A slow build
    // stays shared in resolveBinary so later polls reuse it instead of restarting.
    const binary = await Promise.race([
      resolveBinary(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DESKTOP_INPUT_PREPARING')), 5000);
      }),
    ]);
    // Only --request-permission may open the macOS authorization UI.
    const { stdout } = await exec(binary, ['--check'], {
      timeout: 5000,
      maxBuffer: 1024,
    });
    return stdout.trim() === 'ready'
      ? 'granted'
      : stdout.trim() === 'permission'
        ? 'missing'
        : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function lockDesktopScreen(
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('DESKTOP_LOCK_UNAVAILABLE');
  const binary = await resolveBinary();
  if (signal.aborted || !isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
  try {
    const { stdout } = await exec(binary, ['--lock-screen'], {
      timeout: 5000,
      maxBuffer: 1024,
      signal,
    });
    if (stdout.trim() !== 'locked') throw new Error('DESKTOP_LOCK_FAILED');
  } catch {
    throw new Error('DESKTOP_LOCK_FAILED');
  }
}

export async function requestDesktopInputPermission(
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  const binary = await resolveBinary();
  if (isCurrent())
    await exec(binary, ['--request-permission'], { timeout: 5000, maxBuffer: 1024, signal });
}

export class DesktopInputHost {
  private windows: WindowsDesktopConnection | null = null;
  private queuedBytes = 0;
  private writing = Promise.resolve();
  private child: ChildProcessWithoutNullStreams | null = null;
  private releaseOwnership: (() => void) | null = null;
  private displayId = '';
  private generation = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  constructor(
    private readonly onFailure: () => void,
    private readonly runtime: {
      platform?: NodeJS.Platform;
      resolveBinary(): Promise<string>;
      spawn(binary: string): ChildProcessWithoutNullStreams;
    } = {
      resolveBinary,
      spawn: (binary: string) => spawn(binary, [], { stdio: 'pipe', windowsHide: true }),
    },
  ) {}
  async start(displayId: string): Promise<void> {
    this.stop();
    const platform = this.runtime.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'win32') throw new Error('DESKTOP_INPUT_UNSUPPORTED');
    const generation = this.generation;
    await this.stopping;
    if (generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
    const release = acquireHumanDesktopInput();
    this.releaseOwnership = release;
    try {
      if (
        platform === 'win32' &&
        !this.runtime.platform &&
        (await readWindowsDesktopSupport()) === 'ready'
      ) {
        if (generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
        const connection = await openWindowsDesktopConnection({ mode: 'input' });
        if (generation !== this.generation) {
          connection.close();
          throw new Error('DESKTOP_LEASE_EXPIRED');
        }
        this.windows = connection;
        this.displayId = displayId;
        this.heartbeat = setInterval(() => this.write([]), 2000);
        return;
      }
      const binary = await this.runtime.resolveBinary();
      if (generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
      const child = this.runtime.spawn(binary);
      this.child = child;
      this.displayId = displayId;
      child.stderr.resume(); // never log typed text or protocol payloads
      child.stdin.on('error', () => {
        if (this.child === child) this.onFailure();
      });
      child.on('exit', () => {
        if (this.child === child) this.onFailure();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DESKTOP_INPUT_UNAVAILABLE')), 8000);
        let text = '';
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.stdout.off('data', receive);
          error ? reject(error) : resolve();
        };
        const receive = (data: Buffer) => {
          text += data.toString();
          if (text.includes('\n'))
            finish(
              text.startsWith('ready') ? undefined : new Error('DESKTOP_ACCESSIBILITY_REQUIRED'),
            );
        };
        child.stdout.on('data', receive);
        child.once('error', () => finish(new Error('DESKTOP_INPUT_UNAVAILABLE')));
        child.once('exit', () => finish(new Error('DESKTOP_INPUT_UNAVAILABLE')));
      });
      if (generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
      child.stdout.on('data', (data: Buffer) => {
        if (data.toString().includes('error') && this.child === child) this.onFailure();
      });
      this.heartbeat = setInterval(() => this.write([]), 2000);
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }
  input(events: DesktopInput[]): void {
    const display = screen.getAllDisplays().find((item) => String(item.id) === this.displayId);
    if (!display || (!this.child && !this.windows)) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
    this.write(
      events.map((event) => {
        if (event.kind !== 'move' && event.kind !== 'button') return event;
        const point = {
          x: Math.round(display.bounds.x + event.x * (display.bounds.width - 1)),
          y: Math.round(display.bounds.y + event.y * (display.bounds.height - 1)),
        };
        const native = process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
        return { ...event, ...native };
      }),
    );
  }
  private write(events: unknown[]): void {
    const child = this.child;
    const line = `${JSON.stringify(events)}\n`;
    const connection = this.windows;
    if (connection) {
      const bytes = Buffer.byteLength(line);
      if (this.queuedBytes + bytes > 32_768) {
        this.onFailure();
        return;
      }
      this.queuedBytes += bytes;
      const generation = this.generation;
      this.writing = this.writing
        .then(async () => {
          if (this.windows !== connection) return;
          if ((await connection.request(line.slice(0, -1))) !== 'ok\n')
            throw new Error('DESKTOP_INPUT_UNAVAILABLE');
        })
        .catch(() => {
          if (this.windows === connection) this.onFailure();
        })
        .finally(() => {
          if (generation === this.generation) this.queuedBytes -= bytes;
        });
      return;
    }
    if (
      !child ||
      child.stdin.destroyed ||
      child.stdin.writableLength + Buffer.byteLength(line) > 32_768
    ) {
      this.onFailure();
      return;
    }
    child.stdin.write(line);
  }
  async release(): Promise<void> {
    this.stop();
    await this.stopping;
  }
  stop(): void {
    this.generation++;
    const windows = this.windows;
    windows?.close();
    this.windows = null;
    this.queuedBytes = 0;
    this.writing = Promise.resolve();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const child = this.child;
    this.child = null;
    const release = this.releaseOwnership;
    this.releaseOwnership = null;
    if (child) {
      this.stopping = new Promise<void>((resolve) => {
        const finish = () => {
          release?.();
          resolve();
        };
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) finish();
        else {
          child.once('close', finish);
        }
      });
      // EOF runs native releaseAll; its watchdog also releases on a stalled parent.
      child.stdin.end('[{"kind":"release"}]\n');
      const timer = setTimeout(() => child.kill(), 1500);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    } else if (windows) {
      // The service closes its worker gracefully before the job-kill deadline.
      this.stopping = new Promise<void>((resolve) =>
        setTimeout(() => {
          release?.();
          resolve();
        }, 1500),
      );
    } else release?.();
  }
}

/** Native mode IDs come only from this computer's current display enumeration. */
export async function readDesktopDisplayModes(
  displayId: string,
): Promise<RemoteDesktopDisplayMode[]> {
  if (process.platform !== 'darwin' || !/^[0-9]{1,10}$/.test(displayId))
    throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
  const { stdout } = await exec(await resolveBinary(), ['--display-modes', displayId], {
    timeout: 5000,
    maxBuffer: 64_000,
  });
  const modes = JSON.parse(stdout) as RemoteDesktopDisplayMode[];
  if (
    !Array.isArray(modes) ||
    modes.length > 256 ||
    !modes.every(
      (mode) =>
        typeof mode.id === 'string' &&
        /^[0-9]{1,10}$/.test(mode.id) &&
        Number.isInteger(mode.width) &&
        mode.width > 0 &&
        Number.isInteger(mode.height) &&
        mode.height > 0 &&
        typeof mode.current === 'boolean' &&
        (mode.native === undefined || typeof mode.native === 'boolean'),
    )
  )
    throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
  return modes;
}
let changingResolution = false;
export async function setDesktopDisplayMode(
  displayId: string,
  modeId: string,
  beforeChange: () => void,
): Promise<void> {
  if (changingResolution) throw new Error('DESKTOP_DISPLAY_BUSY');
  changingResolution = true;
  try {
    const modes = await readDesktopDisplayModes(displayId);
    if (!modes.some((mode) => mode.id === modeId)) throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
    const binary = await resolveBinary();
    // Build/enumeration can finish after disconnect, revocation or view-only.
    beforeChange();
    await exec(binary, ['--display-mode', displayId, modeId], { timeout: 5000, maxBuffer: 1024 });
  } finally {
    changingResolution = false;
  }
}

/** Counter only: clipboard text never crosses a helper's stdout/log boundary. */
export async function readDesktopClipboardVersion(portable = false): Promise<string> {
  if (process.platform !== 'darwin' && process.platform !== 'win32')
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  try {
    const { stdout } = await exec(
      await resolveBinary(),
      [
        portable && process.platform === 'darwin'
          ? '--clipboard-content-version'
          : '--clipboard-version',
      ],
      {
        timeout: 2000,
        maxBuffer: 128,
        windowsHide: true,
      },
    );
    const version = stdout.trim();
    if (!/^[0-9]+$/.test(version)) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    return version;
  } catch (error) {
    if (
      portable &&
      process.platform === 'darwin' &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 3
    )
      throw new Error('CLIPBOARD_UNSUPPORTED');
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  }
}

export async function readDesktopSelection(portable = false): Promise<string> {
  try {
    const { stdout } = await exec(
      await resolveBinary(),
      [portable ? '--clipboard-content-selection' : '--clipboard-selection'],
      {
        timeout: 3000,
        maxBuffer: 128_000,
        windowsHide: true,
      },
    );
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      !('text' in value) ||
      typeof value.text !== 'string' ||
      value.text.length > 16_384
    )
      throw new Error('INVALID_SELECTION');
    return value.text;
  } catch {
    // execFile/JSON errors can contain stdout. Never propagate selected text in errors.
    throw new Error('DESKTOP_CLIPBOARD_COPY_FAILED');
  }
}
