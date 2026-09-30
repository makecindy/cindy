import { app } from 'electron';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { RemoteClipboardContent } from '@cindy/device-link';
import { isLinuxDesktopUnlocked } from './linuxSessionLock';

const exec = promisify(execFile);
export function supportsLinuxClipboard(): boolean {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    accessSync('/usr/bin/wl-paste', constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function read(args: string[], maxBuffer: number): Promise<Buffer> {
  if (!(await isLinuxDesktopUnlocked())) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  try {
    const result = await exec('/usr/bin/wl-paste', args, {
      timeout: 2000,
      maxBuffer,
      encoding: 'buffer',
    });
    if (!(await isLinuxDesktopUnlocked())) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    return result.stdout;
  } catch (error) {
    // Empty selection is distinct from failed compositor access. Never propagate
    // subprocess exceptions: they can include clipboard contents in stdout.
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      Buffer.isBuffer(error.stderr) &&
      /^Nothing is copied|^No selection/.test(error.stderr.toString())
    )
      return Buffer.alloc(0);
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  }
}
export async function readLinuxClipboardSnapshot(
  primary = false,
): Promise<{ formats: string[]; content: RemoteClipboardContent }> {
  if (!supportsLinuxClipboard()) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  const selection = primary ? ['--primary'] : [];
  const formats = (await read([...selection, '--list-types'], 16384))
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  if (formats.length > 64 || formats.some((f) => f.length > 256))
    throw new Error('CLIPBOARD_UNSUPPORTED');
  const fileBacked = formats.some((f) =>
    /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/i.test(f),
  );
  const content: RemoteClipboardContent = {};
  const textTypes = [
    ['text', ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING']],
    ['html', ['text/html']],
    ['rtf', ['text/rtf', 'application/rtf']],
  ] as const;
  if (!fileBacked) {
    for (const [key, types] of textTypes) {
      if (primary && key !== 'text') continue;
      const mime = types.find((type) => formats.includes(type));
      if (mime) {
        const value = (
          await read([...selection, '--no-newline', '--type', mime], 2 * 1024 * 1024)
        ).toString();
        if (value.length > 512000) throw new Error('CLIPBOARD_TOO_LONG');
        if (value) content[key] = value;
      }
    }
  }
  if (!primary && formats.includes('image/png')) {
    const png = await read(['--no-newline', '--type', 'image/png'], 8 * 1024 * 1024);
    if (
      png.length < 33 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('CLIPBOARD_UNSUPPORTED');
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (!width || !height || width * height > 4000000) throw new Error('CLIPBOARD_TOO_LONG');
    content.png = png.toString('base64');
  }
  return { formats, content };
}
let building: Promise<string> | undefined;
async function binary(): Promise<string> {
  const name = 'cindy-linux-desktop-clipboard';
  if (app.isPackaged) return path.join(process.resourcesPath, 'tools', 'remote-desktop', name);
  if (building) return building;
  building = (async () => {
    const source = path.join(app.getAppPath(), 'native', 'remote-desktop', 'linux-clipboard');
    const hash = createHash('sha256').update(process.arch);
    for (const name of ['main.c', 'build.mjs', 'wlr-data-control-unstable-v1.xml'])
      hash.update(await fs.readFile(path.join(source, name)));
    const directory = path.join(
      app.getPath('userData'),
      'remote-desktop',
      'native',
      hash.digest('hex'),
    );
    const target = path.join(directory, name);
    try {
      await fs.access(target, constants.X_OK);
      return target;
    } catch {
      /* Build this source. */
    }
    await exec('node', [path.join(source, 'build.mjs'), directory], {
      timeout: 60000,
      maxBuffer: 64000,
    });
    return target;
  })()
    .catch(() => {
      throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    })
    .finally(() => {
      building = undefined;
    });
  return building;
}
let writer: ChildProcessWithoutNullStreams | null = null;
/** Like Electron's clipboard owner, an explicitly copied value survives the
 * remote lease until replacement or app exit. It never observes later copies. */
export function stopLinuxClipboardWriter(): void {
  writer?.kill();
  writer = null;
}
export async function writeLinuxClipboard(
  content: RemoteClipboardContent,
  current: () => boolean,
): Promise<void> {
  const executable = await binary();
  if (!(await isLinuxDesktopUnlocked())) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
  const child = spawn(executable, [], { stdio: 'pipe' });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      let response = '';
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        child.stdout.off('data', data);
        child.off('error', failed);
        child.off('exit', failed);
        if (ready) resolve();
        else reject(new Error('DESKTOP_CLIPBOARD_WRITE_FAILED'));
      };
      const failed = () => finish(false);
      const data = (chunk: Buffer) => {
        response += chunk.toString();
        if (response.length > 32) failed();
        else if (response.includes('\n')) finish(response === 'ready\n');
      };
      const timer = setTimeout(failed, 5000);
      child.once('error', failed);
      child.once('exit', failed);
      child.stdout.on('data', data);
      child.stdin.write(
        JSON.stringify({
          ...content,
          ...(content.url && !content.text ? { text: content.url } : {}),
        }) + '\n',
      );
    });
    if (!(await isLinuxDesktopUnlocked())) throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    writer?.kill();
    writer = child;
    child.once('exit', () => {
      if (writer === child) writer = null;
    });
  } catch (error) {
    child.kill();
    throw error;
  }
}
