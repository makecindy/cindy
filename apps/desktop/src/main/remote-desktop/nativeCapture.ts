import {
  isRemoteDesktopCursor,
  REMOTE_DESKTOP_OFFER_BUDGET,
  type RemoteDesktopCursorFrame,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import { app, nativeImage, screen } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { desktopVideoFramerate, desktopVideoProfile } from '../../shared/remoteDesktopQuality';
import { createLogger } from '../logger';
import { openWindowsDesktopConnection, type WindowsDesktopConnection } from './windowsHost';
import { decodeWindowsCursorFrame } from './windowsCursorFrame';

import { resolveLinuxCaptureBinary } from './linuxCapture';
import { WAYLAND_DISPLAY_ID } from './waylandCapture';
import { linuxMonitor } from './linuxDesktop';

const log = createLogger('remote-desktop:native-capture');
const exec = promisify(execFile);
const name = 'cindy-macos-desktop-capture';
// A running helper answers within this; a fresh one may still be starting capture.
const FRAME_MS = 3000;
// The macOS helper has a five-second bound for completing SCStream shutdown.
// Leave it time to finish an in-flight start and stop before forcing termination.
const CAPTURE_SHUTDOWN_MS = 6000;
function stopCaptureProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'darwin') {
    child.stdin.destroy();
    child.kill();
    return;
  }
  if (child.exitCode != null || child.signalCode != null) return;
  const timer = setTimeout(() => child.kill('SIGKILL'), CAPTURE_SHUTDOWN_MS);
  timer.unref();
  const closed = () => {
    clearTimeout(timer);
    child.off('exit', closed);
    child.off('close', closed);
  };
  child.once('exit', closed);
  child.once('close', closed);
  // Discard any late frame while the helper processes EOF and stops its stream.
  child.stdout.resume();
  child.stdin.end();
}
let building: Promise<string> | null = null;
async function binary(): Promise<string> {
  if (process.platform === 'linux') return resolveLinuxCaptureBinary();
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools', 'remote-desktop', name);
  if (building) return building;
  building = (async () => {
    const source = path.join(app.getAppPath(), 'native', 'remote-desktop', 'macos-capture.m');
    const hash = createHash('sha256')
      .update(await fs.readFile(source))
      .update(process.arch)
      .digest('hex');
    const directory = path.join(app.getPath('userData'), 'remote-desktop', 'native', hash);
    const output = path.join(directory, name);
    try {
      await fs.access(output);
      return output;
    } catch {
      /* compile this source */
    }
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      await exec(
        'xcrun',
        [
          'clang',
          source,
          '-fobjc-arc',
          '-fblocks',
          '-O2',
          '-framework',
          'Foundation',
          '-framework',
          'AppKit',
          '-framework',
          'CoreGraphics',
          '-framework',
          'CoreImage',
          '-framework',
          'IOSurface',
          '-framework',
          'ImageIO',
          '-framework',
          'IOKit',
          '-weak_framework',
          'ScreenCaptureKit',
          '-framework',
          'CoreMedia',
          '-framework',
          'CoreVideo',
          '-o',
          temporary,
        ],
        { timeout: 120_000 },
      );
      await fs.rename(temporary, output);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return output;
  })().finally(() => {
    building = null;
  });
  return building;
}

/**
 * 代输入 (macOS): one photo of just this window, from the same window-only
 * stream as the live view. Its own pixels only, whatever covers it; never the
 * display. Null when it cannot be taken. Nothing is written to disk.
 */
export async function photographMacWindow(
  displayId: string,
  windowId: number,
): Promise<Buffer | null> {
  if (process.platform !== 'darwin' || !/^[0-9]{1,10}$/.test(displayId)) return null;
  if (!Number.isSafeInteger(windowId) || windowId <= 0 || windowId > 0xffff_ffff) return null;
  const executable = await binary();
  return new Promise((resolve) => {
    // Physical pixels up to 2800 on the long side and a 3 MB frame keep small text and QR codes sharp.
    const child = spawn(
      executable,
      [displayId, 'cursor-overlay', '30', '0.9', '2800', '3000000', `window:${windowId}`],
      { stdio: 'pipe' },
    );
    let text = '';
    let done = false;
    const finish = (jpeg: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopCaptureProcess(child);
      resolve(jpeg);
    };
    const timer = setTimeout(() => finish(null), 5000);
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('ascii');
      if (text.length > 4_200_000) return finish(null);
      const end = text.indexOf('\n');
      if (end < 0) return;
      try {
        const frame = JSON.parse(text.slice(0, end)) as { jpeg?: unknown };
        const jpeg =
          typeof frame.jpeg === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.jpeg)
            ? frame.jpeg
            : '';
        finish(jpeg ? Buffer.from(jpeg, 'base64') : null);
      } catch {
        finish(null);
      }
    });
    child.stdin.write('f');
  });
}

/** One capture child for the current lease. No sockets, files, or frame history.
 * macOS/Linux use user-session children; Windows uses the authorized SYSTEM broker.
 * No adapter keeps frame history on disk.
 */
export class NativeDesktopCapture {
  // Local recording can defer JPEG work until a frame is requested. Remote
  // desktop and window-only callers retain their existing eager stream.
  constructor(private readonly options: { encodeOnRequest?: boolean } = {}) {}

  private excludedWindows = '';
  private confirmedExclusion = '';
  setExcludedWindows(ids: number[]): void {
    const next = ids.join(',');
    if (next === this.excludedWindows) return;
    this.stop();
    this.excludedWindows = next;
  }
  private onlyWindow = '';
  /** 代输入 live view (macOS): capture just this window; null returns to the whole display. */
  setWindow(id: number | null): void {
    const next =
      id && Number.isSafeInteger(id) && id > 0 && id <= 0xffff_ffff ? `window:${id}` : '';
    if (next === this.onlyWindow) return;
    this.stop();
    this.onlyWindow = next;
  }
  get privacyReady(): boolean {
    return !!this.excludedWindows && this.confirmedExclusion === this.excludedWindows;
  }
  async preparePrivacy(display: string, settings?: RemoteDesktopVideoSettings): Promise<void> {
    if (process.platform !== 'darwin') return;
    this.stop();
    const frame = await this.frame(display, true, settings);
    if (!frame || !this.privacyReady) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  }
  private windows: WindowsDesktopConnection | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private display = '';
  private config = '';
  private generation = 0;
  private busy = false;
  private cancel: ((error?: Error) => void) | null = null;

  async frame(
    display: string,
    overlay = false,
    settings?: RemoteDesktopVideoSettings,
  ): Promise<string | RemoteDesktopCursorFrame | null> {
    const profile = desktopVideoProfile(settings);
    const fps = desktopVideoFramerate(settings);
    if (process.platform === 'win32') {
      if (this.busy) return null;
      const config = overlay ? 'overlay:' + profile.windowsBitrate : '';
      if (this.windows && (this.display !== display || this.config !== config)) this.stop();
      const selected = screen.getAllDisplays().find((item) => String(item.id) === display);
      if (!selected) return null;
      this.busy = true;
      const generation = this.generation;
      try {
        if (!this.windows) {
          const bounds = screen.dipToScreenRect(null, selected.bounds);
          const connection = await openWindowsDesktopConnection({
            mode: 'capture',
            rect: [bounds.x, bounds.y, bounds.width, bounds.height],
            ...(overlay ? { cursorOverlay: true, bitrate: profile.windowsBitrate } : {}),
          });
          if (generation !== this.generation) {
            connection.close();
            return null;
          }
          this.windows = connection;
          this.display = display;
          this.config = config;
        }
        const jpeg = (await this.windows.request('f')).trim();
        if (generation !== this.generation) return null;
        if (overlay) {
          return decodeWindowsCursorFrame(jpeg, selected.scaleFactor, (pixels, size) =>
            nativeImage.createFromBitmap(pixels, size).toPNG(),
          );
        }
        return generation === this.generation &&
          jpeg.length <= 240000 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)
          ? jpeg
          : null;
      } catch {
        if (generation === this.generation) this.stop();
        return null;
      } finally {
        if (generation === this.generation) this.busy = false;
      }
    }
    const config =
      overlay || process.platform === 'linux'
        ? [overlay, fps, settings?.quality ?? 'auto'].join(':')
        : '';
    if (this.child && this.config !== config) this.stop();
    const linux = process.platform === 'linux';
    if (
      linux
        ? display !== WAYLAND_DISPLAY_ID && !/^hyprland:[A-Za-z0-9_.-]{1,80}$/.test(display)
        : process.platform !== 'darwin' || !/^[0-9]{1,10}$/.test(display)
    )
      return null;
    if (this.busy) return null;
    // A window view exists only as the macOS overlay stream; never widen it to the display.
    if (this.onlyWindow && (linux || !overlay)) return null;
    if (this.display && this.display !== display) this.stop();
    this.busy = true;
    const generation = this.generation;
    try {
      const cold = !this.child;
      if (!this.child) {
        const output = linux && display !== WAYLAND_DISPLAY_ID ? await linuxMonitor(display) : null;
        const executable = await binary();
        if (generation !== this.generation) return null;
        const quality = profile.jpegQuality;
        const args = linux
          ? [
              overlay ? 'cursor-overlay' : 'video',
              String(output?.scale ?? screen.getAllDisplays()[0]?.scaleFactor ?? 1),
              String(Math.round(quality * 100)),
              ...(output ? [output.name] : []),
            ]
          : overlay
            ? [
                display,
                this.options.encodeOnRequest ? 'cursor-overlay-demand' : 'cursor-overlay',
                String(fps),
                String(quality),
                String(profile.physicalMaxEdge),
                String(profile.maxFrameBytes),
              ]
            : [display];
        if (!linux && this.onlyWindow) args.push(this.onlyWindow);
        else if (!linux && this.excludedWindows) args.push(this.excludedWindows);
        const child = spawn(executable, args, { stdio: 'pipe' });
        this.child = child;
        this.display = display;
        this.config = config;
        child.stderr.resume();
        child.stdin.on('error', () => {
          if (this.child === child) this.stop();
        });
        child.on('error', () => {
          if (this.child === child) this.stop();
        });
        child.on('exit', (code) => {
          if (this.child !== child) return;
          log.warn(`Native capture helper exited code=${code}`);
          this.cancel?.(
            new Error(
              code === 3 ? 'DESKTOP_SCREEN_PERMISSION_REQUIRED' : 'DESKTOP_VIDEO_UNAVAILABLE',
            ),
          );
          this.stop();
        });
      }
      const child = this.child;
      // macOS overlay frames follow the tier's byte budget; the base64 frame
      // plus the bounded cursor PNG and JSON keep the historical 1.5 MB margin.
      const frameBytes = overlay && !linux ? profile.maxFrameBytes : 1_000_000;
      const jpegLimit = Math.ceil(frameBytes / 3) * 4;
      const textLimit = jpegLimit + 166_664;
      return await new Promise<string | RemoteDesktopCursorFrame | null>((resolve, reject) => {
        let text = '';
        const finish = (frame: string | RemoteDesktopCursorFrame | null, error?: Error) => {
          if (frame && generation === this.generation)
            this.confirmedExclusion = this.excludedWindows;
          clearTimeout(timer);
          child.stdout.off('data', receive);
          this.cancel = null;
          if (error) reject(error);
          else resolve(frame);
        };
        const receive = (chunk: Buffer) => {
          text += chunk.toString('ascii');
          if (text.length > (overlay || linux ? textLimit : 240_001)) {
            this.stop();
            return;
          }
          if (!text.endsWith('\n')) return;
          if (overlay) {
            try {
              const value = JSON.parse(text) as RemoteDesktopCursorFrame;
              if (
                typeof value.jpeg !== 'string' ||
                value.jpeg.length > jpegLimit ||
                !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpeg) ||
                (value.cursor !== null && !isRemoteDesktopCursor(value.cursor))
              )
                throw new Error('INVALID_CURSOR_FRAME');
              finish(generation === this.generation ? value : null);
            } catch {
              this.stop();
            }
            return;
          }
          const jpeg = text.slice(0, -1);
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)) {
            this.stop();
            return;
          }
          finish(generation === this.generation ? jpeg : null);
        };
        // Starting capture and the first cursor read can take seconds on a busy
        // or high-resolution Mac; only later frames use the steady-state bound.
        const waitMs = cold ? REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs : FRAME_MS;
        const timer = setTimeout(() => {
          if (generation === this.generation)
            log.warn(`Native capture produced no frame within ${waitMs}ms cold=${cold}`);
          this.stop();
        }, waitMs);
        this.cancel = (error) => finish(null, error);
        child.stdout.on('data', receive);
        child.stdin.write('f');
      });
    } finally {
      // A cancelled old request must not reset a newer reader's backpressure.
      if (generation === this.generation) this.busy = false;
    }
  }

  stop(): void {
    this.confirmedExclusion = '';
    this.generation++;
    this.windows?.close();
    this.windows = null;
    this.cancel?.();
    this.cancel = null;
    const child = this.child;
    this.child = null;
    this.display = '';
    this.busy = false;
    if (child) {
      stopCaptureProcess(child);
    }
  }
}
