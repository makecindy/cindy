import { app } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isX11Desktop } from './linuxInput';

const exec = promisify(execFile);
const binaryName = 'cindy-linux-desktop-capture';
let building: Promise<string> | null = null;
export async function readLinuxCursorSupport(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { stdout } = await exec(await resolveLinuxCaptureBinary(), ['--cursor-check'], {
      timeout: 3000,
      maxBuffer: 1024,
    });
    return stdout.trim() === 'ready';
  } catch {
    return false;
  }
}
let x11Ready: Promise<boolean> | null = null;
/** X11 root capture without the pointer, plus XFIXES cursor metadata.
 * A positive probe is kept for this run (the X session cannot change under a
 * running app); a failed one is retried by the next caller. */
export function readLinuxX11CaptureSupport(): Promise<boolean> {
  if (!isX11Desktop()) return Promise.resolve(false);
  x11Ready ??= (async () => {
    try {
      const { stdout } = await exec(await resolveLinuxCaptureBinary(), ['--x11-check'], {
        timeout: 3000,
        maxBuffer: 1024,
      });
      return stdout.trim() === 'ready';
    } catch {
      return false;
    }
  })().then((ready) => {
    if (!ready) x11Ready = null;
    return ready;
  });
  return x11Ready;
}
export function resolveLinuxCaptureBinary(): Promise<string> {
  if (app.isPackaged)
    return Promise.resolve(path.join(process.resourcesPath, 'tools', 'remote-desktop', binaryName));
  if (building) return building;
  building = (async () => {
    const root = path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-capture');
    const hash = createHash('sha256').update(process.arch);
    for (const name of [
      'main.c',
      'cursor.h',
      'cursor_shape.h',
      'jpeg.h',
      'x11.h',
      'build.mjs',
      'wlr-screencopy-unstable-v1.xml',
      'ext-image-copy-capture-v1.xml',
      'ext-image-capture-source-v1.xml',
      'ext-foreign-toplevel-list-v1.xml',
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
