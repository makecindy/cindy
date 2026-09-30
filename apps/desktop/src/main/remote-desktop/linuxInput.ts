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

/** Probe registry support without creating devices or injecting input. */
export async function readLinuxDesktopInputSupport(): Promise<boolean> {
  if (!isWaylandDesktop(process.platform, process.env) || !process.env.HYPRLAND_INSTANCE_SIGNATURE)
    return false;
  try {
    const { stdout } = await exec(await resolveLinuxInputBinary(), ['--check'], {
      timeout: 3000,
      maxBuffer: 1024,
    });
    return stdout.trim() === 'ready';
  } catch {
    return false;
  }
}
