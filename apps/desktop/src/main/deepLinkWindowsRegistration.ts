import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import { DEEP_LINK_SCHEMES } from '../shared/deepLinkSchemes';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('deepLink');
const options = { windowsHide: true, encoding: 'utf8' as const, timeout: 3_000 };

/** Protocol-scoped name: never rename the shared Electron executable or other apps' handlers. */
export async function registerWindowsDeepLinkName(scheme: string, platform = process.platform): Promise<void> {
  if (platform !== 'win32' || !DEEP_LINK_SCHEMES.some(value => value === scheme)) return;
  const key = `HKCU\\Software\\Classes\\${scheme}\\Application`;
  try {
    let existing = '';
    try {
      const result = await execFileAsync('reg.exe', ['query', key, '/v', 'ApplicationName'], options);
      existing = /ApplicationName\s+REG_SZ\s+([^\r\n]*)/.exec(result.stdout)?.[1]?.trim() ?? '';
    } catch { /* First registration has no Application metadata yet. */ }
    if (existing === BRAND_IDENTITY.displayName) return;
    await execFileAsync('reg.exe', ['add', key, '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', BRAND_IDENTITY.displayName, '/f'], options);
  } catch {
    // A missing display label must never block startup or change the existing launch command.
    log.warn('could not register protocol display name', { scheme });
  }
}
