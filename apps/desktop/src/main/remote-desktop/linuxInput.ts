import { app, screen } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWaylandDesktop } from './waylandCapture';

const exec = promisify(execFile);
export type LinuxInputBackend = 'wayland' | 'x11';
/** DISPLAY also exists under XWayland: never use it to escape a Wayland session. */
export function linuxInputBackend(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): LinuxInputBackend | null {
  if (platform !== 'linux') return null;
  if (isWaylandDesktop(platform, env)) return env.HYPRLAND_INSTANCE_SIGNATURE ? 'wayland' : null;
  // startx and SSH-launched processes may inherit "tty" despite reachable X11.
  // Let the native probe verify XTEST and reject XWayland.
  return env.DISPLAY ? 'x11' : null;
}

/** X11 has one root pixel space. Refuse mixed-DPI layouts rather than target the wrong screen. */
export function linuxX11Geometry(
  displays: readonly {
    id: number;
    scaleFactor: number;
    bounds: { x: number; y: number; width: number; height: number };
  }[],
  displayId: string,
): string[] {
  const selected = displays.find((display) => String(display.id) === displayId);
  const scale = selected?.scaleFactor;
  if (
    !selected ||
    !scale ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    displays.some(
      (display) =>
        display.scaleFactor !== scale ||
        !Object.values(display.bounds).every(Number.isFinite) ||
        display.bounds.x < 0 ||
        display.bounds.y < 0 ||
        display.bounds.width <= 0 ||
        display.bounds.height <= 0,
    )
  )
    throw new Error('DESKTOP_DISPLAY_MISSING');
  // Preserve positive framebuffer margins. The first monitor need not start at
  // root (0,0); subtracting its origin silently shifts every remote click.
  // Negative/DIP-relative layouts need native RandR reconciliation first.
  const geometry = [
    selected.bounds.x * scale,
    selected.bounds.y * scale,
    selected.bounds.width * scale,
    selected.bounds.height * scale,
  ].map(Math.round);
  if (
    geometry.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    geometry[2] < 1 ||
    geometry[3] < 1
  )
    throw new Error('DESKTOP_DISPLAY_MISSING');
  return ['--geometry', ...geometry.map(String)];
}

const builds = new Map<LinuxInputBackend, Promise<string>>();
export function resolveLinuxInputBinary(): Promise<string> {
  const backend = linuxInputBackend();
  if (!backend) return Promise.reject(new Error('DESKTOP_INPUT_UNSUPPORTED'));
  const binaryName =
    backend === 'x11' ? 'cindy-linux-x11-desktop-input' : 'cindy-linux-desktop-input';
  if (app.isPackaged)
    return Promise.resolve(path.join(process.resourcesPath, 'tools', 'remote-desktop', binaryName));
  const building = builds.get(backend);
  if (building) return building;
  const build = (async () => {
    const root = path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-input');
    const hash = createHash('sha256').update(process.arch).update(backend);
    for (const name of [
      'main.c',
      'backend.h',
      `${backend}.c`,
      'build.mjs',
      ...(backend === 'wayland'
        ? ['virtual-keyboard-unstable-v1.xml', 'wlr-virtual-pointer-unstable-v1.xml']
        : []),
    ])
      hash.update(await fs.readFile(path.join(root, name)));
    const output = path.join(
      app.getPath('userData'),
      'remote-desktop',
      'native',
      hash.digest('hex'),
    );
    const binary = path.join(output, binaryName);
    try {
      await fs.access(binary, fs.constants.X_OK);
      return binary;
    } catch {
      /* build this source */
    }
    await exec('node', [path.join(root, 'build.mjs'), output, backend], {
      timeout: 60000,
      maxBuffer: 64000,
    });
    return binary;
  })().finally(() => {
    builds.delete(backend);
  });
  builds.set(backend, build);
  return build;
}

/** Probe without creating virtual devices, changing keymaps or injecting input. */
export async function readLinuxDesktopInputSupport(): Promise<boolean> {
  const backend = linuxInputBackend();
  if (!backend) return false;
  try {
    if (backend === 'x11') {
      const displays = screen.getAllDisplays();
      linuxX11Geometry(displays, String(displays[0]?.id));
    }
    const { stdout } = await exec(await resolveLinuxInputBinary(), ['--check'], {
      timeout: 3000,
      maxBuffer: 1024,
    });
    return stdout.trim() === 'ready';
  } catch {
    return false;
  }
}
