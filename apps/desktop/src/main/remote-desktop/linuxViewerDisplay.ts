import { app } from 'electron';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { RemoteDesktopDisplay } from '@cindy/device-link';
import type { ViewerDisplayHandle } from './viewerDisplay';
import { linuxDisplay, linuxMonitor, linuxMonitors, supportsLinuxDisplay } from './linuxDesktop';
import { supportsHyprlandCapture } from './hyprlandCapture';

function script(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'remote-desktop', 'linux-viewer-display.py')
    : path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-viewer-display.py');
}
export function supportsLinuxViewerDisplay(): boolean {
  // Portal capture cannot select the helper's Hyprland-only display IDs.
  if (!supportsHyprlandCapture() || !supportsLinuxDisplay()) return false;
  try {
    accessSync('/usr/bin/python3', constants.X_OK);
    accessSync(script(), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The independent helper undoes its temporary mirror even when Electron exits.
 * This adapts the existing viewer-display lease, not a second display lifecycle. */
export async function createLinuxViewerDisplay(
  sourceId: string,
  isCurrent: () => boolean,
  onFailure: () => void,
): Promise<ViewerDisplayHandle> {
  if (!supportsLinuxViewerDisplay()) throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
  const original = await linuxMonitor(sourceId);
  if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
  const child = spawn('/usr/bin/python3', ['-I', '-u', script(), original.name], { stdio: 'pipe' });
  let closed = false,
    busy = false;
  let id: string | undefined;
  const failed = () => {
    if (!closed) {
      dispose();
      onFailure();
    }
  };
  child.stderr.resume();
  child.stdin.on('error', failed);
  child.once('error', failed);
  child.once('exit', failed);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
    child.once('error', () => resolve(1));
  });
  const heartbeat = setInterval(() => {
    if (!closed && !child.stdin.destroyed) child.stdin.write('{"op":"ping"}\n');
  }, 2000);
  heartbeat.unref();
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    child.stdin.end();
    // SIGTERM runs the same restoration finally block; never SIGKILL a helper
    // that may still own a mirrored physical display.
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    timer.unref();
    void exited.then(() => clearTimeout(timer));
  };
  return {
    get displayId() {
      return id;
    },
    async resize(width, height, current) {
      if (closed || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
      if (busy) throw new Error('DESKTOP_DISPLAY_BUSY');
      busy = true;
      try {
        const result = await new Promise<RemoteDesktopDisplay>((resolve, reject) => {
          let buffer = '';
          const finish = (result?: RemoteDesktopDisplay) => {
            clearTimeout(timer);
            child.stdout.off('data', receive);
            child.off('exit', ended);
            child.off('error', ended);
            if (result) resolve(result);
            else reject(new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE'));
          };
          const ended = () => finish();
          const receive = (chunk: Buffer) => {
            buffer += chunk.toString();
            if (buffer.length > 4096) return finish();
            if (!buffer.includes('\n')) return;
            try {
              const value = JSON.parse(buffer);
              if (
                typeof value.id !== 'string' ||
                !/^hyprland:CindyRemote-[a-f0-9]{16}$/.test(value.id) ||
                value.width !== width ||
                value.height !== height ||
                typeof value.name !== 'string'
              )
                return finish();
              finish(value);
            } catch {
              finish();
            }
          };
          const timer = setTimeout(ended, 8000);
          child.stdout.on('data', receive);
          child.once('exit', ended);
          child.once('error', ended);
          child.stdin.write(JSON.stringify({ width, height }) + '\n');
        });
        if (closed || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        id = result.id;
        const actual = linuxDisplay(await linuxMonitor(id));
        if (!current() || closed) throw new Error('DESKTOP_LEASE_EXPIRED');
        if (actual.width !== width || actual.height !== height)
          throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
        return actual;
      } catch (error) {
        dispose();
        throw error;
      } finally {
        busy = false;
      }
    },
    async restore(current) {
      dispose();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE')),
              12000,
            );
          }),
        ]);
        if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        if (code !== 0) throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
        const monitors = await linuxMonitors();
        if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        // An unplugged source has no remaining geometry to restore.
        return linuxDisplay(monitors.find((m) => m.name === original.name) ?? original);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose,
  };
}
