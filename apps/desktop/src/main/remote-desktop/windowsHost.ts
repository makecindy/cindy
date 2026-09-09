import { app } from 'electron';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WindowsDesktopSupport } from '../../shared/remoteDesktop';

const exec = promisify(execFile);
const requireNative = createRequire(import.meta.url);
const binary = () =>
  path.join(process.resourcesPath, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe');
export interface WindowsDesktopConnection {
  request(line: string): Promise<string>;
  close(): void;
}
export async function readWindowsDesktopSupport(): Promise<WindowsDesktopSupport | undefined> {
  if (process.platform !== 'win32') return undefined;
  if (!app.isPackaged) return 'installRequired';
  try {
    const { stdout } = await exec(binary(), ['--status'], {
      timeout: REMOTE_DESKTOP_OFFER_BUDGET.platformStatusMs,
      maxBuffer: 1024,
      windowsHide: true,
    });
    const status = stdout.trim();
    if (status === 'ready') {
      try {
        const connection = await openWindowsDesktopConnection({ mode: 'probe' });
        connection.close();
      } catch {
        return 'missing';
      }
    }
    return status === 'ready' || status === 'missing' || status === 'installRequired'
      ? status
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
export async function configureWindowsDesktopSupport(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged)
    throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  await exec(
    binary(),
    enabled ? ['--elevate-install', String(process.pid)] : ['--elevate-uninstall'],
    { timeout: 130_000, maxBuffer: 1024, windowsHide: true },
  );
  if (enabled && (await readWindowsDesktopSupport()) !== 'ready')
    throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
}
export async function openWindowsDesktopConnection(
  init: { mode: 'input' | 'probe' } | { mode: 'capture'; rect: number[] },
): Promise<WindowsDesktopConnection> {
  if (process.platform !== 'win32' || !app.isPackaged)
    throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  // Fixed packaged Node-API addon, loaded only by Main. It opens the pipe in
  // this process and authenticates SCM/SYSTEM identity before sending anything.
  const native = requireNative(
    path.join(process.resourcesPath, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.node'),
  ) as {
    DesktopConnection: { open(binary: string, init: string): Promise<WindowsDesktopConnection> };
  };
  return native.DesktopConnection.open(binary(), JSON.stringify(init));
}
