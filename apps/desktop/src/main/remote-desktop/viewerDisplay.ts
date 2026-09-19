import { app, screen } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteDesktopDisplay } from '@cindy/device-link';
import { createLinuxViewerDisplay, supportsLinuxViewerDisplay } from './linuxViewerDisplay';

const exec = promisify(execFile);
let build: Promise<string> | undefined;

/** Prototype only: SPI is not shipped until supported OS/signing tests are complete. */
export async function viewerDisplaySupported(): Promise<boolean> {
  if (process.platform === 'linux') return supportsLinuxViewerDisplay();
  try {
    await binary();
    return true;
  } catch {
    return false;
  }
}

async function binary(): Promise<string> {
  if (process.platform !== 'darwin' || app.isPackaged)
    throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
  if (build) return build;
  build = (async () => {
    const source = path.join(
      app.getAppPath(),
      'native',
      'remote-desktop',
      'macos-viewer-display.m',
    );
    const digest = createHash('sha256')
      .update(await fs.readFile(source))
      .update(process.arch)
      .digest('hex');
    const directory = path.join(app.getPath('userData'), 'remote-desktop', 'native', digest);
    const target = path.join(directory, 'cindy-viewer-display');
    try {
      await fs.access(target);
      return target;
    } catch {
      /* Compile this version. */
    }
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await exec(
      'clang',
      [
        '-fobjc-arc',
        '-framework',
        'Foundation',
        '-framework',
        'CoreGraphics',
        source,
        '-o',
        temporary,
      ],
      { timeout: 60_000 },
    );
    await fs.rename(temporary, target);
    return target;
  })()
    .then(async (target) => {
      await exec(target, ['--probe'], { timeout: 5000 });
      return target;
    })
    .catch(() => {
      build = undefined;
      throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
    });
  return build;
}

export interface ViewerDisplayHandle {
  readonly displayId?: string;
  resize(width: number, height: number, isCurrent: () => boolean): Promise<RemoteDesktopDisplay>;
  restore?(isCurrent: () => boolean): Promise<RemoteDesktopDisplay>;
  dispose(): void;
}

/** CoreGraphics completion precedes Electron's display projection. */
export async function waitForDisplayRestore(
  displayId: string,
  expected: { width: number; height: number } | undefined,
  requireCurrent: () => void,
  released: (displays: Electron.Display[]) => boolean = () => true,
): Promise<RemoteDesktopDisplay> {
  for (let attempt = 0; attempt < 100; attempt++) {
    requireCurrent();
    const displays = screen.getAllDisplays();
    const display = displays.find((item) => String(item.id) === displayId);
    // An unplugged source has no remaining geometry to restore.
    if (
      released(displays) &&
      (!display ||
        !expected ||
        (display.size.width === expected.width && display.size.height === expected.height))
    )
      return {
        id: displayId,
        name: display?.label || 'Display',
        width: display?.size.width || expected?.width || 0,
        height: display?.size.height || expected?.height || 0,
      };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
}

/** The helper owns one temporary mirror, never a global persistent display preference. */
export async function createViewerDisplay(
  sourceDisplayId: string,
  isCurrent: () => boolean,
  onFailure: () => void,
): Promise<ViewerDisplayHandle> {
  if (process.platform === 'linux')
    return createLinuxViewerDisplay(sourceDisplayId, isCurrent, onFailure);
  const executable = await binary();
  if (!isCurrent()) throw new Error('DESKTOP_LEASE_EXPIRED');
  const child: ChildProcessWithoutNullStreams = spawn(executable, [], { stdio: 'pipe' });
  const original = screen
    .getAllDisplays()
    .find((display) => String(display.id) === sourceDisplayId);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  let closed = false;
  let virtualDisplayId: number | undefined;
  child.stderr.resume();
  const failed = () => {
    if (!closed) onFailure();
  };
  child.on('error', failed);
  child.on('exit', failed);
  child.stdin.on('error', failed);
  return {
    get displayId() {
      return virtualDisplayId === undefined ? undefined : String(virtualDisplayId);
    },
    async resize(width, height, current) {
      if (closed || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
      const result = await new Promise<{ id: number }>((resolve, reject) => {
        let text = '';
        const finish = (error?: Error, value?: { id: number }) => {
          clearTimeout(timer);
          child.stdout.off('data', receive);
          child.off('exit', exited);
          child.off('error', exited);
          error ? reject(error) : resolve(value!);
        };
        const exited = () => finish(new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE'));
        const receive = (chunk: Buffer) => {
          text += chunk.toString();
          if (text.length > 4096) return exited();
          if (!text.includes('\n')) return;
          try {
            const value = JSON.parse(text);
            if (
              !Number.isSafeInteger(value.id) ||
              value.id <= 0 ||
              value.width !== width ||
              value.height !== height
            )
              return exited();
            finish(undefined, value);
          } catch {
            exited();
          }
        };
        const timer = setTimeout(exited, 8000);
        child.stdout.on('data', receive);
        child.once('exit', exited);
        child.once('error', exited);
        child.stdin.write(`${JSON.stringify({ sourceDisplayId, width, height })}\n`);
      });
      virtualDisplayId = result.id;
      // CoreGraphics replies before Electron necessarily observes the display change.
      for (let attempt = 0; attempt < 40; attempt++) {
        if (closed || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        const actual = screen.getAllDisplays().find((d) => d.id === result.id);
        if (actual?.size.width === width && actual.size.height === height)
          return {
            id: String(actual.id),
            name: actual.label || 'Cindy Remote Desktop',
            width,
            height,
          };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
    },
    async restore(this: ViewerDisplayHandle, current) {
      this.dispose();
      return waitForDisplayRestore(
        sourceDisplayId,
        original?.size,
        () => {
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        },
        (displays) => exited && !displays.some((item) => item.id === virtualDisplayId),
      );
    },
    dispose() {
      if (closed) return;
      closed = true;
      child.stdin.end(); // EOF restores the source mode and releases the virtual display.
      const timer = setTimeout(() => child.kill('SIGTERM'), 1500);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    },
  };
}
