import {
  isRemoteDesktopCursor,
  type RemoteDesktopCursorFrame,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import { app, screen } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { openWindowsDesktopConnection, type WindowsDesktopConnection } from './windowsHost';

const exec = promisify(execFile);
const name = 'cindy-macos-desktop-capture';
let building: Promise<string> | null = null;
async function binary(): Promise<string> {
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

/** One capture child for the current lease. No sockets, files, or frame history.
 * macOS uses a user-session child; Windows uses the authorized SYSTEM broker.
 * Neither adapter keeps frame history on disk.
 */
export class NativeDesktopCapture {
  private excludedWindows = '';
  private confirmedExclusion = '';
  setExcludedWindows(ids: number[]): void {
    const next = ids.join(',');
    if (next === this.excludedWindows) return;
    this.stop();
    this.excludedWindows = next;
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
    if (process.platform === 'win32') {
      if (this.busy) return null;
      if (this.display && this.display !== display) this.stop();
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
          });
          if (generation !== this.generation) {
            connection.close();
            return null;
          }
          this.windows = connection;
          this.display = display;
        }
        const jpeg = (await this.windows.request('f')).trim();
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
    const config = overlay ? [settings?.fps ?? 30, settings?.bitrate ?? 0].join(':') : '';
    if (this.child && this.config !== config) this.stop();
    if (process.platform !== 'darwin' || !/^[0-9]{1,10}$/.test(display)) return null;
    if (this.busy) return null;
    if (this.display && this.display !== display) this.stop();
    this.busy = true;
    const generation = this.generation;
    try {
      if (!this.child) {
        const executable = await binary();
        if (generation !== this.generation) return null;
        const quality =
          settings?.bitrate === 20_000_000 ? 0.95 : settings?.bitrate === 8_000_000 ? 0.8 : 0.65;
        const args = overlay
          ? [display, 'cursor-overlay', String(settings?.fps ?? 30), String(quality)]
          : [display];
        if (this.excludedWindows) args.push(this.excludedWindows);
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
          this.cancel?.(
            new Error(
              code === 3 ? 'DESKTOP_SCREEN_PERMISSION_REQUIRED' : 'DESKTOP_VIDEO_UNAVAILABLE',
            ),
          );
          this.stop();
        });
      }
      const child = this.child;
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
          if (text.length > (overlay ? 1_500_000 : 240_001)) {
            this.stop();
            return;
          }
          if (!text.endsWith('\n')) return;
          if (overlay) {
            try {
              const value = JSON.parse(text) as RemoteDesktopCursorFrame;
              if (
                typeof value.jpeg !== 'string' ||
                value.jpeg.length > 1_333_336 ||
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
        const timer = setTimeout(() => this.stop(), 3000);
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
      child.stdin.destroy();
      child.kill();
    }
  }
}
