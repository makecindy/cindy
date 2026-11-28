import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy';

const previews = new WeakMap<BrowserWindow, ChildProcess>();

/** Accept only a local regular file. Remote paths must never reach a local shell provider. */
export async function openSystemPreview(
  owner: BrowserWindow | null,
  input: unknown,
): Promise<boolean> {
  if (!owner || typeof input !== 'string' || !path.isAbsolute(input)) return false;
  const allowed = (value: string) => isPathAllowedAgainst(value, getSensitiveMediaBlocklist());
  if (!allowed(input)) return false;
  try {
    const target = await fs.realpath(input);
    if (!allowed(target) || !(await fs.stat(target)).isFile() || owner.isDestroyed()) return false;
    if (process.platform === 'darwin') {
      owner.previewFile(target);
      return true;
    }
    if (process.platform !== 'win32') return false;
    // Shell manages its own preview handlers and security policy in a separate process.
    const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    const executable = path.join(root, 'tools', 'file-preview', 'cindy-file-preview.exe');
    const hwnd = owner.getNativeWindowHandle().readBigUInt64LE().toString();
    previews.get(owner)?.kill();
    const child = spawn(executable, [hwnd, target], { stdio: 'ignore' });
    previews.set(owner, child);
    const close = () => {
      child.kill();
    };
    owner.once('closed', close);
    return await new Promise<boolean>((resolve) => {
      const finish = (success: boolean) => {
        owner.removeListener('closed', close);
        if (previews.get(owner) === child) previews.delete(owner);
        resolve(success);
      };
      child.once('error', () => finish(false));
      child.once('exit', (code, signal) => finish(code === 0 || signal !== null));
    });
  } catch {
    return false;
  }
}
