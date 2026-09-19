import { app } from 'electron';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WindowsDesktopSupport, WindowsDesktopSetupPhase } from '../../shared/remoteDesktop';
import { createWindowsDevelopmentAssets, type WindowsDesktopAssets } from './windowsDevelopment';

const exec = promisify(execFile);
const requireNative = createRequire(import.meta.url);
let development: ReturnType<typeof createWindowsDevelopmentAssets> | null = null;
function developmentAssets() {
  return (development ??= createWindowsDevelopmentAssets({
    application: app.getAppPath(),
    executable: process.execPath,
    userData: app.getPath('userData'),
    arch: process.arch,
  }));
}
async function assets(
  prepare = false,
  progress?: (phase: WindowsDesktopSetupPhase) => void,
): Promise<WindowsDesktopAssets | null> {
  if (app.isPackaged)
    return {
      binary: path.join(
        process.resourcesPath,
        'tools',
        'remote-desktop',
        'cindy-windows-desktop-host.exe',
      ),
      addon: path.join(
        process.resourcesPath,
        'tools',
        'remote-desktop',
        'cindy-windows-desktop-host.node',
      ),
    };
  return progress
    ? developmentAssets().resolve(prepare, progress)
    : developmentAssets().resolve(prepare);
}
async function helper(
  prepare = false,
  progress?: (phase: WindowsDesktopSetupPhase) => void,
): Promise<WindowsDesktopAssets | null> {
  const current = await assets(prepare, progress);
  if (current || app.isPackaged) return current;
  return developmentAssets().installed();
}
export interface WindowsDesktopConnection {
  request(line: string): Promise<string>;
  close(): void;
}
export async function readWindowsDesktopSupport(): Promise<WindowsDesktopSupport | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const current = await assets();
    const native = current ?? (await helper());
    if (!native) return 'missing';
    const { stdout } = await exec(native.binary, ['--status'], {
      timeout: REMOTE_DESKTOP_OFFER_BUDGET.platformStatusMs,
      maxBuffer: 1024,
      windowsHide: true,
    });
    const status = stdout.trim();
    if (status === 'ready' || status === 'updateRequired') {
      try {
        const connection = await openWindowsDesktopConnection({ mode: 'probe' });
        connection.close();
      } catch {
        // The SCM service is installed. A failed probe must not look like a
        // missing grant, or Settings only offers Enable and cannot uninstall.
        return 'unavailable';
      }
      // A previous checkout-bound helper can still talk to the installed
      // service. Do not report ready: settings must offer Update, while
      // uninstall still uses helper() without rebuilding.
      if (!current) return 'updateRequired';
    }
    return status === 'ready' ||
      status === 'missing' ||
      status === 'installRequired' ||
      status === 'updateRequired'
      ? status
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
export async function uninstallWindowsDesktopSupportFrom(
  resources: string,
  progress?: (phase: WindowsDesktopSetupPhase) => void,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const native = {
    binary: path.join(resources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe'),
    addon: path.join(resources, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.node'),
  };
  if (!existsSync(native.binary)) return;
  progress?.('removing');
  await exec(native.binary, ['--elevate-uninstall'], {
    timeout: 130_000,
    maxBuffer: 1024,
    windowsHide: true,
  });
}

export async function configureWindowsDesktopSupport(
  enabled: boolean,
  progress?: (phase: WindowsDesktopSetupPhase) => void,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  let native: WindowsDesktopAssets | null;
  try {
    // Uninstall must use the last installed helper. Rebuilding current source
    // is not required to revoke an auto-start SYSTEM service.
    native = await helper(enabled, progress);
  } catch (error) {
    if (!enabled) {
      native = app.isPackaged ? null : await developmentAssets().installed();
      if (!native) throw error;
    } else if (!app.isPackaged) {
      throw new Error('DESKTOP_NATIVE_BUILD_FAILED');
    } else {
      throw error;
    }
  }
  if (!native) throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  // Recreating a Dev cache does not revoke the installed grant.
  if (enabled && !app.isPackaged && (await readWindowsDesktopSupport()) === 'ready') return;
  progress?.('authorizing');
  await exec(
    native.binary,
    enabled ? ['--elevate-install', String(process.pid)] : ['--elevate-uninstall'],
    { timeout: 130_000, maxBuffer: 1024, windowsHide: true },
  );
  progress?.('verifying');
  if (enabled && (await readWindowsDesktopSupport()) !== 'ready')
    throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
}
export async function openWindowsDesktopConnection(
  init:
    | { mode: 'input' | 'probe' }
    | { mode: 'capture'; rect: number[]; cursorOverlay?: boolean; bitrate?: number },
): Promise<WindowsDesktopConnection> {
  if (process.platform !== 'win32') throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  const prepared = await helper();
  if (!prepared) throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  // Fixed native addon (checkout-bound in Dev), loaded only by Main. It opens the pipe in
  // this process and authenticates SCM/SYSTEM identity before sending anything.
  // Dev status/probe reuse the last installed helper when the current fingerprint
  // no longer matches, so an authorized service still shows Remove.
  const native = requireNative(prepared.addon) as {
    DesktopConnection: { open(binary: string, init: string): Promise<WindowsDesktopConnection> };
  };
  return native.DesktopConnection.open(prepared.binary, JSON.stringify(init));
}
