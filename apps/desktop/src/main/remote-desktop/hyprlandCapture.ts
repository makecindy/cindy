import { NativeDesktopCapture } from './nativeCapture';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { WAYLAND_DISPLAY_ID, isWaylandDesktop } from './waylandCapture';
import type { RemoteDesktopCursorFrame, RemoteDesktopVideoSettings } from '@cindy/device-link';
import { linuxMonitor } from './linuxDesktop';

// Use the distribution's helper, never a command supplied by a remote peer or PATH.
const executable = '/usr/bin/grim';
export function supportsHyprlandCapture(): boolean {
  if (!isWaylandDesktop(process.platform, process.env) || !process.env.HYPRLAND_INSTANCE_SIGNATURE)
    return false;
  try {
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Hyprland's native screencopy respects compositor permissions without a portal
 * picker. Called only inside the authorized desktop lease. No files or retained
 * frames; stopping aborts the process and discards a late result.
 * A persistent screencopy child serves supported layouts. grim composes the
 * whole desktop when the persistent helper is unavailable.
 */
export class HyprlandCapture {
  private active: AbortController | null = null;
  private native = new NativeDesktopCapture();
  private fallback = false;

  async frame(
    display: string,
    overlay = false,
    settings?: RemoteDesktopVideoSettings,
  ): Promise<string | RemoteDesktopCursorFrame | null> {
    if (
      (display !== WAYLAND_DISPLAY_ID && !/^hyprland:[A-Za-z0-9_.-]{1,80}$/.test(display)) ||
      !supportsHyprlandCapture() ||
      this.active
    )
      return null;
    const active = new AbortController();
    this.active = active;
    try {
      if (!this.fallback) {
        const frame = await this.native.frame(display, overlay, settings).catch(() => null);
        if (active.signal.aborted || this.active !== active) return null;
        if (frame) return frame;
        this.native.stop();
        this.fallback = true;
      }
      const output = display === WAYLAND_DISPLAY_ID ? null : await linuxMonitor(display);
      if (active.signal.aborted) return null;
      const jpeg = await new Promise<Buffer>((resolve, reject) => {
        execFile(
          executable,
          [
            '-t',
            'jpeg',
            '-q',
            settings?.bitrate === 20_000_000 ? '95' : settings?.bitrate === 8_000_000 ? '80' : '65',
            '-s',
            '1',
            ...(output ? ['-o', output.name] : []),
            '-',
          ],
          {
            encoding: 'buffer',
            timeout: 2500,
            maxBuffer: 8 * 1024 * 1024,
            signal: active.signal,
            killSignal: 'SIGKILL',
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      if (
        active.signal.aborted ||
        this.active !== active ||
        jpeg.length < 4 ||
        jpeg[0] !== 0xff ||
        jpeg[1] !== 0xd8 ||
        jpeg[jpeg.length - 2] !== 0xff ||
        jpeg[jpeg.length - 1] !== 0xd9
      )
        return null;
      return jpeg.toString('base64');
    } catch {
      return null;
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  stop(): void {
    const active = this.active;
    this.active = null;
    active?.abort();
    this.native.stop();
    this.fallback = false;
  }
}
