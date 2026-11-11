import { app } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isWaylandDesktop } from './waylandCapture';

const exec = promisify(execFile);
const binaryName = 'cindy-linux-desktop-input';
let building: Promise<string> | null = null;
export function resolveLinuxInputBinary(): Promise<string> {
  if (app.isPackaged)
    return Promise.resolve(path.join(process.resourcesPath, 'tools', 'remote-desktop', binaryName));
  if (building) return building;
  building = (async () => {
    const root = path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-input');
    const hash = createHash('sha256').update(process.arch);
    for (const name of [
      'main.c',
      'x11.h',
      'build.mjs',
      'virtual-keyboard-unstable-v1.xml',
      'wlr-virtual-pointer-unstable-v1.xml',
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
    await exec('node', [path.join(root, 'build.mjs'), output], {
      timeout: 60000,
      maxBuffer: 64000,
    });
    return binary;
  })().finally(() => {
    building = null;
  });
  return building;
}

export function isX11Desktop(platform: string = process.platform): boolean {
  return (
    platform === 'linux' && Boolean(process.env.DISPLAY) && !isWaylandDesktop(platform, process.env)
  );
}

/** Probe registry support without creating devices or injecting input. */
export async function readLinuxDesktopInputSupport(): Promise<boolean> {
  const x11 = isX11Desktop();
  if (
    !x11 &&
    (!isWaylandDesktop(process.platform, process.env) || !process.env.HYPRLAND_INSTANCE_SIGNATURE)
  )
    return false;
  try {
    const { stdout } = await exec(
      await resolveLinuxInputBinary(),
      x11 ? ['--x11', '--check'] : ['--check'],
      {
        timeout: 3000,
        maxBuffer: 1024,
      },
    );
    return stdout.trim() === 'ready';
  } catch {
    return false;
  }
}

/** Electron exposes X11 bounds in DIP; XTest needs pixels relative to the root.
 * Reject ambiguous mixed scaling instead of clicking the wrong monitor. */
export function x11InputGeometry(
  displays: readonly {
    id: number;
    scaleFactor: number;
    bounds: { x: number; y: number; width: number; height: number };
  }[],
  displayId: string,
): string[] {
  const display = displays.find((d) => String(d.id) === displayId);
  if (!display) throw new Error('DESKTOP_DISPLAY_MISSING');
  const scale = display.scaleFactor;
  if (!Number.isFinite(scale) || scale <= 0 || displays.some((d) => d.scaleFactor !== scale))
    throw new Error('DESKTOP_INPUT_UNSUPPORTED');
  const x = Math.min(...displays.map((d) => d.bounds.x));
  const y = Math.min(...displays.map((d) => d.bounds.y));
  const values = [
    display.bounds.x - x,
    display.bounds.y - y,
    display.bounds.width,
    display.bounds.height,
  ].map((n) => Math.round(n * scale));
  if (
    values.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 32767) ||
    values[2] === 0 ||
    values[3] === 0
  )
    throw new Error('DESKTOP_DISPLAY_MISSING');
  return values.map(String);
}
