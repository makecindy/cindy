import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** electron-builder 24's default NSIS GUID: UUID v5(appId, its fixed namespace). */
export function windowsInstallKey(appId: string): string {
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const bytes = createHash('sha1').update(namespace).update(appId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** First launch after a ZIP applied by an old updater: no startup-wide repair. */
export async function syncWindowsVersionAfterUpdate(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  version: string;
  appId: string;
  exePath: string;
  resourcesPath: string;
  patchInfoPath: string;
  warn: (message: string) => void;
}): Promise<void> {
  if (options.platform !== 'win32' || !options.packaged || /^0\.0\.0(?:$|[-+])/.test(options.version)) return;
  try {
    // Read the receipt synchronously before startup's existing patch cleanup
    // can consume a same-version receipt. The file is tiny and this runs once.
    const patch = JSON.parse(fs.readFileSync(options.patchInfoPath, 'utf8')) as {
      version?: string; applyAttempts?: number;
    };
    // The Rust updater deletes the ZIP after success, but leaves patch-info.
    if (patch.version !== options.version || !(typeof patch.applyAttempts === 'number' && patch.applyAttempts > 0)) return;
    const script = await fs.promises.readFile(path.join(options.resourcesPath, 'windows-installation-version.ps1'), 'utf8');
    // Do not resolve executable code from the installation directory or PATH.
    const powershell = path.win32.join(process.env.SystemRoot ?? ['C:', 'Windows'].join(String.fromCharCode(92)), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await new Promise<void>((resolve) => {
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          CINDY_VERSION_SYNC_KEY: windowsInstallKey(options.appId),
          CINDY_VERSION_SYNC_EXE: options.exePath,
          CINDY_VERSION_SYNC_EXPECTED: options.version,
        },
      }, (error, stdout, stderr) => {
        if (error || stdout || stderr) options.warn('Windows installation version metadata could not be synchronized.');
        resolve();
      });
    });
  } catch {
    // Missing/invalid patch-info means this is not a completed ZIP update.
    // Metadata repair must never interfere with normal startup or updating.
  }
}
